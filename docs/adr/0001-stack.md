# 0001 Stack and toolchain

Status: accepted (2026-10-27)

## Context

The brief (section 5) fixes the overall stack: one strict TypeScript monorepo for the factory, the app and the infrastructure, deployed with AWS CDK. Some details had drifted by October 2026. Node 22 enters end of life in April 2027. TypeScript 7 (the native compiler) is `latest`, but typescript-eslint supports only TypeScript `<6.1`. The Agent SDK is still 0.x and publishes several releases a week.

## Decision

- Node 24 LTS, enforced by `.nvmrc` and `engines`. Lambda uses `nodejs24.x`.
- TypeScript 6.0, `strict`, ESM with `module`/`moduleResolution` `NodeNext`. `erasableSyntaxOnly` is on so Node can run `.ts` scripts directly with built-in type stripping, no loader.
- pnpm workspaces. `packageManager` pins pnpm. Packages are created only when a milestone needs them.
- ESLint 10 flat config with typescript-eslint (type-aware rules).
- Vitest for unit tests and Playwright for e2e and QA. zod 4 for every JSON result, payload, contract and config; `z.toJSONSchema` feeds Agent SDK structured output.
- `@anthropic-ai/claude-agent-sdk` and `@fission-ai/openspec` are pinned to exact versions. Upgrades are deliberate changes that re-run the gates (and, from M7, the benchmark).
- AWS CDK v2. `aws-cdk-lib` and the `aws-cdk` CLI are versioned separately and pinned separately.
- `pnpm check` is the single entry point for the gates: typecheck, lint, unit tests, `openspec validate --all --strict`.

## Alternatives

- Node 22 as the brief first said: it is supported, but would force a runtime migration mid-project.
- TypeScript 7 with oxlint and tsgolint: a much faster typecheck, but a smaller lint rule set and younger tooling. Revisit when typescript-eslint supports TypeScript 7.
- Biome instead of ESLint: fast and simple, but no type-aware rules.

## Consequences

- One known upgrade ahead (TypeScript 7); it is isolated to devDependencies and lint config.
- Scripts can only use erasable TypeScript syntax: no enums, no namespaces, no parameter properties.
- SDK upgrades are explicit, so behaviour changes in the SDK show up as a diff and a gate run.
