#!/usr/bin/env bash
set -euo pipefail

case "${KQ_PR_SCHEDULER:?}" in
  slurm) sinfo -h -o '%T' | grep -Eq 'idle|alloc|mix' ;;
  pbs) qstat -B >/dev/null ;;
  *) echo "Unsupported PR scheduler" >&2; exit 2 ;;
esac
