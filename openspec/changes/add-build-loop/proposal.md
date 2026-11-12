# Proposal

## Why

M3's exit (brief, section 7) is a pull request for the `vocab.db` importer, with every task ticked on green gates and no human edits to code or tests, plus at least one `medium` change that passed agent design review. `add-build-gates` and `add-build-roles` provide the checks and the roles. This change connects them into the work item's flow after Proposal approval:

```
Design → Design review → Plan → Build loop (per task: tests → code → gates) → pull request
```

It routes on complexity, retries failed tasks with evidence, sends design flaws back to Design, and ticks tasks as they pass. It is build steps M3.3 (the flow, run locally) and M3.4 (the same flow in AWS, and the exit run).

## What Changes

- **Complexity routing after Proposal approval**, from `x-complexity`:
  - `small`: straight to Plan
  - `medium`: Design, then the design reviewer
  - `large`: Design, then the owner's `/approve`
- **Design:** the architect writes `design.md` and contracts. Validated with `--strict`, up to 3 attempts. For `medium`, a fresh design reviewer follows. `changes-requested` sends its findings to the next architect attempt, still within the 3.
- **Owner design approval** for `large`: the same `waitForTaskToken` and `/approve` as proposal approval, with a design summary comment.
- **Plan:** the planner writes `tasks.md` and returns `tasks.json`, checked by `validatePlan`, up to 3 attempts. Its tasks go to the ledger. Plan returns the unfinished task ids to the execution.
- **Build loop:** a Step Functions Map over the task ids, one task at a time. Per task, a worker `step` state decides the next move from the ledger and prepares the build container's input. Build states run `factory-build` (`add-build-roles`) in the build task:
  1. the test author, until the red gate passes
  2. the implementer, until the green gate passes
- **Record:** the worker reads each build outcome from the artifact store, writes its messages, tokens and cost to the ledger, re-checks the patch's paths, then applies, commits and pushes it as the App's bot. After green gates it ticks the task in `tasks.md` in the same commit.
- **Failure routing**, by the failure classifier after a failed green gate:
  - `bug`: retry the implementer with the evidence, up to 3 implementer attempts per task
  - `flaky`: re-run only the gates, once
  - `design-flaw`: back to Design with the evidence, then re-plan the unfinished tasks; at most 2 design flaws per work item
  - `spec-ambiguity`: escalate to the owner with the question
  - `infra`: wait and retry the build, twice, then escalate

  A failed red gate retries the test author, up to 3 attempts.
- **Pull request:** when every task is done, the worker opens a PR from the change branch to `master` with the task list, the cost per role and a link to the issue. The work item becomes `pr-open`.
- **The artifact store in AWS:** one S3 bucket. The worker reads and writes it; the build task reads and writes `work-items/*` only. Role results stay on their attempts in the ledger (ADR 0003 amendment); build outputs live in the bucket, and the ledger keeps their keys.
- **The build task** in the factory stack: its own task definition from the `build` image target, with one secret (the API key), a task role limited to the bucket prefix, and a security group with no ingress that Aurora does not admit.
- **The GitHub App** asks for `pull_requests: write` too.
- **Local runs** go as far as the PR: `pnpm factory run --issue <n> --until design|plan|pr`, `pnpm factory approve --issue <n>`, and the build container through Docker.
- **Two items left from M2:**
  - a failed `approve` task now comments on the issue
  - the approval comment says which approval it closed

Out of scope:
- the reviewer, preview, QA, acceptance and release (M4); the PR waits for the owner
- independent tasks in parallel (the Map runs with concurrency 1)
- a running per-work-item budget that pauses the execution (M6); M3.3 measures the spend instead
- gating `/approve` on unanswered open questions (they are answered on the branch, which the factory cannot judge)
- roles adding packages or dependencies; a task that needs one ends as `spec-ambiguity`

## Capabilities

### New Capabilities

### Modified Capabilities
- `orchestration`: the states from Proposal approval to the pull request, the Map loop, retries and failure routing, task ticking, the artifact store, the PR, and the local run up to the PR.
- `roles`: the build container's boundaries checked on Fargate.

## Impact

- `factory/orchestrator`:
  - handlers `design`, `plan`, `step`, `open-pr` and the generalised approval
  - the state machine with the Map loop
  - the local run loop up to the PR
  - new exit codes
- `factory/worker`: the new states, and the store wiring.
- `factory/forge`: `openPullRequest` and `findPullRequest` on the `Forge` interface, `GitHubForge` and `FakeForge`.
- `factory/ledger`: migration `0003_build.sql`, which adds tasks, the approval kind, task and store keys on attempts, and design-flaw counts.
- `factory/cli`: `--until design|plan|pr` and `approve`.
- `infra/factory-stack.ts`: the bucket, the build task definition and its security group, and IAM for the worker, the build task and the state machine.
- The owner enables Pull requests read and write in the App's settings. ADR 0009 is amended.
- Running cost: the bucket costs cents. Each task runs about four Fargate tasks, each with a minute of start-up. Model tokens dominate and are measured in M3.3.
- Tagged `large`: new infrastructure, and the factory's GitHub permissions.
- Depends on `add-build-gates` and `add-build-roles`.
