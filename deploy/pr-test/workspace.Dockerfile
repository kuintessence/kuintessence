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
COPY packages/fabric-adapter/package.json ./packages/fabric-adapter/
COPY contracts/fabric/evidence/package.json ./contracts/fabric/evidence/
COPY contracts/fabric/commercial/package.json ./contracts/fabric/commercial/
COPY contracts/fabric/market/package.json ./contracts/fabric/market/
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages ./packages
COPY contracts ./contracts
COPY authz ./authz
COPY scripts ./scripts
COPY deploy/pr-test ./deploy/pr-test
COPY deploy/compose/docker-compose.pr-test.yml ./deploy/compose/docker-compose.pr-test.yml
COPY deploy/compose/docker-compose.pr-spack-case.yml ./deploy/compose/docker-compose.pr-spack-case.yml
COPY deploy/compose/docker-compose.pr-spack-managed.yml ./deploy/compose/docker-compose.pr-spack-managed.yml
RUN bun --bun run --filter @kuintessence/proto generate \
  && test "$(spack --version)" = "1.0.0" \
  && test "$(bun --version)" = "1.4.2"

ENV GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
