# 0007 Database access

Status: proposed (2026-11-27; owner decisions of 2026-11-27, change `add-app-foundations`)

## Context

ADR 0001 chose Postgres on Aurora Serverless v2 for the app. Aurora has no public endpoint; it lives in a VPC. A Lambda that speaks the Postgres protocol must run inside that VPC, which brings three problems:

- It loses the internet, so calls to Cognito, S3 or SSM need a NAT Gateway (about $35 a month per AZ) or interface endpoints (about $8 a month each per AZ).
- Each concurrent Lambda opens its own connection, which usually needs RDS Proxy.
- It needs the database's credentials at run time.

All of that is much for a one-person app with a small budget. Tests also need a database: the tests and builds run where no Postgres server is available.

## Decision

- **Lambdas reach Aurora through the Data API** (`@aws-sdk/client-rds-data`), over HTTPS with IAM. They run outside the VPC, with direct internet access, and hold no connection.
- **The cluster:**
  - one Aurora Serverless v2 PostgreSQL cluster, 0 to 2 ACU, auto-pause after 10 minutes, Data API on, in a VPC with isolated subnets only and no NAT
  - one database and one role per environment: `vocab_test` and `vocab_prod`, each with its own Secrets Manager secret
  - each environment's Lambdas may read only their own secret
- **Code talks to a small `Db` interface** (`app/api/src/db/db.ts`), with named parameters (`:name`):
  - The Data API adapter is used in AWS. It retries while a paused cluster wakes.
  - The PGlite adapter (`@electric-sql/pglite`, Postgres compiled to WASM) is used in tests, so tests run real SQL and the real migrations in-process. PGlite is a dev dependency only.
- **Migrations are an ordered list of TypeScript modules** exporting SQL (`app/api/src/migrations/`), applied by a small runner that records them in `app.schema_migrations`. The list is append-only. A custom resource runs them on every deploy (ADR 0006).

## Alternatives

- **`pg` from Lambdas in the VPC with NAT:** the usual setup, with full driver features, but a fixed monthly cost several times the rest of the app's, and connection handling.
- **`pg` in the VPC with interface endpoints instead of NAT:** cheaper than NAT, but every AWS service a Lambda calls needs its own endpoint, and it still has no way out to the internet.
- **A local Postgres or Docker in tests:** the real server, but not available everywhere the tests run.
- **pg-mem in tests:** an in-memory imitation of Postgres, which misses real behaviour. PGlite is Postgres itself.
- **A migration library** (node-pg-migrate, Kysely's migrator): more features, but they assume a `pg` connection, not the Data API.

## Consequences

- The first request after a pause takes about 15 s.
- Data API limits: about 1 MB per result and 45 s per statement. Large imports write in batches.
- The `:name` to `$n` rewrite for PGlite must leave casts (`::`) and string literals alone; it is tested.
- SQL is written by hand behind `Db`; there is no ORM.
- A Data API outage takes the API down with it.
- The cluster costs only storage and backups while paused; active time is billed per ACU-hour.
