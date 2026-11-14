# Design

## Overview

Two places run roles. The worker holds the factory's secrets and runs roles without Bash. The build container holds only the model credential and runs the roles that execute code. The worker never runs agent-written code; the build container has nothing but the API key to lose.

```
                 worker (all secrets)                       build container (API key only)
  ┌──────────────────────────────────────┐        ┌──────────────────────────────────────────┐
  │ architect, design-reviewer, planner  │        │ factory-build <role> --input <key>        │
  │ failure-classifier (no tools)        │        │  1. read input.json from the store        │
  │ sandbox on, no Bash (ADR 0007)       │ input  │  2. git clone the change branch (public)  │
  │                                      │ ─────▶ │  3. pnpm install --offline (warm store)   │
  │ Record: re-check the patch, apply,   │        │  4. role session: Bash on its allowlist,  │
  │ commit, push, write the ledger       │ ◀───── │     sandbox off, path guard, read guard   │
  └──────────────────────────────────────┘ output │  5. diff check  6. gates (red | green)    │
                                                  │  7. write patch, gates, messages, outcome │
                                                  └──────────────────────────────────────────┘
```

How inputs and outputs travel between them, and which state starts which, is `add-build-loop`'s business. This change makes both sides work against an `ArtifactStore`: a directory locally, S3 in the cloud.

## Decided (owner, 2026-11-08)

### Bash roles run in a build container (option B)

Considered after the M2 finding that `bwrap` cannot start on Fargate:
- **A. No Bash for any role; gates in a secret-free task.** The implementer would write code blind, and each red gate would cost an attempt. Rejected by the owner: a blind implementer.
- **B. Bash roles in their own task holding only the API key (chosen).** The agent runs its tests within the session. Agent-written code can reach the key, which is spend-limited and revocable.
- **C. ECS on EC2 with relaxed seccomp and AppArmor, so the sandbox starts.** Rejected in M2 for cost and complexity, and it leaves the host's `/proc` readable.

### Role prompts move to `factory/roles/<role>.md` (option A)

Considered:
- **A. Move them next to their configs, with no frontmatter (chosen).** Claude Code never loads them, and the yaml is the only source for tools and model.
- **B. Keep `.claude/agents/<role>.md` without frontmatter.** It relies on Claude Code skipping such files, and the folder still says "agents".
- **C. Keep them as subagents.** Any local session could run the implementer, by hand or by auto-delegation, with no path guard, read guard, environment allowlist or budget.

## Components

### Role config (`factory/roles/src/config.ts`)

New field: `runsIn: worker | build`, required.

Writable globs gain two things:
- **`!` exclusions**, so the implementer's `app/*/src/**` can exclude `app/contracts/**`. A path is writable when it matches some glob and no exclusion. `writableFor` and the path guard share one matcher.
- **The `{taskStubs}` placeholder**, filled per attempt with the task's source files that did not exist at the starting commit. Only the test author uses it.

### The roles

| Role | Model | Runs in | Tools | Writable | Turns | Budget | Result |
|---|---|---|---|---|---|---|---|
| architect | `claude-opus-5-5` | worker | Read, Grep, Glob, Edit, Write | `openspec/changes/{changeId}/design.md`, `app/contracts/src/**` | 40 | $1.50 | `design-result` |
| design-reviewer | `claude-sonnet-5-5` | worker | Read, Grep, Glob | none | 20 | $0.50 | `review-result` |
| planner | `claude-sonnet-5-5` | worker | Read, Grep, Glob, Edit, Write | `openspec/changes/{changeId}/tasks.md` | 25 | $0.75 | `plan-result` |
| test-author | `claude-sonnet-5-5` | build | Read, Grep, Glob, Edit, Write, Bash | `app/*/test/**`, `app/e2e/**`, `{taskStubs}` | 40 | $1.00 | `test-result` |
| implementer | `claude-sonnet-5-5` | build | Read, Grep, Glob, Edit, Write, Bash | `app/*/src/**`, `!app/contracts/**`, `infra/app-stack.ts`, `infra/preview-stack.ts`, `infra/app/**` | 60 | $1.50 | `implementation-result` |
| failure-classifier | `claude-haiku-5-5` | worker | none | none | 3 | $0.05 | `classification-result` |

The Bash allowlist of the test author and implementer:
- `Bash(pnpm typecheck)`
- `Bash(pnpm lint)`
- `Bash(pnpm exec vitest run:*)`
- `Bash(git status:*)`
- `Bash(git diff:*)`

There is no install, no `pnpm add`, no network command and no `git push`.

The runner also passes a fixed deny list to every session as SDK `disallowedTools`, whatever the role's allowlist: `Bash(git push:*)`, `Bash(curl:*)`, `Bash(wget:*)`, `Bash(ssh:*)`, `Bash(scp:*)`, `Bash(nc:*)`, `Bash(pnpm add:*)`, `Bash(pnpm install:*)`, `Bash(npm:*)` and `Bash(npx:*)`. Deny rules win over allow rules, and the CLI checks each part of a compound command. `loadRole` refuses a config whose allowlist overlaps the list: a bare `Bash` or `Bash(*)`, a rule for a command a denied rule covers (`Bash(git push:*)`, `Bash(npm install)`), or a prefix rule that a denied command starts with, such as `Bash(git:*)`. The list matches command strings, so it stops the model's own commands, not code they run: see the accepted risks.

The worker roles keep the sandbox options of ADR 0007, so their sessions still need `bubblewrap` in the image. The build roles run with `sandbox: { enabled: false }`, set explicitly.

Result schemas (`factory/artifacts`):
- `design-result`: `{ summary, contracts: string[], adrNeeded: string[], openQuestions: string[] }`
- `review-result`: `{ verdict: "approve" | "changes-requested", findings: [{ severity: "blocker" | "major" | "minor", location, summary }] }`, refined so `changes-requested` has a blocker or major finding
- `plan-result` (`tasks.json`): `{ tasks: [{ id, title, dependsOn: string[], files: string[], scenarios: string[], tests: string[] }] }`
- `test-result`: `{ tests: [{ file, scenario }], stubs: string[], notes }`
- `implementation-result`: `{ summary, notes }`
- `classification-result`: `{ kind: "flaky" | "bug" | "design-flaw" | "spec-ambiguity" | "infra", evidence: string }`
- `build-outcome`: `{ role, outcome: "passed" | "failed", reason?, roleResult?, diffCheck: { passed, outside: string[] }, gates?: string, patch: string, messages: string, baseCommit }`. Here `gates`, `patch` and `messages` are store keys, and `reason` is a runner failure reason or `diff-check`, `red` or `green`.

The planner's result is checked by `validatePlan(plan, changeDir, tasksMd, previous, paths)` in `factory/roles/src/plan.ts`, against the rules in the spec. `previous` is `tasks.md` before the session on a re-plan, or `undefined`. `paths` holds the implementer's and test author's writable globs, which the caller takes from their configs. The plan lists every task, ticked ones included, so a task's line in `tasks.md` may be ticked (`- [x] <id>`) on a re-plan. It returns every problem found, each naming its task, scenario or file. A failed check is a failed attempt, with the check's messages as evidence.

Prompts (`factory/roles/<role>.md`) follow the proposal author's structure: who you are, untrusted data, what you may write, what you return. Each role-specific prompt also says:
- **Architect:** design what the delta specs require and no more. List the contracts changed and the decisions that need an ADR. Never edit specs or tasks.
- **Design reviewer:** check the design against the delta specs, `openspec/specs/` and the contracts. Request changes only for a blocker or major finding.
- **Planner:** every task fits one implementer session. Every scenario belongs to a task. On a re-plan, leave ticked tasks alone.
- **Test author:** name each test `it("Scenario: <exact title>", …)`. Stub any new source file the tests import, with the signatures from the contracts or the design, bodies throwing `new Error("not implemented")`, and parameters prefixed `_`, which the app's lint config allows. Stub an async function without `async`, returning `Promise.reject(new Error("not implemented"))`, so `require-await` passes. Make the tests fail at run time, never at load.
- **Implementer:** make this task's tests pass without editing them. Run `pnpm exec vitest run`, `pnpm typecheck` and `pnpm lint` before returning. If the tests or the design look wrong, say so in `notes` rather than work around them.

### The failure classifier (decided by the owner, 2026-11-09)

The brief has the classifier as a single Messages API call through `@anthropic-ai/sdk`. The Messages API takes only an API key, and local runs keep the subscription token, so the classifier would have no credential locally. It runs through `runRole` instead, as a session with `tools: []` and structured output. That works in both auth modes, records cost the same way as every other role, and needs no new dependency or price table. Its input is the failed `gates.json`, the task and the changed paths, fenced as untrusted data. `maxTurns` is 3, because structured output may take a turn of its own; the live test records the real count.

### The build container

**Image.** A `build` target in `factory/worker/Dockerfile`, built `FROM worker`:
- the dev dependencies (Vitest, TypeScript, ESLint) installed from the frozen lockfile, as in `boundary-check`
- a pnpm store warmed from that lockfile, so a clone installs with `--offline`
- `FACTORY_CONTAINER=build` and the entry point `node factory/worker/src/build-main.ts`

The image is built from master at deploy time. A branch whose lockfile differs from the image's falls back to an online install, which is logged and counted.

**Entry point** (`factory/worker/src/build.ts`). `factory-build <role> --input <key>`:
1. Refuse to start (exit 2) if the environment holds any of: `FACTORY_GITHUB_APP_PRIVATE_KEY`, `FACTORY_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `FACTORY_LEDGER_SECRET`, `FACTORY_DATABASE_URL`, `FACTORY_WEBHOOK_SECRET`. The error names the variable, never its value.
2. Read `input.json`, which holds:
   - `changeId`, `branch`, `baseCommit`, and `cloneUrl`, the public URL cloned with no token
   - the task from `tasks.json`
   - the role's evidence from earlier attempts (`gates.json`, the classification, the diff check), as `{ reason, evidence }` text, fenced as untrusted in the role's prompt
   - the green gates' `coveredSoFar`

   Outputs go next to the input key. The store is `FACTORY_STORE_DIR` locally and `FACTORY_ARTIFACT_BUCKET` in the cloud. The warm store is at `FACTORY_PNPM_STORE`, and the pnpm metadata cache it needs offline is the factory user's.
3. Clone the branch into `$HOME/work` and check out `baseCommit`. Install with `pnpm install --frozen-lockfile --offline`.
4. Run the role with `runRole`, recording messages to `messages.jsonl` in the store rather than the ledger (a `JsonlRecorder` behind the same `Recorder` interface as `LedgerRecorder`).
5. Run the diff check (below).
6. If the session succeeded and the diff check passed, run the gates: red after the test author, green after the implementer. Redact the model credential's value.
7. Write `patch.diff` (`git diff --binary <baseCommit>` with untracked files added with `--intent-to-add`), `gates.json` and `outcome.json`.
8. Exit 0 when the outcome is written, whether it passed or failed. Exit 1 on a crash, exit 2 on bad input.

A work item can carry a `prompt` its caller rendered (the build roles' task prompt, the classifier's prompt) and its `taskStubs`. The runner runs `openspec validate` only for a role with writable paths, so the classifier and the design reviewer need no valid change folder.

`runRole` takes `container: "worker" | "build"` from its caller. It throws `RoleConfigError` for a `runsIn: build` role when it is not `"build"`. The worker passes `"worker"`; only `build.ts` passes `"build"`, and only when `FACTORY_CONTAINER=build`.

### The diff check (`factory/roles/src/diff-check.ts`)

`diffCheck(worktree, baseCommit, writable)` compares the working tree with `baseCommit`, which comes from `input.json` and never from the clone's `HEAD`. It uses `git diff --name-status -z --no-renames <baseCommit>` plus `git ls-files --others --exclude-standard -z`, and checks each path with the role's matcher. `git status` is not used: it compares with `HEAD`, so a commit made during the session (by agent code running `git commit`; the allowlist has no `git commit`, but `pnpm exec vitest` runs arbitrary code) would hide its files. With the base fixed, committed, staged and unstaged changes all count alike, and so do deletions. Ignored files never appear, so caches under `node_modules/` pass. For the test author, a `{taskStubs}` path must be newly added, not modified. The patch is built the same way, as `git diff --binary <baseCommit>` with untracked files added, so it holds exactly what the check saw.

Everything under `.git/` is writable by agent code too: refs, config, `info/exclude`. So the build container's check is fast feedback, not the boundary. The boundary is the worker, which runs the same matcher on the paths in `patch.diff` (`git apply --numstat -z`, with its own clean git) before it applies the patch to a fresh worktree at `baseCommit` (`add-build-loop`). A file hidden from the build container's check is also missing from its patch, so it never reaches the branch. A forged outcome or a swapped patch cannot get a path outside the role's globs committed.

### `ArtifactStore` (`factory/worker/src/store.ts`)

`get(key)`, `put(key, body)` and `exists(key)`, with two implementations:
- `FsStore(root)` for tests and local runs, with keys mapped under a root directory and `..` refused
- `S3Store(bucket)`, on `@aws-sdk/client-s3`

Keys look like `work-items/<changeId>/tasks/<taskId>/<role>/<attempt>/<file>`.

### Local runs

The CLI runs the build container with `docker run --rm`, using the locally built `build` target and the store directory mounted at `/store`, with only `CLAUDE_CODE_OAUTH_TOKEN` from `.env.local` passed in. Local runs keep the subscription, as ADR 0006 decides (owner, 2026-11-09). The token is then readable by agent-written code in the container: an accepted risk (below).

## Accepted risks (owner, 2026-11-08)

- **The model credential is reachable by agent-written code.** A test or source file the role writes runs under `pnpm exec vitest`, can read the credential from `/proc/1/environ`, and can send it anywhere.
  - In the cloud it is the API key. Limits: the $20 monthly workspace limit, revocation, and the 14-day log retention to spot it.
  - Locally it is the owner's subscription token (owner, 2026-11-09). It has no spend limit of its own and lasts until it expires or is revoked (`claude setup-token` issues a new one).
- **The build task role's credentials are reachable too, from the ECS credential endpoint.** They allow only reading and writing `work-items/*` in the artifact bucket (`add-build-loop`). The worst case is a forged or overwritten build output. The worker re-checks every patch's paths before committing, and the PR's CI run is an independent check.
- **The deny list does not stop code that an allowed command runs.** `pnpm exec vitest run` runs the tests the role wrote, and they can open sockets or call `git` directly; a rewritten command (`git -c x=y push`) can slip past the string match too. A push still fails, since the container holds no GitHub credential, and network egress stays uncontrolled, as the first risk above and the ADR 0008 amendment accept. The deny list keeps a future allowlist from granting those commands to the model by mistake.
- **The gates can be fooled from inside the container.** The implementer's code could tamper with `node_modules` or the Vitest report before the gates run. This is the same risk as in `add-build-gates`. The PR's CI run of `pnpm check` in GitHub Actions does not share the container, and from M4 the reviewer adds a second look.

## Risks

- **The SDK with the sandbox off.** No live test has run Bash with `sandbox.enabled: false` yet. The live test "Non-allowlisted command is denied" runs again in the build container, along with a new probe for compound commands (`pnpm lint && curl …`).
- **Budgets.** A task costs a test author and an implementer session plus retries, at up to $2.50 per try. The importer's plan might hold five tasks. The caps are per attempt, so the real spend has to be measured. `add-build-loop` records it in M3.3, before the exit run.
- **Stubs and lint.** The red gate runs `pnpm lint`, and `strictTypeChecked` flags unused parameters by default, `_` names included. `eslint.config.js` therefore allows `_` names for unused parameters, variables and caught errors under `app/**/*.ts` only (owner, 2026-11-12); factory code keeps the default rule. A unit test in task 2.12 lints sample stubs to pin it.
- **Image size and start-up.** The `build` target adds the dev dependencies and a pnpm store to the worker's roughly 1 GB. Task 2.11 measures it.

## Contracts

No changes in `app/contracts/`.

## Decisions that need an ADR

- **0011 Bash roles in a build container:** options A, B and C, the decision, the boundaries (`runsIn`, refusing factory credentials, the deny list, the diff check twice), and the accepted risks.
- **0012 Role prompts outside `.claude/agents`:** options A, B and C, and the decision.
- **0007 amendment:** the sandbox stays on for worker roles. Bash roles run with it off, in the build container, and the read-only-worktree decision no longer applies to them. The cache question is closed: caches go under git-ignored `node_modules` in the build container's clone.
- **0008 amendment:** the new accepted risks above, and why there is still no network layer.
- **0010 amendment:** the `build` target, and `.claude/agents` no longer in the image.
