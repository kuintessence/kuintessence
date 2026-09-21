# Built from repo root. Static build + nginx serve.
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
COPY packages/web/tsconfig.json ./packages/web/

RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
ARG VITE_PREVIEW_LOGIN=false
ENV VITE_PREVIEW_LOGIN=${VITE_PREVIEW_LOGIN}
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
COPY examples ./examples
RUN cd packages/web && bun run build

FROM nginx:1.27-alpine
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD wget -q -O - http://127.0.0.1/ > /dev/null || exit 1
