#!/usr/bin/env bash
# AIO supervisor: starts Postgres, Redis, RustFS, Server, Registry, and nginx
# inside a single container. First-run safe (initdb + create user/db + migrate).
set -euo pipefail

PGDATA=${PGDATA:-/data/postgres}
RUSTFS_DATA=${RUSTFS_DATA:-/data/rustfs}

log() { echo "[aio $(date -Iseconds)] $*"; }

if [ -d /data/minio ]; then
    log "legacy MinIO data detected; migrate objects and metadata before starting RustFS"
    exit 1
fi

PIDS=()
shutdown() {
    local pid
    trap - EXIT
    log "shutting down"
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    wait || true
}
trap 'shutdown' EXIT
trap 'exit 0' SIGTERM SIGINT

mkdir -p "$PGDATA" "$RUSTFS_DATA" /run/postgresql
chown -R postgres:postgres "$PGDATA" /run/postgresql

# 1. Initdb on first start ---------------------------------------------------
if [ ! -s "$PGDATA/PG_VERSION" ]; then
    log "initdb at $PGDATA"
    # Bash process substitution ( <() ) creates a /dev/fd/N descriptor owned by
    # the parent shell — postgres can't read it under `su-exec`. Write the
    # password to a real file with postgres ownership instead, then nuke it.
    PWFILE=$(mktemp /tmp/initdb-pw.XXXXXX)
    printf '%s' "$AIO_POSTGRES_PASSWORD" > "$PWFILE"
    chown postgres:postgres "$PWFILE"
    chmod 600 "$PWFILE"
    su-exec postgres initdb \
        --username=postgres \
        --pwfile="$PWFILE" \
        -D "$PGDATA" >/dev/null
    rm -f "$PWFILE"
    {
        echo "host all all 127.0.0.1/32 md5"
        echo "host all all ::1/128 md5"
    } >> "$PGDATA/pg_hba.conf"
    echo "listen_addresses = '127.0.0.1'" >> "$PGDATA/postgresql.conf"
fi

# 2. Start Postgres ----------------------------------------------------------
log "starting postgres"
su-exec postgres postgres -D "$PGDATA" >/var/log/aio/postgres.log 2>&1 &
PIDS+=("$!")

for ((attempt = 0; attempt < 60; attempt++)); do
    if su-exec postgres pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
    sleep 0.5
done
if ! su-exec postgres pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    log "postgres failed to become ready"; tail -50 /var/log/aio/postgres.log; exit 1
fi
log "postgres ready"

# 3. Ensure app user / database ---------------------------------------------
export PGPASSWORD="$AIO_POSTGRES_PASSWORD"
psql -h 127.0.0.1 -U postgres -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname='${AIO_APP_USER}'" | grep -q 1 || \
    psql -h 127.0.0.1 -U postgres -c \
        "CREATE USER ${AIO_APP_USER} WITH PASSWORD '${AIO_APP_PASSWORD}';"
psql -h 127.0.0.1 -U postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${AIO_APP_DB}'" | grep -q 1 || \
    psql -h 127.0.0.1 -U postgres -c \
        "CREATE DATABASE ${AIO_APP_DB} OWNER ${AIO_APP_USER};"
unset PGPASSWORD
log "app user/db ensured"

# 4. Run database migrations -------------------------------------------------
log "running database migrations"
(cd /app/packages/db && bun run src/pg/migrate.ts)
log "migrations complete"

# 5. Start Redis -------------------------------------------------------------
log "starting redis"
redis-server --bind 127.0.0.1 --port 6379 --daemonize no \
    --appendonly no --save "" --dir /tmp \
    >/var/log/aio/redis.log 2>&1 &
PIDS+=("$!")

# 6. Start RustFS -------------------------------------------------------------
log "starting rustfs"
rustfs "$RUSTFS_DATA" \
    --address "0.0.0.0:9000" \
    --console-address "0.0.0.0:9001" \
    >/var/log/aio/rustfs.log 2>&1 &
PIDS+=("$!")

# 7. Initialize immutable object storage ------------------------------------
for ((attempt = 0; attempt < 60; attempt++)); do
    if wget -q -O- http://127.0.0.1:9000/health >/dev/null 2>&1; then break; fi
    sleep 0.5
done
if ! wget -q -O- http://127.0.0.1:9000/health >/dev/null 2>&1; then
    log "rustfs failed to become ready"; tail -50 /var/log/aio/rustfs.log; exit 1
fi
log "initializing NetDrive, Data Market staging, and immutable buckets"
: "${DATA_MARKET_COMMITTER_SECRET_KEY:?DATA_MARKET_COMMITTER_SECRET_KEY is required}"
export NETDRIVE_ACCESS_KEY="${DATA_MARKET_COMMITTER_ACCESS_KEY}"
export NETDRIVE_SECRET_KEY="${DATA_MARKET_COMMITTER_SECRET_KEY}"
RUSTFS_ENDPOINT=http://127.0.0.1:9000 /usr/local/bin/bootstrap-object-lock
log "object storage buckets ready"
unset RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY DATA_MARKET_COMMITTER_SECRET_KEY

# 8. Start Server ---------------------------------------------------------------
log "starting server"
( cd /app && exec bun packages/server/src/index.ts >/var/log/aio/server.log 2>&1 ) &
PIDS+=("$!")

# 9. Start Registry ------------------------------------------------------
log "starting registry"
export REGISTRY_AUTH_MODE=${REGISTRY_AUTH_MODE:-jwt}
export REGISTRY_JWT_SECRET=${REGISTRY_JWT_SECRET:-$JWT_SECRET}
( cd /app && exec bun packages/registry/src/index.ts >/var/log/aio/registry.log 2>&1 ) &
PIDS+=("$!")

# 10. Start nginx (foreground front door) ------------------------------------
# Both APIs must be ready before publishing the front door.
for port in "$SERVER_PORT" "$REGISTRY_PORT"; do
    for ((attempt = 0; attempt < 60; attempt++)); do
        if wget -q -T 2 -O /dev/null "http://127.0.0.1:${port}/api/health"; then break; fi
        sleep 0.5
    done
    if ! wget -q -T 2 -O /dev/null "http://127.0.0.1:${port}/api/health"; then
        log "API on port ${port} failed to become ready"
        tail -30 /var/log/aio/server.log /var/log/aio/registry.log
        exit 1
    fi
done

log "starting nginx (front door on :80)"
nginx -g 'daemon off;' >/var/log/aio/nginx.log 2>&1 &
PIDS+=("$!")

# 11. Supervise --------------------------------------------------------------
if wait -n; then
    log "a supervised process exited; tearing down"
else
    log "a supervised process failed; tearing down"
fi
log "--- last 30 lines of each component log ---"
for f in /var/log/aio/*.log; do
    echo "===== $f ====="
    tail -30 "$f" || true
done
shutdown
exit 1
