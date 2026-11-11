#!/usr/bin/env bash
set -euo pipefail
umask 077
directory=/var/lib/kuintessence/registration
mkdir -p "$directory"
if [[ -s "$directory/agent.env" && -s "$directory/certs/client.crt" && -s "$directory/certs/client.key" && -s "$directory/certs/ca.crt" ]]; then
  exit 0
fi
# A token is single-use: an unknown completion needs an operator to reconcile it.
if [[ -e "$directory/registration.attempt" ]]; then
  echo 'Registration outcome unknown; reconcile the original Agent/certificate before enrolling again.' >&2
  exit 1
fi
[[ -s /run/kq-agent-enrollment/token ]] || { echo 'Provision a private one-time registration token.' >&2; exit 1; }
printf '%s\n' 'Registration started; preserve this checkpoint if completion is unknown.' > "$directory/registration.attempt"
/usr/local/bin/kq-agent-admin agent register \
  --url "${SERVER_HTTP_URL:?}" --grpc-url "${SERVER_GRPC_URL:?}" \
  --token-file /run/kq-agent-enrollment/token \
  --scheduler "${KQ_AGENT_REGISTRATION_SCHEDULER:?}" --output-dir "$directory"
rm "$directory/registration.attempt"
