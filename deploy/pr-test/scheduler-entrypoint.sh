#!/usr/bin/env bash
set -euo pipefail

case "${KQ_PR_SCHEDULER:-}" in
  slurm)
    exec /usr/local/bin/kq-slurm-entrypoint "$@"
    ;;
  pbs)
    kq_pr_pbs_marker() {
      local event="$1" code="$2" line="$3"
      [[ "$event" == ERR || "$event" == EXIT ]] || return 0
      [[ "$code" =~ ^[0-9]{1,3}$ && "$line" =~ ^[0-9]{1,5}$ ]] || return 0
      (( 10#$code <= 255 )) || return 0
      printf 'ci-pbs-entrypoint:event=%s line=%s exit=%s\n' "$event" "$line" "$code" >&2 || :
    }
    # Do not enable errtrace or export hooks into registration/Agent child shells.
    trap 'kq_pr_pbs_marker ERR "$?" "$LINENO"' ERR
    trap 'kq_pr_pbs_marker EXIT "$?" "$LINENO"' EXIT
    # A conditional source would disable the original entrypoint's errexit.
    source /usr/local/bin/kq-pbs-entrypoint "$@"
    ;;
  *)
    exit 2
    ;;
esac
