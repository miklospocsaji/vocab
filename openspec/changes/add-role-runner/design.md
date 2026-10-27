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
  - `sandbox` with filesystem writes limited to `writable`
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

## Risks

- **SDK 0.x churn.** The SDK is pinned exactly, and an upgrade re-runs the boundary tests.
- **Sandbox support on Linux and in Fargate.** It needs verifying in M1 locally and in M2 in the worker image. If it is unavailable, the fallback is a read-only bind mount of everything outside the writable paths.
- **Boundary tests need a live model.** They run against real sessions with small budgets. The path guard and prompt builder also get pure unit tests that need no model.
