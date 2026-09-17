/**
 * Builders for the `docker exec` argv used by the Agent's file-transfer paths.
 *
 * SECURITY: the presigned `url` and the job/workflow-controlled `targetPath`
 * MUST NOT be interpolated into the `sh -c` script string — `targetPath`
 * derives from a workflow's `stagePath` (user-authored, unvalidated) and the
 * command runs as root inside the cluster container, so interpolation is a
 * remote-command-execution vector. Both are passed as positional args
 * (`sh -c '<script>' _ <url> <targetPath>` → `$1`, `$2`) so the shell treats
 * them as data, never as code. Mirrors the positional-arg pattern in
 * `container-io.ts`. `maxRetries` ($3) and `backoffSec` ($4) are config ints,
 * but are likewise passed positionally so the script string stays fully
 * interpolation-free (no value from outside the fixed constants is spliced in).
 */

/**
 * Bounded retry-resume download. `curl -C -` resumes from the partial file's
 * current size (verified against real MinIO: correct on both a fresh/nonexistent
 * file and a partial one), so a single-branch loop is correct — no first-attempt
 * special case. After `$3` consecutive failures it exits non-zero so the Server
 * re-dispatches. A rare end-of-stream 416 (the file is already byte-complete when
 * a retry fires) is NOT handled in-script: curl exits non-zero, the loop gives up,
 * and the transfer falls back to a full re-dispatch — accepted as a rare case.
 */
const CLOUD_TO_CLUSTER_SCRIPT =
  'dir=$(dirname "$2"); mkdir -p "$dir"; n=0; ' +
  'while :; do if [ -n "$5" ]; then curl -fsSL -C - --connect-to "$5" "$1" -o "$2"; ' +
  'else curl -fsSL -C - "$1" -o "$2"; fi && break; ' +
  'n=$((n+1)); [ "$n" -ge "$3" ] && exit 1; sleep "$4"; done; chmod 644 "$2"';

/**
 * True if a transfer path contains a `..` segment. Transfer paths are
 * Server-anchored at a per-job run directory (`<base>/<stagePath>`) where
 * `stagePath` is user-authored and unvalidated; a `..` segment lets it escape
 * the run dir — writing arbitrary files on download, or reading arbitrary files
 * to exfiltrate on upload, both as root in the container. The Agent rejects such
 * paths defensively (the durable fix is to validate stagePath upstream — tbd #12).
 */
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
): string[] {
  return [
    "docker",
    "exec",
    "-u",
    "root",
    containerId,
    "sh",
    "-c",
    CLOUD_TO_CLUSTER_SCRIPT,
    "_",
    url,
    targetPath,
    String(maxRetries),
    String(backoffSec),
    connectTo,
  ];
}

export function buildHostCloudToClusterArgv(
  url: string,
  targetPath: string,
  maxRetries: number,
  backoffSec: number,
  connectTo = "",
): string[] {
  return [
    "sh",
    "-c",
    CLOUD_TO_CLUSTER_SCRIPT,
    "_",
    url,
    targetPath,
    String(maxRetries),
    String(backoffSec),
    connectTo,
  ];
}
