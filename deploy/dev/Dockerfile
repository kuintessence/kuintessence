FROM oven/bun:1.4.2-alpine

RUN apk add --no-cache git
ENV GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1

WORKDIR /app

COPY package.json bun.lock biome.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/proto/package.json packages/proto/buf.yaml packages/proto/buf.gen.yaml ./packages/proto/
COPY packages/db/package.json ./packages/db/
COPY packages/server/package.json ./packages/server/
COPY packages/registry/package.json ./packages/registry/
COPY packages/agent/package.json ./packages/agent/
COPY packages/cli/package.json ./packages/cli/
COPY packages/web/package.json ./packages/web/
COPY packages/docs-site/package.json ./packages/docs-site/

RUN bun install --frozen-lockfile --ignore-scripts
