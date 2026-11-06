# Tasks

M2 build step 1, part one: the worker and the GitHub App Forge. Runs before `add-cloud-proposal-run`, which deploys what this change builds. Every task here runs on this machine, and nothing touches AWS.

Unit tests run in `pnpm check` and need only the local ledger. Docker tests (`*.docker.test.ts`) build and run the image through `pnpm test:docker`. Live tests (`*.live.test.ts`) start real Agent SDK sessions through `pnpm test:live`. Neither runs in `pnpm check` or CI.

## Step 1: Worker and GitHub App Forge

### Decisions and spike

- [x] 1.1 Spike, with no production code: build a draft image (Node 24 slim, git, bubblewrap, socat, the pinned SDK) and run one Haiku session with the ADR 0007 sandbox options under `docker run` with the default seccomp profile and no added capabilities. Check:
  - that the sandbox starts with `failIfUnavailable: true`
  - that a Bash write into the worktree fails
  - that the sandbox's network proxy blocks an outbound connection from a sandboxed command

  Budget under $0.05, in subscription mode. Record the findings in `design.md`. If the sandbox does not start, stop and ask the owner to choose among the options in Open questions.
- [x] 1.2 Write ADR 0009 "GitHub App auth": App permissions and events, the private key held by the worker, key rotation, the bot identity, the webhook secret, and who may `/approve`. Amend ADR 0006 with `FACTORY_AUTH_MODE`.
- [x] 1.3 Write ADR 0010 "Worker image" from the spike: base and digest pin, `linux/amd64`, contents, non-root user, how the image is built, tagged and pushed (CDK `DockerImageAsset`), and the sandbox result. Amend ADR 0007 with the spike's findings and the owner's decision.

### Role runner

- [x] 1.4 Create the `factory/worker` package (`@vocab/factory-worker`) with a typecheck script and a Vitest project. Add a `docker` Vitest project for `*.docker.test.ts` and a root `pnpm test:docker` script, and exclude docker tests from `pnpm test`.
- [x] 1.5 Failing tests for the runner, with a fake `query`. Scenarios:
  - Deployment overrides the configured mode
  - Mismatched auth mode fails fast (still holds with the override)
  - Factory credentials do not reach the role session
  - Credentials stay out of the ledger

  Also cover: an invalid `FACTORY_AUTH_MODE` fails the attempt before `query()` runs, and `PATH`, `HOME` and `OPENSPEC_TELEMETRY` still reach the session.
- [x] 1.6 Write the allowlisted `childEnv` and the auth-mode override in `factory/roles/src/runner.ts`.
- [x] 1.7 Failing unit tests for the read guard on a temp worktree, and for the proposal author's config. Scenarios:
  - Reading a process environment is denied
  - Read through a symlink out of the worktree is denied
  - Reading inside the worktree is allowed
  - Three attempts stay within the work-item limit
  - Proposal author cannot run commands

  Also cover: Grep and Glob with and without `path`, Glob patterns that leave the worktree, and the config allowing `WebFetch` only with the two GitHub domain rules. This replaces the Bash expectations in `factory/roles/test/proposal-author.test.ts`.
- [x] 1.8 Write `createReadGuard` and wire it into the runner. Update `proposal-author.yaml` and `.claude/agents/proposal-author.md`: no Bash, GitHub-only `WebFetch`, `maxBudgetUsd: 1.5`, and the OpenSpec structure stated in the prompt instead of the steps that ran `openspec`.
- [x] 1.9 Live tests, in subscription mode. Scenarios:
  - WebFetch outside GitHub is denied (budget under $0.10)
  - Reading a process environment is denied, against a real session (budget under $0.10)
  - Proposal author produces a valid change without Bash (the existing proposal-author live test, budget $1.50 per attempt; record the number of attempts)

  Also confirm that a fetch from `github.com` is still allowed, and try `Glob` with the pattern `/proc/*/environ` against a real session. The existing live tests "Non-allowlisted command is denied" and "Bash cannot write outside the role's paths" keep passing, through their throwaway probe roles.

### GitHub App Forge

- [x] 1.10 Failing tests for `createInstallationTokenProvider` and `GitHubForge` with a token provider, using the injected `fetch` and a test RSA key generated in the test. Scenarios:
  - Installation token is scoped to the repository (the JWT verifies against the public key, with `iss` set to the App id and an expiry of at most 10 minutes)
  - Expiring token is refreshed
  - Token failures do not leak the token

  Also run the existing Forge contract tests against a `GitHubForge` built with a token provider.
- [x] 1.11 Write `factory/forge/src/github-app.ts` and make `GitHubForge` accept `token: string | (() => Promise<string>)` and an optional `committer`. The local CLI is unchanged.

### Worker entry point

- [ ] 1.12 Failing tests for `runWorker` in `factory/worker/src/worker.ts`, with a `FakeForge`, the scripted fake role runner, a temp bare remote and the real ledger. Scenarios:
  - Worker runs Intake for an issue
  - Worker advances a proposal
  - Repeated worker task does nothing
  - Worker reports an escalation
  - Worker reports a rejected issue
  - Unknown state is refused
  - Commits are authored by the factory's bot
- [ ] 1.13 Write `factory/worker/src/worker.ts` (migrate, clone with the credential helper for `proposal`, worktree under a temp home, call the handler, map the outcome to an exit code) and `factory/worker/src/main.ts` (configuration from the environment, real dependencies, nothing logged that contains a secret).

### Image

- [ ] 1.14 Failing docker tests in `factory/worker/test/image.docker.test.ts`. Scenario: Worker image holds no secrets. They build the image from a temp copy of the repo with a dummy `.env.local` and `docs/vocab.db` added, then inspect the image. Also check that `factory-worker design --issue 1` in the container exits 2 with no network access (`--network none`).
- [ ] 1.15 Write `factory/worker/Dockerfile` and `factory/worker/Dockerfile.dockerignore` following ADR 0010.
- [ ] 1.16 Live check in the container, with `docker run` and no added capabilities, in subscription mode, with a budget under $0.10. Scenarios:
  - Boundaries hold in the worker container
  - Missing sandbox blocks Bash (a throwaway probe role with Bash, inside the image)

  Also confirm that the Grep tool works in the image without a system `ripgrep`. Record the results in `design.md`.
