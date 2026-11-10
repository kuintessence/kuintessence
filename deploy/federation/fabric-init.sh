#!/usr/bin/env bash
set -euo pipefail
umask 077
export FABRIC_CFG_PATH=/run/kq-admin

fail() { printf '%s\n' "$1" >&2; exit 1; }
# Each invocation performs one local administrative action, never another member's approval.
action=${1:-}
kind=${2:-}
args=()
read_args() {
  [[ -f "$1" ]] || fail "Missing deployment-approved CLI arguments."
  mapfile -t args < "$1"
  ((${#args[@]})) || fail "Empty deployment-approved CLI arguments."
}
case "$action" in
  orderer-join)
    read_args /run/kq-admin/orderer-join.args
    exec osnadmin channel join "${args[@]}" ;;
  peer-join)
    [[ -f /run/kq-admin/channel.id && -f /run/kq-admin/channel.block ]] || fail "Missing approved channel artifacts."
    channel=$(cat /run/kq-admin/channel.id)
    [[ "$channel" =~ ^[a-z][a-z0-9.-]{0,248}$ ]] || fail "Invalid channel ID."
    joined=$(peer channel list)
    while IFS= read -r line; do
      if [[ "$line" == "$channel" ]]; then
        printf 'Peer already joined %s\n' "$channel"
        exit 0
      fi
    done <<< "$joined"
    exec peer channel join -b /run/kq-admin/channel.block ;;
  install|approve|readiness|commit|initialize|verify)
    case "$kind" in evidence|commercial|market|case) ;; *) fail "Specify evidence, commercial, market or case." ;; esac
    directory=/run/kq-admin/$kind
    [[ -f "$directory/package.id" && -f "$directory/package.tgz" ]] || fail "Missing approved CCAAS package."
    expected=$(cat "$directory/package.id")
    actual=$(peer lifecycle chaincode calculatepackageid "$directory/package.tgz")
    [[ "$expected" == "$actual" ]] || fail "CCAAS package ID mismatch."
    case "$action" in
      install)
        installed=$(peer lifecycle chaincode queryinstalled)
        while IFS= read -r line; do
          if [[ "$line" == "Package ID: $expected, Label: "* ]]; then
            printf 'CCAAS package already installed\n'
            exit 0
          fi
        done <<< "$installed"
        exec peer lifecycle chaincode install "$directory/package.tgz" ;;
      approve)
        read_args "$directory/approve.args"
        exec peer lifecycle chaincode approveformyorg --package-id "$expected" "${args[@]}" ;;
      readiness)
        read_args "$directory/readiness.args"
        exec peer lifecycle chaincode checkcommitreadiness "${args[@]}" --output json ;;
      commit)
        read_args "$directory/commit.args"
        exec peer lifecycle chaincode commit "${args[@]}" ;;
      initialize)
        read_args "$directory/initialize.args"
        exec peer chaincode invoke --isInit --waitForEvent -c '{"Args":["Init"]}' "${args[@]}" ;;
      verify)
        read_args "$directory/verify.args"
        exec peer lifecycle chaincode querycommitted "${args[@]}" --output json ;;
    esac ;;
  *) fail 'Usage: fabric-admin orderer-join|peer-join|install|approve|readiness|commit|initialize|verify [kind]' ;;
esac
