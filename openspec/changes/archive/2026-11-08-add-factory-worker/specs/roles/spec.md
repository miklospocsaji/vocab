## MODIFIED Requirements

### Requirement: Auth mode is configured and recorded
The runner SHALL support an `api-key` mode and a `subscription` mode, selected by the role's config. A deployment MAY override the mode for every role by setting `FACTORY_AUTH_MODE` to `api-key` or `subscription`; any other value SHALL fail the attempt before a session starts. The runner SHALL record in the ledger the auth mode the SDK actually reported. It SHALL fail the attempt if the reported mode differs from the effective one (the override if set, otherwise the config).

#### Scenario: Mismatched auth mode fails fast
- **WHEN** the config selects `api-key` but the SDK reports a subscription login
- **THEN** the attempt fails with reason `auth-mode-mismatch` before any tool runs

#### Scenario: Deployment overrides the configured mode
- **WHEN** a role whose config selects `subscription` runs with `FACTORY_AUTH_MODE=api-key` and an API key in the environment
- **THEN** the session receives the API key and no OAuth token, and the ledger records the attempt's auth mode as `api-key`

### Requirement: Bash is limited to allowlisted commands
For roles with Bash, the runner SHALL allow only commands matching the role's allowlist, and SHALL deny `git push` and network commands regardless of the allowlist. Bash SHALL run in a sandbox whose filesystem writes are limited to the role's writable paths. On a host where the sandbox cannot start, every Bash command SHALL fail, and none SHALL run outside the sandbox.

#### Scenario: Non-allowlisted command is denied
- **WHEN** a role whose allowlist is `openspec` only runs `curl https://example.com`
- **THEN** the command does not run and the ledger records the denial

#### Scenario: Bash cannot write outside the role's paths
- **WHEN** an allowlisted command tries to write a file outside the role's writable paths
- **THEN** the write fails and the file does not exist

#### Scenario: Missing sandbox blocks Bash
- **WHEN** a role with Bash runs an allowlisted command in a `factory-worker` container, where the sandbox cannot start
- **THEN** the command fails with the sandbox's error, and its effect does not happen

## ADDED Requirements

### Requirement: Role sessions hold no factory credentials
The runner SHALL build a role session's environment from an allowlist: the variables the session needs to run (such as `PATH`, `HOME`, locale and temp-directory settings), the factory's own settings for the session, and the credential of the effective auth mode. No other inherited variable SHALL reach the session. In particular, GitHub tokens, AWS credentials, the ECS container-credential and metadata endpoints, and the ledger's database URL SHALL NOT reach it.

#### Scenario: Factory credentials do not reach the role session
- **WHEN** the runner starts a session in a process whose environment holds `FACTORY_GITHUB_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `ECS_CONTAINER_METADATA_URI_V4` and `FACTORY_DATABASE_URL`
- **THEN** the session's environment contains none of them, and contains `ANTHROPIC_API_KEY` only when the effective mode is `api-key`

#### Scenario: Credentials stay out of the ledger
- **WHEN** a role runs with an API key and a GitHub token in the worker's environment
- **THEN** no message, attempt or event recorded in the ledger contains either value

### Requirement: Reads are confined to the worktree
The runner SHALL deny any Read, Grep or Glob call whose target, resolved against the worktree with symlinks followed, falls outside the worktree.

#### Scenario: Reading a process environment is denied
- **WHEN** a role tries to read `/proc/self/environ` or the environment of its parent process
- **THEN** the call is denied with a reason, and no file content reaches the session

#### Scenario: Read through a symlink out of the worktree is denied
- **WHEN** the worktree contains a symlink to a file outside it and a role reads through the symlink
- **THEN** the call is denied

#### Scenario: Reading inside the worktree is allowed
- **WHEN** a role reads `docs/brief.md` or searches the worktree root
- **THEN** the call is not denied by the read guard

### Requirement: Proposal author has no Bash
The proposal author SHALL have no Bash tool, locally or in the worker. Its output SHALL be validated by the runner after the session, and a failed validation SHALL reach the next attempt as evidence.

#### Scenario: Proposal author cannot run commands
- **WHEN** the proposal author's config is loaded and a session starts
- **THEN** Bash is not among the session's tools, and no `Bash` rule is in its pre-approved calls

#### Scenario: Proposal author produces a valid change without Bash
- **WHEN** the proposal author completes a real session for an issue
- **THEN** the change passes `openspec validate --strict` within the three attempts

### Requirement: Proposal author fetches only from GitHub
The proposal author's `WebFetch` SHALL be limited to `github.com` and `raw.githubusercontent.com`. A fetch of any other host SHALL be denied without prompting.

#### Scenario: WebFetch outside GitHub is denied
- **WHEN** the proposal author fetches `https://example.com`
- **THEN** no request is made and the ledger records the denial

### Requirement: Proposal attempts fit the work-item budget
The proposal author's per-attempt budget multiplied by the maximum number of Proposal attempts SHALL NOT exceed $5, the model spend limit per work item.

#### Scenario: Three attempts stay within the work-item limit
- **WHEN** the proposal author's config is loaded
- **THEN** its `maxBudgetUsd` times the maximum number of Proposal attempts is at most 5

### Requirement: Roles run in the factory worker image
One container image, `factory-worker`, SHALL be able to run any role. It SHALL contain the factory's code at the commit it was built from, the pinned Agent SDK and OpenSpec CLI, and git. It SHALL run as a non-root user, and SHALL contain no secrets and no personal data. The role boundaries SHALL hold inside the image, in a container started with no added capabilities and the default seccomp profile.

#### Scenario: Worker image holds no secrets
- **WHEN** the `factory-worker` image is built from a checkout that contains `.env.local` and `docs/vocab.db`
- **THEN** the image contains neither file, has no `.git` directory, and its default user is not root

#### Scenario: Boundaries hold in the worker container
- **WHEN** the boundary tests ("Write outside the allowed paths is denied", "Reading a process environment is denied", "WebFetch outside GitHub is denied", "Proposal author cannot run commands") run inside a `factory-worker` container with no added capabilities
- **THEN** they pass
