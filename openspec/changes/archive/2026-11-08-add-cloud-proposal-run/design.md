# Design

## Overview

Only the worker touches the ledger. Every state, including a quick one, runs as a Fargate task from one image using the M1 handlers. That keeps the Lambda out of the VPC, which removes the need for private subnets, a NAT and VPC endpoints.

```
GitHub ─▶ webhook Lambda (Function URL, no VPC, no ledger)
            ├─ issues.labeled "factory" ─▶ StartExecution { issueNumber }
            └─ owner's /approve ─────────▶ ecs:RunTask  factory-worker approve --issue <n>

Step Functions (each state is a worker task):
  Intake ─▶ Proposal ─▶ AwaitApproval ······ waits ······ ▶ Approved ─▶ end
    │ 4        │ 3 or retries used up
    ▼          ▼
   end      Escalate ─▶ fail

VPC, public subnets only:
  Fargate worker (public IP, no inbound) ──5432/TLS──▶ Aurora (no public address)
```

## Components

### `infra` (new package `@vocab/infra`)

- `infra/bin/factory.ts`: the CDK app. Its environment is the account from the deploy credentials, in `eu-central-1`.
- `infra/factory-stack.ts`: one stack, one file while it stays readable. Never written by factory roles (brief, section 5).
  - **VPC:** `natGateways: 0`, one public subnet tier across two AZs (Aurora's subnet group needs two). No private subnets, no endpoints.
  - **Aurora:** Serverless v2, PostgreSQL 17, `serverlessV2MinCapacity: 0` (auto-pause after 5 minutes idle), max 1 ACU, one writer, `publiclyAccessible: false`, credentials generated into Secrets Manager, deletion protection on, 7-day backups. Its security group has one ingress rule: 5432 from the worker's security group. Auto-pause depends on nothing waking it, which is another reason it has no public address.
  - **Worker:** an ECS cluster and a Fargate task definition (`DockerImageAsset` from `factory/worker/Dockerfile`, `linux/amd64`), 1 vCPU / 2 GB, `assignPublicIp: ENABLED`, a security group with no ingress, logs kept 14 days. Secrets come through ECS `secrets`, never `environment`.
    - The task role may only call `states:SendTaskSuccess` and `states:SendTaskFailure` on this state machine.
    - The execution role reads the image, writes logs, and reads the worker's parameters and the ledger secret.
  - **Boundary check (test only):** a second task definition with the worker's roles, size, environment, secrets and logs, and the Dockerfile's `boundary-check` target as its image: the worker image plus Vitest (owner decision, 2026-11-06; ADR 0010). ECS cannot override the worker's entry point, and the worker image holds no Vitest, so "Boundaries hold in Fargate" runs here. The state machine never runs it.
  - **Parameters:** the owner creates `/factory/anthropic-api-key`, `/factory/github-app-private-key` and `/factory/github-webhook-secret` as SecureStrings with the AWS CLI before they are needed. CloudFormation cannot create SecureStrings, so the stack only references them.
  - **Webhook Lambda:** `NodejsFunction` (`nodejs24.x`) with a Function URL, auth `NONE` (the signature is checked in code). Its role may start this state machine, run the worker task definition, pass the worker's roles, and read the webhook secret parameter.
  - **Budget:** an AWS Budgets cost budget of $50 a month with no filter, so it covers the whole account (owner decision, 2026-11-02), with emails at 80% actual and 100% forecast to the address in the deploy-time context `budgetEmail`, which is never committed.

Non-secret configuration lives in `infra/cdk.json` context: the GitHub repository, the App id, the installation id, the App slug and the owner's login.

### Webhook Lambda (`factory/orchestrator/src/lambda/webhook.ts`)

Verifies `X-Hub-Signature-256` in constant time, answering 401 on failure. Then:
- `issues.labeled` with label `factory` on an open issue: `StartExecution` named `issue-<n>-<delivery-id>`, input `{ issueNumber }`, answer 202.
- `issue_comment.created` on an issue (not a pull request), whose first line is `/approve`, and whose author is the owner: `ecs:RunTask` of `factory-worker approve --issue <n>`, answer 202.
- Anything else: answer 204 and do nothing. A non-owner's `/approve` is visible only in the Lambda's log.

It needs no ledger and no VPC, and it answers GitHub well within 10 seconds even when Aurora is paused.

### Worker states (`factory-worker <state> --issue <n>`)

`add-factory-worker` delivers `intake` and `proposal`. This change adds:
- `intake --execution <arn>`: records the ARN on the work item. If the issue's work item has a different ARN, or the insert loses to a concurrent Intake on the unique issue number, it does nothing and exits 4.
- `await-approval`: reads the task token from `FACTORY_TASK_TOKEN`, stores an open approval, then posts the summary from the attempt's stored result. An error sends `SendTaskFailure`.
- `approve`: atomically closes the open approval with the owner's login and calls `SendTaskSuccess`. If that call fails, it reopens the approval and comments, so the owner can try again. With no open approval, it comments that nothing awaits approval.
- `approved`: sets `proposal-approved` and posts the confirmation.
- `escalate --reason <code>`: sets `escalated` and comments. The reason is a fixed code (`worker-failed`, `worker-refused`), never environment values or an ECS message.

### State machine (`factory/orchestrator/src/state-machine.ts`)

A pure function `definition({ cluster, taskDefinition, subnets, securityGroup, container })` returning JSONata ASL, so it is unit-tested without CDK or AWS. The execution input is `{ issueNumber }`, kept as a variable.

- **Intake** (`ecs:runTask.sync`): exit `0` → Proposal; `4` → `Ended` (Succeed).
- **Proposal** (`ecs:runTask.sync`): exit `0` → AwaitApproval; `3` → `Escalated` (Fail).
- **AwaitApproval** (`ecs:runTask.waitForTaskToken`): passes `$states.context.Task.Token` as the `FACTORY_TASK_TOKEN` environment override. No timeout in M2. On `SendTaskSuccess` → Approved.
- **Approved** (`ecs:runTask.sync`): exit `0` → Succeed.
- **Escalate** (`ecs:runTask.sync`): `escalate --reason <code>`, then Fail regardless of its own result.
- **For Intake, Proposal and Approved:** exit `2` → Escalate at once. Exit `1`, or a task that never started, retries through an `Assign`ed counter and `Wait` states of 30 s and 90 s, then → Escalate. The handlers are idempotent, so a retry after a crash is safe.

**How a non-zero exit surfaces (measured in task 3.1):** a non-zero exit fails the state with `States.TaskFailed`, and the ECS task description is in `Cause` as a JSON string. So `definition()` reads exit 0 from `$states.result.Containers[0].ExitCode`, and any other exit from a `Catch` on `States.TaskFailed` that parses `$parse($states.errorOutput.Cause).Containers[0].ExitCode`. See "Exit-code spike" below.

### Changes to existing packages

- `factory/orchestrator`:
  - `WorkItemState` gains `proposal-approved`. The local run loop treats it as past `awaiting-proposal-approval`.
  - `renderProposalSummary` takes an optional cost line (tokens, USD estimate, auth mode) and an optional approval instruction. The local CLI keeps its M1 summary.
  - `intake` takes an optional `executionArn`, and returns a `duplicate` transition as described above.
- `factory/ledger`: migration `0002_cloud.sql` and its queries, plus `connectionFromSecret(json)`, which builds a `pg` config with TLS verified against the RDS CA bundle committed at `factory/ledger/certs/rds-global-bundle.pem` with its SHA-256 recorded. The connection retries for up to 180 s while Aurora resumes.

## Data model (migration 0002)

- `work_items`: `+ execution_arn text`. The index on `issue_number` becomes unique. Intake writes the row before the branch, so a concurrent loser fails before creating anything.
- `attempts`: `+ result jsonb`.
- `approvals(id, work_item_id, state, task_token text, requested_at, resolved_at, resolved_by)`, with a partial unique index allowing one open approval per work item.

## Decisions

- **Only the worker touches the ledger.** A Lambda that needs both the database and the internet is what forces private subnets and a NAT. Here each state costs about a minute of task start-up and a fraction of a cent, which is acceptable: nothing in M2 is latency-sensitive.
- **Public subnets for the worker.** A public IP with no inbound rules costs about $0.005 an hour while a task runs, and needs no routing infrastructure. Aurora sits in the same subnets without a public address.
- **States run the worker's task definition family, not a revision.** An execution keeps the definition it started with. A deploy that changes the image registers a new revision and deregisters the old one, so a revision in the definition fails every later state of a paused execution (exit run 2). With the family, ECS runs the latest revision, so a paused execution continues on the newest image. The handlers are idempotent and read everything from the ledger, so that is safe. The state machine's and the webhook's `ecs:RunTask` allow `task-definition/<worker family>:*` only, and the webhook gets the family in `FACTORY_WORKER_TASK_DEFINITION`.
- **The issue number is the pointer.** An issue has at most one work item, and states pass nothing else, so no state output needs threading through.
- **Execution names include the delivery id.** Standard execution names cannot be reused for 90 days, so `issue-<n>` alone would block relabelling a rejected issue after its body is fixed. Duplicates end at Intake instead. No delivery table is needed: GitHub does not redeliver automatically, and a manual redelivery is harmless.
- **The token is stored before the summary is posted.** The owner cannot reply to a summary before its token exists.
- **Parameter Store over Secrets Manager** for the three secrets the owner supplies: free, and ECS injects both the same way. The generated ledger credentials stay in Secrets Manager ($0.40 a month), because RDS generates them there.
- **The result lives in the ledger until M3.** One small JSON per attempt doesn't justify a bucket yet. S3 arrives with larger artifacts, as the brief's section 3 describes.
- **Migrations run at worker start-up,** as the CLI does. `migrate()` already takes an advisory lock.
- **Tests:**
  - Unit tests in `pnpm check`: worker states with `FakeForge`, fake AWS clients and the real local ledger; the webhook handler; the ASL from `definition()`; CDK template assertions, synthesised with bundling skipped (`aws:cdk:bundling-stacks: []`).
  - Cloud tests (`*.cloud.test.ts`, `pnpm test:cloud`): run against the deployed stack with the owner's AWS credentials.
  - The exit run covers the whole path.

## Fargate boundary check (task 2.8)

Deployed 2026-11-06 to account 943081072466 with the `vocab` profile (about 9 minutes).

Run 1 (2026-11-06, `pnpm test:cloud`):
- **`bwrap` cannot start on Fargate:** "No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces". This confirms ADR 0007's expectation, and is input to M3's decision on Bash.
- "Proposal author cannot run commands" passed in the task.
- The three live boundary tests failed before any model call ($0.00). A one-off probe in the check task found the cause: the API key in `/factory/anthropic-api-key` is not scoped to a workspace, so the API rejects every request without an `anthropic-workspace-id` header. The fix is a key created in the dedicated factory workspace, which also puts the $20 monthly limit on it.
- The identity check failed on a test bug: AWS returns `compatibilities` in no particular order. Fixed by comparing such lists as sets.

Run 2 (2026-11-06, after the owner replaced the key with one scoped to the factory workspace, created on the API keys page with the workspace chosen in the Create key dialog): **passed**, both cloud tests.
- The deployed check task definition equals the worker's but for the image, and the worker image's layers are the check image's first layers.
- "Boundaries hold in Fargate": "Write outside the allowed paths is denied", "WebFetch outside GitHub is denied" and "Reading a process environment is denied" passed on Haiku in api-key mode, and "Proposal author cannot run commands" passed. Each probe ended `invalid-change`, as locally, since probes write no valid change. Model cost $0.0033 in total.
- `bwrap` still cannot create namespaces on Fargate (the same message as run 1). So M3's Bash roles cannot rely on the SDK sandbox in Fargate.

## Exit-code spike (task 3.1)

Run 2026-11-06 with the `vocab` profile, approved by the owner. Everything below was created for the spike and deleted afterwards.
- **Setup:**
  - A throwaway role `vocab-spike-sfn-ecs`. It could run only the worker task definition `FactoryWorker01A7C86A:1`, pass only the worker's two roles, and use the managed rule `StepFunctionsGetEventsForECSTaskRule`.
  - A STANDARD JSONata state machine `vocab-spike-exit-codes` with one `arn:aws:states:::ecs:runTask.sync` state on the deployed cluster, subnets and worker security group, with a public IP.
- **Forcing the exit codes:** ECS overrides can't replace the worker's entry point (`node main.ts`), so a command override alone runs a real state (owner decision, 2026-11-06). Each execution used `Command: ["spike"]` plus the environment override `NODE_OPTIONS=--import=data:text/javascript,process.exit(<n>)`, which exits before `main.ts` loads: no ledger, GitHub or model.
- **Exit 0:** the execution succeeds. The state's result is the task description: `LastStatus: "STOPPED"`, `StopCode: "EssentialContainerExited"`, `Containers[0]: { Name: "worker", ExitCode: 0 }`.
- **Exit 1 and exit 3:** the state fails (`TaskFailed`, then `ExecutionFailed` with no `Catch`) with `Error: "States.TaskFailed"`. `Cause` is the same task description as a JSON string (about 2.6 KB), with `Containers[0].ExitCode` 1 or 3. Nothing distinguishes exit codes in `Error`, so routing needs the parsed `Cause`.
- **History holds the overrides.** The `TaskScheduled` parameters and the task description in the result or `Cause` repeat the container overrides, environment values included. So `FACTORY_TASK_TOKEN` will appear in AwaitApproval's history (allowed by "Execution history holds no artifacts or secrets"), and no override may ever carry a secret. Secrets injected through the task definition's `secrets` don't appear: neither their names nor their values were in the task description.
- **Not measured:** a task that never starts (for example, a failed image pull or no capacity). By AWS's description it also fails with `States.TaskFailed` or an ECS error, but with no `ExitCode`. `definition()` treats a missing exit code like exit 1 (retry).
- **Left behind:** the rule `StepFunctionsGetEventsForECSTaskRule`, which Step Functions manages (`ManagedBy: states.amazonaws.com`). It's free, and the stack's state machine will use it.
- **Cost:** three Fargate tasks of under a minute each, under $0.01.

## State machine and webhook deploy (task 3.10)

Deployed 2026-11-06 with the `vocab` profile, approved by the owner (93 s). It added the state machine `factory-work-item` and the webhook Lambda with its Function URL (output `WebhookUrl`). It also replaced the worker and boundary-check task definitions with revision 2, whose images now hold the Step Functions client.

"Unsigned webhook is rejected" passed against the deployed endpoint (`webhook.cloud.test.ts`). Three deliveries, with no signature, another secret's signature and a malformed one, each got 401, and no execution or worker task started. The Lambda's log shows each rejection. That it answered 401 rather than 500 also shows it read the webhook secret from Parameter Store.

The owner then set the App's webhook URL to the Function URL and activated it. The first full `pnpm test:cloud` failed on a test bug: the webhook test counted every task in the cluster, and the boundary check's task, started by the other cloud test file in parallel, was one. The test now counts only tasks of the worker's family, the only ones the webhook can start. Run 2 (2026-11-06) **passed**: all 3 cloud tests, "Unsigned webhook is rejected" and the two boundary tests of task 2.7, on revision 2 of both task definitions.

## Exit run (task 4.1)

**Run 1 (2026-11-06, issue #4): failed at Intake, fixed.**
- The first label (21:48 UTC) sent no delivery: the App was not subscribed to the Issues event. The owner subscribed it (an `installation` delivery at 22:14 was the only one, answered 204), then removed and re-added the label.
- Execution `issue-4-03584d40-da30-11f1-899a-8466560805f6` started at 22:18:38 UTC. Intake's worker exited 2 with `FACTORY_DATABASE_URL is not set`, so Escalate ran at once and failed the same way. The execution failed at 22:20:22. No work item, branch or comment was created, and no tokens were spent.
- Cause: the stack injects the ledger as `FACTORY_LEDGER_SECRET`, but the worker still read only `FACTORY_DATABASE_URL`. `connectionFromSecret` (task 2.6) was never wired in. The 60 s retry while Aurora resumes was missing too. No test checked the task definition against the worker's configuration, and no earlier cloud test started a worker that touches the ledger.
- Fix: `workerConfig` builds the ledger from `FACTORY_LEDGER_SECRET` with `connectionFromSecret`, falling back to `FACTORY_DATABASE_URL` locally. `runWorker` calls `waitForLedger` (2 s apart, each connect bounded at 10 s; 60 s at first, 180 s since run 2) before migrating, inside its `try`, so a ledger that never answers still fails a paused AwaitApproval. A stack test now runs `workerConfig` on the task definition's environment and secrets. Deployed as revision 4 of both task definitions (67 s).

**Run 2 (issue #4): paused for approval, then `/approve` failed on Aurora's resume, fixed.**
- Execution `issue-4-ebaefdd0-da32-11f1-92f9-5bb17e05ec30` started at 22:39:27 UTC on 2026-11-06. Intake took 66 s, including Aurora's 16 s resume. Proposal took 92 s, and AwaitApproval posted the summary at 22:42:29, 3 min 2 s after the label. The cost line read 53,854 tokens, about $0.16, auth mode `api-key`. The branch held commit `a479ba0` by `vocab-factory[bot]`, valid under `--strict`.
- The summary listed five open questions. The owner answered them on the branch (`e51b847`, still valid under `--strict`) before approving. Gating `/approve` on open questions is left for a change after M2.
- `/approve` on 2026-11-08 at 14:52:35 UTC started the `approve` task, launched correctly (revision 4, the worker's security group, public IP). It exited 1 with "the ledger did not answer within 60 s (Error)". After about 40 hours paused, Aurora took 76 s to resume (14:52:59 to 14:54:15). The approval stayed open and the execution stayed paused.
- "Execution history holds no artifacts or secrets", checked by hand by the owner on 2026-11-08 before the second `/approve`, with the execution paused at AwaitApproval (23 events). The history and its strings, unescaped one level, were searched for every line of the issue body, `proposal.md` and the delta spec, and for the Anthropic API key, the webhook secret, the App private key's body lines, the ledger password and the GitHub token prefixes. Each value went from AWS straight into `grep` and was never printed. All eight came back clean. A control, the `FACTORY_TASK_TOKEN` override, was found, as expected.
- Fix: `waitForLedger` waits 180 s by default and names a timeout without a code as `connection timeout`. A failed `approve` still leaves no comment on the issue: left for the change after M2.
- The second `/approve`, at 17:38 UTC on 2026-11-08 on revision 5, closed the approval and resumed the execution ("resumed" at 17:39:23). Approved then failed in 0.1 s with `ECS.AccessDeniedException` on `FactoryWorker01A7C86A:4`. The execution still named revision 4, its start revision, which the deploy of the 180 s fix had made INACTIVE and dropped from the role's policy. Both retries and Escalate failed the same way, and the execution failed at 17:41:23. The work item stays `awaiting-proposal-approval` with its approval closed, so issue #4 cannot finish in M2. A relabel ends at Intake as a duplicate.
- Fix: states and the webhook name the worker's family (see Decisions). Deployed as revision 6. The exit run continues on a new issue.

**Run 3 (2026-11-08, issue #5): passed.** Revision 6 throughout, no deploy during the run, nothing on the laptop.
- "Labelling an issue starts an execution": the label at 19:56:34 UTC started `issue-5-8011d200-dbae-11f1-8ec4-15ae77b7973e` at 19:56:35. Intake created work item `add-show-how-often-each-word-was-looked` and its branch.
- "Execution waits for approval": Intake took 69 s, including Aurora's resume, and Proposal took 84 s. AwaitApproval posted the summary at 19:59:35, 3 min 0 s after the label. At 19:59:56 the execution was paused with no worker task running.
- "Summary shows the cost": 53,389 tokens, about $0.16 estimated, auth mode `api-key`, ending with the `/approve` instruction.
- The branch held `5484257` by `vocab-factory[bot]`, valid under `--strict`. The summary listed four open questions. The owner's answers were committed as `2e4e3c6`, still valid under `--strict`.
- "Execution history holds no artifacts or secrets": the scan ran at 20:03:37 UTC while the execution was paused (23 events). The control, the `FACTORY_TASK_TOKEN` override, was found. The issue body, both versions of `proposal.md` and of the delta spec, the Anthropic API key, the webhook secret, the App private key, the ledger password and the GitHub token prefixes were all clean.
- "Owner's approval resumes the execution": the owner's `/approve` at 20:08:35 started `approve` at 20:08:38 (webhook log). It closed the approval and resumed the execution at 20:09:20. Approved set `proposal-approved` and posted the confirmation at 20:09:46. The execution succeeded at 20:10:11, 96 s after `/approve`.
- Cost: $0.16 in model tokens, plus five Fargate tasks of about a minute each (well under a cent).

## Cost (eu-central-1, monthly, idle; estimates, not checked against the current price list)

| Item | Estimate |
| --- | --- |
| Aurora storage and I/O when paused | <$1 |
| Secrets Manager, 1 secret | $0.40 |
| ECR, logs, CDK bootstrap bucket | <$0.50 |
| Step Functions, Lambda, Parameter Store | free at this volume |
| **Total** | **about $1–2** |

Per work item: Aurora at up to 1 ACU for the minutes it is awake, and a few Fargate minutes, together a few cents. Model tokens come on top, controlled by the $20 Anthropic workspace limit and the $5 work-item limit: M1's proposal cost an estimated $0.37.

## Contracts

No changes in `app/contracts/`.

## Decisions that need an ADR

- **0008 No worker egress control:** the owner's decision of 2026-11-02 and why (complexity and cost for a pet project), what limits an agent instead (no Bash for the proposal author, `WebFetch` domain rules, read guard, spend-limited key), the accepted risk, and the proxy design it replaces, in case it is ever wanted. Written in task 2.1.
- **0002 amendment:** every state runs as a worker task, so a worker, not a Lambda, stores the token, and `/approve` resumes through a worker task.
- **0003 amendment:** no private subnets; JSON results in the ledger until M3.
- **0009 GitHub App auth** and **0010 Worker image** come from `add-factory-worker`.

## Owner prerequisites

- AWS: the account and the local profile to deploy with (SSO preferred; no static keys in files), and approval for `cdk bootstrap` and each `cdk deploy`.
- GitHub App (task 1.1, per ADR 0009):
  - created under the owner's account, installed on this repository only
  - permissions: Contents read & write, Issues read & write, Metadata read
  - events: Issues, Issue comment
  - the webhook URL is set after the first deploy

  The App id, installation id and slug go in `infra/cdk.json`. The private key goes straight into Parameter Store.
- Anthropic: an API key in a dedicated workspace with a $20 monthly limit, written straight into Parameter Store.
- A webhook secret the owner generates and writes to both Parameter Store and the App's settings.
- The budget alarm's email address, passed at deploy.
- The `factory` label on the repository, and a test issue for the exit run.

## Risks

- **No network-level egress control (accepted by the owner, 2026-11-02).** See `add-factory-worker`'s risks and ADR 0008. Reconsider before M3.
- **A worker that dies silently in AwaitApproval leaves the execution paused,** because `waitForTaskToken` does not watch the task. There is no timeout in M2. The owner would notice the missing summary and stop the execution by hand. Errors the worker can catch are reported with `SendTaskFailure`.
- **If the worker can't run at all,** Escalate can't run either, so the execution fails with no issue comment. It shows as failed in the Step Functions console. Acceptable for one owner watching one issue.
- **The factory shares an AWS account with the owner's other projects (owner decision, 2026-11-02).** The budget alarm counts their spend too, so it does not measure the factory alone. It only alerts, and stops nothing. The per-work-item cost comes from the ledger, not from the budget. The stack's IAM policies are scoped to its own resources, and the worker's task role can only report to its own state machine.
- **Ledger reads from the laptop.** Aurora has no public address, so `pnpm factory cost` can't reach it. The summary comment carries the cost in M2.
- **Aurora resume latency** (about 15 s) slows the first step after an idle period. The connection retry covers it.
- **Role boundaries on Fargate.** "Boundaries hold in Fargate" is checked in task 2.8, before any role runs there for real, in the boundary-check image. Its tests prove that the check image stands for the worker (ADR 0010, amendment of 2026-11-06), but they run the runner from Vitest, not through the worker's entry point. The same task records whether the SDK sandbox can start on Fargate, as input to M3's decision on Bash (see `add-factory-worker`).
