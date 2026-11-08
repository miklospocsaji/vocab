# Proposal

## Why

M2 is the cloud skeleton (brief, section 7). The same Intake and Proposal handlers that M1 runs from the CLI must run in AWS, started by a GitHub label and paused for the owner's approval. This proves durable orchestration, the containerised worker and short-lived credentials end to end, before M3 adds the build loop. The owner chose the simplest infrastructure that does this (2026-11-02): no egress control, and only the worker touches the ledger.

## What Changes

- A factory CDK stack in eu-central-1 (`infra/factory-stack.ts`):
  - **network:** a small VPC with public subnets only, in two AZs. No private subnets, NAT or proxy
  - **data:** the ledger on a dedicated Aurora Serverless v2 Postgres cluster with auto-pause and no public address, reachable only from the worker
  - **compute:** an ECS cluster and a Fargate task definition for the `factory-worker` image from `add-factory-worker`
  - **orchestration:** a Step Functions Standard state machine (JSONata) and one webhook Lambda behind a Function URL
  - **secrets:** SSM Parameter Store SecureStrings for the API key, App private key and webhook secret; Secrets Manager only for the generated ledger credentials
  - **budget:** a $50 monthly AWS budget alarm for the whole account that emails the owner
- Labelling an issue `factory` starts an execution. Every state (Intake, Proposal, Proposal approval, Approved, Escalate) runs as a worker task.
- Proposal approval uses `waitForTaskToken`, with the token in the ledger. The summary comment now shows the cost and says how to approve. The owner's `/approve` starts a worker task that resumes the execution, which ends in the new state `proposal-approved` until M3 adds Design.
- The role result is stored in the ledger on its attempt. S3 joins in M3, when artifacts grow.
- A second ledger migration: approvals with their task tokens, the execution ARN per work item, a unique issue number, and the result per attempt.
- Infrastructure failures (a worker task that cannot start or crashes) retry, then escalate the work item with a comment.

Out of scope:
- network-level egress control (removed by the owner)
- every state after Proposal approval (M3 onwards); `proposal-approved` is terminal in M2
- `/approve` on pull requests (no PRs exist before M3)
- S3 artifacts (M3)
- enforcing the $5 per-work-item limit as a running total, and pausing executions on any budget (M6)
- a timeout on Proposal approval, and retrying an escalated work item from GitHub
- CI that builds the image or deploys
- the app, preview and certificate stacks (M4)

## Capabilities

### New Capabilities

### Modified Capabilities
- `orchestration`: webhook intake, the cloud state machine up to Proposal approval, `/approve`, infrastructure-failure escalation, results in the ledger, the cost in the summary comment, and the ledger's network boundary.
- `roles`: role boundaries verified in Fargate.

## Impact

- New package `infra` (`@vocab/infra`) with `aws-cdk-lib`, `constructs` and the `aws-cdk` CLI, pinned exactly and separately (ADR 0001), plus `esbuild` for bundling the Lambda. New root scripts `infra:synth`, `infra:diff` and `infra:deploy`.
- `factory/orchestrator`: the state machine definition (`src/state-machine.ts`, a pure function returning JSONata ASL), the webhook handler (`src/lambda/webhook.ts`), the approval logic, and the `proposal-approved` state.
- `factory/worker`: the states `await-approval`, `approve`, `approved` and `escalate`.
- `factory/ledger`: migration `0002_cloud.sql` and its queries.
- A new Vitest project `cloud` and a script `pnpm test:cloud` for tests against the deployed stack. Like `test:live`, it never runs in `pnpm check` or CI.
- ADR 0008 (no egress control), and amendments to ADRs 0002 and 0003.
- Running cost: about $1–2 a month idle and a few cents per work item, plus model tokens.
- Tagged `large`: new infrastructure and credentials.
- Depends on `add-factory-worker`.
