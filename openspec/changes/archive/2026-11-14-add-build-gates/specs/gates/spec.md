## ADDED Requirements

### Requirement: Gates report a typed result
The gates runner SHALL run in one of two modes for one task of a change, `red` or `green`, and SHALL return a result that passes the `gates-result` schema: the mode, the change id, the task id, whether all checks passed, and for each check its name, whether it passed, its exit code, its duration and either its output or the scenarios it found missing. The runner SHALL run every check of the mode even after one fails, so the result holds all the evidence.

#### Scenario: Green gates pass on a finished task
- **WHEN** the green gates run for a task whose tests pass, in a worktree where typecheck, lint, strict validation and coverage also pass
- **THEN** the result passes the `gates-result` schema, its overall result is passed, and it lists the checks `typecheck`, `lint`, `unit`, `spec` and `coverage`, each passed

#### Scenario: Every failing check is reported
- **WHEN** the green gates run in a worktree with both a lint error and a failing test
- **THEN** the overall result is failed, and both `lint` and `unit` are reported failed with output naming the file or test, while the other checks still ran

### Requirement: New tests fail for the right reason
In `red` mode, the gates SHALL pass only if typecheck and lint pass, at least one test names each of the task's scenarios, every such test fails while it runs (not while its file loads), and every other test passes. A test file that fails to load, for example on a missing module or a syntax error, SHALL fail the red gate.

#### Scenario: Assertion failures pass the red gate
- **WHEN** the red gate runs for a task whose new tests import an existing stub and fail on an assertion or on the stub's "not implemented" error
- **THEN** the red gate passes

#### Scenario: A test that cannot load fails the red gate
- **WHEN** a new test imports a module that does not exist
- **THEN** the red gate fails, and its output names the test file and the missing module

#### Scenario: A passing new test fails the red gate
- **WHEN** a test naming one of the task's scenarios already passes
- **THEN** the red gate fails, and its output names that test

#### Scenario: A broken existing test fails the red gate
- **WHEN** the new tests fail as required, but a test of another task now fails
- **THEN** the red gate fails, and its output names that test

### Requirement: Every scenario has a test
The coverage check SHALL read the scenario titles from the change's delta specs and SHALL report every title, from all of them or from a given subset, that no test name under `app/` contains verbatim as `Scenario: <title>`. Coverage SHALL fail when any title is missing.

#### Scenario: Scenario without a test fails coverage
- **WHEN** a change's delta spec has a scenario "Re-import adds only new lookups" and no test under `app/` names it
- **THEN** coverage fails, and its result lists "Re-import adds only new lookups" as missing

#### Scenario: Coverage checks only the given scenarios
- **WHEN** coverage runs with a subset of the change's scenario titles, all of which have tests, while other scenarios of the change have none yet
- **THEN** coverage passes

### Requirement: Gate output is bounded and redacted
Each check's output in the result SHALL be at most 16 KB, keeping its end, and SHALL have every secret value the runner was given replaced with `[redacted]`.

#### Scenario: Gate output never holds the API key
- **WHEN** a failing test prints the value of the API key the runner was given
- **THEN** the `unit` check's output contains `[redacted]` in its place, and no field of the result contains the key

#### Scenario: Long output is cut
- **WHEN** a check prints 1 MB of output
- **THEN** that check's output in the result is at most 16 KB and ends with the check's last line

### Requirement: Gates run without the factory's services
The gates SHALL run the tests under `app/` only, and SHALL need no ledger, network access or factory credentials.

#### Scenario: Gates run without a ledger
- **WHEN** the green gates run with no `FACTORY_DATABASE_URL` and no credentials in the environment
- **THEN** the `unit` check runs the app's tests only, and no factory test is reported
