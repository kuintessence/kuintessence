#!/usr/bin/env bash
set -euo pipefail
[[ "${KQ_PR_TEST:-}" == 1 && "$(id -un)" == kq ]]
cd /workspace
test "$(spack --version)" = 1.0.0
test ! -d /opt/kq-case
test ! -d /case-server
test ! -f /etc/sudoers.d/kq
test ! -f /var/lib/kuintessence/agent/pr-scheduler/certs/client.key
test "$(find /sys/class/net -mindepth 1 -maxdepth 1 -printf '%f\n')" = lo
grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status
test -z "$(ip -4 route show default)"
test -z "$(ip -6 route show default)"
if curl --noproxy '*' --silent --fail --connect-timeout 3 --max-time 5 https://ftp.gnu.org/gnu/hello/ >/dev/null; then
  echo "The offline case unexpectedly reached upstream" >&2
  exit 1
fi
if curl --noproxy '*' --silent --fail --connect-timeout 3 --max-time 5 http://registry:3100/api/health >/dev/null; then
  echo "The Agent network unexpectedly reached Registry directly" >&2
  exit 1
fi
digest="$(< /scratch/kq-spack-case/manifest-digest)"
spack python deploy/pr-test/spack-case/offline.py \
  /case-input "$digest" /scratch/kq-spack-case/native
