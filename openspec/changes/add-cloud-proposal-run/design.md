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

**How a non-zero exit surfaces is unverified.** The AWS docs do not say whether a `.sync` task whose container exits non-zero completes with `Containers[0].ExitCode` in its output, or fails the state with the task description in the error's `Cause`. Task 3.1 measures it on a throwaway state machine before `definition()` is written. Either way, the routing above stays the same; only where the exit code is read from changes (`$states.result`, or a `Catch` parsing `$states.errorOutput.Cause`).

### Changes to existing packages

- `factory/orchestrator`:
  - `WorkItemState` gains `proposal-approved`. The local run loop treats it as past `awaiting-proposal-approval`.
  - `renderProposalSummary` takes an optional cost line (tokens, USD estimate, auth mode) and an optional approval instruction. The local CLI keeps its M1 summary.
  - `intake` takes an optional `executionArn`, and returns a `duplicate` transition as described above.
- `factory/ledger`: migration `0002_cloud.sql` and its queries, plus `connectionFromSecret(json)`, which builds a `pg` config with TLS verified against the RDS CA bundle committed at `factory/ledger/certs/rds-global-bundle.pem` with its SHA-256 recorded. The connection retries for up to 60 s while Aurora resumes.

## Data model (migration 0002)

- `work_items`: `+ execution_arn text`. The index on `issue_number` becomes unique. Intake writes the row before the branch, so a concurrent loser fails before creating anything.
- `attempts`: `+ result jsonb`.
- `approvals(id, work_item_id, state, task_token text, requested_at, resolved_at, resolved_by)`, with a partial unique index allowing one open approval per work item.

## Decisions

- **Only the worker touches the ledger.** A Lambda that needs both the database and the internet is what forces private subnets and a NAT. Here each state costs about a minute of task start-up and a fraction of a cent, which is acceptable: nothing in M2 is latency-sensitive.
- **Public subnets for the worker.** A public IP with no inbound rules costs about $0.005 an hour while a task runs, and needs no routing infrastructure. Aurora sits in the same subnets without a public address.
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
