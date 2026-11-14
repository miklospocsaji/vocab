## MODIFIED Requirements

### Requirement: Run stops at the requested state
A local run SHALL stop at the requested point: with `--until proposal` after a valid proposal is pushed, with `--until design` after the design is accepted, with `--until plan` after the plan is stored, and with `--until pr` after the pull request is open. A run SHALL stop at any open approval, which `pnpm factory approve --issue <n>` closes. After Proposal, it SHALL post a summary comment on the issue (why, what changes, affected capabilities, complexity, open questions) and leave the work item in state `awaiting-proposal-approval`.

#### Scenario: Summary comment is posted
- **WHEN** a run with `--until proposal` completes
- **THEN** the issue has a comment listing the change id, affected capabilities, complexity and open questions, and the work item state is `awaiting-proposal-approval`

#### Scenario: Local run reaches the pull request
- **WHEN** the owner runs `pnpm factory approve --issue 12` for a `small` work item awaiting proposal approval, then `pnpm factory run --issue 12 --until pr`
- **THEN** the plan's tasks are built in order, each is ticked in `tasks.md`, a pull request is open from the change branch, and the work item is `pr-open`

### Requirement: The factory acts as its GitHub App
Outside local runs, the Forge SHALL authenticate with installation tokens of the factory's GitHub App. Each token SHALL be requested for this repository only, with the permissions `contents: write`, `issues: write`, `pull_requests: write` and `metadata: read`. A token SHALL be refreshed before any call made within five minutes of its expiry. Tokens SHALL never appear in error messages, logs, command lines, remote URLs or git config. Commits the factory pushes SHALL be authored and committed by the App's bot user.

#### Scenario: Installation token is scoped to the repository
- **WHEN** the token provider requests an installation token
- **THEN** the request is signed with a JWT for the App, names only this repository, and asks only for `contents: write`, `issues: write`, `pull_requests: write` and `metadata: read`

#### Scenario: Expiring token is refreshed
- **WHEN** the Forge makes a call less than five minutes before its current token expires
- **THEN** a new installation token is requested first, and the call uses the new token

#### Scenario: Token failures do not leak the token
- **WHEN** a GitHub call or a push fails with an authentication error
- **THEN** the error message and every log line name the failure without containing the token or the App's private key

#### Scenario: Commits are authored by the factory's bot
- **WHEN** the worker commits and pushes a proposal or a task
- **THEN** the pushed commit's author and committer are the App's bot user, not the owner

### Requirement: The worker runs one state per task
The worker SHALL take a state and an issue number (`factory-worker <state> --issue <n>`, plus `--task <id>` for `step`) and SHALL run that state's handler for the issue's work item. It SHALL apply pending ledger migrations before the handler runs. A work item already past the state SHALL be left unchanged, and no role SHALL run.

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
The worker SHALL exit with 0 when the state advanced or had nothing to do, 3 when the work item escalated, 4 when the run should end without a work item to continue, 2 without running a role for invalid input, and 1 on any other error. It SHALL use these codes for the routes after Proposal: 10 when `Approved` skips Design, 11 when Design waits for the owner, 20 when `step` has prepared a build, 21 when `step` asks for a build after a wait, and 13 when `step` found a design flaw.

#### Scenario: Worker reports an escalation
- **WHEN** the worker runs `proposal` and all three attempts fail validation
- **THEN** the work item is `escalated`, the issue has the escalation comment, and the worker exits 3

#### Scenario: Worker reports a rejected issue
- **WHEN** the worker runs `intake` for an issue with an empty body
- **THEN** no work item or branch is created, the issue has the comment asking for a requirement, and the worker exits 4

#### Scenario: Unknown state is refused
- **WHEN** the worker is started with the state `deploy`, with `proposal` for an issue that has no work item, or with `step` and no `--task`
- **THEN** no role runs, nothing is cloned or recorded, and the worker exits 2 with a message naming the problem

### Requirement: `/approve` resumes the execution
An issue comment whose first line is `/approve`, written by the owner, SHALL start a worker task that resumes the execution with the open approval's token, whether it is a proposal or a design approval. The comment confirming it SHALL name which approval it closed. `/approve` from anyone else, or on a pull request, SHALL start nothing. `/approve` with no open approval SHALL be answered with a comment and change nothing. If resuming fails, the approval SHALL be reopened and the issue SHALL get a comment saying so.

#### Scenario: Owner's approval resumes the execution
- **WHEN** the owner comments `/approve` on an issue whose work item is `awaiting-proposal-approval`
- **THEN** the execution resumes, the work item is `proposal-approved`, the approval is closed with the owner's login, and the issue gets a comment confirming the proposal approval

#### Scenario: Approval from another user is ignored
- **WHEN** a user other than the owner comments `/approve` on an issue awaiting approval
- **THEN** no worker task starts, the execution stays paused and the approval stays open

#### Scenario: Approval with nothing awaiting is answered
- **WHEN** the owner comments `/approve` on an issue whose work item has no open approval
- **THEN** no execution changes, and the issue gets a comment saying that nothing awaits approval and naming the work item's state

#### Scenario: Failed resume is reported on the issue
- **WHEN** the `approve` task cannot resume the execution
- **THEN** the approval is open again, and the issue has a comment saying the approval did not go through and can be repeated

### Requirement: Executions carry only pointers
A role's validated result SHALL be stored in the ledger on its attempt, and a build's outputs SHALL be stored in the artifact store with their keys on the attempt. State inputs and outputs SHALL carry only pointers: the issue number, the change id, task ids, exit codes and task tokens.

#### Scenario: Proposal result is stored in the ledger
- **WHEN** a proposal attempt succeeds in the worker
- **THEN** the attempt in the ledger holds the result, and it passes the proposal result schema

#### Scenario: Execution history holds no artifacts or secrets
- **WHEN** an execution has opened its pull request
- **THEN** no event in its history contains the proposal, design or task text, the issue body, a patch, gate output, the Anthropic API key, a GitHub token, the App's private key, the webhook secret or the ledger password

## ADDED Requirements

### Requirement: Complexity decides the design route
After Proposal approval, the work item's route SHALL follow the change's `x-complexity`: `small` goes to Plan, `medium` to Design followed by the design reviewer, and `large` to Design followed by the owner's approval. A missing or unknown value SHALL escalate the work item.

#### Scenario: Small change skips Design
- **WHEN** a `small` change's proposal is approved
- **THEN** no architect or design reviewer runs, and the work item is in Plan

#### Scenario: Medium change gets the agent review
- **WHEN** a `medium` change's design passes strict validation
- **THEN** the design reviewer runs in a fresh session, and the work item goes to Plan once it returns `approve`

#### Scenario: Large design waits for the owner
- **WHEN** a `large` change's design passes strict validation
- **THEN** no design reviewer runs, the execution pauses with an open design approval, and the issue gets a comment with the design summary and the `/approve` instruction

### Requirement: Design is produced and reviewed
The Design state SHALL run the architect and accept its output only if the change passes `openspec validate <id> --strict` and the result passes its schema. A design reviewer's `changes-requested` SHALL send its findings to the architect's next attempt. Design SHALL escalate after 3 architect attempts in total. An accepted design SHALL be committed and pushed.

#### Scenario: Requested changes reach the architect
- **WHEN** the design reviewer returns `changes-requested` with a blocker finding
- **THEN** the architect's next attempt has the finding in its prompt, and the reviewer runs again on the new design

#### Scenario: Three rejected designs escalate
- **WHEN** the architect's third attempt is also answered with `changes-requested`
- **THEN** the work item is `escalated`, and the issue gets a comment with the last findings

### Requirement: Plan produces checked tasks
The Plan state SHALL run the planner, accept its output only if `validatePlan` passes and the change passes strict validation, retry with the evidence up to 3 attempts, and then escalate. An accepted plan's tasks SHALL be stored in the ledger, and `tasks.md` committed and pushed. Plan SHALL return the ids of the unfinished tasks, in order, to the execution.

#### Scenario: Plan stores its tasks
- **WHEN** the planner's output passes `validatePlan`
- **THEN** the ledger holds one task per entry in `tasks.json`, with its scenarios and files, `tasks.md` is on the branch, and the execution's next state receives the task ids in order

### Requirement: Each task is built tests-first
For each task, in order, the build loop SHALL run the test author in the build container until the red gate passes, then the implementer until the green gate passes. The test author's patch SHALL be committed before the implementer starts, and the implementer SHALL start from that commit. A failed red gate SHALL retry the test author with the gate's result, up to 3 attempts, and then escalate.

#### Scenario: Tests are committed before code
- **WHEN** a task's test author passes the red gate
- **THEN** its tests are committed and pushed, and the implementer's input names that commit as its base

#### Scenario: Red gate failure retries the test author
- **WHEN** the test author's tests fail to load
- **THEN** the next test author attempt has the red gate's result in its prompt

### Requirement: Build outputs are re-checked before commit
The worker SHALL apply a build's patch only if every path in it is inside the role's writable globs. A patch that fails this check SHALL fail the attempt with reason `diff-check`, and nothing from it SHALL be committed.

#### Scenario: Forged patch is refused
- **WHEN** a build outcome reports a passed diff check but its patch changes `package.json`
- **THEN** the worker commits nothing, and the attempt is recorded as failed with reason `diff-check`, naming `package.json`

### Requirement: Failed tasks are classified and routed
After a failed green gate, the worker SHALL run the failure classifier and route the task on its label: `bug` and `flaky` retry the task, `design-flaw` returns the change to Design, and `spec-ambiguity` and `infra` escalate as below. An implementer attempt that fails before the gates (turn cap, budget, diff check) SHALL count as `bug` without a classifier call.

#### Scenario: Spec ambiguity goes to the owner
- **WHEN** the classifier returns `spec-ambiguity`
- **THEN** the work item is `escalated`, and the issue gets a comment with the classifier's evidence as a question

#### Scenario: Infrastructure failure waits and retries
- **WHEN** the classifier returns `infra` for the third time in a task
- **THEN** the build ran again after a wait twice before, and now the work item is `escalated` with a comment naming the infrastructure failure

### Requirement: Bugs are retried with evidence
On `bug`, the worker SHALL retry the implementer with the gates' result and the classifier's evidence, up to 3 implementer attempts per task, and then escalate. On the first `flaky` in a task, it SHALL re-run only the gates on the same patch; a later `flaky` SHALL count as `bug`.

#### Scenario: Bug is retried with evidence
- **WHEN** a task's green gate fails and the classifier returns `bug`
- **THEN** the implementer's next attempt has the failing checks' output and the classifier's evidence in its prompt, and the ledger records the failed attempt with its classification

#### Scenario: Three failed implementer attempts escalate
- **WHEN** a task's third implementer attempt fails its green gate with `bug`
- **THEN** the work item is `escalated`, the issue gets a comment with the task and the last gate output, and the execution ends failed

#### Scenario: Flaky failure re-runs the gates only
- **WHEN** the classifier returns `flaky` for the first time in a task
- **THEN** the build container re-runs the green gate on the same patch, and no implementer session runs

### Requirement: Design flaws send the change back to Design
On `design-flaw`, the work item SHALL return to Design with the classifier's evidence in the architect's prompt, go through its design route again, and then re-plan. The re-plan SHALL keep the ticked tasks, and the build loop SHALL continue with the unfinished ones. A third design flaw in one work item SHALL escalate it.

#### Scenario: Design flaw re-plans the unfinished tasks
- **WHEN** task 1.3 of a `medium` change fails with `design-flaw` after tasks 1.1 and 1.2 are ticked
- **THEN** the architect runs with the evidence, the reviewer runs, the planner re-plans, tasks 1.1 and 1.2 stay ticked and are not rebuilt, and the build loop continues with the new plan's unfinished tasks

### Requirement: Passed tasks are ticked and committed
When a task's green gate passes, the worker SHALL tick that task's line in `tasks.md` and commit it with the implementer's patch, as the App's bot, and push. A task that is already ticked SHALL be skipped by the build loop.

#### Scenario: Task is ticked with its code
- **WHEN** task 1.2's green gate passes
- **THEN** one new commit on the branch holds the implementer's changes and `- [x] 1.2`, and the ledger marks task 1.2 done with that commit

#### Scenario: Ticked task is not rebuilt
- **WHEN** the build loop reaches a task that is already ticked
- **THEN** no role runs for it, and the loop moves on

### Requirement: A pull request opens when every task is done
When every task of the plan is ticked, the worker SHALL open one pull request from the change branch to `master`, or reuse the open one. Its body SHALL list the tasks, each role's tokens and estimated cost, and the issue. The issue SHALL get a comment linking it, and the work item SHALL become `pr-open`.

#### Scenario: Pull request is opened once
- **WHEN** the open-PR state runs twice for a work item whose tasks are all ticked
- **THEN** exactly one pull request exists for the branch, its body lists the tasks and the cost, and the issue has one comment linking it

### Requirement: Build sessions are recorded in the ledger
The worker SHALL record each build attempt's SDK messages, tokens, estimated cost and auth mode from its `messages.jsonl`, exactly as a session in the worker is recorded. An attempt whose build task produced no outcome SHALL be recorded as failed with reason `no-outcome`.

#### Scenario: Build cost reaches the ledger
- **WHEN** an implementer attempt has run in the build container and been recorded
- **THEN** the ledger holds its messages with token counts, its estimated cost and its auth mode, and the work item's total cost includes it

### Requirement: Build tasks hold only the model credential
The build task SHALL receive only the API key as a secret, SHALL have a task role that can only read and write `work-items/*` in the artifact bucket, and SHALL have a security group with no ingress that the ledger does not admit. The artifact bucket SHALL block public access and refuse requests without TLS.

#### Scenario: Build task cannot reach the factory's secrets
- **WHEN** the factory stack is synthesised
- **THEN** the build task definition's only secret is the API key, its task role allows only `s3:GetObject` and `s3:PutObject` on `work-items/*` in the artifact bucket, and the ledger's security group has no rule for the build task's security group

### Requirement: Build tasks have room for their checks
The build task SHALL have 8 GB of memory, SHALL run Node with a 4 GB heap (`NODE_OPTIONS=--max-old-space-size=4096`) so the heap does not depend on Node's estimate, and SHALL write no core dumps (a core ulimit of 0), so an aborted process cannot leave gigabytes in the clone.

#### Scenario: Build task has room for its checks and writes no core dumps
- **WHEN** the factory stack is synthesised
- **THEN** the build task definition has 8 GB of memory, its container sets `NODE_OPTIONS` to `--max-old-space-size=4096`, and its core ulimit is 0, soft and hard

### Requirement: Commits and pull requests say what they hold
A design commit that adds or changes contracts SHALL be a `feat` commit, `feat(<change id>): design the change and its contracts`; one that changes only `design.md` stays `docs(<change id>): design the change`. The pull request's cost note SHALL follow the auth modes its attempts ran in: in `api-key` mode the cost was charged to the factory's API key, in `subscription` mode no money was charged per token.

#### Scenario: Design that adds contracts is committed as a feature
- **WHEN** the architect writes `design.md` and a file under `app/contracts/src/`, and the design is accepted
- **THEN** the design commit holds both files, and its subject is `feat(<change id>): design the change and its contracts`

#### Scenario: Pull request says what its cost means
- **WHEN** a pull request opens for a work item whose attempts all ran in `api-key` mode
- **THEN** its cost note says the cost was charged to the factory's API key, and does not say that no money was charged
