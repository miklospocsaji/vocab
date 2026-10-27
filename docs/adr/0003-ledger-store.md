# 0003 Ledger store

Status: accepted (2026-10-27; owner decision of 2026-10-26)

## Context

The ledger records work items, tasks, attempts, artifacts (as S3 pointers), SDK messages, token usage, cost and events. It feeds the console (M6) and the benchmark (M7), which need relational queries: cost per role per work item, success rate per role version, attempts per task.

## Decision

- Postgres on a dedicated Aurora Serverless v2 cluster for the factory, separate from the app's cluster. `serverlessV2MinCapacity: 0` with auto-pause, so an idle factory costs only storage.
- JSON artifacts and screenshots go to S3, keyed by work item and attempt. The ledger stores their keys.
- Locally (M1) the same schema runs in Postgres in Docker.
- Schema migrations are plain SQL files, applied by the deterministic runner.

## Alternatives

- DynamoDB: cheaper when idle and no VPC needed, but the console and benchmark queries would need precomputed aggregates.
- Sharing the app's Aurora cluster: cheaper, but couples factory experiments to app data and blast radius.

## Consequences

- The ledger needs a VPC. Lambdas and Fargate tasks that write to it run in private subnets (see the egress decision in the brief, section 8).
- Resuming from auto-pause takes roughly 15 seconds. Handlers use connection retries with a timeout long enough for it.
- Agents never connect to the ledger. The runner records on their behalf.
