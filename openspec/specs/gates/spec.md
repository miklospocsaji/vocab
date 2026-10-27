# gates Specification

## Purpose
The deterministic checks that decide whether a change may progress (typecheck, lint, tests, OpenSpec validation and, later, scenario coverage, e2e and QA), and where they run: locally through `pnpm check` and in CI on every pull request.

## Requirements

### Requirement: Single check command
The repository SHALL provide `pnpm check`, which runs typecheck, lint, unit tests and strict OpenSpec validation of all changes and specs, in that order. It SHALL exit non-zero as soon as any of them fails.

#### Scenario: All gates pass
- **WHEN** a developer runs `pnpm check` on a tree where typecheck, lint, tests and OpenSpec validation all pass
- **THEN** the command exits with code 0

#### Scenario: A type error fails the check
- **WHEN** a tracked TypeScript file contains a type error and `pnpm check` runs
- **THEN** the command exits non-zero and its output names the file with the error

#### Scenario: An invalid OpenSpec change fails the check
- **WHEN** a change under `openspec/changes/` fails `openspec validate --strict` and `pnpm check` runs
- **THEN** the command exits non-zero and its output names the invalid change

### Requirement: Enforced toolchain versions
The repository SHALL pin the Node major version and the package manager version, and SHALL refuse to install dependencies with any other Node major version.

#### Scenario: Wrong Node version is refused
- **WHEN** a developer runs `pnpm install` with a Node major version other than 24
- **THEN** the install fails with a message naming the required Node version

### Requirement: Gates run in CI
Every pull request and every push to `master` SHALL run `pnpm check` in GitHub Actions, using the Node version from `.nvmrc` and the committed lockfile without modification. The run's result SHALL be reported as a status check on the commit.

#### Scenario: Pull request gets a status check
- **WHEN** a pull request is opened or updated
- **THEN** a CI run executes `pnpm check` and reports success or failure as a status check on the head commit

#### Scenario: Out-of-date lockfile fails CI
- **WHEN** a pushed commit changes a `package.json` dependency without updating `pnpm-lock.yaml`
- **THEN** the CI run fails at dependency installation
