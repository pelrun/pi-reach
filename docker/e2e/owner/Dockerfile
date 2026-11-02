# syntax=docker/dockerfile:1
FROM node:24.20.0-bookworm-slim AS dependencies

WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY pwa/package.json ./pwa/package.json
COPY pi-extension/package.json ./pi-extension/package.json
COPY packages/protocol/ ./packages/protocol/
RUN corepack enable \
    && pnpm --filter @pelrun/pi-reach... install --frozen-lockfile \
    && pnpm --filter @pelrun/pi-reach deploy --legacy --prod /out/owner

FROM node:24.20.0-bookworm-slim

ENV NODE_ENV=production \
    OWNER_PORT=8788 \
    OWNER_STATE_DIR=/var/lib/pi-reach-owner

RUN useradd --create-home --uid 10002 --shell /bin/bash owner \
    && mkdir -p /opt/pi-reach-owner /var/lib/pi-reach-owner \
    && chown -R owner:owner /opt/pi-reach-owner /var/lib/pi-reach-owner

COPY --from=dependencies /out/owner/node_modules /opt/pi-reach-owner/node_modules
COPY docker/e2e/owner/server.mjs /opt/pi-reach-owner/server.mjs
RUN chown -R owner:owner /opt/pi-reach-owner

USER owner
WORKDIR /opt/pi-reach-owner
EXPOSE 8788
ENTRYPOINT ["node", "/opt/pi-reach-owner/server.mjs"]
