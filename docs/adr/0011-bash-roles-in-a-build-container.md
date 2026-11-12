# 0011 Bash roles in a build container

Status: accepted (2026-11-09; owner decisions of 2026-11-08 and 2026-11-09)

## Context

M3 adds the test author and the implementer (brief, section 4). Both write code and must run it: the tests, typecheck and lint. Running code means Bash, and Bash can write anywhere the process can.

What M2 left:
- The SDK's Bash sandbox (bubblewrap) cannot start in a container with no added privileges, and Fargate does not allow relaxing seccomp (ADR 0007, amendment of 2026-11-04). In the worker every Bash command fails.
- The worker holds every factory secret: the GitHub App's private key, the ledger's credentials and the API key (ADR 0009, ADR 0010). The runner keeps them out of a session's environment, and the read guard keeps Read, Grep and Glob out of `/proc` (ADR 0008). Agent-written code run by `pnpm exec vitest` would face neither: it runs as the worker's user and can read `/proc/1/environ`.
- There is no network-level egress control (ADR 0008). Whatever code can read, it can send anywhere.

## Decision

Roles with Bash run in a **build container**, a separate task that holds only the model credential (option B, owner, 2026-11-08).

- **Where roles run.** Every role config says `runsIn: worker | build`. `runRole` takes `container: "worker" | "build"` from its caller and throws `RoleConfigError` for a `runsIn: build` role when it is not `"build"`. The worker passes `"worker"`. Only the build entry point passes `"build"`, and only when `FACTORY_CONTAINER=build`. Roles that run in the worker have no Bash, and no `Bash` rule in their pre-approved calls.
- **The image.** A `build` target of the worker Dockerfile, built `FROM worker`: the dev dependencies from the frozen lockfile and a pnpm store warmed from it, `FACTORY_CONTAINER=build`, and the entry point `factory-build <role> --input <key>` (ADR 0010, amendment of 2026-11-09).
- **Refusing factory credentials.** The build entry point exits 2, before cloning or starting a session, if its environment holds any of `FACTORY_GITHUB_APP_PRIVATE_KEY`, `FACTORY_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `FACTORY_LEDGER_SECRET`, `FACTORY_DATABASE_URL` or `FACTORY_WEBHOOK_SECRET`. The error names the variable, never its value.
- **No GitHub write access.** The container clones the change branch over public HTTPS with no token, and never pushes. It writes its patch, gate result, message stream and outcome to an artifact store (S3 in the cloud, a directory locally). The worker applies the patch, commits and pushes.
- **Bash on an allowlist, sandbox off.** The test author and implementer may run `pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run:*`, `git status:*` and `git diff:*`, and nothing else: no install, no network command, no `git push`. The runner sets `sandbox: { enabled: false }` explicitly for build roles. Worker roles keep ADR 0007's sandbox options.
- **The diff check, twice.** Bash writes are not confined in the session, so writes are checked after it:
  - In the build container, `diffCheck(worktree, baseCommit, writable)` lists every path that differs from `baseCommit` (taken from the input, never from the clone's `HEAD`): committed, staged, unstaged and untracked, git-ignored files excluded. Any path outside the role's globs fails the attempt with reason `diff-check`. This is fast feedback, not the boundary, since agent code can change `.git` too.
  - In the worker, the same matcher runs on the paths in `patch.diff` before the patch is applied to a fresh worktree at `baseCommit` (`add-build-loop`). This is the boundary: a path outside the role's globs is never committed, whatever the build container reports.
- **The gates** run in the build container after the session, red after the test author and green after the implementer, with the model credential's value redacted (`add-build-gates`). The PR's CI run of `pnpm check` is the independent check.
- **Local runs** start the same image with `docker run --rm`, the store directory mounted at `/store`, and only `CLAUDE_CODE_OAUTH_TOKEN` passed in. They keep the subscription (ADR 0006; owner, 2026-11-09).

## Alternatives

- **A. No Bash for any role; the gates in a secret-free task.** The implementer would write code it cannot run, and every red gate would cost a whole attempt. Rejected by the owner: a blind implementer.
- **B. Bash roles in their own task holding only the model credential (chosen).**
- **C. ECS on EC2 with relaxed seccomp and AppArmor, so the sandbox starts.** Rejected in M2 for cost and complexity, and the weaker nested sandbox leaves the host's `/proc` readable.

## Consequences

- **Accepted risk: the model credential is reachable by agent-written code** (owner, 2026-11-08 and 2026-11-09). A test or source file the role writes runs under `pnpm exec vitest`, can read the credential from `/proc/1/environ`, and with no egress control can send it anywhere.
  - In the cloud it is the API key: limited by the $20 monthly workspace limit, revocable, and the 14-day log retention helps spot misuse.
  - Locally it is the owner's subscription token, which has no spend limit of its own and lasts until it expires or is revoked (`claude setup-token` issues a new one).
- **Accepted risk: the build task role's credentials** are reachable from the ECS credential endpoint. They allow only reading and writing `work-items/*` in the artifact bucket (`add-build-loop`). The worst case is a forged or overwritten build output, which the worker's re-check of the patch's paths and the PR's CI run contain.
- **Accepted risk: the gates can be fooled from inside the container**, for example by tampering with `node_modules` or the Vitest report. The PR's CI run does not share the container, and from M4 the reviewer adds a second look.
- The live test "Non-allowlisted command is denied" runs again in the build container, now also with a compound command (`pnpm lint && curl …`), because no live test has run Bash with the sandbox off before.
- Every build attempt pays a second task start-up and an install from the warm store. A branch whose lockfile differs from the image's falls back to an online install, which is logged and counted.
- No role may add packages in M3: `package.json`, lockfiles and `tsconfig.json` are writable by no role.
