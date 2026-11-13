# Tasks

Build steps M3.3 and M3.4. Depends on `add-build-gates` and `add-build-roles`. Unit tests run in `pnpm check` with `FakeForge`, fake SDK sessions, a fake build runner, an `FsStore` and the real local ledger. Cloud tests (`*.cloud.test.ts`) run through `pnpm test:cloud`. Every deploy, AWS write and GitHub write is confirmed with the owner first.

Scenarios carried unchanged inside MODIFIED requirements keep their existing tests and are not listed below: Expiring token is refreshed, Token failures do not leak the token, Commits are authored by the factory's bot, Worker runs Intake for an issue, Worker advances a proposal, Repeated worker task does nothing, Worker reports a rejected issue, Approval from another user is ignored, Approval with nothing awaiting is answered, Proposal result is stored in the ledger. They must still pass, and the coverage run of task 4.12 checks them.

## Step M3.3: The build loop, locally

### Ledger and Forge

- [x] 3.1 Failing tests against the local Postgres for migration 0003 and its queries: tasks inserted from a plan; a re-plan supersedes only unfinished tasks; one open approval per work item, whatever its kind; attempts carry a task, a store prefix, a classification and a gates result; `design_flaws` counts.
- [x] 3.2 Write `factory/ledger/migrations/0003_build.sql` and the queries.
- [x] 3.3 Failing tests for `openPullRequest` and `findPullRequest` on `GitHubForge` (fake fetch) and `FakeForge`, and for the token request. Scenario: Installation token is scoped to the repository (now with `pull_requests: write`).
- [x] 3.4 Write them.

### Design and Plan

- [x] 3.5 Failing handler tests with fake roles. Scenarios:
  - Small change skips Design
  - Medium change gets the agent review
  - Large design waits for the owner
  - Requested changes reach the architect
  - Three rejected designs escalate
  - Plan stores its tasks

  Also: an unknown `x-complexity` escalates; each accepted design and plan is committed by the bot and pushed.
- [x] 3.6 Write the `approved` routing, `design`, the generalised `awaitApproval`, `plan`, and the design summary comment.

### Step, Record and the PR

- [x] 3.7 Failing tests for `step` with a fake build runner writing outcomes to an `FsStore`. Scenarios:
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
- [x] 3.8 Write `step`, the outcome recording and `tick`.
- [x] 3.9 Failing tests. Scenarios:
  - Pull request is opened once
  - Design flaw re-plans the unfinished tasks (handlers in sequence with fake roles)
- [x] 3.10 Write `open-pr` and the design-flaw path.

### Local run

- [x] 3.11 Failing CLI and run-loop tests with fakes. Scenarios:
  - Local run reaches the pull request
  - Summary comment is posted (unchanged, re-run)

  Also: `--until design` and `--until plan` stop where they say; a run stops at an open approval and names the `approve` command.
- [x] 3.12 Write the run loop, `pnpm factory approve`, `--until design|plan|pr` and the Docker build runner.
- [x] 3.13 With the owner's approval of each GitHub write, run the factory locally end to end on a small real issue in `app/domain` that the owner writes, up to the PR. Record here: attempts per role, tokens and estimated cost per role and in total, wall time, and anything the roles got wrong. If the typical spend is near the $5 limit, stop and bring the owner options for caps or models before M3.4.

  **Record (12 November 2026):** issue #7, "Clean up Kindle usage sentences and find the looked-up word in them", a `small` change in `app/domain`, run locally with the subscription token, up to PR #9.

  | Role | Task | Attempts | Tokens (in / out / cache read / cache write) | Estimated cost | Duration |
  |---|---|---:|---|---:|---:|
  | proposal-author | | 1 | 99,538 (8 / 3,581 / 69,318 / 26,631) | $0.30 | 33 s |
  | planner | | 1 | 46,888 (4 / 832 / 22,861 / 23,191) | $0.11 | 8 s |
  | test-author | 1.1 | 1 | 83,340 (12 / 2,236 / 64,789 / 16,303) | $0.09 | 112 s |
  | implementer | 1.1 | 1 | 79,518 (12 / 1,779 / 63,074 / 14,653) | $0.08 | 251 s |
  | test-author | 1.2 | 1 | 81,885 (12 / 2,244 / 70,942 / 8,687) | $0.06 | 76 s |
  | implementer | 1.2 | 1 | 78,752 (12 / 1,573 / 68,895 / 8,272) | $0.06 | 98 s |
  | **Total** | | **6** | **469,921** | **$0.70** | |

  - Per role: proposal author $0.30, planner $0.11, test author $0.16, implementer $0.14. No retries, no classifier call, no design (a `small` change).
  - Wall time: `--until proposal` 40 s; `--until pr` 9 min 12 s (Plan, four builds in the local `build` image, the commits and the PR). Each build's duration includes the container's clone and install.
  - The typical spend, $0.70 for a two-task change, is far from the $5 limit: no caps or model changes are needed before M3.4.
  - What went wrong, or nearly:
    - The change branch was cut from `master` before M3 was merged, so it had no `app/domain` package; the proposal author asked about it as an open question. The owner merged M3 (PR #8) and merged `master` into the change branch before approving. Intake cuts from `master`, so factory work needs the factory's own milestone merged first.
    - The proposal author and test author wrote the invisible characters (soft hyphen, zero-width characters, byte order mark, U+00A0) literally in the spec and tests, where the issue used `\u` escapes. The tests pass, but the scenarios cannot be read or reviewed by eye, and an editor may strip them.
    - The proposal's Impact says `app/domain` "may not exist yet", which was true when it ran and stale by the PR.
    - The proposal author's 4 open questions went unanswered, as nothing reads answers; none blocked the build.
    - Two factory bugs found before the run, both fixed: the Docker build runner left the store unwritable for the image's user, and `.gitignore` hid the coverage gate's test fixture from CI.
    - The pushed branch's `origin/<branch>` ref in the local worktree stays stale after `pushBranch` (it pushes to the URL, not to `origin`), so `git status` there shows "ahead 1". Cosmetic; `step` fetches before each build.

## Step M3.4: The build loop in AWS, and the exit run

### Worker and state machine

- [x] 4.1 Failing worker tests for the states `design`, `plan` (task token, `SendTaskSuccess` with ids, `SendTaskFailure` on error), `step` and `open-pr`. Scenarios:
  - Unknown state is refused
  - Failed resume is reported on the issue
  - Owner's approval resumes the execution (now naming the approval)
  - Worker reports an escalation (unchanged, re-run)
- [x] 4.2 Write the worker states and the store wiring (`S3Store` from `FACTORY_STORE_BUCKET`).
- [x] 4.3 Failing tests on `definition()`: the routes of the diagram in `design.md`, the Map's concurrency 1 and items from `$tasks`, `DesignFlaw` caught into Design, and `WorkItemEscalated` into Escalated. Scenario: Execution history holds no artifacts or secrets (static half: every state's arguments hold only the issue number, the change id, task ids, the execution ARN, exit codes and task tokens).
- [x] 4.4 Write the state machine.

### Stack

- [x] 4.5 Failing CDK assertion tests. Scenario: Build task cannot reach the factory's secrets. Also: the bucket blocks public access, enforces TLS and expires objects after 180 days; the worker role reads and writes the bucket; the state machine may run only the worker and build families and pass only their roles; the build task definition's image is the Dockerfile's `build` target.
- [x] 4.6 Write the bucket, the build task definition, its security group and the IAM changes.
- [x] 4.7 With the owner: enable Pull requests read and write in the App's settings and accept it on the installation. Amend ADRs 0002, 0003 and 0009.
- [x] 4.8 Failing cloud test `factory/worker/test/build-boundaries.cloud.test.ts`, running the build task definition with a probe input. Scenario: Build boundaries hold in Fargate (budget under $0.10). Then confirm with the owner, run `pnpm infra:diff`, `pnpm infra:deploy` and `pnpm test:cloud`, and record the results in `design.md`.

### Exit run

- [x] 4.9 Draft the importer issue (parse words, lookups and books from `vocab.db` in `app/domain`; idempotent re-import; tested against `app/fixtures/vocab.db` and `vocab-older.db`) and show it to the owner. The owner creates it and labels it `factory`. Do not deploy while its execution runs.
- [ ] 4.10 Follow the execution to its PR. Confirm and record in the M3 PR description:
  - every task in `tasks.md` ticked, each in a commit by `vocab-factory[bot]` with green gates
  - no commit by anyone else touching `app/**/src` or `app/**/test` (`git log --format='%an' -- app/` on the branch)
  - CI green on the PR
  - attempts, cost per role and in total, and wall time
  - Scenario: Execution history holds no artifacts or secrets (the scan of M2's task 4.1, extended to patches, gate output and the design)
- [ ] 4.11 If the importer was not `medium`, repeat with a second issue the owner writes, which is `medium`, up to its PR. Record that it passed agent design review.
- [ ] 4.12 Run `pnpm gates coverage --tests factory` for `add-build-gates`, `add-build-roles` and `add-build-loop`. Update `CLAUDE.md` with the build task, `pnpm factory approve`, `--until pr`, the artifact bucket and how to follow a build in the logs. Archive `add-build-gates`, then `add-build-roles`, then `add-build-loop`.
