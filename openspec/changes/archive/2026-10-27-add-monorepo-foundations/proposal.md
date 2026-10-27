# Proposal

## Why

Milestone M0 needs one command that tells a human, Claude Code and later the factory whether the repo is healthy. Every later milestone builds on these gates: "No gate, no progress" (brief, principle 5). Without CI, nothing stops a PR that breaks typecheck, lint, tests or the OpenSpec files.

## What Changes

- A pnpm workspace with strict TypeScript, ESLint, Vitest and the pinned OpenSpec CLI.
- `pnpm check` runs typecheck, lint, unit tests and `openspec validate --all --strict`, and fails if any of them fails.
- The Node version is enforced: installing with anything other than Node 24 is refused.
- A GitHub Actions workflow runs `pnpm check` on every pull request and on every push to `master`.
- `CLAUDE.md` lists the commands, the repo map and the conventions.

Out of scope:
- the scenario-coverage gate (M3)
- `gates.json` output (M3)
- e2e tests, preview deploys and QA gates (M4)
- branch protection settings on GitHub (the owner configures them)

## Capabilities

### New Capabilities
- `gates`: the deterministic checks that decide whether a change may progress, and where they run.

### Modified Capabilities

## Impact

- New root files: `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`, `.nvmrc`, `.github/workflows/ci.yml`, `CLAUDE.md`.
- Dev dependencies: typescript 6.0.3, eslint 10, typescript-eslint 8, vitest 5, @fission-ai/openspec 1.15.0 (all pinned exactly).
- No runtime code and no AWS resources.
