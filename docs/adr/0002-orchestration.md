# 0002 Orchestration

Status: accepted (2026-10-27)

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
