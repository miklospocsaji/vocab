# Design

## Overview

The change adds three packages and the infrastructure they run on, and deploys a walking skeleton: a web page that shows the API's health, and an API whose health check reaches the database.

```
browser ──▶ CloudFront (test.vocab.logtion.app) ──▶ S3: app/web build
   │
   └──────▶ HTTP API (api.test.vocab.logtion.app) ──▶ Lambda ──▶ Data API ──▶ Aurora: vocab_test
```

Everything lives in the app's AWS account, 100159507559, in eu-central-1. The one exception is the CloudFront certificate, which CloudFront accepts only from us-east-1.

Two rules shape the infrastructure:
- **Synth makes no AWS calls.** It needs no credentials, so it can run where the code is not trusted with any. Every value it needs is in committed config or is resolved by CloudFormation at deploy time.
- **Deploying runs no repository code.** It is a plain `cdk deploy` of an already synthesised assembly.

## Layout

```
app/
├── contracts/src/health.ts      # new: the health response
├── api/                         # new: @vocab/api
│   ├── src/
│   │   ├── db/db.ts             # the Db interface
│   │   ├── db/data-api.ts       # Data API adapter (AWS)
│   │   ├── db/pglite.ts         # PGlite adapter (tests)
│   │   ├── migrations/index.ts  # the ordered list of migrations
│   │   ├── migrate.ts           # the migration runner
│   │   └── handlers/
│   │       ├── health.ts        # GET /health
│   │       └── migrate.ts       # the deploy-time custom resource
│   └── test/
├── web/                         # new: @vocab/web
│   ├── index.html
│   ├── vite.config.ts
│   ├── src/main.tsx, App.tsx, api.ts
│   └── test/
infra/                           # new: @vocab/infra
├── bin/app.ts                   # the CDK app; -c env=base|test|prod picks the stacks
├── config.ts                    # account, regions, domains, committed resource ids
├── src/
│   ├── base/                    # deployed by the owner only
│   │   ├── zone-stack.ts
│   │   ├── certificate-stack.ts
│   │   └── shared-stack.ts
│   ├── app-stack.ts             # VocabApp-<env>
│   └── app/                     # the app stack's constructs: web, api, migrations
├── scripts/synth.ts, deploy.ts
└── test/
```

`infra/src/base/` is kept apart from `infra/src/app-stack.ts` and `infra/src/app/` on purpose. The base stacks hold the zone, the certificates and the database cluster. They change rarely, and only by the owner. The app stack is what features change.

## Environments and configuration

`infra/config.ts` is plain data, imported by `bin/app.ts` and the scripts:

```ts
export const account = "100159507559";
export const region = "eu-central-1";
export const certificateRegion = "us-east-1";
export const zoneName = "vocab.logtion.app";

export const environments = {
  test: { web: "test.vocab.logtion.app", api: "api.test.vocab.logtion.app", database: "vocab_test", resetDatabase: true },
  prod: { web: "vocab.logtion.app", api: "api.vocab.logtion.app", database: "vocab_prod", resetDatabase: false },
} as const;

// Filled in by the owner after the base stacks are first deployed (tasks 7.2 and 7.3).
export const base = {
  hostedZoneId: "",
  cloudFrontCertificateArn: "",
};
```

- **Committed ids:** only the hosted zone id and the CloudFront certificate's ARN. Both cross a region, and CloudFormation cannot read another region's parameters. Neither value is secret.
  - Only `VocabCertificates` (us-east-1) uses `hostedZoneId`. `VocabShared` and the app stacks read the zone's id from SSM.
  - Only the app stacks use `cloudFrontCertificateArn`.
- **SSM parameters:** everything else, under `/vocab/base/…` in eu-central-1: the zone's id from `VocabZone`, and the shared stack's values. Stacks read them with `StringParameter.valueForStringParameter`, so CloudFormation resolves them at deploy time and synth never looks them up.
- **Empty ids:** the stacks take their config as props, so the infra tests pass fixed dummy ids and never read `config.base`. `bin/app.ts` handles an empty id by environment:
  - `base` always has `VocabZone` and `VocabShared`. It has `VocabCertificates` only once `hostedZoneId` is set, and prints a note when it leaves it out.
  - `test` and `prod` fail at once with a clear message (`config.base.cloudFrontCertificateArn is empty: deploy the base stacks first`), never with a CDK error and never with a placeholder.
- **No lookups:** `cdk.context.json` stays empty, and no construct may call `fromLookup`. An infra test fails if the synthesised assembly carries any missing context.

## Stacks

### `VocabZone` (base, eu-central-1)

- A public hosted zone for `vocab.logtion.app`. It outputs its id and name servers, and writes its id to the SSM parameter `/vocab/base/hosted-zone-id`.
- It is a stack of its own because the delegation at `logtion.app` has to be in place before any certificate can validate.

### `VocabCertificates` (base, us-east-1)

- One ACM certificate for `vocab.logtion.app` and `test.vocab.logtion.app`, DNS-validated in the zone from `config.base.hostedZoneId`.
- It outputs the ARN.

### `VocabShared` (base, eu-central-1)

- **The API certificate:** one ACM certificate for `api.vocab.logtion.app` and `api.test.vocab.logtion.app`, DNS-validated in the zone whose id it reads from `/vocab/base/hosted-zone-id`. The names are listed rather than covered by a wildcard, since `api.test` is two labels deep.
- **VPC:** two AZs, isolated subnets only, no NAT and no internet gateway. It holds only the cluster; no Lambda runs in it.
- **Aurora Serverless v2, PostgreSQL 17:** the newest 17.x in `aws-cdk-lib`'s list (`AuroraPostgresEngineVersion.VER_17_9` in 2.275.0) that supports the Data API and auto-pause, checked when it is built.
  - capacity 0 to 2 ACU, auto-pause after 10 minutes (`serverlessV2MinCapacity: 0`, `serverlessV2MaxCapacity: 2`, `serverlessV2AutoPauseDuration: Duration.minutes(10)`), with one serverless v2 writer and no readers
  - Data API on (`enableDataApi: true`)
  - deletion protection, removal policy `RETAIN`, 7-day backups
- **Secrets:**
  - the master user's secret, generated by RDS
  - one secret per environment's database user (`vocab_test`, `vocab_prod`), generated by Secrets Manager in the shape the Data API expects: `generateSecretString: { secretStringTemplate: '{"username":"vocab_test"}', generateStringKey: "password", excludePunctuation: true, passwordLength: 32 }`, and the same for `vocab_prod`
- **A database bootstrap custom resource** (Lambda over the Data API, with the master secret). It creates, idempotently:
  - the roles `vocab_test` and `vocab_prod`, each with its own secret's password and no other privileges
  - the databases `vocab_test` and `vocab_prod`, each owned by its role, with `CONNECT` revoked from `PUBLIC`
- **The bootstrap handler** (`infra/src/base/db-bootstrap/handler.ts`):
  - It lives under `infra/src/base/` because it runs with the master secret, and `app/*/src/**` is where feature work writes. It is standalone: it makes its few `RDSDataClient` and `SecretsManagerClient` calls directly and imports nothing from `@vocab/api`, so a change to `app/api` cannot change what runs with the master secret.
  - Only the bootstrap Lambda may read the master secret, and it may read both environment secrets. No app Lambda may read the master secret.
  - Postgres takes no bound parameter in `CREATE ROLE … PASSWORD`. The handler checks that each password matches `^[A-Za-z0-9]{32}$`, which `excludePunctuation` guarantees, before writing it into the statement as a literal; any other password fails the deploy. It never logs the event's secrets or the SQL.
  - It runs `CREATE ROLE` when a role is missing and `ALTER ROLE … PASSWORD` otherwise, so the roles always match their secrets.
  - A pure function `bootstrapStatements(names, passwords)` returns the SQL.
- **SSM parameters** (with `/vocab/base/hosted-zone-id` from `VocabZone`, five in all):
  - `/vocab/base/api-certificate-arn`
  - `/vocab/base/cluster-arn`
  - `/vocab/base/test/database-secret-arn`
  - `/vocab/base/prod/database-secret-arn`

The test environment's code never holds the prod database's credentials: each app stack's Lambdas may read only their own environment's secret. Isolation of the two environments is otherwise limited (ADR 0006).

### `VocabApp-<env>` (app, eu-central-1)

**Web**
- A private S3 bucket and a CloudFront distribution with origin access control.
  - alias `environments[env].web`, with the certificate from `config.base`
  - SPA fallback: 403 and 404 return `/index.html` with 200
  - HTTPS only
- A `BucketDeployment` of `app/web/dist`, which invalidates `/*`.
- Route 53 A and AAAA alias records.

**API**
- An HTTP API (API Gateway v2) with the custom domain `environments[env].api`, using the regional certificate from SSM, and Route 53 alias records.
- CORS allows only the web origin. Throttling is 20 requests per second with a burst of 40, as a cost guard.
- `GET /health`: a `NodejsFunction` from `app/api/src/handlers/health.ts`.
  - Node 24, arm64, 256 MB, 10 s timeout
  - bundled by esbuild at synth, never in Docker
  - may run Data API statements on the cluster and read its environment's secret

**Migrations**
- A `NodejsFunction` from `app/api/src/handlers/migrate.ts`, behind a custom resource `Provider`.
- Its properties include the synth's commit, so it runs on every deploy.
- For `test`, `resetDatabase: true`: it drops and recreates the schema `app` (`DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app`), then applies every migration. The role owns the schema, so this needs no `CREATEDB` and touches no other database.
- For `prod`: it applies the pending migrations only.
- A failed migration fails the deploy, and CloudFormation rolls the stack back. A migration that already committed is not undone; migrations are written to be safe to re-run up to their own commit.

**Outputs** with fixed ids, which the deploy writes to its outputs file: `WebUrl`, `ApiUrl`, and `Commit` (the synthesised commit).

**Removal**
- `test`: the bucket is destroyed with its stack.
- `prod`: the bucket is retained, and the stack has termination protection.

## `app/api`

**`Db` (`src/db/db.ts`)**

```ts
export type Scalar = string | number | boolean | null;
export type Row = Record<string, Scalar>;
export interface Db {
  query<T extends Row = Row>(sql: string, params?: Record<string, Scalar>): Promise<T[]>;
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
}
```

- SQL uses named parameters (`:name`), as the Data API does.

**The adapters**
- `createDataApiDb({ resourceArn, secretArn, database })` uses `RDSDataClient`. It retries `DatabaseResumingException` with backoff for up to 30 s, since a paused cluster takes about 15 s to wake. It maps `formatRecordsAs: "JSON"` results to rows.
- `createPgliteDb(pglite)` turns `:name` into `$n` and runs the statement on an in-memory PGlite. Tests run real Postgres SQL and the real migrations, with no database server.
- Only the Data API adapter is imported by handlers. PGlite is a dev dependency and never reaches a Lambda bundle.

**Migrations**
- `src/migrations/index.ts` exports an ordered list of `{ id: "0001-…", sql }`. Each migration is a `.ts` module exporting its SQL as a string, so there are no files to bundle.
- Each migration's `sql` is one statement, run by one `Db.query` call (found when built). PGlite's `query` takes a single statement, and the Data API documentation does not say whether `ExecuteStatement` accepts several. A feature that needs several statements ships several migrations, or the list's entries grow a list of statements in a later change.
- This change ships the runner and an empty list. The first product migration comes with the first feature that needs a table.

**The runner (`src/migrate.ts`)**
- `migrate(db, migrations, { reset })` creates `app.schema_migrations (id text primary key, applied_at timestamptz)` if it is missing.
- With `reset`, it first drops and recreates `app`.
- It applies each missing migration and records it in one transaction per migration. Migrations are applied in list order, and the list may only be appended to.

**`GET /health` (`src/handlers/health.ts`)**
- Returns `HealthResponse`: `{ status: "ok", database: "ok", commit }`.
- If `SELECT 1` fails, it returns 503 with `database: "unavailable"`. The commit comes from the function's environment.

## `app/web`

- Vite with `@vitejs/plugin-react`, React and React Router.
- `src/main.tsx` mounts the router. `App.tsx` has one route, which shows the app's name and the health state (checking, ok, or unavailable).
- `src/api.ts` fetches `GET ${import.meta.env.VITE_API_URL}/health` and validates the response with `HealthResponse`.
- The API's URL is set at build time: `infra:synth` builds the web app with `VITE_API_URL` from the environment's config, so the built files of `test` and `prod` differ only in that URL.
- `tsconfig.json`: `jsx: "react-jsx"`, `lib` adds `dom`, and `types` holds `vite/client`. The strict base settings stay.
- `oidc-client-ts` is a dependency now, unused until sign-in.
- Unstyled, apart from the browser's defaults. There is no service worker or PWA manifest yet.

## `app/contracts`

`src/health.ts` (new), re-exported from `src/index.ts`:

```ts
export const HealthResponse = z.strictObject({
  status: z.literal("ok"),
  database: z.enum(["ok", "unavailable"]),
  commit: z.string(),
});
```

The 503 response carries the same shape.

## Scripts

**`pnpm infra:synth --env base|test|prod --out <dir>`** (`infra/scripts/synth.ts`)
1. Refuses an unknown environment.
2. For `test` and `prod`, runs `vite build` for `app/web` with `VITE_API_URL=https://<api domain>`.
3. Runs `cdk synth --app "node bin/app.ts" -c env=<env> -c commit=<sha> --output <dir> --no-notices` with `CDK_DISABLE_VERSION_CHECK=1` and `CDK_DISABLE_CLI_TELEMETRY=true`. The commit is `git rev-parse HEAD`; `bin/app.ts` passes it to the health function's environment, the migrate custom resource and the `Commit` output. `bin/app.ts` builds only that environment's stacks:
   - `base`: the base stacks (`VocabCertificates` only once `hostedZoneId` is set; see "Empty ids")
   - `test` and `prod`: `VocabApp-<env>`, or a clear error while `cloudFrontCertificateArn` is empty
4. Writes `<dir>/synth.json`: `{ env, commit, stacks, aws-cdk-lib version }`.
5. Fails if the assembly reports missing context, which would mean a lookup slipped in.

It needs no AWS credentials, and runs with none in its environment. Lambda code is bundled by esbuild during synth, and the web build is an ordinary directory asset.

**`pnpm infra:deploy --env <env> [--stack <name>]`** (`infra/scripts/deploy.ts`)
- The owner's command for deploys by hand, with `AWS_PROFILE=vocab-app`.
- Runs `infra:synth` into `infra/cdk.out/<env>`, then `cdk deploy --app infra/cdk.out/<env> --all --require-approval broadening --outputs-file infra/cdk.out/<env>-outputs.json`.
- `--stack <name>` deploys just that stack (`cdk deploy --app <dir> <name> …`) instead of `--all`.
- The deploy pipeline does not use this script. It runs its own `cdk deploy --app <dir>` on an assembly that `infra:synth` made, so it runs no repository code.

**Versions:** `aws-cdk-lib` **2.275.0** and `aws-cdk` **2.1147.0**, pinned exactly. The CLI that deploys an assembly must be at least as new as the `aws-cdk-lib` that synthesised it, and the deploy pipeline deploys with `aws-cdk` 2.1147.0. So `aws-cdk-lib` is not upgraded past what that CLI can deploy, and an upgrade of either is a deliberate change agreed with the pipeline.

**Bootstrap:** already done (27 November 2026), with `aws-cdk` 2.1147.0 and the default qualifier, in eu-central-1 (where the deploy pipeline's account is trusted) and in us-east-1 (owner only). Nothing in this change bootstraps again.

**Lambda bundling:** `NodejsFunction` with the root `pnpm-lock.yaml` as `depsLockFilePath`, `format: OutputFormat.ESM`, target `node24`, and a `createRequire` banner for packages that still `require`. `forceDockerBundling` stays off; `esbuild` comes from `infra`'s dev dependencies.

## Root configuration

- `pnpm-workspace.yaml`: `app/*` and `infra`.
- `vitest.config.ts`: two projects.
  - `node`: `app/*/test/**/*.test.ts` except `app/web`, plus `infra/test/**/*.test.ts`
  - `web`: `app/web/test/**/*.test.{ts,tsx}` in happy-dom, with Testing Library's cleanup
  - `pnpm test` runs both.
  - A run filtered by path, such as `pnpm exec vitest run app/`, with Vitest's JSON reporter (`--reporter=json --outputFile=<file>`), must still work and report every test's full name. Automation runs the unit tests that way.
- Infra tests synthesise stacks with the context `aws:cdk:bundling-stacks: []`, so they skip the esbuild bundling and stay fast.
- `eslint.config.js`: browser globals and `eslint-plugin-react-hooks` for `app/web/**/*.{ts,tsx}`, and the `_` rule extended to `infra/**` and `.tsx`.
- `package.json` scripts: `infra:synth`, `infra:deploy`. `pnpm check` is unchanged in shape: typecheck, lint, test, spec.
- CI: after `pnpm check`, `pnpm infra:synth --env base`, with no AWS credentials, which proves synth needs none and makes no lookups. Task 7.3 extends it to `--env test` and `--env prod` once the certificate ARN is committed. CI never deploys.
- `.gitignore`: `infra/cdk.out/` (already covered by `cdk.out/`) and `app/web/dist/` (covered by `dist/`). No change is needed beyond checking it.

## Dependencies

All pinned exactly. Versions are the current ones when the change is built, except `aws-cdk-lib` and `aws-cdk` (above). Later features cannot add dependencies of their own, so this list is what they build on; a missing one means a hand-made change like this one.

| Package | Dependencies | Dev dependencies |
| --- | --- | --- |
| `app/web` | `react`, `react-dom`, `react-router`, `oidc-client-ts`, `@vocab/contracts` | `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`, `happy-dom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `@testing-library/jest-dom` |
| `app/api` | `@aws-sdk/client-rds-data`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@vocab/contracts` | `@types/aws-lambda`, `@electric-sql/pglite` |
| `infra` | `aws-cdk-lib`, `constructs`, `@aws-sdk/client-rds-data`, `@aws-sdk/client-secrets-manager` (the bootstrap handler) | `aws-cdk`, `esbuild` |
| root | | `eslint-plugin-react-hooks` |

`@aws-sdk/*` are bundled into each Lambda rather than taken from the runtime, so the versions in the lockfile are the ones that run.

## Contracts

- `app/contracts/src/health.ts` (new): `HealthResponse`.
- `app/contracts/src/index.ts`: re-exports it.

## Decisions that need an ADR

- **0006 Environments and deployment:**
  - the `test` and `prod` environments in one account
  - the `test` branch and its reset to `master`
  - base stacks deployed by the owner, and one app stack deployed per environment
  - synth without credentials, and deploying an assembly
  - the test database rebuilt on every deploy
  - the accepted risk that `test` and `prod` share an account
- **0007 Database access:** Aurora Serverless v2 through the Data API, with Lambdas outside the VPC; one database and one role per environment; the `Db` interface with PGlite in tests; migrations as ordered modules.

## Risks

- **Waking a paused cluster.** The first request after a pause takes about 15 s, and the Data API answers `DatabaseResumingException` until the cluster is up. The adapter retries for up to 30 s, and the health Lambda's timeout covers that. Each health check wakes the cluster; nothing polls it.
- **Named parameters on PGlite.** The `:name` to `$n` rewrite must leave `::` casts and quoted strings alone. It is tested on both.
- **Data API limits:** about 1 MB per result, and statements of up to 45 s. Fine for this app's sizes. A large import is written in batches.
- **CloudFront is slow to create.** The first deploy of each environment takes 5 to 15 minutes; later deploys that change only files are fast.
- **Committed base ids.** If the zone or the certificate is ever replaced, `config.ts` must change with it. Both live in base stacks that rarely change.
- **`test` and `prod` share the account and the cluster.** A template from a feature branch could grant itself access to the prod database. Accepted by the owner (ADR 0006): reviews come before any test deploy.
