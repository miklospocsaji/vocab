# Design

## Components

- `factory/worker` (`@vocab/factory-worker`), new:
  - `Dockerfile` and `Dockerfile.dockerignore` (BuildKit reads the ignore file next to the Dockerfile). The build context is the repository root; see the image section below.
  - `src/main.ts`: the entry point. It loads its configuration from the environment, runs migrations, runs the state and sets the exit code. The wiring stays thin; the logic lives in `src/worker.ts`, with every dependency injected so tests can run it with a `FakeForge`, a scripted role runner, a temp bare remote and the real Postgres ledger.
- `factory/roles/src/runner.ts`:
  - `childEnv` becomes an allowlist: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TZ`, `NODE_EXTRA_CA_CERTS`, plus `OPENSPEC_TELEMETRY=0` and the credential of the effective mode.
  - The effective auth mode is `FACTORY_AUTH_MODE` if set, otherwise `role.authMode`. An invalid value throws an `AttemptFailed("config")` before `query()` is called.
  - A second `PreToolUse` hook on `Read|Grep|Glob`.
  - The sandbox options stay as they are for any role with Bash. The proposal author has none, so they do not affect it.
- `factory/roles/src/guard.ts`: `createReadGuard({ role, worktree })` shares the path resolution of the write guard. `Read` targets `file_path`; `Grep` and `Glob` target their optional `path`, which defaults to the worktree. The worktree root itself is allowed. `Glob` is also denied when its `pattern` could leave the `path`: an absolute or `~` start, or a `..` segment, including inside braces. Grep's `glob` only filters within its search root, so it needs no check.
- `factory/roles/proposal-author.yaml`: `allow` replaces `WebFetch` with `WebFetch(domain:github.com)` and `WebFetch(domain:raw.githubusercontent.com)`; `maxBudgetUsd` becomes 1.5; `tools` and `allow` lose Bash and its four `openspec` rules. The prompt says GitHub only, drops the steps that ran `openspec`, and states the expected structure of `proposal.md` and delta specs directly, taken from `openspec instructions` at the pinned version. An OpenSpec upgrade re-checks that text.
- `factory/forge`:
  - `src/github-app.ts`: `createInstallationTokenProvider({ appId, installationId, privateKey, repository, fetch })`. It signs an RS256 JWT with `node:crypto` (`iat` 60 s in the past, `exp` 9 minutes ahead), calls `POST /app/installations/{id}/access_tokens` with `repositories` and `permissions`, and caches the token until five minutes before `expires_at`.
  - `GitHubForge` takes `token: string | (() => Promise<string>)`. The local CLI keeps passing the `gh auth token` string. The credential helper reads the token from the environment of each `git push`, as in M1.
  - `GitHubForge` gets an optional `committer` (`name`, `email`), which `commitChange` uses through `-c user.name`/`-c user.email`. For the App it is `<slug>[bot]` and `<bot-user-id>+<slug>[bot]@users.noreply.github.com`. The bot user id comes from `GET /users/<slug>[bot]` once at start-up.
- `factory/worker/src/config.ts`: the command line (`parseWorkerArgs`) and the configuration from the environment (`workerConfig`): `FACTORY_DATABASE_URL`, `FACTORY_GITHUB_REPOSITORY`, `FACTORY_GITHUB_APP_ID`, `FACTORY_GITHUB_APP_INSTALLATION_ID`, `FACTORY_GITHUB_APP_SLUG` and `FACTORY_GITHUB_APP_PRIVATE_KEY` (a PEM; `\n` escapes are accepted). Errors name the variable, never its value. `main.ts` checks the command line before anything else, so invalid input exits 2 with no configuration or network, and removes the private key and the database URL from `process.env` once read.
- The `Forge` gains `clone(directory)`. `GitHubForge` clones with `--filter=blob:none` through the push credential helper, given with `git -c`, so nothing is written into the clone's config. `FakeForge` clones its `remote`. `appCommitter({ slug, token })` in `github-app.ts` looks up the bot user and returns its git identity.
- `factory/orchestrator`: no handler logic changes. `ProposalContext` gains an optional `committer`, passed to `commitChange`. `proposal` already returns `advance` at once for a work item past its state, which makes "Repeated worker task does nothing" hold. For `proposal`, the worker passes a fresh clone as `repo` and a temp `home`, so the worktree lives in the task's ephemeral storage. `intake` needs no clone.

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

## Image (ADR 0010)

- Base `node:24-bookworm-slim`, pinned by digest. Adds `git`, `ca-certificates`, `bubblewrap` and `socat` from Debian, and the RDS CA bundle for TLS to Aurora (pinned by checksum). `bubblewrap` and `socat` are needed although no role in the image uses Bash: without them the SDK refuses to start any session (see the task 1.16 results).
- Platform `linux/amd64`. The laptop is x86_64, so the image is built natively, and the spike runs on the same platform as Fargate. arm64 would save about 20% on Fargate minutes, which is cents a month at this volume.
- The factory runs `.ts` files directly with Node's type stripping, which refuses files under `node_modules`. So the image holds the workspace layout (root manifests, `factory/*`, `.claude/agents`, `openspec/config.yaml`) and runs `pnpm install --frozen-lockfile --prod` for the worker's dependency closure plus the pinned OpenSpec CLI. `pnpm deploy` is not used, because it would copy the workspace packages into `node_modules`.
- The ignore file is an allowlist: everything is excluded except the paths above, plus `tsconfig.base.json` (which every `factory/*/tsconfig.json` extends) and the two Vitest configs, so the live check can run the tests inside the image. `.env*`, `docs/`, `app/`, `.git` and `node_modules` never enter the build context.
- The OpenSpec CLI moves from the root's `devDependencies` to its `dependencies` (same pinned version), because the factory runs it at run time and `--prod` would leave it out.
- A non-root user `factory` (uid 10001). `HOME` and the work directory are in the task's ephemeral storage.
- Role configs and prompts are read from the image, not the clone, as in M1 (`loadRole` defaults to the factory's own root). The image's commit is the factory's version.

## Decisions

- **Allowlist, not denylist, for the session environment.** The M1 runner removes `ANTHROPIC_*` and `CLAUDE_CODE_*` and passes everything else. In Fargate, everything else would include `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, the GitHub token used for pushes and the database URL. An allowlist stops new variables from leaking by default.
- **The read guard replaces what the proxy would have backstopped.** The session's own process must hold the API key. Without a guard, the `Read` tool could plausibly return `/proc/self/environ`, and nothing else would stop that value reaching a fetch. This is unverified, so a live test tries it. The guard covers the tools, and the proposal author has no way to run commands.
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

The sandbox could not run, so the owner decided before ADR 0010 was written (see below).

### Spike findings (task 1.1, 2026-11-02, SDK 0.3.310, Docker on Linux, non-root user, no added capabilities)

Base image `node:24-bookworm-slim`, digest `sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`. Draft image about 1.2 GB (the design guessed 400 MB). All sessions used Haiku, about $0.005 in total.

| Container settings | Sandbox options | Result |
| --- | --- | --- |
| Docker defaults | ADR 0007 | bubblewrap cannot start: "No permissions to create new namespace" |
| Docker defaults | plus `enableWeakerNestedSandbox` | same failure |
| seccomp unconfined only | none (bubblewrap directly) | user namespace works; bubblewrap fails: "Failed to make / slave" |
| AppArmor unconfined only | none (bubblewrap directly) | no user namespace |
| both unconfined | ADR 0007 | bubblewrap fails: "Can't mount proc" |
| both unconfined | plus `enableWeakerNestedSandbox` | works: a write to the worktree fails with "Read-only file system", and `curl https://example.com` is denied by the sandbox's network proxy |

- **The sandbox does not run under Docker's default settings.** Both seccomp and AppArmor block it. Fargate does not allow relaxing seccomp, so it very likely fails there too. That has not been tested on Fargate.
- **The working combination has a cost.** `enableWeakerNestedSandbox` leaves the host's `/proc` readable by sandboxed commands, and it needs a host that allows unconfined containers.
- **It fails closed, but not the way ADR 0007 says.** With `failIfUnavailable: true`, every Bash command fails with exit code 1, so nothing runs unconfined. The session itself carries on and ends with result `success`. ADR 0007 says the attempt fails; it does not. A role without working Bash can therefore still succeed, and the runner's own validation still applies.

### Live results (task 1.9, 2026-11-05, SDK 0.3.310, subscription mode, on the laptop)

| Test | Model | Result | Cost |
| --- | --- | --- | --- |
| WebFetch outside GitHub is denied | Haiku | `example.com` denied by `dontAsk` and listed in `permission_denials`; `github.com` fetched | $0.0015 |
| Reading a process environment is denied | Haiku | `/proc/self/environ` and the parent's `/proc/<pid>/environ` refused; no environment content in any tool result | $0.0007 |
| Read through a worktree symlink to `/proc/self/environ` | Haiku | denied by the read guard | $0.0006 |
| `Glob` with the pattern `/proc/*/environ` | Haiku | denied by the read guard ("can leave the worktree") | $0.0005 |
| Non-allowlisted command is denied | Haiku | passes | $0.0017 |
| Bash cannot write outside the role's paths | Haiku | passes | $0.0011 |
| Proposal author produces a valid change without Bash | Opus | valid on the first of three attempts (`x-complexity: large`) | $0.2656 |

- **The Read tool refuses `/proc` paths itself, before the read guard runs.** A direct `Read` of `/proc/self/environ` returns the tool's own error ("names a device or process file that this tool does not read"). The SDK checks the tool's input before `PreToolUse` hooks, so the guard never sees that call. The live test accepts either refusal. A worktree symlink to `/proc/self/environ` passes the tool's own check, and the read guard denies it, so the guard does matter against a real session. The tool's check is SDK behaviour, not ours, and an upgrade could change it.
- **The proposal author needed one attempt without Bash**, at $0.27, against M1's $0.37 with Bash. One run is not a rate; the exit run of `add-cloud-proposal-run` records attempts again.

### Container results (task 1.16, 2026-11-06, SDK 0.3.310, subscription mode, `docker run` with no added capabilities and the default seccomp profile)

| Test | Model | Result | Cost |
| --- | --- | --- | --- |
| Write outside the allowed paths is denied | Haiku | passes | $0.0011 |
| WebFetch outside GitHub is denied | Haiku | passes | $0.0020 |
| Reading a process environment is denied | Haiku | passes | $0.0012 |
| Proposal author cannot run commands | none (config check) | passes | $0 |
| Missing sandbox blocks Bash | Haiku | an allowlisted `touch` inside the writable paths fails with the sandbox's error, and the file does not exist | $0.0016 |
| Grep without a system ripgrep | Haiku | the Grep tool finds the file (the SDK's bundled ripgrep); `rg` is not on `PATH` | $0.0010 |

- **Without `bubblewrap` and `socat`, no session starts.** The first run, on the image as ADR 0010 first described it, failed every session before the first model call ($0): "Sandbox required but unavailable: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed". The runner sets the sandbox with `failIfUnavailable: true` for every role, including the proposal author, which has no Bash. The spike had `bubblewrap` installed, so it only saw Bash commands fail. With the binaries missing, the SDK refuses the whole session instead. The owner chose to install them in the image (2026-11-06). Sessions then start, and Bash fails per command, as in the spike.
- The live check runs from `factory/worker/test/container.live.test.ts` (`pnpm test:live factory/worker/test/container.live.test.ts`). It builds the image, adds Vitest in a test-only layer (`factory/worker/test/live-check.Dockerfile`, replaced on 2026-11-06 by the Dockerfile's `boundary-check` target), and runs the tests in the container. The checks that hold only in the image are in the `container` Vitest project (`*.container.test.ts`), which never runs in `pnpm check`, `test:live` or `test:docker`. About $0.008 in all, including one debugging probe.
- The image is 991 MB.

## Contracts

No changes in `app/contracts/`.

## Decisions that need an ADR

- **0009 GitHub App auth:** the App's permissions and events, the private key in the worker and why there is no broker, key rotation, the bot identity, the webhook secret, and who may `/approve`. Written in task 1.2, before the Forge code.
- **0010 Worker image:** base and pinning, platform, contents, non-root user, how the image is built and tagged, and the sandbox result from the spike. Written in task 1.3.
- **0006 amendment:** `FACTORY_AUTH_MODE` as the per-deployment override.
- **0007 amendment:** the spike's findings, the corrected `failIfUnavailable` behaviour, and no Bash for the proposal author.

## Decided: no Bash for the proposal author (owner, 2026-11-04)

The owner considered four options after the spike and chose the first:
1. **The proposal author loses Bash (chosen).** It applies locally too, so one config serves both. The runner already validates the change after the session, so the role only loses its own check-and-fix loop. It may need more attempts, which the exit run measures.
2. Keep Bash on its allowlist with the sandbox off: rejected, because only the allowlist would stand between a session and the worker's secrets.
3. ECS on EC2 with seccomp and AppArmor unconfined and `enableWeakerNestedSandbox`: rejected, because it costs more and undoes part of the simplified design.
4. Only the deterministic runner runs commands: no new work in M2, where it amounts to option 1. It stays open for M3.

**M3 must decide how the test author and implementer run code.** They need Bash, the sandbox probably does not run on Fargate, and there is no network layer behind it. An allowlist entry for `pnpm test` does not contain code the agent wrote. Task 2.7 of `add-cloud-proposal-run` records whether the sandbox starts on Fargate, as input to that decision.

## Risks

- **No network layer behind the runner's checks (accepted by the owner, 2026-11-02).** A bug or a changed SDK default in the tool rules or the guard could let a prompt-injected session reach any host. The live boundary tests re-run on every SDK upgrade. Reconsider before M3, when roles run code they wrote.
- **What a leak would cost.** The API key sits in a dedicated workspace with a $20 monthly limit and can be revoked. The installation token lasts an hour and covers this repository only. The App's private key is the longest-lived secret; it can be rotated in the App's settings.
- **Agent SDK behaviour in a container.** The CLI may write to `HOME` or need writable caches. `HOME` and `TMPDIR` point at ephemeral storage.
- **The read guard could block something the SDK needs.** It applies to tool calls only, not to the CLI's own file access. The live tests catch a regression.
- **More proposal attempts.** Without Bash the role cannot check its own work, and an invalid proposal costs another attempt, about $0.37 at M1's cost. The three attempts at $1.50 stay within the $5 limit. The exit run records how many attempts it took.
