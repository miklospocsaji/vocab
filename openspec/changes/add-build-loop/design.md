# Design

## Overview

Every state is still a Fargate task. The worker runs the roles without Bash, the classifier and every ledger, git and GitHub step. The build task (`add-build-roles`) runs the test author and implementer and their gates. They exchange files through the artifact store, and the execution carries only pointers: the issue number, the change id, task ids, exit codes and task tokens. The change id names the work item's branch and store prefix and holds no artifact, so it is a pointer like the issue number; the worker checks it against the issue's work item.

```
… AwaitApproval ─▶ Approved ─┬─ 10 (small) ─────────────────────────────────┐
                             └─ 0 ─▶ Design ─┬─ 0 (medium: reviewer passed) ─┤
                                    ▲        └─ 11 (large) ─▶ AwaitDesignApproval ─┤
                                    │                                       ▼
                                    │                     Plan (waitForTaskToken → { exitCode, changeId, tasks })
                                    │                                       ▼
                                    │       BuildTasks: Map over tasks, concurrency 1
                                    │       ┌──────────────────────────────────────────────┐
                                    │       │ Step ─┬─ 0  ─▶ task done                      │
                                    │       │  ▲    ├─ 20 ─▶ Build ─────────────┐           │
                                    │       │  │    ├─ 21 ─▶ Wait 60 s ─▶ Build ┤           │
                                    │       │  └────┼───────────────────────────┘           │
                                    │       │       ├─ 13 ─▶ Fail DesignFlaw                │
                                    │       │       └─ 3  ─▶ Fail Escalated                 │
                                    │       └──────────────────────────────────────────────┘
                                    └──── Catch DesignFlaw              │ all done
                                                                       ▼
                                                                OpenPullRequest ─▶ Done
```

## Components

### Exit codes (`factory/orchestrator/src/exit-codes.ts`)

These are added to `WORKER_EXIT`:

| Code | Name | Used by |
|---|---|---|
| 10 | `skipDesign` | `approved` for a `small` change |
| 11 | `ownerDesignReview` | `design` for a `large` change |
| 13 | `designFlaw` | `step` on a `design-flaw` |
| 20 | `build` | `step` has written the next build input |
| 21 | `buildAfterWait` | `step` on `infra`: build again after a wait |

Plan returns through a task token, not an exit code (below).

### Worker states

- **`approved`** (changed): sets `proposal-approved`, comments, then reads `x-complexity` from `.openspec.yaml` (zod; unknown escalates). It exits 10 for `small` and 0 otherwise.
- **`design`** (new): runs the architect, then for `medium` the design reviewer, in the same task to save a start-up, looping up to 3 architect attempts. Each accepted design is committed and pushed. It exits 0 (go to Plan), 11 (`large`: owner review) or 3. On a return for a design flaw, it puts the flaw's evidence in the architect's prompt and counts the flaw; the third flaw escalates.
- **`await-approval --kind proposal|design`** (generalised): the approval row gets a `kind`. The design summary lists the design's summary, its contracts, the ADRs it needs, and its cost.
- **`plan`** (new, a `waitForTaskToken` state): runs the planner and `validatePlan`, stores the tasks, commits and pushes `tasks.md`. It then calls `SendTaskSuccess` with `{ exitCode: 0, changeId, tasks: [<unfinished ids>] }`, or `{ exitCode: 3, changeId, tasks: [] }` when it escalated. Any other error is a `SendTaskFailure`, as in AwaitApproval.
- **`step --task <id>`** (new): the task's state machine, rebuilt from the ledger every time, so a repeated or retried `step` is safe:

  | Ledger shows | Step does | Exits |
  |---|---|---|
  | task ticked | nothing | 0 |
  | no test author attempt, or the last one failed and fewer than 3 were made | write test author input | 20 |
  | a build outcome not yet recorded | record it (below), then decide again | — |
  | test author passed red | write implementer input on the tests' commit | 20 |
  | implementer passed green | tick, commit, push, mark done | 0 |
  | implementer failed before the gates | count as `bug` | 20 or 3 |
  | implementer failed green | run the classifier and route (spec) | 20, 21, 13 or 3 |

  "Write input" means it puts `input.json` at `work-items/<changeId>/tasks/<taskId>/next.json` in the store, and creates the attempt row with that prefix.
- **`open-pr`** (new): finds or opens the PR, comments the link on the issue, and sets `pr-open`.

**Recording a build outcome** (inside `step`):
1. Read `outcome.json`, which must parse with `build-outcome`. Read `messages.jsonl` and replay it through `LedgerRecorder`.
2. Store the role result and the gates result on the attempt.
3. Re-run the diff check on the patch's paths.
4. Apply the patch to a fresh worktree at `baseCommit` and commit as the bot:
   - test author: `test(<changeId>): tests for task <id>`
   - implementer: `feat(<changeId>): task <id> <title>`, with the tick in `tasks.md`
5. Push.

If there is no outcome, the attempt fails with `no-outcome` and counts as `infra`.

### Build task invocation

The `Build` state runs the build task definition with the command `["build", "--change", <changeId>, "--task", <taskId>]`. The build entry point reads `next.json` for its role, attempt prefix and inputs, and writes its outputs under that prefix. Its role is in the input, not the state, so one `Build` state serves both roles and the gates-only re-run.

**Gates-only re-run.** For `flaky`, `step` writes an input with `mode: "gates-only"` and the earlier attempt's patch key. The build entry point clones, applies the patch, runs the green gates and writes the outcome, with no session.

### State machine (`factory/orchestrator/src/state-machine.ts`)

- New worker states use the existing `workerState` helper, so they get the same crash retries and Escalate path.
- `Plan` is an `ecs:runTask.waitForTaskToken` state with a heartbeat-free timeout of 2 hours. Its output is `{ changeId, tasks }`, kept as the variables `$changeId` and `$tasks`.
- **`BuildTasks`:** an inline Map, `Items: {% $tasks %}`, `MaxConcurrency: 1`, whose processor is `Step` → `StepExit` → `Build` / `WaitInfra` → `Step`.
  - A `Build` task that crashes is retried twice, as worker states are, then goes to `Step`, which records `no-outcome`.
  - `Fail` states inside the processor carry the errors `DesignFlaw` and `WorkItemEscalated`.
- The Map catches `DesignFlaw` into `Design`, and `WorkItemEscalated` into `Escalated`. It succeeds into `OpenPullRequest`.
- Task ids are the only per-item input. The processor's first state assigns the item to `$taskId`, and `Step` and `Build` take `--task` from it; `Build` takes `--change` from `$changeId`. Retries inside the Map count in `$itemTries`, since a Map's states may not assign a variable of the outer scope. A crashed or refusing `Step` ends the item with `WorkerFailed` or `WorkerRefused`, which the Map catches into `Escalate` with that reason.

### Ledger (`0003_build.sql`)

- `approvals.kind text not null default 'proposal'`, with the one-open-per-work-item constraint unchanged.
- `tasks(id, work_item_id, task_id, position, title, depends_on jsonb, files jsonb, scenarios jsonb, tests jsonb, status pending|done|superseded, done_commit, plan_attempt_id)`, unique on `(work_item_id, task_id)` among non-superseded rows. A re-plan supersedes the unfinished rows and inserts the new ones.
- `attempts.task_id` (nullable), `attempts.store_prefix`, `attempts.classification jsonb`, `attempts.gates jsonb`.
- `work_items.design_flaws int not null default 0`.
- New states: `design`, `design-review`, `awaiting-design-approval`, `plan`, `build`, `pr-open`.

### Forge

- `openPullRequest({ head, base, title, body })`
- `findPullRequest(head)`
- `GitHubForge` uses `POST /repos/{o}/{r}/pulls` and `GET …/pulls?head=<owner>:<branch>&state=open`. `FakeForge` keeps them in memory.
- The token provider's permissions gain `pull_requests: write`.

### Local runs (`factory/orchestrator/src/run.ts`, `factory/cli`)

The run loop gains the new states:
- `--until design|plan|pr`.
- `pnpm factory approve --issue <n>` closes the open approval locally and advances the work item. Local runs have no task token.
- For the build loop, the CLI's `runBuild` runs `docker run --rm` of the locally built `build` image, with an `FsStore` under `~/.factory/store` mounted at `/store`, and `CLAUDE_CODE_OAUTH_TOKEN` from `.env.local` (`add-build-roles`, "Local runs").

The loop calls the same handlers as the worker, with `step` in a loop per task.

### Factory stack (`infra/factory-stack.ts`)

- **Artifact bucket:**
  - `BlockPublicAccess.BLOCK_ALL`, `enforceSSL`, S3-managed encryption, versioning off
  - lifecycle: expire objects after 180 days
  - `RemovalPolicy.RETAIN`
- **Build task definition:**
  - image: the `build` target of the same `DockerImageAsset` Dockerfile
  - size: 2 vCPU / 4 GB, since tests and typecheck run in it
  - storage: 30 GB ephemeral
  - environment: `FACTORY_AUTH_MODE=api-key` and `FACTORY_STORE_BUCKET` (the worker reads the same variable)
  - secrets: only `ANTHROPIC_API_KEY`
  - logs: 14 days
- **Build task role:** `s3:GetObject` and `s3:PutObject` on `<bucket>/work-items/*`, nothing else. Its execution role reads only the API key parameter.
- **Build security group:** no ingress, all egress. It is not added to Aurora's ingress.
- **Worker task role:** gains `s3:GetObject` and `s3:PutObject` on `<bucket>/work-items/*`, and `s3:ListBucket` on the bucket for the `work-items/` prefix, so that a missing key is a 404 rather than a 403 (`step` asks whether an outcome exists).
- **State machine role:** gains running the build family and passing the build roles.
- **Webhook Lambda:** unchanged.

## Decisions

- **One `step` state per move, rebuilt from the ledger.** A retried or duplicated task re-derives what to do. The alternative, one state per role and outcome, would double the states and the start-ups.
- **Plan returns task ids through its task token.** An inline Map needs its items in the state input. ECS `.sync` returns only the task description, so the worker hands back the ids with `SendTaskSuccess`. Task ids are pointers, not artifacts. A Distributed Map reading from S3 would work too, but it adds child executions for a list of about five items.
- **Design and design review in one worker task.** Both are worker roles, and the review needs the design just written. One task saves a minute of start-up per round.
- **Role results stay in the ledger, build outputs go to S3.** ADR 0003 planned S3 for every result from M3. Results are still small JSON that the summary, the console and the benchmark query. Patches, gate output and message streams are large, and the build task cannot reach the ledger. ADR 0003 is amended.
- **The PR waits for the owner.** M3 has no reviewer, preview or acceptance. CI runs `pnpm check` on the PR as an independent check, which the build container cannot influence.

## Risks

- **Budget.** A five-task plan could reach $10–15 in the worst case of capped attempts. Typical spend is unknown. M3.3 measures a local run and records it before the exit run. If the typical spend is near $5, the owner decides on caps or models before M3.4.
- **Start-up time.** A task with no retries runs `step`, `Build`, `step`, `Build` and `step`: five Fargate tasks, two of them with an install. That is roughly 10 minutes of overhead per task, and about an hour for the importer. Acceptable for M3. Folding `step` into the build task is not possible, since `step` needs the ledger.
- **Deploying while paused.** Executions continue on the families' latest revisions (CLAUDE.md). A deploy that changes the input format between `step` and `factory-build` must not happen during a run.
- **Re-plans that rename tasks.** `validatePlan` keeps ticked tasks, but a re-plan may reuse an unfinished id with a new meaning. The superseded rows keep the history.

## Contracts

No changes in `app/contracts/`.

## Decisions that need an ADR

- **0002 amendment:** the Map loop, `step` re-derived from the ledger, Plan returning ids by task token, and the build task as the second kind of task.
- **0003 amendment:** results in the ledger, build outputs and their keys in S3.
- **0009 amendment:** `pull_requests: write`; the App now opens PRs.

## Owner prerequisites

- Enable Pull requests read and write in the `vocab-factory` App's settings and accept the new permission on the installation (step M3.4).
- Approval of every deploy, and of each GitHub write in the local runs and the exit run.
- The importer issue, and if the importer is not tagged `medium`, a second, `medium` issue.
