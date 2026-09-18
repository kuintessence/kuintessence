
# --- Stage 1: build app (proto codegen + web SPA) -------------------------
FROM oven/bun:1.3.13-alpine AS builder
WORKDIR /app
COPY package.json bun.lock biome.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/proto/package.json packages/proto/tsconfig.json packages/proto/buf.yaml packages/proto/buf.gen.yaml ./packages/proto/
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/server/package.json packages/server/tsconfig.json ./packages/server/
COPY packages/registry/package.json packages/registry/tsconfig.json ./packages/registry/
COPY packages/web/package.json packages/web/tsconfig.json ./packages/web/
COPY packages/agent/package.json packages/agent/tsconfig.json ./packages/agent/
COPY packages/cli/package.json packages/cli/tsconfig.json ./packages/cli/
COPY packages/docs-site/package.json ./packages/docs-site/

RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/shared ./packages/shared
COPY packages/proto ./packages/proto
COPY packages/db ./packages/db
COPY packages/server ./packages/server
COPY packages/registry ./packages/registry
COPY packages/web ./packages/web
COPY authz ./authz
# Web bundles examples/workflows/*.yaml via Vite ?raw imports for the dashboard
# Quick Start and the workflow template gallery.
COPY examples ./examples

RUN cd packages/proto && bun run generate
ARG VITE_PREVIEW_LOGIN=false
ENV VITE_PREVIEW_LOGIN=${VITE_PREVIEW_LOGIN}
RUN cd packages/web && bun run build

# --- Stage 2: pick MinIO binary -------------------------------------------
FROM minio/minio:RELEASE.2025-09-07T16-13-09Z AS minio-bin

# --- Stage 3: pick MinIO client --------------------------------------------
FROM minio/mc:RELEASE.2025-08-13T08-35-41Z AS minio-mc

# --- Stage 4: runtime (Postgres-based, plus bun/redis/minio/nginx) --------
FROM postgres:16-alpine

RUN apk add --no-cache \
    bash \
    git \
    libgcc \
    libstdc++ \
    nginx \
    redis \
    su-exec \
    tini \
    tzdata \
    wget

# Bun runtime (statically built, lift binary out of the official image)
COPY --from=oven/bun:1.3.13-alpine /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# MinIO server
COPY --from=minio-bin /usr/bin/minio /usr/local/bin/minio
COPY --from=minio-mc /usr/bin/mc /usr/local/bin/mc

WORKDIR /app
COPY --from=builder /app /app

COPY deploy/aio/nginx.conf /etc/nginx/http.d/default.conf
COPY deploy/aio/entrypoint.sh /entrypoint.sh
COPY deploy/minio/bootstrap-object-lock.sh /usr/local/bin/bootstrap-object-lock
RUN chmod +x /entrypoint.sh /usr/local/bin/bootstrap-object-lock && \
    mkdir -p /data/postgres /data/minio /run/postgresql /var/log/aio /var/www && \
    cp -r /app/packages/web/dist/. /var/www/ && \
    chown -R postgres:postgres /data/postgres /run/postgresql

ENV PATH="/usr/local/bin:${PATH}" \
    DATABASE_URL=postgres://kq:kq@127.0.0.1:5432/kuintessence \
    REDIS_URL=redis://127.0.0.1:6379 \
    JWT_SECRET=demo-aio-secret-change-me-at-least-32-chars-long \
    SERVER_PORT=3000 \
    SERVER_GRPC_PORT=3001 \
    REGISTRY_PORT=3100 \
    BLOB_STORE_DIR=/data/registry/blobs \
    SPACK_RECIPE_STORE_DIR=/data/registry/recipes \
    SPACK_MATERIAL_STORE_DIR=/data/registry/materials \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    NODE_ENV=production \
    LOG_LEVEL=info \
    PGDATA=/data/postgres \
    MINIO_DATA=/data/minio \
    MINIO_ROOT_USER=minioadmin \
    MINIO_ROOT_PASSWORD=minioadmin \
    NETDRIVE_ENABLED=true \
    NETDRIVE_ENDPOINT=127.0.0.1 \
    NETDRIVE_PORT=9000 \
    NETDRIVE_USE_SSL=false \
    DATA_MARKET_COMMITTER_ACCESS_KEY=kq-data-market-committer \
    NETDRIVE_ACCESS_KEY=kq-data-market-committer \
    NETDRIVE_BUCKET=kq-netdrive \
    DATA_MARKET_STAGING_BUCKET=kq-data-market-staging \
    DATA_MARKET_IMMUTABLE_BUCKET=kq-data-market-immutable \
    DATA_MARKET_STAGING_EXPIRY_DAYS=1 \
    NETDRIVE_REGION=us-east-1 \
    NETDRIVE_PUBLIC_URL=http://localhost:9000 \
    DATA_MARKET_IMMUTABLE_RETENTION_DAYS=365 \
    AIO_POSTGRES_PASSWORD=postgres \
    AIO_APP_USER=kq \
    AIO_APP_PASSWORD=kq \
    AIO_APP_DB=kuintessence

VOLUME ["/data"]
EXPOSE 80 9000 9001

HEALTHCHECK --interval=10s --timeout=10s --start-period=60s --retries=5 \
    CMD wget -q -T 2 -O /dev/null "http://127.0.0.1:${SERVER_PORT}/api/health" && \
        wget -q -T 2 -O /dev/null "http://127.0.0.1:${REGISTRY_PORT}/api/health" && \
        wget -q -T 2 -O /dev/null http://127.0.0.1:9000/minio/health/ready && \
        wget -q -T 2 -O /dev/null http://127.0.0.1/ || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
