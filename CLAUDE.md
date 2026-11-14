# CLAUDE.md

Kindle Vocab Software Factory. `docs/brief.md` is the source of truth; decisions live in `docs/adr/`.

## Commands

- `pnpm install`: requires Node 24 (`.nvmrc`; install fails on other versions)
- `pnpm db:up`: starts the local ledger (Postgres in Docker, port 54329). Run it before `pnpm check` or `pnpm factory`: ledger-backed tests read `FACTORY_DATABASE_URL` and fail, never skip, if it is unset
- `pnpm check`: all gates: typecheck, lint, unit tests, `openspec validate --all --strict`
- `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm spec:validate`: single gates
- `pnpm typecheck:app` / `pnpm lint:app`: the app's typecheck and lint only. The build gates and the build roles run these, never the whole repository's: whole-repo typed lint does not fit the build task. Work-item branches are cut from `master`, so anything the gates rely on must be on `master` first
- `pnpm gates coverage --change <id> --tests <dir>`: the scenario coverage gate for a change. For the factory's own changes use `--tests factory`, and `--tests infra` for the stack's scenarios
- `pnpm test:live`: real Agent SDK sessions with small budgets (`*.live.test.ts`); never in `pnpm check` or CI
- `pnpm test:docker`: tests that build and run the worker image (`*.docker.test.ts`); never in `pnpm check` or CI. Needs Docker
- `pnpm test:cloud`: tests against the deployed `Factory` stack (`*.cloud.test.ts`), with `AWS_PROFILE=vocab`; never in `pnpm check` or CI. The worker and build boundary tests spend under $0.20 of model budget together
- `pnpm infra:synth` / `pnpm infra:diff` / `pnpm infra:deploy`: the factory's CDK stack in eu-central-1, with `AWS_PROFILE=vocab`. Each needs `-c budgetEmail=<address>`, which is never committed. Ask the owner before every deploy. Run them through these scripts, not a bare `cdk`, so the webhook's esbuild bundling finds `infra`'s esbuild. A diff after any edit under `factory/` shows new images, since tests are in the image's build context
- `pnpm factory run --issue <n> --until proposal|design|plan|pr`: runs the factory locally against a GitHub issue (pushes a change branch, comments on the issue; `pr` builds the tasks in the local `vocab-factory-build:local` image and opens a pull request). It stops at every approval. Needs `gh auth login` and `CLAUDE_CODE_OAUTH_TOKEN` in the git-ignored `.env.local` (ADR 0006)
- `pnpm factory approve --issue <n>`: approves the proposal or design a local run stopped at
- `pnpm factory cost --issue <n>`: the work item's tokens, auth mode and estimated cost per attempt and in total, from the local ledger only
- `pnpm exec openspec <cmd>`: the pinned OpenSpec CLI (`list`, `show <id>`, `validate <id> --strict`, `archive <id> --yes`)

## Repo map

- `openspec/`: specs (`specs/`), active changes (`changes/`), conventions (`config.yaml`)
- `docs/`: brief and ADRs
- `app/fixtures/`: anonymised Kindle `vocab.db` fixtures and the script that makes them
- `factory/roles`: role configs (`*.yaml` + prompt) and the role runner on the Agent SDK
- `factory/artifacts`: zod schemas for role results
- `factory/ledger`: Postgres migrations, typed queries and the `LedgerRecorder`
- `factory/forge`: the `Forge` interface, `GitHubForge` and the test `FakeForge`
- `factory/orchestrator`: change ids, worktrees and git, the state handlers (Intake to Open PR, including `step`, which drives the build loop), the state machine definition, the local run loop
- `factory/gates`: the build gates (typecheck, lint, unit, red, spec, coverage) and `pnpm gates`
- `factory/cli`: the `pnpm factory` entry point (`src/main.ts`)
- `factory/worker`: the image (targets `worker`, `build`, `boundary-check`) and its entry points: `factory-worker`, which runs one state per task, and `factory-build`, which runs one test-author or implementer session or a gates-only run per task
- `infra`: the factory's CDK app (`bin/factory.ts`) and its one stack, `factory-stack.ts`: VPC with public subnets only, Aurora ledger, artifact bucket, worker, build and boundary-check task definitions, state machine, webhook Lambda, budget. Non-secret settings are in `cdk.json` context. Factory roles never write it
- `app/*`: see brief section 5; packages appear as milestones need them

## Cloud runs

- An issue labelled `factory` starts an execution of the `factory-work-item` state machine through the webhook. The owner's `/approve` comment runs the `approve` worker task, for a proposal or a `large` design. Every state is a `factory-worker <state> --issue <n>` Fargate task, except Build: the build loop runs `step` in the worker and each session in a `factory-build` Fargate task (8 GB, only the API key, no ledger access). The run ends with a pull request opened by `vocab-factory[bot]`; the owner reviews and merges it.
- A stopped or failed execution cannot be resumed (draft M3.5): relabelling ends in a `duplicate` Intake. Start again with a new issue.
- To follow a run (with `AWS_PROFILE=vocab AWS_REGION=eu-central-1`): `aws stepfunctions list-executions` and `get-execution-history` for the states, `aws logs tail` on the worker log group (one stream per task: `worker/worker/<task-id>` for worker states, `build/build/<task-id>` for build sessions; `--log-stream-name-prefix build/` follows only builds) and the webhook log group. The log group names are in the stack outputs.
- Each build attempt's evidence is in the artifact bucket (`ArtifactBucketName` output), under `work-items/<change-id>/tasks/<task-id>/<role>/<n>/`: `input.json`, `patch.diff`, `gates.json`, `messages.jsonl` and `outcome.json`; the task's `next.json` names the next build. Objects expire after 180 days.
- The ledger has no public address, so the laptop can't read it. `pnpm factory cost` doesn't work for cloud work items.
- Reading cloud cost:
  - **Per work item:** the summary comment's cost line (tokens, estimated USD, auth mode `api-key`), and the pull request's cost table per role.
  - **Model spend:** the Anthropic console, under the factory's workspace ($20 monthly limit).
  - **AWS spend:** Cost Explorer. The account is shared with other projects, so the $50 budget alarm (emails at 80% actual and 100% forecast) covers all of it. The stack tags its resources `project=vocab-factory`, but that tag isn't activated as a cost allocation tag yet.
- Don't deploy while an execution is paused if you need it unchanged. Paused executions continue on the worker family's latest revision.

## Conventions

- Every change goes through an OpenSpec change (`openspec/changes/<verb-led-id>/`), scoped to one milestone and archived when it ships.
- Tests name the scenario they prove: `it("Scenario: <exact title>", …)`.
- TypeScript is strict and erasable-only (no enums, namespaces or parameter properties), so `node file.ts` runs it directly.
- Pin dependencies exactly (`--save-exact`); the Agent SDK and OpenSpec are upgraded deliberately.
- Record significant decisions as ADRs: `docs/adr/NNNN-title.md`.
- Never commit secrets or `docs/vocab.db`.
