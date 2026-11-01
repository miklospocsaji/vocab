# Design

## Components

- `factory/cli`: parses `run --issue <n> --until <state>`, loads config, and calls the orchestrator.
- `factory/orchestrator`: the state handlers `intake` and `proposal`, written as plain async functions `(ctx, item) => Promise<Transition>`. M1 sequences them in a local loop; in M2 the same handlers become Step Functions task handlers (ADR 0002).
- `factory/forge`: a `Forge` interface (`getIssue`, `comment`, `pushBranch`) with a `GitHubForge` implementation built on `@octokit/rest`. Locally it authenticates with the owner's `gh auth token`; in M2 it uses GitHub App installation tokens.
- `factory/ledger`: SQL migrations plus typed queries. It runs against Postgres in Docker locally and against Aurora from M2 (ADR 0003).
- Worktrees: each work item gets a git worktree in a directory outside the repo (`$FACTORY_HOME/worktrees/<change-id>`), so agent runs never touch the owner's checkout.

## Data model (first cut)

- `work_items(id, issue_number, change_id unique, branch, state, created_at, updated_at)`
- `attempts(id, work_item_id, state, role, n, started_at, ended_at, outcome, failure_reason, auth_mode, cost_usd_estimate)`
- `messages(id, attempt_id, seq, type, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw jsonb)`
- `events(id, work_item_id, at, kind, data jsonb)`

## Decisions

- **Change ids are deterministic.** Intake computes them from the title, with no agent involved, so the branch exists before any agent runs.
- **Re-runs resume.** The work item is looked up by issue number, and each state handler is idempotent.
- **Retry evidence is passed as an artifact.** It is the `openspec validate --json` output, never a transcript.
- **Which failures retry (owner decision, 2026-10-27).** Any failed attempt is retried, up to 3 attempts in total, except `auth-mode-mismatch`, which escalates at once. Re-running an `escalated` work item runs no agent and exits non-zero.
- **Suffixes fit the length limit.** A collision suffix (`-2`) counts toward the 40 characters, so the base id is cut shorter at a word boundary.
- **Ledger tests need Postgres.** `pnpm check` requires `pnpm db:up` locally, and CI runs a Postgres service container. The tests fail rather than skip when the database is missing.

## Risks

- Subscription-mode costs are estimates only. The ledger stores tokens, so the cost can be recomputed later.
- Pushing with the owner's token in M1 means the agent's work is attributed to the owner. Acceptable for M1; replaced by the GitHub App in M2.
