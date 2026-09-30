# One-shot, insert-only seed runner. Build context must be the repository root.
FROM oven/bun:1.4.2-alpine
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
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

RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY deploy/seed ./deploy/seed

USER bun
CMD ["bun", "run", "deploy/seed/index.ts"]
