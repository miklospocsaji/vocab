## ADDED Requirements

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
