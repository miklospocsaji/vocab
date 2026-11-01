# CLAUDE.md

Kindle Vocab Software Factory. `docs/brief.md` is the source of truth; decisions live in `docs/adr/`.

## Commands

- `pnpm install`: requires Node 24 (`.nvmrc`; install fails on other versions)
- `pnpm db:up`: starts the local ledger (Postgres in Docker, port 54329). Run it before `pnpm check` or `pnpm factory`: ledger-backed tests read `FACTORY_DATABASE_URL` and fail, never skip, if it is unset
- `pnpm check`: all gates: typecheck, lint, unit tests, `openspec validate --all --strict`
- `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm spec:validate`: single gates
- `pnpm test:live`: real Agent SDK sessions with small budgets (`*.live.test.ts`); never in `pnpm check` or CI
- `pnpm factory run --issue <n> --until proposal`: runs the factory locally against a GitHub issue (pushes a change branch, comments on the issue). Needs `gh auth login` and `CLAUDE_CODE_OAUTH_TOKEN` in the git-ignored `.env.local` (ADR 0006)
- `pnpm factory cost --issue <n>`: the work item's tokens, auth mode and estimated cost per attempt and in total
- `pnpm exec openspec <cmd>`: the pinned OpenSpec CLI (`list`, `show <id>`, `validate <id> --strict`, `archive <id> --yes`)

## Repo map

- `openspec/`: specs (`specs/`), active changes (`changes/`), conventions (`config.yaml`)
- `docs/`: brief and ADRs
- `app/fixtures/`: anonymised Kindle `vocab.db` fixtures and the script that makes them
- `factory/roles`: role configs (`*.yaml` + prompt) and the role runner on the Agent SDK
- `factory/artifacts`: zod schemas for role results
- `factory/ledger`: Postgres migrations, typed queries and the `LedgerRecorder`
- `factory/forge`: the `Forge` interface, `GitHubForge` and the test `FakeForge`
- `factory/orchestrator`: change ids, worktrees and git, the Intake and Proposal handlers, the local run loop
- `factory/cli`: the `pnpm factory` entry point (`src/main.ts`)
- `app/*`, `infra/`: see brief section 5; packages appear as milestones need them

## Conventions

- Every change goes through an OpenSpec change (`openspec/changes/<verb-led-id>/`), scoped to one milestone and archived when it ships.
- Tests name the scenario they prove: `it("Scenario: <exact title>", …)`.
- TypeScript is strict and erasable-only (no enums, namespaces or parameter properties), so `node file.ts` runs it directly.
- Pin dependencies exactly (`--save-exact`); the Agent SDK and OpenSpec are upgraded deliberately.
- Record significant decisions as ADRs: `docs/adr/NNNN-title.md`.
- Never commit secrets or `docs/vocab.db`.
