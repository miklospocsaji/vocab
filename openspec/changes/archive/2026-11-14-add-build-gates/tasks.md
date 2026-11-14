# Tasks

Build step M3.1. The gates are tested against small fixture worktrees under `factory/gates/test/fixtures/`, each a minimal pnpm workspace with an `app/` package, run with the repo's own pinned tools. No agent, ledger or cloud resource is involved.

## Step M3.1: Gates

### App packages and schema

- [x] 1.1 Create the empty packages `app/domain` (`@vocab/domain`) and `app/contracts` (`@vocab/contracts`, with `zod` pinned exactly), each with `package.json`, `tsconfig.json`, `src/index.ts` and an empty `test/`. Check that `pnpm check` stays green and that `pnpm typecheck` covers them.
- [x] 1.2 Failing tests for the `gates-result` schema in `factory/artifacts`: a result with every check passes; an unknown check name, an `output` over 16 KB, or a missing `passed` is rejected.
- [x] 1.3 Write `factory/artifacts/src/gates-result.ts` and register it in `resultSchemas`.

### Checks

- [x] 1.4 Failing tests for `src/vitest-report.ts` against JSON reports produced by the pinned Vitest from fixture files: a passing test, an assertion failure, a thrown error inside a test, a missing import, and a syntax error. Pin the report fields the red check reads.
- [x] 1.5 Write `src/vitest-report.ts`.
- [x] 1.6 Failing tests for `src/coverage.ts` and `src/redact.ts`. Scenarios:
  - Scenario without a test fails coverage
  - Coverage checks only the given scenarios
  - Long output is cut

  Also: titles inside `describe` blocks are covered; a title that only appears in a comment is not, when a report exists; secrets shorter than 8 characters are not replaced.
- [x] 1.7 Write `src/coverage.ts` and `src/redact.ts`.

### Runner and CLI

- [x] 1.8 Failing tests for `runGates` against fixture worktrees. Scenarios:
  - Green gates pass on a finished task
  - Every failing check is reported
  - Assertion failures pass the red gate
  - A test that cannot load fails the red gate
  - A passing new test fails the red gate
  - A broken existing test fails the red gate
  - Gate output never holds the API key
  - Gates run without a ledger

  Also: every check runs with only the fixed environment (a probe test prints its environment); the result parses with `GatesResult`.
- [x] 1.9 Write `src/checks.ts`, `src/run.ts` and `src/cli.ts`, and the root script `pnpm gates`.
- [x] 1.10 Run `pnpm gates coverage --change add-build-gates --tests factory` by hand and record the result here.
  - 2026-11-09: passed, all 10 scenarios of the change covered by tests under `factory/` (`"missing": []`, exit 0).
