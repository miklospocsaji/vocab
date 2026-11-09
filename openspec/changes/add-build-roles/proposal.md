# Proposal

## Why

M3 needs the roles between an approved proposal and a pull request (brief, sections 4 and 7): architect, design reviewer, planner, test author, implementer and failure classifier. The test author and implementer must run the code they write, so they need Bash. The SDK's Bash sandbox cannot start on Fargate (`add-cloud-proposal-run`, task 2.8), and the worker holds every factory secret, so Bash cannot run in the worker.

The owner decided on 2026-11-08:
- **Bash roles run in a build container** that holds only the model credential (option B). Agent-written code can reach the spend-limited API key and the worktree, and nothing else. The owner rejected a test author and implementer with no Bash ("blind implementer").
- **Role prompts move out of `.claude/agents/`** to `factory/roles/<role>.md`, with no frontmatter (option A). Claude Code registers every `.claude/agents/*.md` as a subagent, so a local session could start the implementer by hand or by auto-delegation, with none of the runner's guards. The yaml config stays the only source for a role's tools and model.

This change is build step M3.2: the roles, and the build container they run in, proven locally and in Docker.

## What Changes

- **Prompt location:** `loadRole` reads `factory/roles/<role>.md`. `.claude/agents/proposal-author.md` moves there without its frontmatter, and `.claude/agents/` is removed. The worker image stops copying it.
- **Role config:** a new field, `runsIn: worker | build`, says where a role may run. Writable globs gain `!` exclusions and the `{taskStubs}` placeholder.
- **Five session roles**, each with a config, a prompt and a zod result schema:
  - `architect` (worker): `design.md` and `app/contracts/src/**`
  - `design-reviewer` (worker): reads only; returns a verdict and findings
  - `planner` (worker): `tasks.md`; returns `tasks.json`
  - `test-author` (build): tests under `app/*/test/**` and `app/e2e/**`, plus stubs of the task's new source files
  - `implementer` (build): `app/*/src/**` except contracts, plus the app and preview stack files (owner decision, brief section 8); never tests
- **The failure classifier:** an Agent SDK session with no tools, a cap of 3 turns and structured output (owner, 2026-11-09), so it runs in both auth modes and is recorded like every other role. The brief's "single Messages API call" is amended. It returns `{ kind, evidence }`, where `kind` is `flaky`, `bug`, `design-flaw`, `spec-ambiguity` or `infra`.
- **The build container:** a `build` target of the worker Dockerfile, with the dev dependencies and a warm pnpm store. Its entry point, `factory-build <role> --input <key>`, does the following:
  - reads its input from the artifact store and clones the change branch (public, no token)
  - runs the role with Bash on its allowlist and the sandbox off
  - runs the diff check, then the gates from `add-build-gates` (red after the test author, green after the implementer)
  - writes `patch.diff`, `gates.json`, `messages.jsonl` and `outcome.json` back to the store
- **Boundaries for Bash roles:**
  - the runner refuses a `runsIn: build` role outside the build container
  - the build container refuses to start if any factory credential is in its environment
  - the **diff check** fails an attempt that changed any path outside the role's globs, however the change was made
- **An artifact store interface** (`ArtifactStore`): a filesystem store for local runs and tests, and an S3 store for the cloud. The bucket itself comes in `add-build-loop`.
- ADR 0011 (Bash roles in a build container) and ADR 0012 (role prompts outside `.claude/agents`). Amendments to ADRs 0007, 0008 and 0010, and edits to brief sections 3, 4, 5 and 8.

Out of scope:
- the states that run these roles, routing, retries and the S3 bucket (`add-build-loop`)
- the reviewer, QA explorer and retro roles (M4, M7)
- roles adding packages or dependencies: `package.json`, lockfiles and `tsconfig.json` are writable by no role in M3
- network-level egress control (ADR 0008 stands, with the new accepted risk below)

## Capabilities

### New Capabilities

### Modified Capabilities
- `roles`: where prompts live, the config fields, the five new session roles and the classifier, the build container, and the diff check.

## Impact

- `factory/roles`: config schema, prompt path, writable-glob exclusions and placeholders, `runsIn` enforcement, the diff check, six yaml configs and prompts.
- `factory/artifacts`: result schemas `design-result`, `review-result`, `plan-result`, `test-result`, `implementation-result`, `classification-result` and `build-outcome`.
- `factory/worker`: the `factory-build` entry point (`src/build.ts`), the `ArtifactStore` with filesystem and S3 implementations, and the Dockerfile `build` target.
- New pinned dependency: `@aws-sdk/client-s3`.
- `.claude/agents/` is removed. A local Claude Code session no longer lists `proposal-author` as an agent.
- **Accepted risks (owner, 2026-11-08 and 2026-11-09):** code that a build role writes can read the model credential and, with no egress control, send it anywhere. In the cloud that is the API key, which is spend-limited ($20 a month workspace) and revocable. Locally it is the owner's subscription token (`CLAUDE_CODE_OAUTH_TOKEN`), which local runs keep using (ADR 0006 unchanged).
- Live tests (`pnpm test:live`) for each role on small budgets, and Docker tests (`pnpm test:docker`) for the build container. Neither runs in `pnpm check` or CI.
- Tagged `large`: it changes the security boundary for roles that run code.
- Depends on `add-build-gates`.
