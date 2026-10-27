# Tasks

## 1. Workspace

- [x] 1.1 Root `package.json` (engines, packageManager, scripts), `pnpm-workspace.yaml` with `engineStrict`, `.nvmrc` (Scenario: Wrong Node version is refused)
- [x] 1.2 `tsconfig.base.json` (strict, NodeNext, erasable syntax only), `eslint.config.js`, `vitest.config.ts` with workspace projects
- [x] 1.3 `pnpm check` chaining typecheck, lint, test and `openspec validate --all --strict` (Scenarios: All gates pass, A type error fails the check, An invalid OpenSpec change fails the check)

## 2. CI

- [x] 2.1 `.github/workflows/ci.yml` running `pnpm install --frozen-lockfile` and `pnpm check` on pull requests and pushes to master (Scenarios: Pull request gets a status check, Out-of-date lockfile fails CI)

## 3. Docs

- [x] 3.1 `CLAUDE.md` with commands, repo map and conventions

## 4. Verification

- [x] 4.1 Demonstrate each failing scenario once on a throwaway commit or locally, and record the evidence in the PR description (automated scenario coverage starts in M3)
