# One-shot migration runner. Built from repo root.
FROM oven/bun:1.3.13-alpine
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

WORKDIR /app/packages/db
CMD ["bun", "run", "src/pg/migrate.ts"]
