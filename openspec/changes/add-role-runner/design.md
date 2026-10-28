# Design

## Components

- `factory/roles/config.ts`: the zod schema for `<role>.yaml`. Fields:
  - `name`, `model`
  - `tools`: the role's whole tool set, passed to SDK `tools`
  - `allow`: pre-approved calls such as `Bash(pnpm exec openspec validate:*)`, passed to SDK `allowedTools`
  - `writable`: globs relative to the worktree
  - `skills`, `maxTurns`, `maxBudgetUsd`, `resultSchema`, `authMode`
- `factory/roles/runner.ts`: `runRole(role, item, evidence?)`, following the sketch in the brief (section 4). The SDK options it sets:
  - `tools`, `allowedTools`, `permissionMode: "dontAsk"`
  - `settingSources: ["project"]`, `skills`
  - `maxTurns`, `maxBudgetUsd`
  - `outputFormat` from `z.toJSONSchema`
  - the `PreToolUse` path guard on `Edit|Write|NotebookEdit`
  - `sandbox` with the whole worktree read-only for Bash (ADR 0007), so files change only through Edit and Write under the path guard
  - `systemPrompt` from `.claude/agents/<role>.md`, with the frontmatter stripped
- `factory/roles/prompt.ts`: builds the prompt from artifacts and fences untrusted text.
- `factory/artifacts/proposal-result.ts`: the zod schema `{ changeId, capabilities[], complexity, summary, openQuestions[] }`.

## Decisions

- **Enforcement has three layers:**
  1. SDK tool restriction and `dontAsk`
  2. the path hook
  3. the sandbox for Bash

  The prompt never counts as enforcement. Each layer gets a test that tries to bypass it.
- **The auth mode is verified, not trusted.** The init message's `apiKeySource` is compared with the configured mode. `ANTHROPIC_API_KEY` means `api-key`; `none` with an OAuth token means `subscription`.
- **Cost is taken from the result message.** The runner reads `modelUsage` and `total_cost_usd` and stores tokens too, so cost can be recomputed later.
- **The proposal author may fetch any URL (owner decision, 2026-10-27).** `WebFetch` is in both `tools` and `allowedTools`, with no domain filter. In M1 nothing restricts egress; from M2 the worker's egress proxy limits destinations. The path guard and Bash allowlist still apply, so fetched content can steer the proposal's text but not where the role writes.
- **The Agent SDK is pinned to 0.3.310,** the version the brief's runner sketch was checked against. Moving to a later version is a separate, deliberate upgrade.
- **Subscription auth comes from `CLAUDE_CODE_OAUTH_TOKEN`** (from `claude setup-token`), never from the interactive login, so tests can replace `HOME` and `CLAUDE_CONFIG_DIR`.

## Spike findings (task 1.3, SDK 0.3.310, Linux with bwrap)

All runs used Haiku, each with a budget under $0.01.

- **Auth:** a `CLAUDE_CODE_OAUTH_TOKEN` run reports `apiKeySource: "none"`. Per the SDK types, an API key reports `"ANTHROPIC_API_KEY"`. That case is untested because no key exists locally.
- **`dontAsk` denials:** a denied call returns an error tool result to the model and is listed in `result.permission_denials` with its tool input. The ledger can therefore record denials from the result message. `PreToolUse` hook denials are not in that list, so the runner records those itself.
- **Turn cap and budget:** the SDK yields a `result` with subtype `error_max_turns` or `error_max_budget_usd`, including cost, and then the iterator throws `Error("Claude Code returned an error result: …")`. The runner classifies the attempt from the result message and ignores the throw that follows.
- **Sandbox:** it works on this host, and Bash writes outside the worktree fail with "Read-only file system". But it cannot express the role's writable globs:
  - Inside the worktree everything is writable by default, and `allowWrite` adds paths but never narrows them.
  - `denyWrite` takes exact paths, not globs.
  - A `denyWrite` on a parent beats an `allowWrite` on a child.

  The runner therefore makes the whole worktree read-only for Bash (ADR 0007). Files change only through Edit and Write, under the path guard.
- **OpenSpec in the sandbox:** `openspec validate --all --strict` runs fine with the worktree read-only. The CLI announces anonymous telemetry, so the runner sets `OPENSPEC_TELEMETRY=0` for roles. The package scripts and CI should set it too.

## Risks

- **SDK 0.x churn.** The SDK is pinned exactly, and an upgrade re-runs the boundary tests.
- **Sandbox support in Fargate.** It is verified locally (see the spike findings); it needs verifying again in M2 in the worker image. `failIfUnavailable` makes a missing sandbox fail the attempt instead of running unconfined.
- **Boundary tests need a live model.** They run against real sessions with small budgets. The path guard and prompt builder also get pure unit tests that need no model.
