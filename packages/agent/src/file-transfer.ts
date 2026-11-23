import { readSiteTransport, siteCurlArgs } from "@kuintessence/shared/site-transport";

// The shell keeps the destination directory as its cwd and the private staging
// directory open across download, verification and rename. Paths and URLs are argv data.
const DOWNLOAD_SCRIPT = `set -eu
url="$1"; target="$2"; attempts="$3"; delay="$4"; connect="$5"; shift 5
handshake=""
if [ "$#" -ge 1 ] && [ "$1" = --confirm ]; then handshake=yes; shift; fi
digest=""; size=""
if [ "$#" -ge 1 ] && [ "$1" = --digest ]; then digest="$2"; size="$3"; shift 3; fi
case "/$target/" in */.kq-replicas/*) exit 2;; esac
dir=$(realpath -m -- "$(dirname -- "$target")")
case "$dir/" in */.kq-replicas/*) exit 2;; esac
cd /
remaining=\${dir#/}
while [ -n "$remaining" ]; do
  component=\${remaining%%/*}
  case "$remaining" in */*) remaining=\${remaining#*/};; *) remaining="";; esac
  [ -d "$component" ] || mkdir -m 700 -- "$component" || [ -d "$component" ]
  cd -P -- "$component"
  case "$(pwd -P)/" in */.kq-replicas/*) exit 2;; esac
done
name=$(basename -- "$target")
case "$name" in ""|"."|".."|".kq-replicas") exit 2;; esac
cwd=$(pwd -P)
tmp=$(mktemp -d .kq-transfer.XXXXXXXX)
exec 4<"$tmp"
[ "$(stat -Lc '%u:%a' /proc/self/fd/4)" = "$(id -u):700" ]
[ "$(readlink -f /proc/self/fd/4)" = "\${cwd%/}/$tmp" ]
case "$(readlink -f /proc/self/fd/4)/" in */.kq-replicas/*) exit 2;; esac
data=/proc/self/fd/4/payload
cleanup() {
  if [ -n "$monitor" ]; then kill "$monitor" 2>/dev/null || :; wait "$monitor" 2>/dev/null || :; fi
  rm -f -- "$data"; rmdir -- "$tmp"
}
monitor=""
trap cleanup EXIT
trap 'exit 1' HUP TERM INT
(set -C; : > "$data")
while sleep 1; do stat -c %s -- "$data" 2>/dev/null || break; done &
monitor=$!
if [ -n "$connect" ]; then set -- "$@" --connect-to "$connect"; fi
if [ -n "$size" ] && [ "$size" != 0 ]; then set -- "$@" --max-filesize "$size"; fi
n=0
while ! curl -fsSL -C - "$@" -o "$data" -- "$url"; do
  n=$((n+1)); [ "$n" -lt "$attempts" ] || exit 1; sleep "$delay"
done
bytes=$(stat -c %s -- "$data")
if [ -n "$digest" ]; then
  actual=$(sha256sum < "$data")
  if [ "$bytes" != "$size" ] || [ "\${actual%% *}" != "$digest" ]; then echo "Download content mismatch" >&2; exit 1; fi
fi
kill "$monitor" 2>/dev/null || :
wait "$monitor" 2>/dev/null || :
monitor=""
if [ -n "$handshake" ]; then
  printf 'ready %s\\n' "$bytes"
  IFS= read -r decision && [ "$decision" = publish ] || exit 1
fi
chmod 644 "$data"
mv -fT -- "$data" "$name"
printf '%s\\n' "$bytes"`;

export function containerTransferSourceArgv(containerId: string, path: string): string[] {
  return [
    "docker",
    "exec",
    "-u",
    "root",
    containerId,
    "sh",
    "-c",
    'set -eu; exec 3<"$1"; test -f /proc/self/fd/3; p=$(readlink -f /proc/self/fd/3); case "/$1/:$p/" in */.kq-replicas/*) exit 2;; esac; exec cat <&3',
    "_",
    path,
  ];
}

/** Agent-side path check for both upload and download requests. */
export function hasPathTraversal(path: string): boolean {
  return path.split("/").some((seg) => seg === "..");
}

export function normalizeClusterToCloudSourceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("enoent") ||
    lower.includes("no such file or directory") ||
    lower.includes("cannot access") ||
    lower.includes("statx")
  ) {
    return "CLUSTER_SOURCE_FILE_UNAVAILABLE";
  }
  return message;
}

/**
 * Build the `docker exec` argv that downloads a presigned object into the
 * container at `targetPath`. `url` and `targetPath` are positional args, never
 * interpolated into the script.
 */
export function buildCloudToClusterArgv(
  containerId: string,
  url: string,
  targetPath: string,
  maxRetries: number,
  backoffSec: number,
  connectTo = "",
  content?: { sha256: string; size: number },
  confirm = false,
  purpose: "transfer" | "job-input" = "transfer",
): string[] {
  if (readSiteTransport())
    throw new Error("Site transport requires host staging before container execution");
  return [
    "docker",
    "exec",
    ...(confirm ? ["-i"] : []),
    ...(purpose === "transfer" ? ["-u", "root"] : []),
    containerId,
    "sh",
    "-c",
    DOWNLOAD_SCRIPT,
    "_",
    url,
    targetPath,
    String(maxRetries),
    String(backoffSec),
    connectTo,
    ...(confirm ? ["--confirm"] : []),
    ...(content ? ["--digest", content.sha256, String(content.size)] : []),
  ];
}

export function buildHostCloudToClusterArgv(
  url: string,
  targetPath: string,
  maxRetries: number,
  backoffSec: number,
  connectTo = "",
  confirm = false,
): string[] {
  const site = readSiteTransport();
  return [
    "sh",
    "-c",
    DOWNLOAD_SCRIPT,
    "_",
    url,
    targetPath,
    String(maxRetries),
    String(backoffSec),
    site ? "" : connectTo,
    ...(confirm ? ["--confirm"] : []),
    ...(site ? siteCurlArgs(url, site) : []),
  ];
}
