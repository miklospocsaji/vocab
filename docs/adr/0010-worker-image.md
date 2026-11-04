# 0010 Worker image

Status: accepted (2026-11-04; owner decision on Bash of 2026-11-04)

## Context

From M2, every state runs as a Fargate task from one `factory-worker` image (brief, section 3). The image must hold everything the factory needs at run time and nothing secret. The factory runs `.ts` files directly with Node's type stripping, which refuses files under `node_modules`. The M2 spike tested the SDK's Bash sandbox in a container, and it cannot start with no added privileges (ADR 0007).

## Decision

- Base `node:24-bookworm-slim`, pinned by digest (`sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c` at the time of the spike). Moving the digest is a deliberate change.
- Platform `linux/amd64`, matching the owner's machine, so the image builds natively and local checks run on the same platform as Fargate.
- Contents:
  - `git` and `ca-certificates` from Debian
  - the factory's code in its workspace layout: root manifests, `factory/*`, `.claude/agents`, `openspec/config.yaml`
  - production dependencies installed with `pnpm install --frozen-lockfile --prod`, plus the pinned OpenSpec CLI
  - the RDS CA bundle
- No `bubblewrap` or `socat`, because no role in the image uses Bash. No Playwright until M4.
- `pnpm deploy` is not used, because it copies workspace packages into `node_modules`, where type stripping refuses them.
- `factory/worker/Dockerfile.dockerignore` is an allowlist, with the repository root as build context. `.env*`, `docs/`, `app/fixtures/`, `.git` and `node_modules` never enter it.
- Non-root user `factory` (uid 10001). `HOME` and the work directory are in the task's ephemeral storage.
- Role configs and prompts come from the image, not the clone, so the image's commit is the factory's version.
- The image is built and pushed by CDK's `DockerImageAsset` on `cdk deploy`, tagged by content hash. CI does not build it.

## Alternatives

- **arm64:** about 20% cheaper Fargate minutes, which is cents a month here, but needs emulated builds on the owner's machine.
- **`pnpm deploy` or a bundled `dist`:** a smaller image, but `.ts` in `node_modules` fails, and a bundle adds a build step the rest of the factory does not have.
- **Keeping the sandbox's dependencies for later:** they do nothing while the sandbox cannot start. M3 decides whether they return.

## Consequences

- The spike's draft image was about 1.2 GB. That costs little to store, but it slows task start-up, and every state pays that start-up.
- Secrets reach the image only as environment at run time, and a docker test proves the build leaves them out.
- An image without Bash roles says nothing about M3's. Its decision may change the base or the platform for those roles.
