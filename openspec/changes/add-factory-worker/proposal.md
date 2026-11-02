# Proposal

## Why

M2 moves the factory off the laptop. Every state must then run unattended in a container, with short-lived, scoped credentials that the agent cannot see (brief, sections 3 and 5). The owner removed network-level egress control on 2026-11-02, so the limits on what an agent can read and fetch now sit in the role runner. This change builds what can be built and tested on this machine before any cloud infrastructure exists: the `factory-worker` image, the worker entry point, a hardened role runner and a Forge that acts as the factory's GitHub App. `add-cloud-proposal-run` deploys them.

## What Changes

- A `factory-worker` container image (`factory/worker/Dockerfile`): Node 24, the factory's code at the deployed commit, the pinned Agent SDK and OpenSpec CLI, git, and the SDK sandbox's dependencies (bubblewrap, socat). It runs as a non-root user and holds no secrets.
- A worker entry point, `factory-worker <state> --issue <n>`. It runs one state (here `intake` and `proposal`; `add-cloud-proposal-run` adds the rest), and reports the outcome by exit code. Runs migrations at start-up, as the CLI does.
- The role runner builds the session's environment from an allowlist instead of a denylist. GitHub tokens, AWS credentials, the ECS credential endpoint and the database URL never reach a role session.
- A read guard: Read, Grep and Glob are denied outside the worktree, including `/proc`, so a session cannot read a process's environment.
- The proposal author's `WebFetch` is limited to GitHub, replacing "any URL" (owner decision of 2026-10-27, changed 2026-11-02).
- The proposal author's per-attempt budget drops from $3 to $1.50, so its three attempts fit the $5 work-item limit.
- A deployment can set the auth mode for all roles with `FACTORY_AUTH_MODE`. The factory stack sets `api-key`. Local runs keep each role's configured mode.
- GitHub App authentication for the Forge: installation tokens scoped to this repository with the least permissions the factory needs, refreshed before they expire, and commits authored by the App's bot user. The owner's `gh` token remains the local CLI's credential.
- A spike that checks whether the SDK sandbox (bubblewrap) runs in a container with no added privileges, as on Fargate, before the image design is fixed.

Out of scope:
- the AWS infrastructure, Step Functions, the webhook and `/approve` (`add-cloud-proposal-run`)
- network-level egress control (removed by the owner)
- enforcing the $5 limit as a running total across roles (M6); until then it holds by the budget arithmetic for the one role that exists
- Playwright in the image (M4, with the QA explorer)
- roles other than the proposal author (M3)
- building the image in CI

## Capabilities

### New Capabilities

### Modified Capabilities
- `roles`: an auth-mode override per deployment, role sessions that hold no factory credentials, the read guard, GitHub-only `WebFetch` for the proposal author, its reduced budget, and roles running in the worker image.
- `orchestration`: the Forge acts as the factory's GitHub App, and the worker runs one state per task.

## Impact

- New package `factory/worker` (`@vocab/factory-worker`): the Dockerfile, its ignore file and the entry point.
- `factory/roles`: the runner's child environment, the auth-mode override, the read guard; `proposal-author.yaml` and its prompt.
- `factory/forge`: a GitHub App token provider (JWT signed with `node:crypto`, no new dependency). `GitHubForge` takes a token provider instead of a fixed token.
- A new Vitest project `docker` and a root script `pnpm test:docker` for tests that build and run the image. Like `test:live`, it never runs in `pnpm check` or CI.
- ADRs: 0009 (GitHub App auth) and 0010 (worker image). ADR 0006 gains `FACTORY_AUTH_MODE`; ADR 0007 is amended if the sandbox fails in a container.
- Tagged `large`: it changes the role runner's security boundary and the factory's credentials.
