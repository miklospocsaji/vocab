# Tasks

Built by hand (the owner or a local Claude Code session), in this order. Tests come before code within each section. Sections 1 to 6 are code; `pnpm check` is green at the end of each. Sections 7 and 8 are the owner's deploys, with `AWS_PROFILE=vocab-app`. The pull request merges after section 8, with `test` serving `/health`; `prod` is first deployed from `master` after the merge (section 9).

## 1. Workspace and root configuration

- [x] 1.1 Add `infra` to `pnpm-workspace.yaml`; create the empty packages `@vocab/web` (`app/web`), `@vocab/api` (`app/api`) and `@vocab/infra` (`infra`), each with `package.json` (`"type": "module"`, a `typecheck` script) and `tsconfig.json` extending `tsconfig.base.json`; `app/web`'s adds `jsx: "react-jsx"`, `lib` with `dom`, and `types` with `vite/client`
- [x] 1.2 Install the dependencies from design.md's table, exact versions (`--save-exact`); `aws-cdk-lib` 2.275.0 and `aws-cdk` 2.1147.0
- [x] 1.3 `vitest.config.ts`: the `node` and `web` projects from design.md (happy-dom, Testing Library cleanup and `jest-dom` matchers in a `web` setup file); `pnpm test` runs both; an empty project does not fail the run; `pnpm exec vitest run app/ --reporter=json --outputFile=<file>` runs only the `app/` tests and reports their full names
- [x] 1.4 `eslint.config.js`: browser globals and `eslint-plugin-react-hooks` for `app/web/**/*.{ts,tsx}`; the `_` unused-variable rule extended to `.tsx` and `infra/**`
- [x] 1.5 Check `.gitignore` covers `infra/cdk.out/` and `app/web/dist/`; `pnpm check` green

## 2. Contracts

- [x] 2.1 Tests in `app/contracts/test/health.test.ts`: `HealthResponse` accepts the ok and the unavailable shapes and rejects an unknown field and an unknown `database` value
- [x] 2.2 `app/contracts/src/health.ts` and its re-export from `src/index.ts`

## 3. `app/api`: database access and migrations

- [x] 3.1 Tests for the `:name` to `$n` rewrite: repeated names, a `::` cast, names inside single-quoted strings and `--` comments left alone, an unknown name rejected
- [x] 3.2 `src/db/db.ts` (the `Db`, `Row` and `Scalar` types) and `src/db/pglite.ts` (`createPgliteDb`, with the rewrite and `transaction`)
- [x] 3.3 Tests for the PGlite adapter on an in-memory PGlite: query with parameters, `null`, booleans and numbers round-trip; a failing statement in `transaction` rolls back
- [x] 3.4 Tests for the migration runner on PGlite, with test-only migrations: a fresh database gets every migration and its records; a second run applies nothing; a new migration at the end is applied alone; `reset` drops the `app` schema's tables and data and applies everything again; a failing migration leaves earlier ones recorded and itself unrecorded
- [x] 3.5 `src/migrations/index.ts` (empty list) and `src/migrate.ts`
- [x] 3.6 Tests for the Data API adapter with a stubbed `RDSDataClient` (no AWS): parameters are sent typed (`stringValue`, `longValue`, `doubleValue`, `booleanValue`, `isNull`); JSON records become rows; `DatabaseResumingException` is retried until success, and gives up after 30 s with the error; `transaction` begins, passes `transactionId`, commits, and rolls back on error
- [x] 3.7 `src/db/data-api.ts` (`createDataApiDb`)

## 4. `app/api`: handlers

- [x] 4.1 Tests for `handlers/health.ts` with a `Db` stub: 200 with `{ status: "ok", database: "ok", commit }` when `SELECT 1` works; 503 with `database: "unavailable"` when it throws; both parse with `HealthResponse`
- [x] 4.2 `handlers/health.ts`: builds its `Db` from environment variables (cluster ARN, secret ARN, database, commit), once per container
- [x] 4.3 Tests for `handlers/migrate.ts` as a custom resource handler with a `Db` stub: `Create` and `Update` run the migrations, with `reset` from the `RESET_DATABASE` environment variable; `Delete` does nothing; a migration error fails the event
- [x] 4.4 `handlers/migrate.ts`

## 5. `app/web`

- [ ] 5.1 Tests in `app/web/test/App.test.tsx` with a stubbed `fetch`: shows "checking" first, then "ok" for a healthy response, and "unavailable" for a 503, a network error or a response that fails `HealthResponse`
- [ ] 5.2 `index.html`, `vite.config.ts`, `src/main.tsx` (router with one route), `src/App.tsx`, `src/api.ts` (reads `import.meta.env.VITE_API_URL`); `pnpm --filter @vocab/web build` writes `app/web/dist`

## 6. `infra`

- [ ] 6.1 `infra/config.ts` as in design.md, with empty `base` ids
- [ ] 6.2 Infra tests (`infra/test/`, `aws:cdk:bundling-stacks: []`, fixed dummy ids passed as props, never `config.base`) for the base stacks: the zone and its `/vocab/base/hosted-zone-id` parameter; the CloudFront certificate in us-east-1 with both names; the shared stack's API certificate with both names, VPC with isolated subnets and no NAT gateway, cluster with Data API on, 0 ACU minimum, auto-pause, deletion protection and `RETAIN`, the three secrets (the environment ones in the Data API's shape), the bootstrap custom resource, its function the only one that may read the master secret, and the four SSM parameters
- [ ] 6.3 `infra/src/base/zone-stack.ts`, `certificate-stack.ts`, `shared-stack.ts`; the standalone bootstrap handler `infra/src/base/db-bootstrap/handler.ts` (roles and databases, idempotent, `CONNECT` revoked from `PUBLIC`; `CREATE ROLE` when missing, `ALTER ROLE … PASSWORD` otherwise). Tests first: unit tests of the pure `bootstrapStatements(names, passwords)`, including a refused password that does not match `^[A-Za-z0-9]{32}$`; the handler with stubbed `RDSDataClient` and `SecretsManagerClient`, which never logs secrets or SQL; and the statements run on PGlite if PGlite supports `CREATE ROLE` (checked; the test is dropped if it does not)
- [ ] 6.4 Infra tests for `VocabApp-test` and `VocabApp-prod`: private bucket with origin access control; distribution with the environment's alias, HTTPS only, SPA fallback; HTTP API with the custom domain, CORS for the web origin only and throttling; Route 53 records; the health and migrate functions on Node 24 arm64; each environment's functions may read only their own database secret and never the master secret; the migrate custom resource carries the commit and the environment's `RESET_DATABASE`; outputs `WebUrl`, `ApiUrl`, `Commit`; `prod` has termination protection and retains its bucket; no stack reports missing context
- [ ] 6.5 `infra/src/app-stack.ts` and its constructs in `infra/src/app/`; `infra/bin/app.ts` picking stacks by `-c env=base|test|prod`, with design.md's handling of empty `config.base` ids (tested)
- [ ] 6.6 `infra/scripts/synth.ts` (`pnpm infra:synth --env <env> --out <dir>`) and `infra/scripts/deploy.ts` (`pnpm infra:deploy --env <env> [--stack <name>]`), as in design.md; a test that synth refuses an unknown environment and fails on missing context
- [ ] 6.7 CI: after `pnpm check`, `pnpm infra:synth --env base` with no AWS credentials; it also passes locally with no AWS credentials in the environment
- [ ] 6.8 `CLAUDE.md`: commands (`infra:synth`, `infra:deploy`, `AWS_PROFILE=vocab-app`) and repo map (`app/web`, `app/api`, `infra`)

## 7. Base stacks (owner)

- [ ] 7.1 `pnpm infra:deploy --env base --stack VocabZone`; add an NS record for `vocab` at `logtion.app`'s DNS with the zone's four name servers; wait until `dig +short NS vocab.logtion.app` returns them
- [ ] 7.2 Commit the zone id into `infra/config.ts`; `pnpm infra:deploy --env base` (`VocabCertificates` in us-east-1 and `VocabShared`); wait for both certificates to be issued; check the five SSM parameters exist and the bootstrap made both roles and databases (a Data API `SELECT current_user` with each environment's secret)
- [ ] 7.3 Commit the certificate ARN into `infra/config.ts`; extend CI's synth step to `--env test` and `--env prod`

## 8. First app deploys (owner)

- [ ] 8.1 Create the `test` branch from this branch's head, and protect it so only the deploy pipeline may push, force pushes included (until the pipeline exists, the owner)
- [ ] 8.2 `pnpm infra:deploy --env test`; `https://test.vocab.logtion.app` shows "ok", and `https://api.test.vocab.logtion.app/health` answers 200 with this commit
- [ ] 8.3 Deploy `test` a second time and check from the migrate function's log that the `app` schema was reset

## 9. Wrap up

- [ ] 9.1 ADRs 0006 and 0007 to `accepted`; `pnpm check` and CI green; merge
- [ ] 9.2 From `master`: `pnpm infra:deploy --env prod`; `https://vocab.logtion.app` shows "ok", and `https://api.vocab.logtion.app/health` answers 200 with `master`'s commit; a second `prod` deploy applies no migration
- [ ] 9.3 Reset `test` to `master`, and archive the change (`openspec archive add-app-foundations --yes`)
