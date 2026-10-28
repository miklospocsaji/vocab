# Tasks

Runs before `add-local-proposal-run`. The runner records through a `Recorder` interface; an in-memory recorder serves these tests and the ledger implements it in `add-local-proposal-run`.

Unit tests need no model and run in `pnpm check`. Live tests (`*.live.test.ts`) start real Agent SDK sessions with small budgets. They run only through `pnpm test:live`, never in CI.

## 1. Decisions, packages and spike

- [x] 1.1 ADR 0006 "Model billing and auth modes" (owner decision of 2026-10-27): local runs use subscription auth (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`), cloud runs use `ANTHROPIC_API_KEY`. Selected per role config, verified against the SDK's `apiKeySource`, and recorded per attempt. In subscription mode cost is an estimate, so tokens are stored too.
- [x] 1.2 Create the `factory/roles` (`@vocab/factory-roles`) and `factory/artifacts` (`@vocab/factory-artifacts`) packages, each with a typecheck script and a Vitest project. Add `@anthropic-ai/claude-agent-sdk`, `zod`, `yaml` and `minimatch`, pinned exactly. Add a `live` Vitest project for `*.live.test.ts` and a root `pnpm test:live` script, and exclude live tests from `pnpm test`.
- [x] 1.3 Spike, with no production code: on this Linux host, with the pinned SDK, check four things:
  - `sandbox` confines Bash writes (bwrap and socat are installed)
  - which `apiKeySource` values the init message reports for an OAuth token and for an API key
  - how `dontAsk` denials appear in the result (`permission_denials`)
  - the result subtypes for the turn cap and the budget

  Record the findings in `design.md`. If the sandbox does not work, write an ADR for the bind-mount fallback before task 5.

## 2. Role config

- [ ] 2.1 Failing tests for loading role configs. Scenario: Invalid config is refused, covering three cases: writable paths missing, an unknown result schema, and the prompt file missing.
- [ ] 2.2 Write `factory/roles/src/config.ts`:
  - the zod schema for `<role>.yaml`
  - `loadRole(name)`, which also reads `.claude/agents/<role>.md` and strips its frontmatter
  - a result-schema registry in `factory/artifacts`
  - a `{changeId}` placeholder in writable globs, filled in per work item

## 3. Path guard (pure, no model)

- [ ] 3.1 Failing unit tests for the `PreToolUse` hook on a temp worktree. Scenarios:
  - Write outside the allowed paths is denied
  - Path traversal is denied
  - Symlink escape is denied

  Also cover a new file in a directory that does not exist yet, dotfiles such as `.openspec.yaml`, and `NotebookEdit`'s `notebook_path`.
- [ ] 3.2 Write `factory/roles/src/guard.ts`. It resolves the target against the worktree, then takes the realpath of the nearest existing ancestor, matches the writable globs with `minimatch` (`dot: true`), and denies anything outside the worktree. The deny reason lists the allowed globs.

## 4. Prompt builder (pure, no model)

- [ ] 4.1 Failing tests. Scenario: Issue text is fenced as data, prompt half:
  - the issue body sits inside a fence that its own content cannot close
  - the fence is labelled as untrusted data
  - the retry evidence section appears only on retries
  - the input type has no field for a transcript
- [ ] 4.2 Write `factory/roles/src/prompt.ts`.

## 5. Runner (stubbed SDK, no model)

- [ ] 5.1 Failing tests against an injected `query` stub:
  - the exact SDK options:
    - `tools` and `allowedTools`
    - `permissionMode: "dontAsk"` and `settingSources: ["project"]`
    - `skills`, `maxTurns` and `maxBudgetUsd`
    - `outputFormat` and the hook
    - `sandbox` per ADR 0007: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, and `denyWrite` on the whole worktree
    - no `Agent` tool
  - the explicit child env:
    - inherited `CLAUDE_CODE_*` and `ANTHROPIC_*` variables are scrubbed
    - only the configured mode's credential is passed
    - `OPENSPEC_TELEMETRY=0` is set
    - the factory's `node_modules/.bin` is on `PATH`
  - every message goes to the `Recorder`
  - result subtypes map to failure reasons
  - the error the SDK throws after an error result is not reported as a second failure
  - an invalid `structured_output` gives `invalid-result`
  - a failed `openspec validate <id> --strict` gives `invalid-change`, with its JSON output as evidence

  Scenarios:
  - Turn cap ends the attempt
  - Budget ends the attempt
  - Mismatched auth mode fails fast (the query is aborted on the init message)
- [ ] 5.2 Write `factory/roles/src/runner.ts` (`runRole(role, item, evidence?)`), the `Recorder` interface, and `AttemptFailed { reason, evidence }`.

## 6. Proposal-author role

- [ ] 6.1 Failing tests:
  - the `ProposalResult` schema: the change id, capabilities limited to the eight in ADR 0004, the complexity enum and open questions
  - `proposal-author.yaml` loads
  - its globs allow `proposal.md`, `specs/**/spec.md` and `.openspec.yaml` in its change folder, and deny `design.md`, `tasks.md` and anything outside the folder
- [ ] 6.2 Write `factory/artifacts/src/proposal-result.ts`, `factory/roles/proposal-author.yaml` and `.claude/agents/proposal-author.md`. The config:
  - model `claude-opus-5-5`, 30 turns, `maxBudgetUsd` 3, auth mode `subscription`
  - Bash allowlist: `openspec validate`, `show`, `list` and `instructions` only, with the factory's `node_modules/.bin` on `PATH`
  - `WebFetch` pre-approved for any URL (owner decision, see `design.md`)
  - no skills

## 7. Live boundary tests (`pnpm test:live`)

Each test runs a small throwaway role on Haiku in a temp worktree, with a budget of about $0.10. Each test asserts that the model actually attempted the forbidden action, so a test where nothing was attempted fails rather than passing vacuously.

- [ ] 7.1 Live write-boundary tests. Scenarios:
  - Unlisted tool is unavailable
  - Write outside the allowed paths is denied
  - Path traversal is denied
  - Symlink escape is denied
- [ ] 7.2 Live Bash, isolation and limit tests. Scenarios:
  - Non-allowlisted command is denied
  - Bash cannot write outside the role's paths
  - User settings do not leak (`CLAUDE_CONFIG_DIR` and `HOME` point at a temp dir with permissive settings)
  - Issue text is fenced as data (the injection attempt)
  - Turn cap ends the attempt
  - Budget ends the attempt
  - Mismatched auth mode fails fast
- [ ] 7.3 Live proposal-author run on Opus against a canned issue in a temp worktree of this repo. Scenario: Proposal author output is complete.
