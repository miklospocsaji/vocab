# Proposal

## Why

M3's build loop (brief, section 3) needs deterministic gates that decide whether one plan task is done, and that produce the evidence a failed attempt is retried and classified with. "No gate, no progress" (principle 5) holds only if the checks are plain code with a typed result. The brief already names that result `gates.json` (section 3, artifacts table) and the scenario-coverage gate (ADR 0004). This change is build step M3.1: the gates themselves, runnable locally, before any role or state uses them.

## What Changes

- A new package `factory/gates` (`@vocab/factory-gates`) with one entry point, `runGates({ worktree, changeId, task, mode })`, and the CLI `pnpm gates <red|green|coverage> …` for running them by hand.
- Two modes, for the two moments in a task:
  - **red**, after the test author: typecheck and lint pass, every test naming one of the task's scenarios exists and fails at run time, not at load, and every other test still passes.
  - **green**, after the implementer: typecheck, lint, the app's unit tests, `openspec validate <id> --strict`, and scenario coverage for the tasks done so far.
- **Scenario coverage:** every `#### Scenario:` title in the change's delta specs, or in the given subset, appears verbatim as `"Scenario: <title>"` in a test name under `app/`.
- **`gates.json`:** a zod schema in `factory/artifacts` for the result: mode, task, overall pass, and per check its name, pass, exit code, duration, and bounded, redacted output or the missing scenarios.
- Gate output is cut to a fixed size and has every known secret value replaced before it is returned.
- Gates run only the app's tests (`app/**`), so they need no ledger, network or factory credentials.
- Empty `app/domain` and `app/contracts` packages, so the gates have the app layout to run against and the M3 roles have a place to write.

Out of scope:
- where the gates run in a work item (the build container, `add-build-roles`) and what the loop does with the result (`add-build-loop`)
- e2e, preview, QA and contract-compatibility gates (M4)
- adding the coverage gate to `pnpm check` for the factory's own changes; it runs by hand on the M3 changes before they are archived
- detecting tests that fake their own result (see design, "Risks")

## Capabilities

### New Capabilities

### Modified Capabilities
- `gates`: the red and green gates for a build task, scenario coverage, and the `gates.json` result.

## Impact

- New package `factory/gates`; new schema `gates-result` in `factory/artifacts`; root script `pnpm gates`.
- New empty packages `app/domain` (`@vocab/domain`) and `app/contracts` (`@vocab/contracts`, depending on zod), included in the root typecheck and the `unit` Vitest project.
- No new dependency beyond what the repo pins: the gates call `tsc`, `eslint`, `vitest` (with its JSON reporter) and `openspec` from the workspace.
- No infrastructure or cost.
- Tagged `medium`: one capability, and a new artifact schema.
