## ADDED Requirements

### Requirement: The factory acts as its GitHub App
Outside local runs, the Forge SHALL authenticate with installation tokens of the factory's GitHub App. Each token SHALL be requested for this repository only, with the permissions `contents: write`, `issues: write` and `metadata: read`. A token SHALL be refreshed before any call made within five minutes of its expiry. Tokens SHALL never appear in error messages, logs, command lines, remote URLs or git config. Commits the factory pushes SHALL be authored and committed by the App's bot user.

#### Scenario: Installation token is scoped to the repository
- **WHEN** the token provider requests an installation token
- **THEN** the request is signed with a JWT for the App, names only this repository, and asks only for `contents: write`, `issues: write` and `metadata: read`

#### Scenario: Expiring token is refreshed
- **WHEN** the Forge makes a call less than five minutes before its current token expires
- **THEN** a new installation token is requested first, and the call uses the new token

#### Scenario: Token failures do not leak the token
- **WHEN** a GitHub call or a push fails with an authentication error
- **THEN** the error message and every log line name the failure without containing the token or the App's private key

#### Scenario: Commits are authored by the factory's bot
- **WHEN** the worker commits and pushes a proposal
- **THEN** the pushed commit's author and committer are the App's bot user, not the owner

### Requirement: The worker runs one state per task
The worker SHALL take a state and an issue number (`factory-worker <state> --issue <n>`) and SHALL run that state's handler for the issue's work item. It SHALL apply pending ledger migrations before the handler runs. A work item already past the state SHALL be left unchanged, and no role SHALL run.

#### Scenario: Worker runs Intake for an issue
- **WHEN** the worker runs `intake` for an open issue with a stated requirement
- **THEN** the ledger holds the work item in state `proposal`, its branch exists on the remote, and the worker exits 0

#### Scenario: Worker advances a proposal
- **WHEN** the worker runs `proposal` for a work item in state `proposal`, and the role produces a valid change
- **THEN** the change is pushed to the work item's branch from a fresh clone, the work item is `awaiting-proposal-approval`, and the worker exits 0

#### Scenario: Repeated worker task does nothing
- **WHEN** the worker runs `proposal` for a work item that is already `awaiting-proposal-approval`
- **THEN** no role runs, no attempt is recorded, the branch is unchanged, and the worker exits 0

### Requirement: The worker reports by exit code
The worker SHALL exit with 0 when the state advanced or had nothing to do, 3 when the work item escalated, 4 when the run should end without a work item to continue, 2 without running a role for invalid input, and 1 on any other error.

#### Scenario: Worker reports an escalation
- **WHEN** the worker runs `proposal` and all three attempts fail validation
- **THEN** the work item is `escalated`, the issue has the escalation comment, and the worker exits 3

#### Scenario: Worker reports a rejected issue
- **WHEN** the worker runs `intake` for an issue with an empty body
- **THEN** no work item or branch is created, the issue has the comment asking for a requirement, and the worker exits 4

#### Scenario: Unknown state is refused
- **WHEN** the worker is started with the state `design`, or with `proposal` for an issue that has no work item
- **THEN** no role runs, nothing is cloned or recorded, and the worker exits 2 with a message naming the problem
