# syntax=docker/dockerfile:1
# Build both the extension dependency graph and TypeScript output inside Linux.
FROM node:24.20.0-bookworm-slim AS extension-build

WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY pwa/package.json ./pwa/package.json
COPY pi-extension/package.json ./pi-extension/package.json
COPY packages/protocol/ ./packages/protocol/
RUN corepack enable && pnpm --filter @pelrun/pi-reach... install --frozen-lockfile
COPY pi-extension/src ./pi-extension/src
COPY pi-extension/scripts ./pi-extension/scripts
COPY pi-extension/index.js pi-extension/tsconfig.json pi-extension/README.md pi-extension/LICENSE ./pi-extension/
RUN pnpm --filter @pelrun/pi-reach build \
    && pnpm --filter @pelrun/pi-reach deploy --legacy /out/extension

# Pi 按发布清单加载入口，编译成功不代表 deploy 产物包含所有入口。
RUN node -e '\
    const fs = require("node:fs"); \
    const path = require("node:path"); \
    const root = "/out/extension"; \
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); \
    for (const entry of pkg.pi.extensions) fs.accessSync(path.resolve(root, entry));'

# Pi itself is pinned independently from the host's package installation.
FROM node:24.20.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/pi \
    PI_CODING_AGENT_DIR=/home/pi/.pi/agent \
    PI_CODING_AGENT_SESSION_DIR=/home/pi/.pi/agent/sessions \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund @earendil-works/pi-coding-agent@0.84.4 \
    && useradd --create-home --uid 10001 --shell /bin/bash pi \
    && mkdir -p /opt/pi-reach /workspace /home/pi/.pi/agent/sessions \
    && chown -R pi:pi /opt/pi-reach /workspace /home/pi \
    && mkdir -p /home/pi/.pi/pi-reach \
    && chown -R pi:pi /home/pi/.pi

# deploy 生成独立依赖树，避免复制指向 workspace 根 virtual store 的失效链接。
COPY --from=extension-build /out/extension/ /opt/pi-reach/
COPY docker/e2e/host/e2e-provider.ts /usr/local/bin/e2e-provider.ts
COPY docker/e2e/host/interactive-controller.mjs /usr/local/bin/interactive-controller.mjs
COPY docker/e2e/host/interactive-entrypoint.sh /usr/local/bin/interactive-entrypoint.sh

RUN chmod 0555 /usr/local/bin/interactive-entrypoint.sh \
    && chown pi:pi /usr/local/bin/interactive-controller.mjs

USER pi
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/interactive-entrypoint.sh"]
