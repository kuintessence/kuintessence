FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock biome.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/proto/package.json ./packages/proto/
COPY packages/db/package.json ./packages/db/
COPY packages/server/package.json ./packages/server/
COPY packages/registry/package.json ./packages/registry/
COPY packages/agent/package.json ./packages/agent/
COPY packages/cli/package.json ./packages/cli/
COPY packages/web/package.json ./packages/web/
COPY packages/docs-site/package.json ./packages/docs-site/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/db/tsconfig.json ./packages/db/
COPY packages/registry/tsconfig.json ./packages/registry/
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/registry ./packages/registry

FROM oven/bun:1.4.2-alpine
RUN apk add --no-cache git curl ca-certificates
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
EXPOSE 3100
CMD ["bun", "packages/registry/src/index.ts"]
