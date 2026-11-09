# Tasks

Build steps M3.3 and M3.4. Depends on `add-build-gates` and `add-build-roles`. Unit tests run in `pnpm check` with `FakeForge`, fake SDK sessions, a fake build runner, an `FsStore` and the real local ledger. Cloud tests (`*.cloud.test.ts`) run through `pnpm test:cloud`. Every deploy, AWS write and GitHub write is confirmed with the owner first.

Scenarios carried unchanged inside MODIFIED requirements keep their existing tests and are not listed below: Expiring token is refreshed, Token failures do not leak the token, Commits are authored by the factory's bot, Worker runs Intake for an issue, Worker advances a proposal, Repeated worker task does nothing, Worker reports a rejected issue, Approval from another user is ignored, Approval with nothing awaiting is answered, Proposal result is stored in the ledger. They must still pass, and the coverage run of task 4.12 checks them.

## Step M3.3: The build loop, locally

### Ledger and Forge

- [ ] 3.1 Failing tests against the local Postgres for migration 0003 and its queries: tasks inserted from a plan; a re-plan supersedes only unfinished tasks; one open approval per work item, whatever its kind; attempts carry a task, a store prefix, a classification and a gates result; `design_flaws` counts.
- [ ] 3.2 Write `factory/ledger/migrations/0003_build.sql` and the queries.
- [ ] 3.3 Failing tests for `openPullRequest` and `findPullRequest` on `GitHubForge` (fake fetch) and `FakeForge`, and for the token request. Scenario: Installation token is scoped to the repository (now with `pull_requests: write`).
- [ ] 3.4 Write them.

### Design and Plan

- [ ] 3.5 Failing handler tests with fake roles. Scenarios:
  - Small change skips Design
  - Medium change gets the agent review
  - Large design waits for the owner
  - Requested changes reach the architect
  - Three rejected designs escalate
  - Plan stores its tasks

  Also: an unknown `x-complexity` escalates; each accepted design and plan is committed by the bot and pushed.
- [ ] 3.6 Write the `approved` routing, `design`, the generalised `awaitApproval`, `plan`, and the design summary comment.

### Step, Record and the PR

- [ ] 3.7 Failing tests for `step` with a fake build runner writing outcomes to an `FsStore`. Scenarios:
  - Tests are committed before code
  - Red gate failure retries the test author
  - Forged patch is refused
  - Bug is retried with evidence
  - Three failed implementer attempts escalate
  - Spec ambiguity goes to the owner
  - Infrastructure failure waits and retries
  - Flaky failure re-runs the gates only
  - Task is ticked with its code
  - Ticked task is not rebuilt
  - Build cost reaches the ledger

  Also: a missing outcome records `no-outcome` and counts as `infra`; a repeated `step` after a recorded outcome records nothing twice.
- [ ] 3.8 Write `step`, the outcome recording and `tick`.
- [ ] 3.9 Failing tests. Scenarios:
  - Pull request is opened once
  - Design flaw re-plans the unfinished tasks (handlers in sequence with fake roles)
- [ ] 3.10 Write `open-pr` and the design-flaw path.

### Local run

- [ ] 3.11 Failing CLI and run-loop tests with fakes. Scenarios:
  - Local run reaches the pull request
  - Summary comment is posted (unchanged, re-run)

  Also: `--until design` and `--until plan` stop where they say; a run stops at an open approval and names the `approve` command.
- [ ] 3.12 Write the run loop, `pnpm factory approve`, `--until design|plan|pr` and the Docker build runner.
- [ ] 3.13 With the owner's approval of each GitHub write, run the factory locally end to end on a small real issue in `app/domain` that the owner writes, up to the PR. Record here: attempts per role, tokens and estimated cost per role and in total, wall time, and anything the roles got wrong. If the typical spend is near the $5 limit, stop and bring the owner options for caps or models before M3.4.

## Step M3.4: The build loop in AWS, and the exit run

### Worker and state machine

- [ ] 4.1 Failing worker tests for the states `design`, `plan` (task token, `SendTaskSuccess` with ids, `SendTaskFailure` on error), `step` and `open-pr`. Scenarios:
  - Unknown state is refused
  - Failed resume is reported on the issue
  - Owner's approval resumes the execution (now naming the approval)
  - Worker reports an escalation (unchanged, re-run)
- [ ] 4.2 Write the worker states and the store wiring (`S3Store` from `FACTORY_STORE_BUCKET`).
- [ ] 4.3 Failing tests on `definition()`: the routes of the diagram in `design.md`, the Map's concurrency 1 and items from `$tasks`, `DesignFlaw` caught into Design, and `WorkItemEscalated` into Escalated. Scenario: Execution history holds no artifacts or secrets (static half: every state's arguments hold only the issue number, task ids, the execution ARN, exit codes and task tokens).
- [ ] 4.4 Write the state machine.

### Stack

- [ ] 4.5 Failing CDK assertion tests. Scenario: Build task cannot reach the factory's secrets. Also: the bucket blocks public access, enforces TLS and expires objects after 180 days; the worker role reads and writes the bucket; the state machine may run only the worker and build families and pass only their roles; the build task definition's image is the Dockerfile's `build` target.
- [ ] 4.6 Write the bucket, the build task definition, its security group and the IAM changes.
- [ ] 4.7 With the owner: enable Pull requests read and write in the App's settings and accept it on the installation. Amend ADRs 0002, 0003 and 0009.
- [ ] 4.8 Failing cloud test `factory/worker/test/build-boundaries.cloud.test.ts`, running the build task definition with a probe input. Scenario: Build boundaries hold in Fargate (budget under $0.10). Then confirm with the owner, run `pnpm infra:diff`, `pnpm infra:deploy` and `pnpm test:cloud`, and record the results in `design.md`.

### Exit run

- [ ] 4.9 Draft the importer issue (parse words, lookups and books from `vocab.db` in `app/domain`; idempotent re-import; tested against `app/fixtures/vocab.db` and `vocab-older.db`) and show it to the owner. The owner creates it and labels it `factory`. Do not deploy while its execution runs.
- [ ] 4.10 Follow the execution to its PR. Confirm and record in the M3 PR description:
  - every task in `tasks.md` ticked, each in a commit by `vocab-factory[bot]` with green gates
  - no commit by anyone else touching `app/**/src` or `app/**/test` (`git log --format='%an' -- app/` on the branch)
  - CI green on the PR
  - attempts, cost per role and in total, and wall time
  - Scenario: Execution history holds no artifacts or secrets (the scan of M2's task 4.1, extended to patches, gate output and the design)
- [ ] 4.11 If the importer was not `medium`, repeat with a second issue the owner writes, which is `medium`, up to its PR. Record that it passed agent design review.
- [ ] 4.12 Run `pnpm gates coverage --tests factory` for `add-build-gates`, `add-build-roles` and `add-build-loop`. Update `CLAUDE.md` with the build task, `pnpm factory approve`, `--until pr`, the artifact bucket and how to follow a build in the logs. Archive `add-build-gates`, then `add-build-roles`, then `add-build-loop`.
