#!/usr/bin/env bash
# Install the kq-agent binary, systemd unit and initial configuration.
# Usage: sudo bash deploy/systemd/install-agent.sh [<binary-path>]

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

BINARY_SRC="${1:-./kq-agent}"
BINARY_DST="/usr/local/bin/kq-agent"
USER_NAME="kq-agent"
GROUP_NAME="kq-agent"
STATE_DIR="/var/lib/kq-agent"
CONF_DIR="/etc/kq-agent"
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
UNIT_SRC="${SCRIPT_DIR}/kq-agent.service"
UNIT_DST="/etc/systemd/system/kq-agent.service"
ENV_SRC="${SCRIPT_DIR}/kq-agent.env.example"
ENV_DST="${CONF_DIR}/kq-agent.env"

log() { echo "[install-agent] $*"; }

if [[ ! -f "${BINARY_SRC}" || ! -x "${BINARY_SRC}" ]]; then
  echo "ERROR: agent binary not found at ${BINARY_SRC}" >&2
  echo "       hint: see deploy/systemd/README.md for Linux binary builds" >&2
  exit 1
fi
if [[ ! -f "${UNIT_SRC}" || ! -f "${ENV_SRC}" ]]; then
  echo "ERROR: keep install-agent.sh with its service and env templates" >&2
  exit 1
fi

if ! getent group "${GROUP_NAME}" >/dev/null; then
  groupadd --system "${GROUP_NAME}"
fi
if ! id -u "${USER_NAME}" >/dev/null 2>&1; then
  log "creating system user ${USER_NAME}"
  useradd --system --gid "${GROUP_NAME}" --home-dir "${STATE_DIR}" \
    --no-create-home --shell /usr/sbin/nologin "${USER_NAME}"
else
  log "user ${USER_NAME} already exists"
fi

install -d -o "${USER_NAME}" -g "${GROUP_NAME}" -m 0700 "${STATE_DIR}"
install -d -o root -g "${GROUP_NAME}" -m 0750 "${CONF_DIR}"
install -d -o root -g root -m 0755 "$(dirname "${BINARY_DST}")"

# Replace the inode so an upgrade can copy a currently running executable.
log "installing binary to ${BINARY_DST}"
BINARY_TMP="$(mktemp "${BINARY_DST}.XXXXXX")"
trap 'rm -f -- "${BINARY_TMP}"' EXIT
install -o root -g root -m 0755 "${BINARY_SRC}" "${BINARY_TMP}"
mv -f -- "${BINARY_TMP}" "${BINARY_DST}"

log "installing systemd unit"
install -o root -g root -m 0644 "${UNIT_SRC}" "${UNIT_DST}"

# Preserve site configuration across upgrades.
if [[ ! -f "${ENV_DST}" ]]; then
  log "installing env template at ${ENV_DST}"
  install -o root -g "${GROUP_NAME}" -m 0640 "${ENV_SRC}" "${ENV_DST}"
  log "edit ${ENV_DST} before starting the service"
else
  log "env file already exists at ${ENV_DST} (preserving user edits)"
fi

systemctl daemon-reload

cat <<EOF

Installed kq-agent. The installer does not execute the binary or change service activation.
  1. Register with 'kq agent register' and install the certificate bundle.
  2. Edit ${ENV_DST}: URLs, registered Agent identity, scheduler PATH.
  3. Start on first install: sudo systemctl enable --now kq-agent
     Apply an upgrade:      sudo systemctl restart kq-agent
  4. View logs:             sudo journalctl -u kq-agent -f

Registration and certificate paths: deploy/systemd/README.md
EOF
