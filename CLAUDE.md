# CLAUDE.md

Kindle Vocab Software Factory. `docs/brief.md` is the source of truth; decisions live in `docs/adr/`.

## Commands

- `pnpm install`: requires Node 24 (`.nvmrc`; install fails on other versions)
- `pnpm check`: all gates: typecheck, lint, unit tests, `openspec validate --all --strict`
- `pnpm test` / `pnpm lint` / `pnpm typecheck`: single gates
- `pnpm exec openspec <cmd>`: the pinned OpenSpec CLI (`list`, `show <id>`, `validate <id> --strict`, `archive <id> --yes`)

## Repo map

- `openspec/`: specs (`specs/`), active changes (`changes/`), conventions (`config.yaml`)
- `docs/`: brief and ADRs
- `app/fixtures/`: anonymised Kindle `vocab.db` fixtures and the script that makes them
- `factory/`, `app/*`, `infra/`: see brief section 5; packages appear as milestones need them

## Conventions

- Every change goes through an OpenSpec change (`openspec/changes/<verb-led-id>/`), scoped to one milestone and archived when it ships.
- Tests name the scenario they prove: `it("Scenario: <exact title>", …)`.
- TypeScript is strict and erasable-only (no enums, namespaces or parameter properties), so `node file.ts` runs it directly.
- Pin dependencies exactly (`--save-exact`); the Agent SDK and OpenSpec are upgraded deliberately.
- Record significant decisions as ADRs: `docs/adr/NNNN-title.md`.
- Never commit secrets or `docs/vocab.db`.
