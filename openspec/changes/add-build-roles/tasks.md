# Tasks

Build step M3.2. Depends on `add-build-gates`. Unit tests run in `pnpm check` with fake SDK sessions and the local ledger. Live tests (`*.live.test.ts`, `pnpm test:live`) run real sessions on small budgets. Docker tests (`*.docker.test.ts`, `pnpm test:docker`) build the `build` target and run it. Neither runs in `pnpm check` or CI. Each live run's cost is recorded here.

## Step M3.2: Roles and the build container

### Decisions

- [ ] 2.1 Write ADR 0011 (Bash roles in a build container) and ADR 0012 (role prompts outside `.claude/agents`). Amend ADRs 0007, 0008 and 0010. Edit the brief: section 3 (the build container in the components table and the gates' location), section 4 (prompt location, `runsIn`, the Bash rules, the classifier as an Agent SDK session instead of a Messages API call), section 5 (repo layout, security) and section 8 (the owner decisions of 2026-11-08 and 2026-11-09). Show the owner the brief diff before going on.

### Prompt location and config

- [ ] 2.2 Failing tests in `factory/roles/test/config.test.ts`. Scenarios:
  - Invalid config is refused (now with `runsIn` missing as a case)
  - Config without a place to run is refused
  - No role is registered as an agent
  - Worker roles have no Bash

  Also: the prompt is read from `factory/roles/<role>.md`; a `!` exclusion makes a path unwritable; `{taskStubs}` expands to the given files.
- [ ] 2.3 Move `.claude/agents/proposal-author.md` to `factory/roles/proposal-author.md` without its frontmatter, and remove `.claude/agents/`. Extend `RoleConfigSchema`, `loadRole`, `writableFor` and the path guard's matcher. Add `runsIn: worker` to `proposal-author.yaml`. Update the worker Dockerfile, its `.dockerignore` allowlist and `image.docker.test.ts`.

### Result schemas and plan validation

- [ ] 2.4 Failing tests for the result schemas in `factory/artifacts` and for `validatePlan`. Scenarios:
  - Changes requested come with findings
  - Plan that leaves a scenario out is refused
  - Re-plan keeps finished tasks
  - Plan with a forward dependency is refused

  Also: a task id with no `tasks.md` line, an unknown scenario title, and a file outside the implementer's and test author's paths are each refused with a message naming them.
- [ ] 2.5 Write the schemas (`design-result`, `review-result`, `plan-result`, `test-result`, `implementation-result`, `classification-result`, `build-outcome`) and `factory/roles/src/plan.ts`.

### Runner boundaries

- [ ] 2.6 Failing unit tests with a fake SDK query. Scenarios:
  - Worker refuses a build role
  - Bash write outside the role's paths fails the attempt (the diff check against a temp repo where a fake session's "Bash" wrote a test file)
  - Commit made during the session is still checked
  - Ignored caches pass the diff check
  - Test author cannot change existing code
  - Implementer cannot edit a test

  Also: build roles get `sandbox: { enabled: false }` and worker roles keep ADR 0007's options; a `{taskStubs}` file that already existed fails the diff check.
- [ ] 2.7 Write `diff-check.ts`, the `container` option and the sandbox switch in `runner.ts`.

### Failure classifier

- [ ] 2.8 Failing unit tests with a fake SDK query. Scenarios:
  - Classifier labels a failed gate (the attempt, tokens and estimated cost land in the ledger)
  - Instructions in gate output are data

  Also: the session gets no tools; a reply that fails the schema fails the attempt with reason `invalid-result`. A live test (task 2.13) records the turns structured output takes, and `maxTurns` is set from it.
- [ ] 2.9 Write the `failure-classifier` config and prompt, and the classifier's prompt builder.

### Build container

- [ ] 2.10 Pin `@aws-sdk/client-s3` exactly. Failing unit tests for `FsStore`, `S3Store` (fake client) and `build.ts` with a fake runner, a temp git remote and an `FsStore`. Scenarios:
  - Build container refuses factory credentials

  Also: the outcome is written when the session fails, and when the diff check fails, with no gates run; the patch applies cleanly to the base commit; `messages.jsonl` replays through `LedgerRecorder` to the same rows as a live recording; a key with `..` is refused.
- [ ] 2.11 Write `store.ts`, `build.ts`, `build-main.ts` and the Dockerfile `build` target. Docker test (`build.docker.test.ts`): the image builds, holds no secrets, runs as non-root and has `FACTORY_CONTAINER=build`. Scenario: Worker image holds no secrets (for both targets). Record the image size and the offline install time here.

### Roles

- [ ] 2.12 Write the configs and prompts for `architect`, `design-reviewer`, `planner`, `test-author` and `implementer`, following `design.md`. Unit tests pin each config's tools, writable globs, `runsIn`, model and budget.
- [ ] 2.13 Live tests (`pnpm test:live`), each on a small fixture change in a temp repo, each under $0.50, in api-key mode. Record the cost of each here:
  - Architect output is complete
  - the design reviewer returns a result that parses (one run on a design with a planted contradiction, expected `changes-requested`)
  - the planner returns a plan that passes `validatePlan`
  - the classifier labels a fixture gate failure, recording how many turns it took
- [ ] 2.14 Live boundary tests in the build container (`pnpm test:live` through the Docker harness, like `container.live.test.ts`). Scenarios:
  - Non-allowlisted command is denied (also `pnpm lint && curl https://example.com`)
  - Build container holds only the model credential
  - Boundaries hold in the worker container (unchanged, re-run)

  Retire the old live tests "Bash cannot write outside the role's paths" and "Missing sandbox blocks Bash", whose scenarios this change removes.
- [ ] 2.15 End-to-end in Docker on a fixture change with one task, through `factory-build` and an `FsStore`: the test author's outcome passes the red gate, then the implementer's passes the green gate. Record the cost, the turns and the wall time here. This is step M3.2's exit.
- [ ] 2.16 Run `pnpm gates coverage --change add-build-roles --tests factory` and record the result.
