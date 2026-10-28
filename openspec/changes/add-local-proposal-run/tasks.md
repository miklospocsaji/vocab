# Tasks

Depends on `add-role-runner` (sections 1–6). Orchestrator tests use an in-memory `FakeForge`, a scripted fake role runner, a temp bare git repo as the remote, and the real Postgres ledger. The real GitHub, the real model and the real issue are used only in section 8.

## 1. Packages and local Postgres

- [ ] 1.1 Create the packages `factory/ledger`, `factory/forge`, `factory/orchestrator` and `factory/cli`, each with a typecheck script and a Vitest project. Add `pg` and `@octokit/rest`, pinned exactly. Then:
  - Add `docker-compose.yml` with Postgres on a non-default port.
  - Add root scripts `db:up` and `factory` (`node factory/cli/src/main.ts`).
  - Ledger-backed tests read `FACTORY_DATABASE_URL`. If it is unset they fail with a clear message, never skip, so `pnpm check` needs `pnpm db:up` first.
  - CI gets a Postgres service container.

## 2. Ledger

- [ ] 2.1 Failing tests against Postgres, with one schema per test file:
  - migrations apply once and are idempotent
  - a work item is created and found by issue number
  - `change_id` is unique
  - attempts open and close with an outcome and failure reason
  - token usage is extracted from SDK messages
  - a work item's estimated cost is the sum over its attempts
- [ ] 2.2 Write:
  - `factory/ledger/migrations/0001_init.sql`, following the data model in `design.md`, plus a `schema_migrations` table
  - the migration runner
  - typed queries
  - a `LedgerRecorder` that implements the role runner's `Recorder`

## 3. Change ids (pure)

- [ ] 3.1 Failing tests. Scenarios:
  - Leading verb is kept
  - Colliding id gets a suffix

  Also cover:
  - "Import Kindle vocab.db" gives `add-import-kindle-vocab-db`
  - punctuation and accents collapse to single hyphens
  - the 40-character cut falls at a word boundary
  - the suffix stays within 40 characters
- [ ] 3.2 Write `deriveChangeId(title, isTaken)` in `factory/orchestrator/src/change-id.ts`. An id is taken if it exists in the ledger or as a remote branch.

## 4. Forge

- [ ] 4.1 Failing tests for `GitHubForge`, with an injected `fetch` and no network: `getIssue`, `comment`, `createBranch` (from the default branch head; it is a no-op if the branch exists) and `branchExists`. Add a `FakeForge` test helper with the same contract and run it against shared contract tests.
- [ ] 4.2 Write the `Forge` interface, `GitHubForge` and `FakeForge`. Locally the token comes from `gh auth token` at CLI start-up and is never logged. `pushBranch` pushes with the token through a git credential helper, never in the remote URL.

## 5. Worktrees and git

- [ ] 5.1 Failing tests against a temp bare remote:
  - a worktree is created under `$FACTORY_HOME/worktrees/<change-id>` (default `~/.factory`) and reused on re-run
  - a commit includes only the change folder
  - the push reaches the remote
- [ ] 5.2 Write `factory/orchestrator/src/git.ts`.

## 6. Intake and Proposal handlers

- [ ] 6.1 Failing tests for Intake. Scenarios:
  - Work item and branch are created
  - Issue without a requirement is rejected
- [ ] 6.2 Write the `intake` handler `(ctx, item) => Promise<Transition>`.
- [ ] 6.3 Failing tests for Proposal, with the fake role runner. Scenarios:
  - Valid proposal is committed and pushed
  - Invalid proposal is retried with evidence
  - Three failed attempts escalate

  Also: an `auth-mode-mismatch` failure escalates at once, without a retry.
- [ ] 6.4 Write the `proposal` handler:
  - scaffold the change with `openspec new change <id>`
  - run `runRole` with up to 3 attempts, recording each attempt in the ledger with its reason and auth mode
  - on retries, pass the `openspec validate --json` output as evidence
  - commit and push the change folder

## 7. Run loop and CLI

- [ ] 7.1 Failing tests for the local run loop. Scenarios:
  - Summary comment is posted
  - Re-run after completion does nothing
  - Cost is visible after a run

  Also: re-running an `escalated` item runs no agent and exits non-zero.
- [ ] 7.2 Write:
  - the local run loop (states as a string union, `--until` handling, resume by issue number)
  - the summary comment renderer
  - `factory/cli/src/main.ts` (`run --issue <n> --until proposal`), with its exit codes and real dependency wiring
  - a `pnpm factory cost --issue <n>` command that prints the work item's cost per attempt and in total

## 8. Exit run

- [ ] 8.1 Run `pnpm factory run --issue <n> --until proposal` against the owner's test issue. Confirm that:
  - the branch has a change that passes `openspec validate --strict`
  - the issue has the summary comment
  - `pnpm factory cost` shows tokens, an estimated cost and `subscription` as the auth mode
  - a second run does nothing

  Record the results in the M1 PR description.
- [ ] 8.2 Update `CLAUDE.md` with the `db:up`, `factory` and `test:live` commands and the new packages.
