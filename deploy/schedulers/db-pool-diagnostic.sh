#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/schedulers/db-pool-diagnostic.sh [compose-files] [env-file]

Environment:
  KQ_DB_POOL_DIAGNOSTIC_WARN_CONNECTIONS
      Warn when total Kuintessence PostgreSQL backends is at or above this
      value. Defaults to 80.

Examples:
  bash deploy/schedulers/db-pool-diagnostic.sh
  bash deploy/schedulers/db-pool-diagnostic.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

compose_files="${1:-deploy/compose/docker-compose.schedulers.yml}"
env_file="${2:-deploy/schedulers/ports-alt.env}"

if [[ -n "${env_file}" ]]; then
  if [[ ! -f "${env_file}" ]]; then
    echo "env file not found: ${env_file}" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

project_name="${KQ_SCHEDULER_COMPOSE_PROJECT:-kq-schedulers}"
compose_cmd=(docker compose --project-directory . -p "${project_name}")
if [[ -n "${env_file}" ]]; then
  compose_cmd+=(--env-file "${env_file}")
fi
IFS=':' read -r -a compose_file_list <<<"${compose_files}"
for compose_file in "${compose_file_list[@]}"; do
  if [[ -n "${compose_file}" ]]; then
    compose_cmd+=(-f "${compose_file}")
  fi
done

running_count="$("${compose_cmd[@]}" ps --status running -q | wc -l | tr -d '[:space:]')"
if [[ "${running_count}" == "0" ]]; then
  echo "scheduler compose stack is not running; run deploy/schedulers/smoke.sh first" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

ip_map_file="${tmp_dir}/ip-map.tsv"
backend_file="${tmp_dir}/backends.tsv"

docker inspect $("${compose_cmd[@]}" ps -q) \
  --format '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' |
  awk 'NF >= 2 { sub("^/", "", $1); print $2 "\t" $1 }' >"${ip_map_file}"

"${compose_cmd[@]}" exec -T postgres ps -eo args |
  sed -nE 's/.*postgres: kq kuintessence ([0-9.]+)\([0-9]+\) (.*)$/\1\t\2/p' \
    >"${backend_file}"

total="$(wc -l <"${backend_file}" | tr -d '[:space:]')"

printf 'Kuintessence PostgreSQL backends: %d\n' "${total}"
if ((total == 0)); then
  echo "No kq/kuintessence PostgreSQL backend processes found."
  exit 0
fi

printf '%-16s %-34s %-8s %s\n' "CLIENT_IP" "SERVICE" "COUNT" "STATES"
awk -F '\t' '
  NR == FNR {
    service[$1] = $2;
    next;
  }
  {
    count[$1] += 1;
    if (states[$1] == "") {
      states[$1] = $2;
    } else if (("," states[$1] ",") !~ ("," $2 ",")) {
      states[$1] = states[$1] "," $2;
    }
  }
  END {
    for (ip in count) {
      printf "%-16s %-34s %-8d %s\n", ip, (service[ip] == "" ? "unknown" : service[ip]), count[ip], states[ip];
    }
  }
' "${ip_map_file}" "${backend_file}" | sort

warn_at="${KQ_DB_POOL_DIAGNOSTIC_WARN_CONNECTIONS:-80}"
if [[ "${warn_at}" =~ ^[0-9]+$ ]] && ((total >= warn_at)); then
  echo "warning: PostgreSQL backend count ${total} is at or above ${warn_at}; migrations and smoke prechecks may hit 'too many clients'" >&2
fi
