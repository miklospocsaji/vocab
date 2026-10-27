# 0002 Orchestration

Status: accepted (2026-10-27)

## Context

The factory is a deterministic program that calls agents for judgement work (brief, section 2). One work item can run for hours or days. It waits for human approvals, retries failed tasks with evidence and loops over the tasks of a plan. Its state must survive crashes and be replayable. The owner wants to learn durable orchestration.

## Decision

- AWS Step Functions Standard workflows, one execution per work item, defined in CDK.
- JSONata as the query language for all states.
- Agent roles run as ECS Fargate tasks from one `factory-worker` image, called with the `.sync` (`RUN_JOB`) integration, so the state waits for the task to finish.
- Human approvals use `WAIT_FOR_TASK_TOKEN`. A Lambda stores the token in the ledger, and a `/approve` comment command resumes the execution with it.
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
