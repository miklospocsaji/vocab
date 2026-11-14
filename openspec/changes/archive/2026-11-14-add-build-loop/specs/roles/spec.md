## ADDED Requirements

### Requirement: Build boundaries hold in Fargate
The build container's boundaries SHALL hold as a Fargate task of the build task definition, as they do in Docker.

#### Scenario: Build boundaries hold in Fargate
- **WHEN** the build boundary tests ("Non-allowlisted command is denied", "Build container holds only the model credential", "Build container refuses factory credentials") run as a Fargate task of the build task definition in api-key mode
- **THEN** they pass

### Requirement: Build roles check only the app
The test author and the implementer SHALL be allowed to run only the app's typecheck and lint (`pnpm typecheck:app`, `pnpm lint:app`) and SHALL NOT be allowed the whole repository's (`pnpm typecheck`, `pnpm lint`). Their prompts SHALL name only the app's commands.

#### Scenario: Build roles check only the app
- **WHEN** the test author's and the implementer's configs are loaded
- **THEN** their Bash allowlists hold `pnpm typecheck:app` and `pnpm lint:app` and neither `pnpm typecheck` nor `pnpm lint`, and their prompts name neither of the latter

### Requirement: Oversized files are never writable
The diff check SHALL fail an attempt that leaves a file over 10 MB anywhere in the worktree, inside the role's writable paths or not, and SHALL name the file. The patch SHALL leave such a file out, so making it never handles one.

#### Scenario: Oversized file fails the diff check
- **WHEN** a session leaves a new test file, a file over 10 MB under the test author's writable paths and another at the worktree's root
- **THEN** the diff check fails naming both large files, and the patch holds the test file and neither large file

### Requirement: A failed patch still leaves evidence
When making the patch fails, `factory-build` SHALL still write the attempt's `messages.jsonl`, an empty `patch.diff` and a failed `outcome.json` with reason `error`, and SHALL log why the patch failed.

#### Scenario: Failed patch still records the attempt
- **WHEN** making an implementer attempt's patch fails after its gates ran
- **THEN** `factory-build` exits 0 having written the messages, an empty patch and a failed outcome with reason `error` that names the gates result, and its error log says why the patch failed
