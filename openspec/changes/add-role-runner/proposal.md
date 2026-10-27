# Proposal

## Why

Every agent step in the factory goes through one role runner. Boundaries are a security property, enforced by code rather than by prompts (brief, principles 2 and 4, and section 4). The runner is where they are enforced: which tools a role has, what it may write, which commands it may run, which settings and skills it sees, and how much it may spend. M1 needs the runner and its first role, the proposal author.

## What Changes

- Role configs in `factory/roles/<role>.yaml`, validated with zod: model, tools, pre-approved calls, writable globs, Bash allowlist, skills, turn cap, budget, result schema id and auth mode.
- A role runner wrapping the Agent SDK `query()`:
  - tool restriction and `dontAsk` permissions
  - project-only settings and a skill filter
  - a path guard hook and the sandbox for Bash
  - structured output validated with zod
  - every message streamed to the ledger
- The prompt for each role is built only from artifacts. Untrusted content (issue text) is fenced and labelled as data.
- The proposal-author role: its config, its prompt in `.claude/agents/proposal-author.md`, and its zod result schema in `factory/artifacts/`.
- Two auth modes selected by config: `api-key` and `subscription`. The mode is verified from the SDK's reported `apiKeySource`.

Out of scope:
- the other nine roles (M3 and M4)
- running roles in Fargate (M2)
- per-work-item budgets across roles (M6); M1 enforces a per-attempt budget

## Capabilities

### New Capabilities
- `roles`: how an agent role is defined and run, and the boundaries every role is held to.

### Modified Capabilities

## Impact

- New packages: `factory/roles` and `factory/artifacts`.
- New dependency: `@anthropic-ai/claude-agent-sdk`, pinned exactly.
- New file `.claude/agents/proposal-author.md`.
- Tagged `large` because it is the factory's security boundary.
