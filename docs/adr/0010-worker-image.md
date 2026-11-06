# 0010 Worker image

Status: accepted (2026-11-04; owner decision on Bash of 2026-11-04); amended 2026-11-06 (boundary-check image)

## Context

From M2, every state runs as a Fargate task from one `factory-worker` image (brief, section 3). The image must hold everything the factory needs at run time and nothing secret. The factory runs `.ts` files directly with Node's type stripping, which refuses files under `node_modules`. The M2 spike tested the SDK's Bash sandbox in a container, and it cannot start with no added privileges (ADR 0007).

## Decision

- Base `node:24-bookworm-slim`, pinned by digest (`sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c` at the time of the spike). Moving the digest is a deliberate change.
- Platform `linux/amd64`, matching the owner's machine, so the image builds natively and local checks run on the same platform as Fargate.
- Contents:
  - `git`, `ca-certificates`, `bubblewrap` and `socat` from Debian
  - the factory's code in its workspace layout: root manifests, `factory/*`, `.claude/agents`, `openspec/config.yaml`
  - production dependencies installed with `pnpm install --frozen-lockfile --prod`, plus the pinned OpenSpec CLI
  - the RDS CA bundle
- `bubblewrap` and `socat`, although no role in the image uses Bash (amended 2026-11-06, owner decision). The runner requires the sandbox for every role (ADR 0007). Without these binaries the SDK refuses to start any session, so the proposal author could not run. With them, sessions start, and every Bash command fails, because the sandbox cannot create its namespaces in a container with no added privileges. No Playwright until M4.
- `pnpm deploy` is not used, because it copies workspace packages into `node_modules`, where type stripping refuses them.
- `factory/worker/Dockerfile.dockerignore` is an allowlist, with the repository root as build context. `.env*`, `docs/`, `app/fixtures/`, `.git` and `node_modules` never enter it.
- Non-root user `factory` (uid 10001). `HOME` and the work directory are in the task's ephemeral storage.
- Role configs and prompts come from the image, not the clone, so the image's commit is the factory's version.
- The image is built and pushed by CDK's `DockerImageAsset` on `cdk deploy`, tagged by content hash. CI does not build it.

## Alternatives

- **arm64:** about 20% cheaper Fargate minutes, which is cents a month here, but needs emulated builds on the owner's machine.
- **`pnpm deploy` or a bundled `dist`:** a smaller image, but `.ts` in `node_modules` fails, and a bundle adds a build step the rest of the factory does not have.
- **Leaving the sandbox's dependencies out** (this ADR's first version): every session failed at start in the task 1.16 live check. **Setting the sandbox only for roles with Bash** would also have fixed it and kept the image smaller. The owner chose to install the binaries instead, which keeps the runner's options the same for every role and on every host.

## Consequences

- The spike's draft image was about 1.2 GB; the built image is about 1 GB. That costs little to store, but it slows task start-up, and every state pays that start-up.
- Secrets reach the image only as environment at run time, and a docker test proves the build leaves them out.
- An image without Bash roles says nothing about M3's. Its decision may change the base or the platform for those roles.

## Amendment 2026-11-06: the boundary-check image

The scenario "Boundaries hold in Fargate" runs the live boundary tests in a Fargate task. The worker image cannot run them: ECS overrides a container's command but not its entry point, and the image holds no Vitest. The owner chose a second, test-only image (2026-11-06) over shipping Vitest in the worker.

- The Dockerfile has a `boundary-check` target, built `FROM worker`: the worker image with Vitest and the dev dependencies installed on top, an empty entry point and the same non-root user. It has no `COPY` or `ADD`, so it changes none of the worker's files. Its last stage is a bare `FROM worker`, so a build without a target is the production image.
- The stack has a second task definition for it, with the worker's task role, execution role, size, platform, environment, secrets and logs. The state machine never runs it.
- What makes the check stand for the worker:
  - CDK assertions: the two task definitions are equal in everything but the image, and both images come from the same Dockerfile and a byte-identical build context. A unit test pins the Dockerfile's stage layout.
  - The cloud test, before it runs anything: the deployed task definitions are equal in everything but the image, and the deployed worker image's layers are, in order, the first layers of the check image.
  - The local container check (`container.live.test.ts`) builds the same target, which replaces `live-check.Dockerfile`.
- What it cannot prove: the tests run the role runner from Vitest with throwaway probe roles, not through the worker's entry point, as they do locally. The dev dependencies are installed into `/app/node_modules` from the frozen lockfile, which leaves the production packages' versions unchanged. And `/app/node_modules` is writable by the factory user in the check image only, which makes the check's environment weaker than the worker's, not stronger.
- Cost: one more image in the CDK assets repository. Its first layers are the worker's, and ECR stores them once.
