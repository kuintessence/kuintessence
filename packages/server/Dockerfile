FROM oven/bun:1.3.13-alpine AS deps
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
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/proto/tsconfig.json ./packages/proto/
COPY packages/db/tsconfig.json ./packages/db/
COPY packages/server/tsconfig.json ./packages/server/
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY packages/shared ./packages/shared
COPY packages/proto ./packages/proto
COPY packages/db ./packages/db
COPY packages/server ./packages/server
COPY authz ./authz
RUN cd packages/proto && bun run generate

FROM oven/bun:1.3.13-alpine
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 3000 3001
CMD ["bun", "packages/server/src/index.ts"]
