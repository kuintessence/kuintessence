FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/agent/package.json ./packages/agent/
COPY packages/cli/package.json ./packages/cli/
COPY packages/db/package.json ./packages/db/
COPY packages/docs-site/package.json ./packages/docs-site/
COPY packages/fabric-adapter/package.json ./packages/fabric-adapter/
COPY packages/proto/package.json ./packages/proto/
COPY packages/registry/package.json ./packages/registry/
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/
COPY contracts/fabric/commercial/package.json ./contracts/fabric/commercial/
COPY contracts/fabric/evidence/package.json ./contracts/fabric/evidence/
COPY contracts/fabric/market/package.json ./contracts/fabric/market/
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY packages/shared ./packages/shared
COPY packages/fabric-adapter ./packages/fabric-adapter
COPY contracts/fabric ./contracts/fabric
RUN cd packages/fabric-adapter && bun run build
RUN cd contracts/fabric/evidence && bun run build
RUN cd contracts/fabric/commercial && bun run build
RUN cd contracts/fabric/market && bun run build

FROM deps AS runtime-deps
RUN rm -rf node_modules packages/*/node_modules contracts/fabric/*/node_modules \
    && bun install --production --frozen-lockfile --ignore-scripts --filter '@kuintessence/fabric-*'

FROM node:22.23.3-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=runtime-deps /app /app
ENV NODE_ENV=production

FROM runtime AS adapter
COPY --from=build /app/packages/fabric-adapter/dist /app/packages/fabric-adapter/dist
CMD ["node", "packages/fabric-adapter/dist/main.js"]

FROM runtime AS chaincode
COPY --from=build /app/contracts/fabric/evidence/dist /app/contracts/fabric/evidence/dist
COPY --from=build /app/contracts/fabric/commercial/dist /app/contracts/fabric/commercial/dist
COPY --from=build /app/contracts/fabric/market/dist /app/contracts/fabric/market/dist
CMD ["node", "contracts/fabric/evidence/dist/main.js"]
