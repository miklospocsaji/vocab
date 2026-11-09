# Design

## Overview

The gates are deterministic code that decides whether one task is done. They run where the agent's code may run, which in M3 is the build container (`add-build-roles`), and never in the worker, which holds the factory's secrets. This change builds them as a plain library and CLI, tested locally against small fixture worktrees.

```
test author's session ──▶ runGates(mode: red)   ──▶ gates.json ──▶ next step or retry
implementer's session ──▶ runGates(mode: green) ──▶ gates.json ──▶ tick, or classifier
```

## Components

### `factory/gates` (new package `@vocab/factory-gates`)

- `src/run.ts`: `runGates({ worktree, changeId, task, mode, secrets })` returns a `GatesResult`. `task` is `{ id, scenarios }`, where `scenarios` are this task's titles. In green mode it also carries `coveredSoFar`, the titles of every task done so far, this one included. `secrets` are the values to redact.
- `src/checks.ts`: one function per check, each running one command with `spawn` (never a shell) in the worktree, keeping the end of its combined stdout and stderr, with a fixed environment: `PATH`, `HOME`, `TMPDIR`, `CI=1`, `OPENSPEC_TELEMETRY=0`, `NODE_OPTIONS` unset. Nothing else is inherited.
  - `typecheck`: `pnpm typecheck`
  - `lint`: `pnpm lint`
  - `unit`: `pnpm exec vitest run --project unit --reporter=default --reporter=json --outputFile.json=<tmp> app/`. The JSON reporter alone prints nothing, not even what a test logs, so the default reporter supplies the output.
  - `spec`: `pnpm exec openspec validate <changeId> --strict --no-interactive`
  - `coverage`: in-process; see below
- `src/vitest-report.ts`: reads Vitest's JSON report (its `testResults[]`, with `status` and `message` per file and `assertionResults[]` per test) into `{ file, loadError?, tests: [{ name, status, failure? }] }`. A file with `status: "failed"` and no assertion results, or with a message and no tests run, is a load error.
- `src/coverage.ts`: `scenarioTitles(changeDir)` parses every `specs/*/spec.md` for lines `#### Scenario: <title>`. `testNames(worktree)` collects the full test names from the Vitest report when there is one, and otherwise from a text scan of `app/**/test/**/*.test.ts` and `app/e2e/**/*.ts` for `"Scenario: <title>"` in any quote style. A title is covered when a test name contains `Scenario: <title>`.
- `src/redact.ts`: replaces each secret value (when at least 8 characters long) with `[redacted]`, then keeps the last 16 KB, cut at a line start.
- `src/cli.ts`: `pnpm gates red|green --change <id> --task <id> --scenarios <file.json>` and `pnpm gates coverage --change <id> [--tests <dir>]`. `--tests` replaces `app/` as the place to scan, so the factory's own changes, whose tests live under `factory/`, can be checked by hand; the build loop never passes it. It prints `gates.json` to stdout and exits 0 on pass, 1 on fail, 2 on bad input.

### Red mode

1. `typecheck` and `lint` must pass. The test author may add stubs of the task's source files, so the tests type-check against real signatures (`add-build-roles`).
2. `unit` runs once with the JSON reporter. The red check then reads it:
   - every scenario of the task is named by at least one test
   - each of those tests failed, in a file with no load error
   - every other test passed
   - no file has a load error

   A failure inside a test, an assertion or a thrown "not implemented", counts as "failed while it runs". A missing module, a syntax error, or an error at the top of a file is a load error.
3. It reports one extra check, `red`, with the scenarios not named, the new tests that passed, the other tests that failed, and the files that failed to load.

### Green mode

It runs `typecheck`, `lint`, `unit` (every app test must pass), `spec`, and `coverage` over `coveredSoFar`. On the last task, `coveredSoFar` holds every scenario of the change.

### `gates-result` (in `factory/artifacts`)

```ts
GatesResult = {
  mode: "red" | "green",
  changeId: string,
  taskId: string,
  passed: boolean,
  checks: Array<{
    name: "typecheck" | "lint" | "unit" | "spec" | "coverage" | "red",
    passed: boolean,
    exitCode: number | null,   // null for in-process checks
    durationMs: number,
    output?: string,           // at most 16 KB, redacted
    missing?: string[],        // coverage and red: scenario titles
    tests?: Array<{ file: string, name: string, problem: "passed" | "failed" | "load-error" | "missing" }>,
  }>,
}
```

### App packages

`app/domain` and `app/contracts` start as empty workspace packages with a `package.json`, a `tsconfig.json` extending the root one, and an empty `src/index.ts` and `test/`. The root typecheck and the `unit` project already pick up `app/*`. The roles in `add-build-roles` cannot write `package.json` or `tsconfig.json`, so these packages exist before the first work item. A work item that needs a new package or dependency escalates as `spec-ambiguity` in M3 (see `add-build-loop`).

## Decisions

- **The app's tests only.** The factory's tests need the ledger, and a work item must not change the factory (brief, section 5). `app/fixtures` has its own tests, which use only committed fixtures.
- **One Vitest run per mode.** The red check reads the same JSON report as `unit`, so there is no second run and no difference between what the two see.
- **Coverage by the full test name.** Vitest's full name includes the `describe` blocks, so `describe("import", () => it("Scenario: …"))` counts. The text scan is only for when there is no report, as with `pnpm gates coverage` run by hand.
- **Redaction by value.** The runner knows the values it must hide (the model credential in the build container). Pattern-based secret scanners would miss values with no known prefix and hide ordinary hashes.

## Risks

- **A test can fake its own result.** Code under test runs in the same container as the gates and could print a fake report or exit early. The coverage gate, the separate implementer and test author, the PR's CI run of `pnpm check` in GitHub Actions, and from M4 the reviewer are the defence. This change does not try to detect it.
- **Vitest's JSON report format.** It is not a stable API. A unit test pins the fields the red check reads, against a report produced by the pinned Vitest, so an upgrade that changes it fails the tests.
- **Stubs that type-check but break lint** (an unused parameter, for example) fail the red gate. The test author's prompt says how to write a stub that lints (`add-build-roles`).

## Contracts

No changes in `app/contracts/` beyond creating the empty package.

## Decisions that need an ADR

None. The gates follow the brief and ADR 0004; where they run is decided in `add-build-roles` (ADR 0011).
