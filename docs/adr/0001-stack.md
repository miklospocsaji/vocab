# 0001 Stack and toolchain

Status: accepted (2026-10-27; split by content on 2026-11-14, when the repository became app-only)

## Context

The app is one strict TypeScript monorepo: a React PWA, a Lambda API, pure domain logic and its own infrastructure. Some toolchain details had drifted by October 2026. Node 22 enters end of life in April 2027. TypeScript 7 (the native compiler) is `latest`, but typescript-eslint supports only TypeScript `<6.1`.

## Decision

- Node 24 LTS, enforced by `.nvmrc` and `engines`. Lambda uses `nodejs24.x`.
- TypeScript 6.0, `strict`, ESM with `module`/`moduleResolution` `NodeNext`. `erasableSyntaxOnly` is on so Node can run `.ts` scripts directly with built-in type stripping, no loader.
- pnpm workspaces over `app/*`. `packageManager` pins pnpm, and dependencies are pinned to exact versions. Packages are created only when the work needs them.
- ESLint 10 flat config with typescript-eslint (type-aware rules).
- Frontend: React + Vite PWA, responsive for desktop and mobile, served from S3 + CloudFront.
- Backend: API Gateway + Lambda, with Postgres on Aurora Serverless v2.
- Auth: Amazon Cognito.
- zod 4 for every API payload, contract and config.
- Vitest for unit tests and Playwright for e2e.
- AWS CDK v2 for the app's stacks, in eu-central-1.
- `pnpm check` is the single entry point for the gates: typecheck, lint, unit tests, `openspec validate --all --strict`.

## Alternatives

- Node 22: it is supported, but would force a runtime migration mid-project.
- TypeScript 7 with oxlint and tsgolint: a much faster typecheck, but a smaller lint rule set and younger tooling. Revisit when typescript-eslint supports TypeScript 7.
- Biome instead of ESLint: fast and simple, but no type-aware rules.

## Consequences

- One known upgrade ahead (TypeScript 7); it is isolated to devDependencies and lint config.
- Scripts can only use erasable TypeScript syntax: no enums, no namespaces, no parameter properties.
