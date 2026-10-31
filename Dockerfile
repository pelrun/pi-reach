# syntax=docker/dockerfile:1
# 从仓库根构建：docker build -f relay/Dockerfile .
FROM node:24.20.0-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY pwa/package.json ./pwa/package.json
COPY pi-extension/package.json ./pi-extension/package.json
COPY relay/package.json ./relay/package.json
COPY packages/protocol/ ./packages/protocol/
RUN pnpm --filter @pi-reach/relay... install --frozen-lockfile
COPY relay/ ./relay/
# 只在部署产物中注入 workspace 依赖，避免运行镜像保留指向构建目录的链接。
RUN pnpm --filter @pi-reach/relay build && \
    pnpm --config.inject-workspace-packages=true --filter @pi-reach/relay deploy --prod /out

FROM node:24.20.0-alpine AS runner
RUN apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production
ENV PI_REACH_RELAY_PORT=3000
COPY --from=builder --chown=node:node /out/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PI_REACH_RELAY_PORT}/health || exit 1
CMD ["node", "dist/main.js"]
