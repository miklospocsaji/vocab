# syntax=docker/dockerfile:1
# The factory-worker image (ADR 0010). Build context: the repository root, filtered by the
# allowlist in Dockerfile.dockerignore. Run: factory-worker <state> --issue <n>.
#   docker build --platform linux/amd64 -f factory/worker/Dockerfile -t factory-worker .

# Moving the digest is a deliberate change (ADR 0010).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# The workspace with its production dependencies. Workspace packages stay in their own
# folders, not node_modules, because Node's type stripping refuses .ts under node_modules.
FROM ${NODE_IMAGE} AS install
ENV PNPM_HOME=/opt/pnpm CI=true
RUN npm install --global --ignore-scripts --prefix /opt/pnpm pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY factory/ factory/
RUN /opt/pnpm/bin/pnpm install --frozen-lockfile --prod --filter "@vocab/factory-worker..." --filter "vocab" \
 && rm -rf /root/.cache /root/.local/share/pnpm /root/.npm
COPY . .

FROM ${NODE_IMAGE}
# bubblewrap and socat: without them the SDK refuses to start any session, Bash or not, since
# the runner requires the sandbox (ADR 0007). With them, sessions start, and a Bash command
# fails because the sandbox cannot create its namespaces here (owner decision, 2026-11-06).
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates bubblewrap socat \
 && rm -rf /var/lib/apt/lists/*
# TLS to Aurora; AWS rotates this bundle rarely, and a new one is a deliberate change too.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=644 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/factory --shell /usr/sbin/nologin factory
# Owned by root: the factory user cannot change its own code.
COPY --from=install /app /app
ENV NODE_ENV=production \
    HOME=/home/factory \
    TMPDIR=/tmp \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    OPENSPEC_TELEMETRY=0
USER factory:factory
WORKDIR /home/factory
ENTRYPOINT ["node", "/app/factory/worker/src/main.ts"]
