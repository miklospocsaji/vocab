# 0002 Orchestration

Status: accepted (2026-10-27); amended 2026-11-06 (every state a worker task) and 2026-11-13 (the build loop)

## Context

The factory is a deterministic program that calls agents for judgement work (brief, section 2). One work item can run for hours or days. It waits for human approvals, retries failed tasks with evidence and loops over the tasks of a plan. Its state must survive crashes and be replayable. The owner wants to learn durable orchestration.

## Decision

- AWS Step Functions Standard workflows, one execution per work item, defined in CDK.
- JSONata as the query language for all states.
- Agent roles run as ECS Fargate tasks from one `factory-worker` image, called with the `.sync` (`RUN_JOB`) integration, so the state waits for the task to finish.
- Human approvals use `WAIT_FOR_TASK_TOKEN`. A Lambda stores the token in the ledger, and a `/approve` comment command resumes the execution with it. Amended 2026-11-06: a worker task stores the token, and `/approve` resumes the execution through a worker task (see below).
- The per-task build loop is a Map state. It runs sequentially at first; independent tasks may run in parallel later.
- States pass small JSON pointers (work-item id, attempt id, S3 keys). Artifacts never travel in the state payload, which is limited to 256 KB.
- Retries, budgets and failure routing are expressed in the state machine and in deterministic handlers, never by an agent.
- M1 runs the same handlers locally from a CLI (`pnpm factory run`) without Step Functions. So the handlers are plain async functions with no AWS-specific control flow, and the state machine only sequences them.

## Alternatives

- Temporal: richer replay semantics and local development, but an extra service to run and pay for. Step Functions is serverless and fits the AWS-only, small-budget setup.
- A home-made queue plus a state table: cheap, but it would rebuild timers, retries and token waits by hand.
- Express workflows: their 5-minute limit rules them out for approvals.

## Consequences

- Execution history gives a free audit trail. The ledger remains the source for cost and metrics.
- Standard workflow pricing is per state transition, which is negligible at this volume.
- The local runner and the cloud state machine must stay in step. Shared handlers keep the drift small.

## Amendment 2026-11-06: every state runs as a worker task

Only the worker touches the ledger (ADR 0003, amendment of 2026-11-06), so no Lambda can store a task token or read one back. In M2 (add-cloud-proposal-run):
- Every state, including the quick ones, is a `factory-worker` Fargate task from the one image: `intake`, `proposal`, `await-approval`, `approved` and `escalate`. Each costs about a minute of task start-up and a fraction of a cent, which nothing in M2 minds.
- Proposal approval is an `ecs:runTask.waitForTaskToken` state. It passes the task token to the worker as the environment override `FACTORY_TASK_TOKEN`. The worker stores the token as an open approval in the ledger before it posts the summary comment, so the owner cannot reply before the token exists. Any error the worker catches is reported with `SendTaskFailure`. Step Functions does not watch the task, so a worker that dies silently leaves the execution paused; M2 has no timeout on the state.
- The webhook Lambda runs outside the VPC and has no ledger access. For the owner's `/approve` it starts one worker task, `approve --issue <n> --by <login>`. That task closes the open approval and calls `SendTaskSuccess` with its token. If the call fails, it reopens the approval and says so on the issue, so the owner can try again.
- States pass only the issue number, exit codes and, for approval, the task token. The worker reports by exit code, and the state machine routes on it. A `.sync` task that exits non-zero fails the state with `States.TaskFailed` and the ECS task description in `Cause`, so the exit code is read from there (measured in task 3.1).
- Infrastructure failures are retried in the state machine, twice, after 30 and 90 seconds. Then an `escalate` task marks the work item and comments with a fixed reason code.

## Amendment 2026-11-13: the build loop

M3 (add-build-loop) runs the work item past Proposal approval to a pull request. The amendment of 2026-11-06 still holds; what it adds:
- **Routes after Approved,** on the change's `x-complexity`, by exit code: `approved` exits 10 for `small` (straight to Plan) and 0 otherwise (to Design). `design` runs the architect and, for `medium`, the design reviewer in the same task. It exits 0 (to Plan), 11 for `large` (to AwaitDesignApproval, the same token wait and `/approve` as the proposal's, with `--kind design`) or 3.
- **Plan returns the tasks through its task token.** An inline Map needs its items in the execution, and a `.sync` task returns only the ECS task description. So Plan is an `ecs:runTask.waitForTaskToken` state with a two-hour timeout. The worker calls `SendTaskSuccess` with `{ exitCode, changeId, tasks }`, which the state machine keeps as the variables `$changeId` and `$tasks`. A Distributed Map reading from S3 would also work, but it adds child executions for a list of about five items.
- **The build loop is an inline Map over `$tasks`, with `MaxConcurrency: 1`.** Per task, a `step --task <id>` worker task decides the next move from the ledger every time, so a retried or repeated step is safe. It exits 0 (done), 20 (build), 21 (build after a 60-second wait), 13 (design flaw) or 3 (escalated). The alternative, one state per role and outcome, would double the states and the start-ups.
- **The build task is a second kind of task:** `factory-build build --change <id> --task <id>`, from its own task definition (ADR 0011). It reads its role and input from the task's `next.json` in the artifact store (ADR 0003, amendment of 2026-11-13). A crashed build is retried twice after 30 and 90 seconds, then `step` records the missing outcome as `no-outcome`.
- **Failures leave the Map as errors.** A step's design flaw ends the item with `DesignFlaw`, which the Map catches into Design, so the change is designed and planned again; the worker escalates a third flaw. An escalated step ends it with `WorkItemEscalated`, caught into Escalated. A step that crashes past its retries or refuses its input ends it with `WorkerFailed` or `WorkerRefused`, caught into Escalate with that reason. Retries inside the Map count in a variable of their own, `$itemTries`, since a Map's states may not assign a variable of the outer scope.
- **States pass only pointers:** the issue number, the change id, task ids, exit codes and task tokens. The change id names the work item's branch and store prefix and holds no artifact, so it is a pointer like the issue number.
- After the Map, `open-pr` opens the pull request and the execution succeeds. The pull request waits for the owner; nothing in the state machine merges.
