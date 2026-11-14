# CLAUDE.md

Kindle Vocab: a web app for practising the words looked up on a Kindle. `docs/brief.md` is the source of truth; decisions live in `docs/adr/`.

## Commands

- `pnpm install`: requires Node 24 (`.nvmrc`; install fails on other versions)
- `pnpm check`: all gates: typecheck, lint, unit tests, `openspec validate --all --strict`
- `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm spec:validate`: single gates
- `pnpm exec openspec <cmd>`: the pinned OpenSpec CLI (`list`, `show <id>`, `validate <id> --strict`, `archive <id> --yes`)

## Repo map

- `openspec/`: specs (`specs/`), active changes (`changes/`), conventions (`config.yaml`)
- `docs/`: brief and ADRs
- `app/contracts`: zod contracts
- `app/domain`: pure domain logic (the `vocab.db` importer)
- `app/fixtures`: anonymised Kindle `vocab.db` fixtures and the script that makes them
- `app/*`: see brief section 2; packages appear as the work needs them

## Conventions

- Every change goes through an OpenSpec change (`openspec/changes/<verb-led-id>/`), archived when it ships.
- Tests name the scenario they prove: `it("Scenario: <exact title>", …)`.
- TypeScript is strict and erasable-only (no enums, namespaces or parameter properties), so `node file.ts` runs it directly.
- Pin dependencies exactly (`--save-exact`).
- Record significant decisions as ADRs: `docs/adr/NNNN-title.md`.
- Never commit secrets or `docs/vocab.db`.
