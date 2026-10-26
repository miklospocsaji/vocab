# Kindle Vocab Software Factory — Bootstrap Brief

Oct 25, 2026 · @Miki

## Purpose and how to use this brief

We are building an autonomous software factory first and a vocabulary app second. The app (section 6) is the factory's first workload. The factory is the thing being learned, measured and improved.

**Learning goals for the owner**

- Build agent roles with the Claude Agent SDK (TypeScript): hooks, subagents, sessions, permissions, structured outputs.
- Orchestrate them durably: retries, timers, human-approval signals, replayable state.
- Run agents safely: sandboxed workers, egress control, short-lived credentials.
- Measure the factory itself: success rate, cost, wall time and human interventions per work item.

**Instructions to Claude Code**

1. Read this whole brief before writing code. Treat it as the source of truth; propose changes to it as edits, not silent deviations.
2. Work milestone by milestone (section 7). Do not start a milestone before the previous one meets its exit criteria.
3. Build a walking skeleton: a thin end-to-end path first, then thicken it. Prefer a working stub over a complete but unconnected component.
4. Record every significant technical decision as an ADR in `docs/adr/NNNN-title.md` (context, decision, alternatives, consequences).
5. When a decision belongs to the owner (section 8 lists known ones), stop and ask. Offer 2–3 options with a recommendation.
6. Keep `CLAUDE.md` short and current: build/test commands, repo map, conventions. Put role-specific knowledge in skills and agent definitions, not in `CLAUDE.md`.
7. Never put secrets in the repo, prompts or logs.

## Guiding principles

The factory is a deterministic program that calls agents for judgement work; agents never control the flow.

1. **Deterministic skeleton, agentic leaves.** The state machine, gates, retries, budgets, merge and deployment are plain code. Agents only write specs, tests and code, review, and explore. The deployer is never an agent.
2. **Narrow roles, enforced boundaries.** Each role has its own model, tool allowlist, writable paths (enforced by a `PreToolUse` hook), turn limit and token budget.
3. **Tests before code, by a different agent.** The test author writes tests from the acceptance criteria; the implementer cannot edit them. The reviewer starts in a fresh session and never sees the implementer's transcript.
4. **Artifacts, not conversations, between steps.** Every step emits an artifact: OpenSpec files validated by `openspec validate --strict`, or a small JSON result validated by zod. All are recorded in the ledger. Steps are replayable and swappable.
5. **Verification gates decide "done".** Typecheck, lint, unit, e2e, preview deploy, QA report and review verdict. No gate, no progress.
6. **Fail, classify, retry with context, escalate.** A cheap classifier labels each failure; retries carry the failure evidence; after N attempts the item escalates to the owner.
7. **Humans approve at gates, not in loops.** The owner approves specs, chooses UX directions and accepts releases. Everything between is autonomous.
8. **Measure the factory.** Every work item records cost, turns, attempts, wall time and interventions. A benchmark of reference tasks is re-run on every factory change.
9. **Behaviour lives in the repo.** Role prompts, skills, agent definitions, hooks and evals are versioned files, changed through merge requests like code.
10. **Cheapest model that passes.** Default to Haiku or Sonnet; reserve Opus for spec and architecture. Model choice per role is configuration, not code.

## Target architecture

A GitHub issue labelled `factory` starts a Step Functions execution that walks one work item from intake to release, calling agent roles as Fargate tasks.

&#91;embedded content: work-item flow · 11 states, 3 decision points, per-task build loop\]

Inside the build loop a failing gate goes to the classifier: bugs retry the task, design flaws send the change back to Design, and spec ambiguity or infrastructure problems escalate to the owner.

### Components

| Component | Responsibility | Implementation |
| --- | --- | --- |
| Forge adapter | Read issues, post comments, open and merge PRs, receive webhooks | GitHub App + `@octokit`, behind a `Forge` interface |
| Intake | Turn a webhook into a work item and start an execution | API Gateway + Lambda |
| Orchestrator | The work-item state machine: order, retries, waits, budgets, the per-task loop | Step Functions (Standard), defined in CDK |
| Factory worker | One container image that runs any role | Node + Agent SDK + OpenSpec CLI + git + Playwright, on ECS Fargate |
| Role runner | Loads role config, runs the agent, validates the output | TypeScript in `factory/roles/` |
| Spec tooling | Validate and archive OpenSpec changes | `openspec` CLI, called by the deterministic runner |
| Gates | Typecheck, lint, unit, e2e, contract checks, `openspec validate`, scenario coverage | Deterministic scripts run in the worker, never by an agent |
| Deployer | Per-PR preview stack, production release | CDK deploy, deterministic |
| Ledger | Work items, attempts, artifacts, costs, events | Postgres (Aurora Serverless v2) or DynamoDB; JSON results in S3 |
| Approvals | Pause for owner decisions and resume | Step Functions `waitForTaskToken`, resumed by a PR/issue comment command |
| Console | One page per work item: state, tasks, attempts, cost, links | Small read-only web page over the ledger (milestone 6) |
| Secrets | Model key, GitHub App key | AWS Secrets Manager, injected per task |

### Work-item states

1. **Intake:** check the issue states a requirement; create the ledger row and a verb-led OpenSpec change id (for example `add-vocab-import`), which is also the branch name.
2. **Proposal:** the proposal author writes `proposal.md` (why, what, impact) and delta specs (requirements with WHEN/THEN scenarios) under `openspec/changes/<id>/`, and tags the change `small`, `medium` or `large`. Open questions go to the owner as an issue comment. `openspec validate <id> --strict` must pass.
3. **Proposal approval (human):** the owner replies `/approve` or edits the files on the branch.
4. **Design:** the architect writes `design.md` (components, data model, decisions, risks) and the code contracts in `app/contracts/`. Skipped for `small` changes.
5. **Design review:** `large` changes wait for owner approval, `medium` changes get a fresh-context design-reviewer agent, `small` changes skip it.
6. **Plan:** the planner writes `tasks.md` (numbered checklist) and a `tasks.json` result listing each task's dependencies, files, scenarios and tests. Every task must fit one implementer session.
7. **Build loop, per task in order:** the test author writes failing tests for the task's scenarios, the implementer makes them pass, then the gates run. When they pass, the runner ticks the task in `tasks.md` and commits. A Step Functions Map state iterates the tasks; independent tasks may run in parallel later.
8. **Review:** a fresh-context reviewer checks the whole diff against the delta specs, `design.md` and the contracts, and returns a verdict.
9. **Preview + QA:** deploy the preview stack; the QA agent exercises the scenarios on desktop and mobile viewports.
10. **Acceptance (human):** the owner reviews the PR with the QA report and merges, or auto-merge for low-risk labels.
11. **Release:** production deploy, then the runner runs `openspec archive <id> --yes`, which merges the deltas into `openspec/specs/`, and commits. The retro agent records lessons.

Failure loop: the classifier labels a failure as `flaky`, `bug`, `design-flaw`, `spec-ambiguity` or `infra`. A bug retries the current task with the evidence (max 3). A design flaw sends the change back to Design with the evidence, then the planner re-plans the unfinished tasks. Spec ambiguity returns to the owner. Infra retries with backoff, then escalates. A reviewer verdict of `changes-requested` is classified the same way.

### Artifacts and the OpenSpec layout

OpenSpec is the format for intent, design and tasks, so the owner can read, edit or hand-run any stage with the normal OpenSpec workflow. One GitHub issue maps to one OpenSpec change.

```
openspec/
├── …                                  # project conventions, created by `openspec init`
├── specs/<capability>/spec.md         # source of truth: current requirements and scenarios
└── changes/
    ├── <change-id>/
    │   ├── proposal.md                # why, what, impact
    │   ├── specs/<capability>/spec.md # delta: ADDED / MODIFIED / REMOVED / RENAMED requirements
    │   ├── design.md                  # how; omitted for small changes
    │   └── tasks.md                   # numbered implementation checklist
    └── archive/YYYY-MM-DD-<change-id>/
```

The scenarios in the delta specs are the acceptance criteria. Each test names the scenario it proves, and a gate checks that every scenario in the change has at least one test.

Results OpenSpec has no place for are small JSON artifacts with zod schemas in `factory/artifacts/`, stored in S3 by work item and attempt. They never go in the change folder.

| Artifact | Produced by | Consumed by |
| --- | --- | --- |
| `proposal.md` + delta specs | Proposal author | Every later step |
| `design.md` + `app/contracts/` | Architect | Planner, test author, implementer, reviewer |
| `tasks.md` + `tasks.json` | Planner | Build loop |
| Test diff per task | Test author | Implementer, gates |
| Code diff per task, PR | Implementer | Gates, reviewer |
| `gates.json` | Gates | Classifier, ledger |
| `review.json` (verdict, findings) | Design reviewer, reviewer | Orchestrator |
| `qa-report.json` + screenshots | QA explorer | Owner, orchestrator |
| `retro.md` | Retro | Factory improvement PRs |

## Role catalog

Ten agent roles, each defined by one config file in `factory/roles/<role>.yaml` plus a prompt in `.claude/agents/<role>.md`. Models are starting defaults; tune them from benchmark results.

| Role | Default model | Tools | May write | Output | Turn cap |
| --- | --- | --- | --- | --- | --- |
| Proposal author | `claude-opus-5-5` | Read, Grep, Glob, WebFetch, Bash (`openspec` only) | `openspec/changes/<id>/` except `design.md` and `tasks.md` | `proposal.md`, delta specs, complexity tag | 30 |
| Architect | `claude-opus-5-5` | Read, Grep, Glob, Edit, Write | `openspec/changes/<id>/design.md`, `app/contracts/` | `design.md`, contracts | 40 |
| Design reviewer | `claude-sonnet-5-5` | Read, Grep, Glob | nothing | `review.json` | 20 |
| Planner | `claude-sonnet-5-5` | Read, Grep, Glob, Edit, Write | `openspec/changes/<id>/tasks.md` | `tasks.md`, `tasks.json` | 25 |
| Test author | `claude-sonnet-5-5` | Read, Grep, Glob, Edit, Write, Bash | `app/**/test/`, `app/e2e/` | test diff for one task | 40 |
| Implementer | `claude-sonnet-5-5` | Read, Grep, Glob, Edit, Write, Bash | `app/**/src/`, `infra/` | code diff for one task | 60 |
| Reviewer | `claude-sonnet-5-5` | Read, Grep, Glob | nothing | `review.json` | 25 |
| QA explorer | `claude-sonnet-5-5` | Playwright MCP, Read | nothing | `qa-report.json` + screenshots | 60 |
| Failure classifier | `claude-haiku-5-5` | none (input in prompt) | nothing | `{kind, evidence}` | 1 |
| Retro | `claude-haiku-5-5` | Read | `factory/lessons/` (via PR) | `retro.md` | 20 |

**Rules that apply to every role**

- The role runner wraps `query()` from `@anthropic-ai/claude-agent-sdk`. It sets `cwd` to the work item's worktree, `allowedTools` from config, `maxTurns`, and a `PreToolUse` hook that blocks writes outside the role's paths.
- Every role starts from the change folder and the current `openspec/specs/` for the affected capabilities. Only the proposal author changes requirements and only the architect changes design. The implementer never edits `tasks.md`; the runner ticks a task once its gates pass.
- Bash is allowlisted per role (for example `pnpm test`, `pnpm lint`, `git diff`, `openspec validate`). No network commands, no `git push`; the deterministic runner pushes.
- The final message must be the role's JSON result. The runner validates it against its schema, and validates any OpenSpec files with `openspec validate <id> --strict`; invalid output counts as a failed attempt.
- Every SDK message is streamed to the ledger with token usage, so cost per role, per task and per work item is always known.
- Prompts receive only artifacts, never other roles' transcripts.

**Role runner sketch** (verify option names against the current Agent SDK TypeScript reference):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

export async function runRole(role: RoleConfig, item: WorkItem): Promise<Artifact> {
  const guardPaths = async (input: any) => {
    const path = input.tool_input?.file_path ?? "";
    return role.writable.some((g) => minimatch(path, g))
      ? {}
      : { decision: "block", reason: `${role.name} may only write ${role.writable.join(", ")}` };
  };

  let last = "";
  for await (const msg of query({
    prompt: renderPrompt(role, item),
    options: {
      cwd: item.worktree,
      model: role.model,
      allowedTools: role.tools,
      maxTurns: role.maxTurns,
      hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [guardPaths] }] },
    },
  })) {
    await ledger.record(item.id, role.name, msg);
    last = extractText(msg) ?? last;
  }
  return role.schema.parse(JSON.parse(last));
}
```

## Stack, repo layout, infrastructure and security

One TypeScript monorepo holds the factory, the app and all infrastructure; everything deploys to one AWS account with CDK.

### Stack

| Area | Choice |
| --- | --- |
| Language | TypeScript (strict) everywhere, Node 22 LTS |
| Package manager | pnpm workspaces |
| Agents | `@anthropic-ai/claude-agent-sdk`; Anthropic API key in Secrets Manager |
| Specs and tasks | OpenSpec: CLI in the worker image and locally; changes under `openspec/changes/` |
| Orchestration | AWS Step Functions (Standard workflows), Map state for the per-task loop |
| Agent compute | ECS Fargate tasks from one `factory-worker` image in ECR |
| Infrastructure | AWS CDK v2 (TypeScript) |
| App frontend | React + Vite PWA, responsive for desktop and mobile; S3 + CloudFront |
| App backend | API Gateway + Lambda; Postgres on Aurora Serverless v2 |
| Auth | Amazon Cognito |
| Validation | zod for every JSON result, API payload, contract and config |
| Tests | Vitest (unit), Playwright (e2e and QA) |
| Forge | GitHub: issues as the backlog, PRs as the unit of change, a GitHub App for the factory |

### Repo layout

```
/
├── CLAUDE.md                 # build/test commands, repo map, conventions (short)
├── .claude/
│   ├── agents/               # one prompt file per role
│   ├── skills/               # reusable know-how (e.g. writing-scenarios, splitting-tasks)
│   └── settings.json         # hooks shared by local Claude Code and the worker
├── openspec/                 # specs, active changes, archive (see section 3)
├── docs/
│   ├── brief.md              # this document
│   └── adr/                  # architecture decision records
├── factory/
│   ├── roles/                # role configs (yaml) + role runner
│   ├── artifacts/            # zod schemas for every JSON result
│   ├── orchestrator/         # state machine definition + task handlers
│   ├── forge/                # Forge interface + GitHub implementation
│   ├── ledger/               # data access for work items, tasks, attempts, costs
│   ├── gates/                # deterministic checks, incl. scenario coverage
│   ├── lessons/              # curated lessons written by the retro role
│   ├── benchmark/            # reference tasks + runner + results
│   └── worker/               # Dockerfile for factory-worker
├── app/
│   ├── contracts/            # zod/OpenAPI contracts written by the architect
│   ├── web/                  # React PWA
│   ├── api/                  # Lambda handlers
│   ├── domain/               # pure domain logic (FSRS scheduling, import parsing)
│   ├── e2e/                  # Playwright tests
│   └── fixtures/             # sample vocab.db, sample EPUB
├── evals/
│   └── enrichment/           # word-in-context translation eval set
└── infra/
    ├── factory-stack.ts
    ├── app-stack.ts
    └── preview-stack.ts      # one instance per PR
```

### Environments

- **Factory:** one long-lived stack (Step Functions, Fargate cluster, ledger, intake API).
- **Preview:** one app stack per open PR, named `pr-<number>`, destroyed on merge or close.
- **Production:** one app stack, deployed only by the Release state.

### Security

- Worker tasks run in private subnets. Egress goes through a proxy or security-group allowlist: Anthropic API, GitHub, npm registry, the preview URL. Nothing else.
- Each task gets a short-lived GitHub App installation token scoped to this repo, and no AWS credentials beyond reading its inputs and writing its artifacts. Deploys use a separate deployer role that agents never hold.
- Agent-visible content from issues, web pages or the app under test is data, never instructions. Role prompts say so, and hooks enforce the path and command allowlists regardless.
- Monthly AWS budget alarm and a per-work-item token budget; exceeding either pauses the execution and notifies the owner.

## First workload: the Kindle vocabulary app

A responsive web app where learners upload the words they looked up on their Kindle and practise them with the book context, a translation into their own language and dictionary examples.

### Users and trajectories

- A **user** has an account and a mother language (the owner's is Hungarian).
- A user has one or more **learning trajectories**. A trajectory maps one foreign language (the books' language) to the user's own language, for example German → Hungarian.
- Kindle **word collections** are uploaded into a trajectory. An upload can contain several books; words are filed under the trajectory matching the book's language.

### Every word must carry

1. The **book** it came from (title, author).
2. Its **contexts**: every sentence where the user looked it up, and the surrounding paragraph when the book text is available.
3. **Translations** into the trajectory's own language, with the sense matched to each context.
4. **Dictionary example sentences** in the foreign language, with translations.

### Source data

The Kindle stores lookups in `system/vocabulary/vocab.db`, a SQLite file the user copies over USB. Expected tables (verify against the real fixture before coding):

| Table | Key columns | Use |
| --- | --- | --- |
| `WORDS` | `id`, `word`, `stem`, `lang`, `timestamp` | The looked-up word and its lemma |
| `LOOKUPS` | `word_key`, `book_key`, `usage`, `timestamp` | One lookup; `usage` is the sentence context |
| `BOOK_INFO` | `id`, `title`, `authors`, `lang` | The book |

- The sentence context comes free in `LOOKUPS.usage`. Paragraph context needs the book text, so the user may optionally upload a DRM-free EPUB of the same book; the importer then locates each sentence and stores its paragraph.
- Re-uploading a newer `vocab.db` must be idempotent: only new lookups are added.

### Enrichment pipeline

- Runs asynchronously after upload (S3 → SQS → Lambda), never on the read path.
- For each new word in context, one Claude call (Batch API where latency allows) returns: lemma, part of speech, the sense used in this context, its translation into the own language, and 2–3 graded example sentences with translations.
- Ground with open data where available (Wiktionary extracts via kaikki.org, Tatoeba sentence pairs) and record which source each item came from.
- Quality is measured by `evals/enrichment/`: about 50 word-in-context cases per language pair with the expected Hungarian sense. Any prompt or model change must not lower the score.

### Practice

- Scheduling uses FSRS (via the `ts-fsrs` library); never a home-made algorithm.
- A review shows the word in the user's own book sentence first, then reveals translation and examples.
- Users can filter practice by trajectory and by book, and mark words as known or as ignored.

### UX process

- The owner wants alternatives, not a single design. Before the first UI milestone the factory produces three distinct directions as clickable prototypes, for desktop and mobile. Starting candidates:
  - **Context-first cloze:** the book sentence with the word blanked; reveal gives translation and examples.
  - **Mobile swipe triage:** swipe to mark known or to drill, feeding FSRS.
  - **Book shelf:** each book is a deck with progress; practise words from the book being read now.
- The owner picks or blends one. The result is frozen as a design system (tokens, components, layouts) that implementers must follow; the QA agent checks screenshots against it.

### Non-functional

- Works on current mobile Safari and Chrome and on desktop browsers; installable as a PWA.
- Importing a 2,000-word `vocab.db` completes, including enrichment, within 15 minutes.
- Personal data stays in one AWS region (eu-central-1).

## Milestones

Eight milestones, each ending in a working end-to-end path; app features enter as factory workload from milestone 3 onwards.

1. **M0 Foundations**
   - Deliverables: monorepo with pnpm, strict TS, Vitest, lint; `openspec init` with project conventions filled in; `CLAUDE.md`; ADRs 0001–0003 (stack, orchestration, ledger store); a basic GitHub Actions CI running the gates on every PR, including `openspec validate --strict`; a real `vocab.db` fixture from the owner (anonymised if needed) in `app/fixtures/`.
   - Exit: `pnpm check` runs typecheck, lint, tests and OpenSpec validation green locally and in CI.
2. **M1 Local walking skeleton**
   - Deliverables: `Forge` interface + GitHub implementation; role runner; proposal-author role; zod schema for its JSON result; a local ledger (Postgres in Docker); CLI `pnpm factory run --issue <n> --until proposal`.
   - Exit: running the CLI against a real issue creates a branch with an OpenSpec change that passes `openspec validate --strict`, posts a summary as an issue comment, and records cost in the ledger.
3. **M2 Cloud skeleton**
   - Deliverables: `factory-worker` image; factory CDK stack (intake API, Step Functions, Fargate, Secrets Manager, ledger); states Intake → Proposal → Proposal approval with `waitForTaskToken`; `/approve` comment command resumes it.
   - Exit: labelling an issue `factory` produces a validated change within minutes; `/approve` moves the execution on; nothing runs on the laptop.
4. **M3 Design, plan and build loop**
   - Deliverables: architect, design-reviewer, planner, test-author, implementer and failure-classifier roles; complexity routing (small skips design, medium gets the agent review, large waits for the owner); the per-task Map loop with gates, task ticking and retry with evidence (max 3); `design-flaw` routing back to Design and re-planning; scenario-coverage gate; PR opening by the deterministic runner.
   - First workload issue: the `vocab.db` importer in `app/domain/` (parse words, lookups and books; idempotent re-import), tested against the fixture.
   - Exit: the importer PR has every task in `tasks.md` ticked with green gates and no human edits to code or tests, and at least one `medium` change has passed through agent design review.
5. **M4 Review, preview, QA and release**
   - Deliverables: reviewer role; per-PR preview stack; QA-explorer role with Playwright MCP on desktop and mobile viewports; QA report and screenshots attached to the PR; acceptance gate; Release state with production deploy and `openspec archive <id> --yes`.
   - Workload: auth with Cognito, trajectories CRUD, upload of `vocab.db` with a minimal unstyled UI.
   - Exit: on a PR with a deliberately seeded UI bug, the QA agent or reviewer catches it; after a merge, the change is archived and `openspec/specs/` reflects it.
6. **M5 UX directions**
   - Deliverables: three clickable prototype directions (section 6) for desktop and mobile, linked from an issue; owner choice recorded in an ADR; design system (tokens, components, layouts) committed; QA checks screenshots against it.
   - Exit: the owner has picked a direction and the existing UI is restyled by the factory to match.
7. **M6 Enrichment, practice and the factory console**
   - Workload: enrichment pipeline with the `evals/enrichment/` gate; FSRS practice flow; filters by trajectory and book.
   - Factory deliverables: console page per work item (state, task progress, attempts, cost, links); per-item token budgets and the monthly budget alarm, both pausing executions.
   - Exit: the owner can import their own Kindle data and practise; every work item's cost is visible in one place.
8. **M7 Self-improving factory**
   - Deliverables: benchmark of 10 reference tasks (replays of earlier issues) with a runner and a results table; retro role opening PRs to `factory/lessons/`, skills and role prompts; model routing per role driven by benchmark results.
   - Workload: optional EPUB upload for paragraph context.
   - Exit: a baseline benchmark run is recorded, and at least one retro PR has measurably improved success rate or cost.

## Owner decisions

Decided on 26 October 2026. Claude Code treats these as requirements and records each in an ADR when its milestone starts.

- [x] **Model billing (M1):** local runs use the subscription's Agent SDK credit; cloud runs (M2 onwards) use an Anthropic API key. The role runner supports both auth modes by config, and the ledger records which mode each run used, since subscription runs have no exact per-call price (record tokens, estimate cost).
- [x] **Ledger store (M0):** a dedicated Aurora Serverless v2 Postgres cluster with auto-pause, separate from the app's.
- [x] **Capabilities (M0):** app: `vocab-import`, `trajectories`, `enrichment`, `practice`, `auth`. Factory: `orchestration`, `roles`, `gates`. The factory capabilities are specified in OpenSpec from M0, so Claude Code builds the factory through OpenSpec changes too.
- [x] **Complexity rules (M3):** small = one capability, no schema or contract change; medium = a contract or schema change within one capability; large = several capabilities, new infrastructure, or anything touching auth or security.
- [x] **Auto-merge policy (M4):** small changes merge themselves on green gates, an approving review and a clean QA report; medium and large changes wait for the owner.
- [x] **Budget limits (M2):** $50 a month AWS budget alarm; $10 model spend per work item.
- [x] **Languages (M3):** English → Hungarian first; the enrichment eval set starts with this pair.
- [x] **Users (M4):** owner only. Admin-created Cognito users, no sign-up page; the data model stays multi-user.
- [x] **Fixture data (M0):** an anonymised copy in git, produced by a committed script that keeps the structure and real sentences from a few books and strips device IDs and ASINs.
- [x] **UX direction (M5):** decide after the three prototypes; no leaning before then.
- [x] **Domain (M4):** web app at `vocab.logtion.app`, API at `api.vocab.logtion.app`. The owner's domain `logtion.app` delegates `vocab.logtion.app` to a Route 53 hosted zone in the app's AWS account (NS records added at the owner's DNS). Previews live at `pr-<n>.vocab.logtion.app` and `api.pr-<n>.vocab.logtion.app`. Certificates come from ACM with DNS validation; the CloudFront certificate must be issued in us-east-1, while the API certificate lives in eu-central-1.
