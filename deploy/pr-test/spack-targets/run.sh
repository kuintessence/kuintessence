#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'Target runner: stage=%s code=FAILED\n' "$1" >&2
  exit 2
}

[[ $# -eq 1 ]] || fail arguments
case "$1" in
  centos7|ubuntu24|ubuntu26) profile="$1" ;;
  *) fail arguments ;;
esac
[[ "${GITHUB_ACTIONS:-}" == true &&
   "${RUNNER_OS:-}" == Linux &&
   "${RUNNER_ARCH:-}" == X64 ]] || fail ci-guard
[[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]{0,19}$ &&
   "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]{0,19}$ ]] || fail ci-guard
[[ -n "${RUNNER_TEMP:-}" && "$RUNNER_TEMP" == /* &&
   -d "$RUNNER_TEMP" && -w "$RUNNER_TEMP" ]] || fail ci-guard
for command in docker python3 timeout; do
  command -v "$command" >/dev/null 2>&1 || fail prerequisites
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
prefix="kq-spack-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${profile}"
prepare_container="${prefix}-prepare"
offline_container="${prefix}-offline"
delivery="${prefix}-delivery"
image_tag="${prefix}:local"
work="$(mktemp -d "$RUNNER_TEMP/${prefix}.XXXXXXXX" 2>/dev/null)" || fail temporary-directory
prepare_owned=false
offline_owned=false
volume_owned=false
image_owned=false

# Pin every operation to the disposable runner's local daemon.
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
docker_local() {
  docker --host unix:///var/run/docker.sock "$@"
}

remove_owned() {
  local kind="$1" name="$2" remaining
  local -a remove list
  case "$kind" in
    container)
      remove=(container rm --force "$name")
      list=(container ls --all --filter "name=^/${name}$" --format '{{.Names}}')
      ;;
    volume)
      remove=(volume rm "$name")
      list=(volume ls --filter "name=^${name}$" --format '{{.Name}}')
      ;;
    image)
      remove=(image rm "$name")
      list=(image ls --quiet "$name")
      ;;
  esac
  if timeout --signal=TERM --kill-after=2s 8s \
    docker --host unix:///var/run/docker.sock "${remove[@]}" >>"$work/cleanup.log" 2>&1; then
    return 0
  fi
  # A failed create/build may not have left a resource. Distinguish that from a failed removal.
  remaining="$(timeout --signal=TERM --kill-after=2s 8s \
    docker --host unix:///var/run/docker.sock "${list[@]}" 2>>"$work/cleanup.log")" || return 1
  [[ -z "$remaining" ]]
}

cleanup() {
  local result=$? cleanup_failed=false
  trap - EXIT INT TERM
  if [[ "$offline_owned" == true ]]; then
    remove_owned container "$offline_container" || cleanup_failed=true
  fi
  if [[ "$prepare_owned" == true ]]; then
    remove_owned container "$prepare_container" || cleanup_failed=true
  fi
  if [[ "$volume_owned" == true ]]; then
    remove_owned volume "$delivery" || cleanup_failed=true
  fi
  if [[ "$image_owned" == true ]]; then
    remove_owned image "$image_tag" || cleanup_failed=true
  fi
  rm -rf -- "$work" 2>/dev/null || cleanup_failed=true
  if [[ "$cleanup_failed" == true ]]; then
    printf '%s\n' 'Target runner: stage=cleanup code=FAILED' >&2
    result=1
  else
    printf '%s\n' 'Target runner: stage=cleanup code=OK'
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

capture() {
  local stage="$1"
  shift
  "$@" >"$work/$stage.log" 2>&1 || fail "$stage"
}

emit_build_markers() {
  python3 - "$work/build.log" 2>"$work/build-markers.log" <<'PY'
import re
import sys

marker = re.compile(
    r"(?:#\d+ (?:\d+\.\d+ )?)?"
    r"(Target bootstrap: stage=(?:platform|openssl|python|solver|spack|recipes) code=(?:OK|FAILED))"
)
with open(sys.argv[1], encoding="utf-8", errors="replace") as stream:
    for raw in stream:
        if len(raw) <= 256:
            match = marker.fullmatch(raw.rstrip("\n"))
            if match:
                print(match.group(1), flush=True)
PY
}

emit_probe_markers() {
  local phase="$1"
  python3 - "$profile" "$phase" "$work/$phase.log" 2>"$work/$phase-markers.log" <<'PY'
import re
import sys

profile, phase, path = sys.argv[1:]
targets = {
    "centos7": "centos7", "ubuntu24": "ubuntu24.04", "ubuntu26": "ubuntu26.04",
}
stages = "platform|prepare|metadata|missing-source|resolve|install|execute|readback|complete"
probe = re.compile(
    rf"Target probe: phase={phase} profile={profile} stage=({stages}) code=(OK|FAILED|RUNNING)"
)
diagnostic = re.compile(
    rf"Target diagnostic: phase={phase} profile={profile} "
    r"error=(ProbeError|OSError|ImportError|ValueError|KeyError|TypeError|"
    r"AttributeError|RuntimeError|CalledProcessError|TimeoutExpired|other) line=[0-9]{1,5}"
)
identity = re.compile(
    rf"Target identity: profile={profile} target=linux-{re.escape(targets[profile])}-x86_64 "
    r"gcc=[0-9]+(?:\.[0-9]+)* python=3\.11\.16 spack=1\.0\.0 code=OK"
)
complete = identified = failed = False
with open(path, encoding="utf-8", errors="replace") as stream:
    for raw in stream:
        line = raw.rstrip("\n")
        if len(line) > 256:
            continue
        match = probe.fullmatch(line)
        if match:
            print(line, flush=True)
            complete = complete or match.groups() == ("complete", "OK")
            failed = failed or match.group(2) == "FAILED"
        elif identity.fullmatch(line):
            print(line, flush=True)
            identified = True
        elif diagnostic.fullmatch(line):
            print(line, flush=True)
sys.exit(0 if complete and identified and not failed else 1)
PY
}

run_probe() {
  local phase="$1" container="$2" result=0 evidence=0
  docker_local start --attach "$container" >"$work/$phase.log" 2>&1 || result=$?
  emit_probe_markers "$phase" || evidence=$?
  [[ "$result" -eq 0 ]] || fail "$phase"
  [[ "$evidence" -eq 0 ]] || fail "$phase-evidence"
  printf 'Target runner: stage=%s code=OK\n' "$phase"
}

# Do not adopt or remove pre-existing resources, including an earlier invocation of this run.
capture inventory-containers docker_local container ls --all --format '{{.Names}}'
capture inventory-volumes docker_local volume ls --format '{{.Name}}'
capture inventory-images docker_local image ls --format '{{.Repository}}:{{.Tag}}'
while IFS= read -r name; do
  [[ "$name" != "$prepare_container" && "$name" != "$offline_container" ]] || fail resource-collision
done <"$work/inventory-containers.log"
while IFS= read -r name; do
  [[ "$name" != "$delivery" ]] || fail resource-collision
done <"$work/inventory-volumes.log"
while IFS= read -r name; do
  [[ "$name" != "$image_tag" ]] || fail resource-collision
done <"$work/inventory-images.log"

build_args=()
if [[ "$profile" == centos7 ]]; then
  dockerfile="$repo_root/deploy/pr-test/spack-targets/centos7.Dockerfile"
else
  dockerfile="$repo_root/deploy/pr-test/spack-targets/ubuntu.Dockerfile"
  base_image=ubuntu:24.04
  [[ "$profile" != ubuntu26 ]] || base_image=ubuntu:26.04
  build_args=(--build-arg "BASE_IMAGE=$base_image" --build-arg "TARGET_PROFILE=$profile")
fi
image_owned=true
build_result=0
docker_local build --progress plain --platform linux/amd64 --pull \
  --file "$dockerfile" --tag "$image_tag" --iidfile "$work/image.id" \
  "${build_args[@]}" "$repo_root" >"$work/build.log" 2>&1 || build_result=$?
emit_build_markers || fail build-evidence
[[ "$build_result" -eq 0 ]] || fail build
[[ -f "$work/image.id" ]] || fail image-identity
image_id="$(<"$work/image.id")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail image-identity
printf '%s\n' 'Target runner: stage=build code=OK'

volume_owned=true
capture delivery docker_local volume create --driver local "$delivery"
isolation_args=(
  --platform linux/amd64
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges
  --user 1000:1000
  --cpus 2
  --memory 4g
  --memory-swap 4g
  --pids-limit 256
  --workdir /work
  --env HOME=/work/home
  --env TMPDIR=/tmp
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=1777
  --tmpfs /work:rw,exec,nosuid,nodev,size=2g,uid=1000,gid=1000,mode=0700
  --entrypoint /opt/spack/bin/spack
)

prepare_owned=true
capture prepare-create docker_local create --name "$prepare_container" \
  "${isolation_args[@]}" --network bridge \
  --mount "type=volume,src=$delivery,dst=/delivery" \
  "$image_id" python /opt/kq-target/probe.py prepare "$profile" /delivery
run_probe prepare "$prepare_container"

offline_owned=true
capture offline-create docker_local create --name "$offline_container" \
  "${isolation_args[@]}" --network none \
  --mount "type=volume,src=$delivery,dst=/delivery,readonly,volume-nocopy" \
  "$image_id" python /opt/kq-target/probe.py offline "$profile" /delivery
capture offline-inspect docker_local container inspect "$offline_container"
if ! python3 - "$work/offline-inspect.log" "$delivery" "$image_id" \
  >"$work/isolation.log" 2>&1 <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    records = json.load(stream)
if not isinstance(records, list) or len(records) != 1:
    sys.exit(1)
container = records[0]
host = container["HostConfig"]
mounts = container["Mounts"]
delivery = [mount for mount in mounts if mount["Destination"] == "/delivery"]
checks = (
    container["Image"] == sys.argv[3],
    container["Config"]["User"] == "1000:1000",
    container["State"]["Status"] == "created",
    host["NetworkMode"] == "none",
    host["ReadonlyRootfs"] is True,
    host["CapDrop"] == ["ALL"],
    "no-new-privileges" in host["SecurityOpt"],
    host["NanoCpus"] == 2_000_000_000,
    host["Memory"] == 4 * 1024**3,
    host["PidsLimit"] == 256,
    set(host["Tmpfs"]) == {"/tmp", "/work"},
    len(delivery) == 1,
    all(mount["Type"] == "tmpfs" or mount in delivery for mount in mounts),
)
if not all(checks):
    sys.exit(1)
mount = delivery[0]
if not (
    mount["Type"] == "volume"
    and mount["Name"] == sys.argv[2]
    and mount["RW"] is False
):
    sys.exit(1)
PY
then
  fail isolation
fi
printf '%s\n' 'Target runner: stage=isolation code=OK'
run_probe offline "$offline_container"
