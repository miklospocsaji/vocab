# CLAUDE.md

Kindle Vocab: a web app for practising the words looked up on a Kindle. `docs/brief.md` is the source of truth; decisions live in `docs/adr/`.

## Commands

- `pnpm install`: requires Node 24 (`.nvmrc`; install fails on other versions)
- `pnpm check`: all gates: typecheck, lint, unit tests, `openspec validate --all --strict`
- `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm spec:validate`: single gates
- `pnpm exec openspec <cmd>`: the pinned OpenSpec CLI (`list`, `show <id>`, `validate <id> --strict`, `archive <id> --yes`)
- `pnpm infra:synth --env base|test|prod [--out <dir>]`: builds the web app (`test`, `prod`) and synthesises the cloud assembly, with no AWS credentials and no AWS calls; `test` and `prod` need `config.base` filled in
- `pnpm infra:deploy --env base|test|prod [--stack <name>]`: the owner's deploy by hand, with `AWS_PROFILE=vocab-app`: synth, then `cdk deploy` of that assembly

## Repo map

- `openspec/`: specs (`specs/`), active changes (`changes/`), conventions (`config.yaml`)
- `docs/`: brief and ADRs
- `app/contracts`: zod contracts
- `app/domain`: pure domain logic (the `vocab.db` importer)
- `app/api`: Lambda handlers, the `Db` interface (Data API in AWS, PGlite in tests) and the migrations
- `app/web`: the React PWA (Vite, React Router)
- `app/fixtures`: anonymised Kindle `vocab.db` fixtures and the script that makes them
- `app/*`: see brief section 2; packages appear as the work needs them
- `infra`: the CDK app: base stacks in `src/base/` (owner only), the app stack in `src/app-stack.ts` and `src/app/`, config in `config.ts`, scripts in `scripts/`

## Conventions

- Every change goes through an OpenSpec change (`openspec/changes/<verb-led-id>/`), archived when it ships.
- Tests name the scenario they prove: `it("Scenario: <exact title>", …)`.
- TypeScript is strict and erasable-only (no enums, namespaces or parameter properties), so `node file.ts` runs it directly.
- Pin dependencies exactly (`--save-exact`).
- Record significant decisions as ADRs: `docs/adr/NNNN-title.md`.
- Never commit secrets or `docs/vocab.db`.
