# 0006 Environments and deployment

Status: proposed (2026-11-27; owner decisions of 2026-11-27, change `add-app-foundations`)

## Context

The app gets its first infrastructure: a web app on CloudFront, an API on API Gateway and Lambda, and a Postgres database on Aurora Serverless v2 (ADR 0001). Features are built on branches and need somewhere to run before they reach `master`. The brief first planned a preview stack per pull request at `pr-<n>.vocab.logtion.app`. That means one CloudFront distribution and one certificate per pull request, which takes minutes to create and to remove.

Most of the code deployed to a pre-production environment is unreviewed when it is first deployed. The infrastructure code (`infra/`) is TypeScript that runs during synth. Whatever holds deploy credentials while it runs can do anything those credentials allow.

## Decision

- **The app has its own AWS account, 100159507559,** in eu-central-1. The only resource outside that region is the CloudFront certificate in us-east-1, which CloudFront requires there. No other workload shares the account.
- **Two environments:**

  | | Web | API | Database | Deployed from |
  | --- | --- | --- | --- | --- |
  | `test` | `test.vocab.logtion.app` | `api.test.vocab.logtion.app` | `vocab_test` | the `test` branch |
  | `prod` | `vocab.logtion.app` | `api.vocab.logtion.app` | `vocab_prod` | `master` |

  There is no stack per pull request.
- **The `test` branch is `master` plus at most one feature branch.** A deploy to `test` resets it to `master` and merges the one feature branch. When that feature is merged or rejected, `test` goes back to `master`. Only the deploy pipeline pushes it. So only one feature is in `test` at a time, while other features keep moving on their own branches.
- **Base stacks, deployed by the owner only:** `VocabZone` (the hosted zone), `VocabCertificates` (us-east-1) and `VocabShared` (the API certificate, the VPC and the Aurora cluster). They change rarely and hold what must not be lost.
- **One app stack, deployed twice,** as `VocabApp-test` and `VocabApp-prod`, from the same code with the environment's config.
- **Synth needs no credentials:**
  - `pnpm infra:synth --env <env> --out <dir>` builds the web app and synthesises the cloud assembly with no AWS calls.
  - No construct looks anything up. Values from other regions are committed in `infra/config.ts`, and values from the shared stack are SSM parameters that CloudFormation resolves at deploy time.
  - Lambdas are bundled by esbuild at synth, and there are no Docker assets.
  - CI runs synth without credentials to prove it.
- **Deploying runs no repository code:** a deploy is `cdk deploy --app <dir>` of an assembly that `infra:synth` made. The owner's `pnpm infra:deploy` does synth and deploy in one go, for deploys by hand.
- **The test database is rebuilt on every deploy:**
  - On every deploy of `test`, the migration custom resource drops and recreates the `app` schema of `vocab_test` and applies every migration. Each test run therefore starts from a known state, and a rejected feature's tables never linger.
  - On every deploy of `prod`, it applies the pending migrations only.

## Alternatives

- **A preview stack per pull request:** isolated, but slow to create and remove, with a certificate and DNS records per pull request. One `test` environment serves one feature at a time, which is enough for a one-person app.
- **`test` accumulating features until release:** fewer resets, but a rejected feature would stay in `test` and change what the next one is tested against. A stage environment that collects tested features may come later.
- **`cdk deploy` from the branch, synth included:** one step, but it runs unreviewed infrastructure code while holding deploy credentials.
- **The app in the same account as other workloads:** no new account, but a template from a feature branch could reach every other stack in it.
- **Separate accounts for `test` and `prod`:** the strongest isolation, but two clusters, two zones and twice the base stacks.

## Consequences

- **Accepted risk (owner, 2026-11-27): `test` and `prod` share the account and the cluster.** The CDK bootstrap's execution role is the same for both. A template from a feature branch could declare a resource that reaches prod, for example a Lambda granted access to the prod database's secret. Separate database roles and secrets keep honest code apart, and reviews come before any test deploy. A deterministic check of the templates before a deploy can narrow the risk later.
- One feature at a time in `test`; others wait for it to be merged or rejected.
- Test data never survives a deploy, so nothing may rely on it.
- Two ids (the hosted zone and the CloudFront certificate) are committed after the base stacks' first deploy, and must change if either resource is ever replaced.
- The CDK CLI that deploys an assembly must be at least as new as the `aws-cdk-lib` that synthesised it.
- The account is bootstrapped in eu-central-1, where the deploy pipeline is trusted, and in us-east-1, where only the owner deploys.
