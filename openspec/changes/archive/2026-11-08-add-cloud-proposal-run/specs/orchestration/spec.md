## ADDED Requirements

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
