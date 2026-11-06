# Tasks

Depends on `add-factory-worker`, which is step 1's worker half. This change holds the rest of M2's four build steps.

Unit tests run in `pnpm check` with fakes for GitHub and AWS and the real local ledger. Cloud tests (`*.cloud.test.ts`) run through `pnpm test:cloud` against the deployed stack with the owner's AWS credentials, never in `pnpm check` or CI. Every `cdk bootstrap`, `cdk deploy`, other AWS write and GitHub write is confirmed with the owner first.

## Step 1: Worker and GitHub App Forge (GitHub App setup)

- [x] 1.1 With the owner, following ADR 0009, register the GitHub App and install it on this repository only (done 2026-11-02: App id `5586098`, installation id `177972181`, slug `vocab-factory`):
  - permissions: Contents read & write, Issues read & write, Metadata read
  - events: Issues, Issue comment; webhook inactive until task 3.10

  The App's private key, the webhook secret and the Anthropic API key are in Parameter Store (done by the owner, 2026-11-02).
- [x] 1.2 Create the `factory` label on the repository (a GitHub write; confirm first).

## Step 2: Network and data stack

### Decisions and package

- [x] 2.1 Write ADR 0008 "No worker egress control", following `design.md`. Amend ADR 0003.
- [x] 2.2 Create the `infra` package (`@vocab/infra`):
  - `aws-cdk-lib`, `constructs`, `aws-cdk` and `esbuild`, pinned exactly
  - `infra/bin/factory.ts` and `infra/cdk.json`, with the App id, installation id, slug and the owner's login (`miklospocsaji`) as context
  - root scripts `infra:synth`, `infra:diff` and `infra:deploy`
  - a `cloud` Vitest project and a root `pnpm test:cloud` script, with cloud tests excluded from `pnpm test`

  Confirm `cdk bootstrap aws://<account>/eu-central-1` with the owner and run it. (Done 2026-11-06 with the owner's `vocab` profile, account 943081072466.)

### Stack

- [x] 2.3 Failing CDK assertion tests for `infra/factory-stack.ts`. Scenario: Ledger is closed to everything but the worker. Also cover:
  - no NAT Gateway, NAT instance, private subnet or VPC endpoint
  - Aurora Serverless v2: min capacity 0, max 1, deletion protection on
  - the task definition takes secrets through `secrets` only, and runs with a public IP and no security group ingress
  - the task role may only send task success and failure to this state machine's tasks
  - log retention is 14 days
  - a $50 monthly budget with no cost filter notifies the `budgetEmail` context
- [x] 2.4 Write `infra/factory-stack.ts` with the VPC, Aurora, the worker and the budget (the state machine and the Lambda come in step 3), and the test-only boundary-check task definition.

### Ledger

- [x] 2.5 Failing tests against the local Postgres for migration 0002 and its queries:
  - `issue_number` is unique
  - the execution ARN is recorded on the work item
  - one open approval per work item; an approval closes with `resolved_by` and can reopen
  - Scenario: Proposal result is stored in the ledger (a successful attempt holds a result that parses with `ProposalResult`)

  Also: `connectionFromSecret` builds a TLS config that verifies against the committed CA bundle, whose SHA-256 matches the recorded one.
- [x] 2.6 Write `factory/ledger/migrations/0002_cloud.sql`, the queries, `connectionFromSecret` and the RDS CA bundle. Store the result on the attempt in the `proposal` handler.

### Deploy and verify the boundary

- [x] 2.7 Failing cloud test in `factory/roles/test/boundaries.cloud.test.ts`, which runs the boundary-check task definition (the worker's, with the worker image plus Vitest; owner decision of 2026-11-06, ADR 0010) as a one-off Fargate task with a command override running the boundary live tests. It first checks that the deployed check stands for the worker: equal task definitions but for the image, and the worker image's layers as the check image's first layers. Scenario: Boundaries hold in Fargate (api-key mode, budget under $0.10). Also run `bwrap` in the task and record whether it can start, as input to M3. A failure there does not fail M2.
- [x] 2.8 Confirm with the owner, then `pnpm infra:deploy`. Run `pnpm test:cloud` for task 2.7 and record the result in `design.md`.

## Step 3: State machine and Lambda

- [ ] 3.1 Spike, with no production code, and confirmed with the owner first: with the AWS CLI, create a throwaway state machine with one `ecs:runTask.sync` state, run the worker task definition with command overrides that exit 0, 1 and 3, then delete the state machine. Record in `design.md` where the exit code appears for a non-zero exit. A few cents at most.

### State machine

- [ ] 3.2 Failing tests for `definition()` in `factory/orchestrator/src/state-machine.ts` (pure ASL, no AWS), following the spike. Scenarios:
  - Worker crash escalates the work item (definition half: exit 1 or a task that never started retries twice with waits, then goes to Escalate and Fail; exit 2 goes to Escalate at once)
  - Escalated proposal ends the execution
  - Execution history holds no artifacts or secrets (static half: every state's arguments hold only the issue number, the execution ARN, states, exit codes and the task token)

  Also: `QueryLanguage` is JSONata; Intake → Proposal → AwaitApproval → Approved; exit 4 from Intake ends successfully.
- [ ] 3.3 Write `state-machine.ts`.

### Worker states

- [ ] 3.4 Failing tests for the new worker states, with `FakeForge`, a fake Step Functions client and the real ledger. Scenarios:
  - Execution waits for approval (the approval is stored before the summary comment is posted; `FakeForge` checks the ledger when the comment arrives)
  - Summary shows the cost
  - Owner's approval resumes the execution (`approve` closes the approval and sends the token; `approved` sets `proposal-approved` and posts the confirmation)
  - Approval with nothing awaiting is answered
  - Worker crash escalates the work item (`escalate` marks the work item and comments with a fixed reason code)
  - Relabelling does not create a second work item (`intake` with a different ARN exits 4 and changes nothing)

  Also: a failed `SendTaskSuccess` reopens the approval; an error in `await-approval` sends `SendTaskFailure`; the local run loop treats `proposal-approved` as past `--until proposal`.
- [ ] 3.5 Write the worker states, `factory/orchestrator/src/approval.ts`, the cost line and approval instruction in `summary.ts`, the execution ARN in `intake`, `proposal-approved` in `WorkItemState`, and the run-loop order. Amend ADR 0002.

### Webhook

- [ ] 3.6 Failing tests for the webhook handler, with fake Step Functions and ECS clients. Scenarios:
  - Unsigned webhook is rejected
  - Other labels are ignored
  - Labelling an issue starts an execution (handler half: one `StartExecution` with input `{ issueNumber }` only)
  - Owner's approval resumes the execution (handler half: one `RunTask` of `approve` for that issue)
  - Approval from another user is ignored

  Also cover: `/approve` on a pull request starts nothing; signatures are compared in constant time; the webhook secret is read once per cold start and never logged.
- [ ] 3.7 Write `factory/orchestrator/src/lambda/webhook.ts`.

### Infrastructure

- [ ] 3.8 Failing CDK assertion tests:
  - the Lambda has a Function URL and no VPC configuration
  - its role may only start this state machine, run the worker task definition, pass the worker's roles and read the webhook secret parameter; it has no access to the ledger's secret
  - the state machine may run only the worker task definition and pass only its roles
- [ ] 3.9 Add the state machine and the Lambda to `infra/factory-stack.ts`.
- [ ] 3.10 Failing cloud test, then deploy after confirming with the owner. Scenario: Unsigned webhook is rejected (against the deployed endpoint). The owner sets the App's webhook URL to the Function URL and activates it. Run `pnpm test:cloud`.

## Step 4: Exit run

- [ ] 4.1 With the laptop's factory processes stopped, the owner labels a test issue `factory`. Confirm:
  - Labelling an issue starts an execution
  - Execution waits for approval, within 10 minutes of the label
  - Summary shows the cost
  - Execution history holds no artifacts or secrets (a cloud test scans the execution's history for the issue body, the proposal text and every secret's value read inside the test, printing only pass or fail)
  - the branch holds a change that passes `openspec validate --strict`, committed by the App's bot

  Then the owner comments `/approve`. Confirm "Owner's approval resumes the execution": the execution succeeds, and the work item is `proposal-approved`. Record timings, cost and links in the M2 PR description.
- [ ] 4.2 Update `CLAUDE.md`: `infra:*`, `test:cloud` and `test:docker`; the `infra` and `factory/worker` packages; how to read cloud cost. Archive `add-factory-worker`, then `add-cloud-proposal-run`.
