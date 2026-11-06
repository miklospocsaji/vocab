# syntax=docker/dockerfile:1
# Test only, never deployed: the factory-worker image plus the dev dependencies the live
# tests need (Vitest), for container.live.test.ts (add-factory-worker task 1.16).
ARG WORKER_IMAGE
FROM ${WORKER_IMAGE}
USER root
# The live setup loads .env.local, so an empty one is added; the token comes from the
# environment. Vitest keeps its token and caches in node_modules, made the one writable folder in /app.
RUN npm install --global --ignore-scripts --prefix /opt/pnpm pnpm@12.15.0 \
 && cd /app && CI=true /opt/pnpm/bin/pnpm install --frozen-lockfile --filter "@vocab/factory-worker..." --filter "vocab" \
 && rm -rf /root/.cache /root/.local/share/pnpm /root/.npm /opt/pnpm \
 && touch /app/.env.local \
 && chown factory:factory /app/node_modules
USER factory:factory
WORKDIR /app
ENTRYPOINT []
