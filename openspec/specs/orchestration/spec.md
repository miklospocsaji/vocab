# orchestration Specification

## Purpose
The work-item lifecycle: the states a work item moves through from issue to release, their transitions, retries and stopping points, and what the ledger records for each.

## Requirements

### Requirement: Intake creates a work item
Running the factory for an issue SHALL create one work item in the ledger, linked to the issue, and a branch named after the work item's change id. An issue with an empty body SHALL be rejected.

#### Scenario: Work item and branch are created
- **WHEN** the owner runs `pnpm factory run --issue 12 --until proposal` for an open issue titled "Import Kindle vocab.db"
- **THEN** the ledger holds one work item for issue 12 with change id `add-import-kindle-vocab-db`, and a branch of that name exists on the remote

#### Scenario: Issue without a requirement is rejected
- **WHEN** the issue body is empty
- **THEN** no work item and no branch are created, the issue gets a comment asking for a stated requirement, and the CLI exits non-zero

### Requirement: Change ids are derived deterministically
Intake SHALL derive the change id from the issue title as `<verb>-<slug>`. If the first word of the title is one of `add`, `fix`, `change`, `remove`, `improve`, `refactor`, that word is the verb and the slug is the rest of the title. Otherwise the verb is `add` and the slug is the whole title. The slug SHALL be lower-case kebab-case, and the id at most 40 characters, cut at a word boundary. A taken id SHALL get a numeric suffix.

#### Scenario: Leading verb is kept
- **WHEN** the issue title is "Fix duplicate lookups on re-import"
- **THEN** the change id is `fix-duplicate-lookups-on-re-import`

#### Scenario: Colliding id gets a suffix
- **WHEN** another work item already uses the change id `add-import-kindle-vocab-db`
- **THEN** the new work item uses `add-import-kindle-vocab-db-2`

### Requirement: Proposal produces a valid change
The Proposal state SHALL run the proposal-author role on the work item's branch, and SHALL accept its output only if `openspec validate <id> --strict` passes and the role's result passes its schema. An attempt that fails either check SHALL be retried with the failure evidence in the prompt, up to 3 attempts in total. After that, the work item SHALL be marked `escalated` and the issue SHALL get a comment with the last failure.

#### Scenario: Valid proposal is committed and pushed
- **WHEN** the proposal-author role produces a change that passes strict validation
- **THEN** the runner commits the change folder on the work item's branch and pushes it

#### Scenario: Invalid proposal is retried with evidence
- **WHEN** an attempt produces a change that fails strict validation
- **THEN** the next attempt's prompt contains the validation errors, and the ledger records the failed attempt with its reason

#### Scenario: Three failed attempts escalate
- **WHEN** three attempts in a row fail validation
- **THEN** the work item is `escalated`, the issue gets a comment with the last validation errors, and the CLI exits non-zero

### Requirement: Run stops at the requested state
With `--until proposal`, the run SHALL stop after a valid proposal is pushed. It SHALL post a summary comment on the issue (why, what changes, affected capabilities, complexity, open questions) and leave the work item in state `awaiting-proposal-approval`.

#### Scenario: Summary comment is posted
- **WHEN** a run with `--until proposal` completes
- **THEN** the issue has a comment listing the change id, affected capabilities, complexity and open questions, and the work item state is `awaiting-proposal-approval`

### Requirement: Runs are resumable
Running the factory again for an issue that already has a work item SHALL continue that work item and SHALL NOT create a second one. If the work item is already at or past the requested state, no agent SHALL run.

#### Scenario: Re-run after completion does nothing
- **WHEN** the owner runs the same command again for an issue whose work item is `awaiting-proposal-approval`
- **THEN** no agent runs, no new attempt is recorded, and the CLI reports the current state

### Requirement: Every run is recorded with its cost
The ledger SHALL record, for every work item:
- each attempt: state, role, start and end time, outcome and failure reason
- each SDK message: token usage
- each attempt's estimated cost in USD and the auth mode used (`api-key` or `subscription`)

The total estimated cost of a work item SHALL be queryable.

#### Scenario: Cost is visible after a run
- **WHEN** a run with `--until proposal` completes
- **THEN** the ledger reports a non-zero token count and an estimated cost for the work item, and the auth mode of each attempt

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

### Requirement: Labelling an issue starts a work item
When the label `factory` is added to an open issue, the factory SHALL start a Step Functions execution for it, whose states run in the factory worker. An issue SHALL never have more than one work item, and a later execution for the same issue SHALL end without changing it. Other labels SHALL be ignored.

#### Scenario: Labelling an issue starts an execution
- **WHEN** the owner adds the label `factory` to an open issue with a stated requirement
- **THEN** one execution starts for the issue, the ledger holds one work item for it with the execution's ARN, and the work item's branch exists on the remote

#### Scenario: Relabelling does not create a second work item
- **WHEN** the label `factory` is removed from an issue that has a work item and added again, or the same delivery is redelivered
- **THEN** the new execution ends successfully at Intake, no role runs, and the ledger still holds one work item with the original execution's ARN

#### Scenario: Other labels are ignored
- **WHEN** a label other than `factory` is added to an issue
- **THEN** no execution starts and no work item is created

### Requirement: Webhooks are verified
The webhook endpoint SHALL act only on deliveries whose `X-Hub-Signature-256` matches the App's webhook secret. It SHALL NOT read or write the ledger.

#### Scenario: Unsigned webhook is rejected
- **WHEN** a request without a valid signature reaches the webhook endpoint
- **THEN** the endpoint answers 401, and no execution or worker task starts

### Requirement: Proposal approval waits for the owner
After a valid proposal is pushed, the execution SHALL pause in Proposal approval. The worker SHALL store the approval's task token in the ledger before it posts the summary comment. The summary SHALL list what M1's summary lists, plus the attempt's tokens, estimated cost and auth mode, and SHALL tell the owner to reply `/approve`.

#### Scenario: Execution waits for approval
- **WHEN** the Proposal state of an execution succeeds
- **THEN** the execution is paused in Proposal approval, the work item is `awaiting-proposal-approval`, the ledger holds an open approval stored before the summary comment was posted, and no worker task is running

#### Scenario: Summary shows the cost
- **WHEN** the summary comment is posted for a cloud run
- **THEN** it shows the proposal's token count, estimated cost in USD and the auth mode `api-key`, and ends with the instruction to reply `/approve`

### Requirement: `/approve` resumes the execution
An issue comment whose first line is `/approve`, written by the owner, SHALL start a worker task that resumes the execution with the open approval's token. The work item SHALL become `proposal-approved`, which ends the execution in M2. `/approve` from anyone else, or on a pull request, SHALL start nothing. `/approve` with no open approval SHALL be answered with a comment and change nothing.

#### Scenario: Owner's approval resumes the execution
- **WHEN** the owner comments `/approve` on an issue whose work item is `awaiting-proposal-approval`
- **THEN** the execution resumes and succeeds, the work item is `proposal-approved`, the approval is closed with the owner's login, and the issue gets a comment confirming the approval

#### Scenario: Approval from another user is ignored
- **WHEN** a user other than the owner comments `/approve` on an issue awaiting approval
- **THEN** no worker task starts, the execution stays paused and the approval stays open

#### Scenario: Approval with nothing awaiting is answered
- **WHEN** the owner comments `/approve` on an issue whose work item has no open approval
- **THEN** no execution changes, and the issue gets a comment saying that nothing awaits approval and naming the work item's state

### Requirement: Infrastructure failures escalate
A worker task that fails to start or exits with an error SHALL be retried with backoff, up to 2 retries. After that, a worker task SHALL mark the work item `escalated` and comment on the issue naming the failure, and the execution SHALL fail.

#### Scenario: Worker crash escalates the work item
- **WHEN** the Proposal worker task exits with code 1 on its first run and on both retries
- **THEN** the work item is `escalated`, the issue has a comment naming the infrastructure failure, and the execution ends failed

#### Scenario: Escalated proposal ends the execution
- **WHEN** the Proposal worker task exits with code 3
- **THEN** no retry runs, and the execution ends failed with the work item `escalated`

### Requirement: Executions carry only pointers
A role's validated result SHALL be stored in the ledger on its attempt. State inputs and outputs SHALL carry only the issue number, exit codes and the task token.

#### Scenario: Proposal result is stored in the ledger
- **WHEN** a proposal attempt succeeds in the worker
- **THEN** the attempt in the ledger holds the result, and it passes the proposal result schema

#### Scenario: Execution history holds no artifacts or secrets
- **WHEN** an execution has reached Proposal approval
- **THEN** no event in its history contains the proposal text, the issue body, the Anthropic API key, a GitHub token, the App's private key, the webhook secret or the ledger password

### Requirement: The ledger accepts connections only from the worker
The ledger SHALL have no public address and SHALL accept connections only from the worker's security group, over TLS.

#### Scenario: Ledger is closed to everything but the worker
- **WHEN** the factory stack is synthesised
- **THEN** the cluster's instances are not publicly accessible, and the only ingress rule on the ledger's security group is port 5432 from the worker's security group
