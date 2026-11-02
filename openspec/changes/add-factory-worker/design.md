# Design

## Components

- `factory/worker` (`@vocab/factory-worker`), new:
  - `Dockerfile` and `Dockerfile.dockerignore` (BuildKit reads the ignore file next to the Dockerfile). The build context is the repository root; see the image section below.
  - `src/main.ts`: the entry point. It loads its configuration from the environment, runs migrations, runs the state and sets the exit code. The wiring stays thin; the logic lives in `src/worker.ts`, with every dependency injected so tests can run it with a `FakeForge`, a scripted role runner, a temp bare remote and the real Postgres ledger.
- `factory/roles/src/runner.ts`:
  - `childEnv` becomes an allowlist: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TZ`, `NODE_EXTRA_CA_CERTS`, plus `OPENSPEC_TELEMETRY=0` and the credential of the effective mode.
  - The effective auth mode is `FACTORY_AUTH_MODE` if set, otherwise `role.authMode`. An invalid value throws an `AttemptFailed("config")` before `query()` is called.
  - A second `PreToolUse` hook on `Read|Grep|Glob`.
- `factory/roles/src/guard.ts`: `createReadGuard({ role, worktree })` shares the path resolution of the write guard. `Read` targets `file_path`; `Grep` and `Glob` target their optional `path`, which defaults to the worktree. The worktree root itself is allowed.
- `factory/roles/proposal-author.yaml`: `allow` replaces `WebFetch` with `WebFetch(domain:github.com)` and `WebFetch(domain:raw.githubusercontent.com)`; `maxBudgetUsd` becomes 1.5. The prompt says GitHub only.
- `factory/forge`:
  - `src/github-app.ts`: `createInstallationTokenProvider({ appId, installationId, privateKey, repository, fetch })`. It signs an RS256 JWT with `node:crypto` (`iat` 60 s in the past, `exp` 9 minutes ahead), calls `POST /app/installations/{id}/access_tokens` with `repositories` and `permissions`, and caches the token until five minutes before `expires_at`.
  - `GitHubForge` takes `token: string | (() => Promise<string>)`. The local CLI keeps passing the `gh auth token` string. The credential helper reads the token from the environment of each `git push`, as in M1.
  - `GitHubForge` gets an optional `committer` (`name`, `email`), which `commitChange` uses through `-c user.name`/`-c user.email`. For the App it is `<slug>[bot]` and `<bot-user-id>+<slug>[bot]@users.noreply.github.com`. The bot user id comes from `GET /users/<slug>[bot]` once at start-up.
- `factory/orchestrator`: no handler changes. `proposal` already returns `advance` at once for a work item past its state, which makes "Repeated worker task does nothing" hold. For `proposal`, the worker passes a fresh clone as `repo` and a temp `home`, so the worktree lives in the task's ephemeral storage. `intake` needs no clone.

## Worker contract

- Arguments: `factory-worker <state> --issue <n>`. The issue number is the only pointer a state needs, because an issue has at most one work item. Here the worker knows `intake` and `proposal`.
- Environment (set by the task definition in `add-cloud-proposal-run`; never logged):
  - `FACTORY_DATABASE_URL`, or the ledger's connection from the injected secret
  - `FACTORY_AUTH_MODE=api-key` and `ANTHROPIC_API_KEY`
  - `FACTORY_GITHUB_REPOSITORY` (`owner/repo`), the App's id, installation id and slug, and its private key
- Exit codes:
  - `0`: advanced, or nothing to do
  - `3`: escalated
  - `4`: the run ends with nothing to continue (a rejected issue)
  - `2`: invalid input, no role run
  - `1`: any other error

  The state machine routes on these, because in the simplified design nothing else reads the ledger on its behalf.

## Image (ADR 0010, after the spike)

- Base `node:24-bookworm-slim`, pinned by digest. Adds `git`, `bubblewrap`, `socat` and `ca-certificates` from Debian, and the RDS CA bundle for TLS to Aurora.
- Platform `linux/amd64`. The laptop is x86_64, so the image is built natively, and the spike runs on the same platform as Fargate. arm64 would save about 20% on Fargate minutes, which is cents a month at this volume.
- The factory runs `.ts` files directly with Node's type stripping, which refuses files under `node_modules`. So the image holds the workspace layout (root manifests, `factory/*`, `.claude/agents`, `openspec/config.yaml`) and runs `pnpm install --frozen-lockfile --prod` for the worker's dependency closure plus the pinned OpenSpec CLI. `pnpm deploy` is not used, because it would copy the workspace packages into `node_modules`.
- The ignore file is an allowlist: everything is excluded except the paths above. `.env*`, `docs/`, `app/fixtures/`, `.git` and `node_modules` never enter the build context.
- A non-root user `factory` (uid 10001). `HOME` and the work directory are in the task's ephemeral storage.
- Role configs and prompts are read from the image, not the clone, as in M1 (`loadRole` defaults to the factory's own root). The image's commit is the factory's version.

## Decisions

- **Allowlist, not denylist, for the session environment.** The M1 runner removes `ANTHROPIC_*` and `CLAUDE_CODE_*` and passes everything else. In Fargate, everything else would include `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, the GitHub token used for pushes and the database URL. An allowlist stops new variables from leaking by default.
- **The read guard replaces what the proxy would have backstopped.** The session's own process must hold the API key. Without a guard, the `Read` tool could plausibly return `/proc/self/environ`, and nothing else would stop that value reaching a fetch. This is unverified, so a live test tries it. The guard covers the tools, and the Bash allowlist covers commands.
- **The worker holds the App's private key.** Each task mints its own installation token, with no broker Lambda. The key reaches the worker's process only, never a role session: the environment allowlist and read guard keep it out. If a task were compromised beyond those, the key would be exposed, so ADR 0009 records this as an accepted trade-off along with how to rotate the key.
- **The JWT is signed with `node:crypto`.** It is about 30 lines, it avoids `@octokit/auth-app` and its dependency tree, and the token request is easy to assert against a fake API.
- **Fresh clone per Proposal task.** Fargate tasks are ephemeral, so the worker clones the repository (`--filter=blob:none`) through the same credential helper as pushes. M1's `ensureWorktree` then adds the work item's worktree under the task's temp home.
- **Docker tests are a separate project.** `*.docker.test.ts` build the image and run containers. They need Docker and take minutes, so they run through `pnpm test:docker`, like `test:live`, never in `pnpm check` or CI.

## Spike (task 1.1)

The SDK sandbox on Linux uses bubblewrap, which needs unprivileged user namespaces. Fargate allows no added capabilities, custom seccomp profiles or privileged mode. The spike runs the pinned SDK's sandbox in the draft image under `docker run` with Docker's default seccomp profile and no `--cap-add` or `--privileged`. It checks:
- whether `sandbox: { enabled: true, failIfUnavailable: true }` starts at all
- whether the read-only worktree of ADR 0007 holds
- whether the sandbox's network proxy blocks a command's outbound connection, which now matters more because no network layer sits behind it

A local pass does not prove Fargate behaves the same. Fargate itself is checked in `add-cloud-proposal-run` (scenario "Boundaries hold in Fargate"), once a cluster exists.

If the sandbox cannot run, the owner decides before ADR 0010 is written in task 1.3 (see Open questions).

## Contracts

No changes in `app/contracts/`.

## Decisions that need an ADR

- **0009 GitHub App auth:** the App's permissions and events, the private key in the worker and why there is no broker, key rotation, the bot identity, the webhook secret, and who may `/approve`. Written in task 1.2, before the Forge code.
- **0010 Worker image:** base and pinning, platform, contents, non-root user, how the image is built and tagged, and the sandbox result from the spike. Written in task 1.3, after the spike.
- **0006 amendment:** `FACTORY_AUTH_MODE` as the per-deployment override.
- **0007 amendment,** only if the spike fails: what replaces the sandbox in the worker.

## Open questions

- **If bubblewrap cannot run without privileges** (decided after the spike). With no network layer behind it, the proposal author's Bash would have no network block:
  1. **The proposal author loses Bash in the worker** (recommended). The runner already validates the change with `openspec validate --strict` after the session, so the role only loses its own check-and-fix loop and may need more attempts. M3 roles that need Bash bring the question back.
  2. **ECS on EC2 instead of Fargate** for the worker, with a custom seccomp profile. About $3–5 a month more, plus instance management.
  3. **Run Bash commands only through the deterministic runner**, never inside the session. The cleanest boundary, but it changes the role model for M3.

## Risks

- **No network layer behind the runner's checks (accepted by the owner, 2026-11-02).** A bug or a changed SDK default in the tool rules, the guard or the sandbox could let a prompt-injected session reach any host. The live boundary tests re-run on every SDK upgrade. Reconsider before M3, when roles run code they wrote.
- **What a leak would cost.** The API key sits in a dedicated workspace with a $20 monthly limit and can be revoked. The installation token lasts an hour and covers this repository only. The App's private key is the longest-lived secret; it can be rotated in the App's settings.
- **Agent SDK behaviour in a container.** The CLI may write to `HOME` or need writable caches. `HOME` and `TMPDIR` point at ephemeral storage.
- **The read guard could block something the SDK needs.** It applies to tool calls only, not to the CLI's own file access. The live tests catch a regression.
