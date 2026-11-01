# Proposal

## Why

M1 is the local walking skeleton: the thinnest path from a GitHub issue to a validated OpenSpec change, with cost recorded. It proves that the deterministic runner, the ledger, the Forge adapter and one agent role connect, before any cloud infrastructure exists.

## What Changes

- A CLI, `pnpm factory run --issue <n> --until proposal`, that runs the work-item states Intake and Proposal locally and stops before Proposal approval.
- Intake derives a verb-led change id from the issue, uses it as the branch name and creates the ledger row.
- Proposal runs the proposal-author role (see `add-role-runner`), validates its output with `openspec validate <id> --strict`, retries invalid output with the validation errors as evidence, then commits, pushes and posts a summary comment on the issue.
- A local ledger in Postgres (Docker) records work items, attempts, SDK messages, token usage, estimated cost and auth mode.
- A `Forge` interface with a GitHub implementation for reading issues, posting comments and pushing branches.
- Re-running the CLI for the same issue resumes the existing work item instead of starting a new one.

Out of scope:
- Step Functions and Fargate (M2)
- `/approve` handling (M2)
- every state after Proposal (M3 onwards)
- the GitHub App (M2); M1 uses the owner's `gh` token locally

## Capabilities

### New Capabilities
- `orchestration`: the work-item lifecycle: states, transitions, retries, stopping points and what is recorded for each.

### Modified Capabilities

## Impact

- New packages: `factory/cli`, `factory/orchestrator`, `factory/forge`, `factory/ledger`.
- New ledger schema (SQL migrations), hence `medium`.
- Docker Compose file for local Postgres.
- Depends on `add-role-runner` for the proposal-author role.
