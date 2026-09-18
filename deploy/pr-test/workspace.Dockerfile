FROM scheduler-base

WORKDIR /workspace
COPY package.json bun.lock tsconfig.base.json biome.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/proto/package.json ./packages/proto/
COPY packages/db/package.json ./packages/db/
COPY packages/server/package.json ./packages/server/
COPY packages/registry/package.json ./packages/registry/
COPY packages/agent/package.json ./packages/agent/
COPY packages/cli/package.json ./packages/cli/
COPY packages/web/package.json ./packages/web/
COPY packages/docs-site/package.json ./packages/docs-site/
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages ./packages
COPY authz ./authz
COPY scripts ./scripts
COPY deploy/pr-test ./deploy/pr-test
COPY deploy/compose/docker-compose.pr-test.yml ./deploy/compose/docker-compose.pr-test.yml
RUN bun --bun run --filter @kuintessence/proto generate \
  && test "$(spack --version)" = "1.0.0" \
  && test "$(bun --version)" = "1.3.13"

ENV GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
