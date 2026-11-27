# Proposal

## Why

The app is only a library so far: `app/contracts`, `app/domain` (the `vocab.db` importer) and `app/fixtures`. There is no web app, no API, no infrastructure and no deployed environment. The next features (sign-in with Cognito, trajectories, uploading a `vocab.db`) all need the same frame: packages to put code in, the dependencies they build on, a database, two environments to run in, and a way to build and deploy them. That frame is set up once, by hand, before any feature, so each feature only fills it in.

## What Changes

- **A walking skeleton, with no product behaviour.** A placeholder web page that calls `GET /health` on the API, and an API whose health check runs `SELECT 1` against the database. Once it is deployed, it proves the domains, certificates, CloudFront, API Gateway, Lambda and Aurora end to end.
- **New packages:**
  - `app/web`: React + Vite PWA shell with React Router; component tests with Vitest, happy-dom and Testing Library
  - `app/api`: Lambda handlers, a small `Db` interface with a Data API adapter (AWS) and a PGlite adapter (tests), and a migration runner
  - `infra`: the CDK app with the base stacks and the app stack, its tests, and the synth and deploy scripts
- **A contract:** `app/contracts` gains the health response.
- **Dependencies for the coming features**, so each one only uses what is already locked:
  - `oidc-client-ts` for sign-in in the web app
  - `@aws-sdk/client-rds-data` for the database
  - `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` for uploads
  - `@electric-sql/pglite` for database tests
- **Two environments** in the app's own AWS account (100159507559):

  | | Web | API | Database | Branch |
  | --- | --- | --- | --- | --- |
  | `test` | `test.vocab.logtion.app` | `api.test.vocab.logtion.app` | `vocab_test`, rebuilt on every deploy | `test` |
  | `prod` | `vocab.logtion.app` | `api.vocab.logtion.app` | `vocab_prod`, migrated on every deploy | `master` |

  The `test` branch holds `master` plus at most one feature branch, and is reset to `master` when that feature is merged or rejected. Only the deploy pipeline pushes it.
- **Base stacks, deployed once by the owner:** the hosted zone, the CloudFront certificate (us-east-1), and the shared stack (the API certificate, the VPC and one Aurora Serverless v2 cluster holding both databases).
- **One app stack, deployed as `VocabApp-test` and `VocabApp-prod`.**
- **Synth is separate from deploy.** `pnpm infra:synth --env <env> --out <dir>` builds the web app and synthesises a cloud assembly with no AWS credentials and no AWS calls. Deploying is a plain `cdk deploy --app <dir>`, which runs no code from the repository.
- **Root config:**
  - the workspace includes `infra`
  - Vitest runs `.tsx` tests in a DOM environment and the infra tests
  - ESLint knows browser globals and React hooks
  - CI also synthesises both environments
- **The brief:** the test environment replaces the per-pull-request previews. ADR 0006 records environments and deployment; ADR 0007 records the database access.
- **Out of scope:**
  - sign-in, users and the Cognito user pool (the auth feature)
  - trajectories, upload and any product table
  - e2e tests and Playwright
  - a PWA manifest and service worker
  - styling
  - deploying from CI
  - a stage environment

## Capabilities

### New Capabilities

### Modified Capabilities

None. The change is tooling and infrastructure only (`skip_specs: true`).

## Impact

- New packages `app/web`, `app/api` and `infra`; `app/contracts` gains `health.ts`.
- New dependencies, pinned exactly; the lockfile grows accordingly, and so does every fresh install.
- Root files: `pnpm-workspace.yaml`, `vitest.config.ts`, `eslint.config.js`, `package.json` scripts, `tsconfig.json`, `.gitignore`, CI.
- AWS (account 100159507559, eu-central-1, with one certificate stack in us-east-1): a hosted zone, two certificates, a VPC with no NAT, an Aurora cluster, three secrets, two S3 buckets, two CloudFront distributions, two HTTP APIs and their Lambdas. The baseline cost is a few dollars a month while the cluster is paused.
- DNS: the owner delegates `vocab.logtion.app` to the new hosted zone.
- Docs: `docs/brief.md` (environments, domains, layout), `CLAUDE.md` (commands, repo map), ADRs 0006 and 0007.
