#!/usr/bin/env bash
set -euo pipefail

normalize_architecture() {
  case "$1" in
    amd64 | x86_64) printf "amd64" ;;
    arm64 | aarch64) printf "arm64" ;;
    *)
      echo "unsupported scheduler architecture: $1" >&2
      return 1
      ;;
  esac
}

detect_binary_architecture() {
  local binary="$1"
  local description
  description="$(file -Lb "${binary}")"
  case "${description}" in
    *x86-64*) printf "amd64" ;;
    *ARM\ aarch64*) printf "arm64" ;;
    *)
      echo "cannot determine ELF architecture for ${binary}: ${description}" >&2
      return 1
      ;;
  esac
}

contract_file="${KQ_IMAGE_ARCHITECTURE_FILE:-/etc/kuintessence/image-architecture}"
if [[ ! -s "${contract_file}" ]]; then
  echo "scheduler image architecture contract is missing: ${contract_file}" >&2
  exit 1
fi

target_architecture="$(normalize_architecture "$(tr -d '[:space:]' <"${contract_file}")")"
runtime_architecture="$(normalize_architecture "$(uname -m)")"
if [[ "${target_architecture}" != "${runtime_architecture}" ]]; then
  echo "scheduler image architecture mismatch: target=${target_architecture} runtime=${runtime_architecture}" >&2
  exit 1
fi

binaries=("$@")
if ((${#binaries[@]} == 0)); then
  binaries=(/usr/local/bin/bun)
fi

for binary in "${binaries[@]}"; do
  if [[ ! -x "${binary}" ]]; then
    echo "architecture contract binary is missing or not executable: ${binary}" >&2
    exit 1
  fi
  binary_architecture="$(detect_binary_architecture "${binary}")"
  if [[ "${binary_architecture}" != "${target_architecture}" ]]; then
    echo "scheduler binary architecture mismatch: binary=${binary} expected=${target_architecture} actual=${binary_architecture}" >&2
    exit 1
  fi
done

echo "architecture contract passed: target=${target_architecture} runtime=${runtime_architecture} binaries=${binaries[*]}"
