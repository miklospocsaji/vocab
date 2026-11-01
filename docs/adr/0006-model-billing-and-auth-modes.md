# 0006 Model billing and auth modes

Status: accepted (2026-10-27; owner decision of 2026-10-27)

## Context

Agent roles run on the Claude Agent SDK, which authenticates in one of two ways:
- with an Anthropic API key (`ANTHROPIC_API_KEY`), billed per token
- with a Claude subscription login (an OAuth token), which draws on the subscription's Agent SDK credit

M1 runs every role locally on the owner's laptop. From M2, roles run unattended in Fargate. Subscription runs report no exact price per call. The SDK's `total_cost_usd` and `modelUsage` are estimates in both modes. The ledger must still show cost per role, per task and per work item (brief, section 4).

## Decision

- Local runs (M1) use subscription auth, through `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. The token lives in the git-ignored `.env.local`, never in the repo, prompts or logs. The interactive `claude` login is not used, so tests can point `HOME` and `CLAUDE_CONFIG_DIR` at throwaway directories.
- Cloud runs (M2 onwards) use an Anthropic API key from Secrets Manager, injected per task.
- Each role config has `authMode: api-key | subscription`. The runner builds the SDK child's environment explicitly:
  - it passes only the credential for the configured mode
  - it scrubs every inherited `ANTHROPIC_*` and `CLAUDE_CODE_*` variable, so a parent Claude Code session or a stray key cannot change the mode
- The runner verifies the mode from the init message's `apiKeySource`. A mismatch fails the attempt with `auth-mode-mismatch` before any tool runs, and the work item escalates without a retry.
- The ledger records, per attempt:
  - the auth mode the SDK reported
  - the token counts per message, including cache reads and writes
  - the SDK's estimated cost in USD

  Cost is always an estimate. Tokens are kept so cost can be recomputed when prices change.
- Budgets (`maxBudgetUsd` per attempt, and later per work item) apply to the estimate in both modes.

## Alternatives

- **API key everywhere:** exact billing from day one, but M1 experiments would cost money that the subscription already covers.
- **Subscription everywhere:** no API bill, but unattended cloud runs on a personal subscription login are fragile (token expiry, interactive re-login) and tie the factory to one person's account.
- **Trusting the configured mode without checking:** simpler, but an inherited `ANTHROPIC_API_KEY` would silently switch a local run to paid billing.

## Consequences

- Local and cloud cost figures are comparable only as estimates. The benchmark (M7) compares tokens as well as dollars.
- The setup token expires. When it does, local runs fail at once with an auth error instead of falling back to another mode.
- Moving a role between modes is a one-line config change.
