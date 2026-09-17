import type { GlobScanner, OutputReader, ValidatedOutputReader } from "./output-collector";

/**
 * Container-side file I/O for the `container` spawner backend: read completed-job
 * output files and create run directories INSIDE a Docker container via
 * `docker exec`. Every path/content value is passed as a
 * positional arg (`sh -c '<script>' _ arg1 arg2`) so it is never interpolated
 * into the `sh -c` string — this eliminates shell-injection risk on
 * job-controlled paths and contents.
 *
 * Host-mode equivalents live in `output-collector` (hostOutputReader) and
 * `index.ts` main() (node:fs). These are extracted from the entrypoint so they
 * can be integration-tested against a real container without triggering main().
 */

/**
 * Build an OutputReader that reads a file from inside a container via
 * `docker exec sh -c 'cat "$1"'`.
 */
export function makeContainerReadOutput(containerId: string): OutputReader {
  const reader: OutputReader = async (path: string): Promise<string> => {
    const proc = Bun.spawn(
      ["docker", "exec", "-u", "root", containerId, "sh", "-c", 'cat "$1"', "_", path],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Container readOutput failed (exit ${exitCode}): ${stderr}`);
    }
    return new Response(proc.stdout).text();
  };
  reader.readValidated = makeContainerValidatedOutputReader(containerId);
  reader.validatePath = async (outputPath, workingDir, protectedPaths) => {
    await runContainerOutputValidation(containerId, outputPath, workingDir, protectedPaths, false);
  };
  return reader;
}

function makeContainerValidatedOutputReader(containerId: string): ValidatedOutputReader {
  return (outputPath, workingDir, protectedPaths) =>
    runContainerOutputValidation(containerId, outputPath, workingDir, protectedPaths, true);
}

async function runContainerOutputValidation(
  containerId: string,
  outputPath: string,
  workingDir: string,
  protectedPaths: readonly string[],
  readContents: boolean,
): Promise<string> {
  const sh = `
set -eu
fail() { printf '%s\\n' "$1" >&2; exit 1; }
inside() {
  [ "$2" = "$1" ] || case "$2" in "$1"/*) return 0 ;; *) return 1 ;; esac
}
read_contents=$1
output_path=$2
working_dir=$3
shift 3
case "$working_dir" in /*) ;; *) fail "Expected output work root must be absolute" ;; esac
[ -d "$working_dir" ] && [ ! -L "$working_dir" ] || fail "Expected output work root must be a non-symbolic-link directory"
work_root=$(realpath -e -- "$working_dir") || fail "Failed to canonicalize output work root"
[ -d "$work_root" ] && [ ! -L "$work_root" ] || fail "Expected output work root must be a directory"
output_resolved=$(realpath -ms -- "$output_path") || fail "Failed to resolve expected output path"
for protected_path in "$@"; do
  protected_resolved=$(realpath -ms -- "$protected_path") || fail "Failed to resolve protected output path"
  inside "$protected_resolved" "$output_resolved" && fail "Expected output path is protected licensed material"
done
exec 3< "$output_path" || fail "Failed to open expected output"
canonical=$(readlink -f /proc/self/fd/3) || fail "Failed to resolve opened expected output"
[ -f /proc/self/fd/3 ] || fail "Expected output must remain a regular file"
[ "$canonical" = "$output_resolved" ] || fail "Expected output must not resolve through symbolic links"
inside "$work_root" "$canonical" || fail "Expected output path escapes the job work root"
for protected_path in "$@"; do
  protected_resolved=$(realpath -ms -- "$protected_path") || fail "Failed to resolve protected output path"
  if [ -e "$protected_resolved" ] || [ -L "$protected_resolved" ]; then
    canonical_protected=$(realpath -e -- "$protected_resolved") || fail "Failed to canonicalize protected output path"
    inside "$canonical_protected" "$canonical" && fail "Expected output path is protected licensed material"
  fi
done
if [ "$read_contents" = 1 ]; then cat <&3; fi
`;
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      "-u",
      "root",
      containerId,
      "sh",
      "-c",
      sh,
      "_",
      readContents ? "1" : "0",
      outputPath,
      workingDir,
      ...protectedPaths,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Container output path validation failed (exit ${exitCode}): ${stderr}`);
  }
  return stdout;
}

export function makeContainerGlobScanner(containerId: string): GlobScanner {
  return async (pattern: string, workingDir: string): Promise<string[]> => {
    const sh = 'test -d "$2" || exit 0; find "$2" -type f -path "$2/$1" -printf "%P\\n"';
    const proc = Bun.spawn(
      ["docker", "exec", "-u", "root", containerId, "sh", "-c", sh, "_", pattern, workingDir],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Container globScanner failed (exit ${exitCode}): ${stderr}`);
    }
    return stdout.split("\n").filter(Boolean);
  };
}

/** Build a `mkdir -p` that creates a run directory inside a container. */
export function makeContainerMkdir(containerId: string): (path: string) => Promise<void> {
  return async (path: string): Promise<void> => {
    const proc = Bun.spawn(
      [
        "docker",
        "exec",
        "-u",
        "root",
        containerId,
        "sh",
        "-c",
        'mkdir -p "$1" && chmod 1777 "$1"',
        "_",
        path,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Container mkdir failed (exit ${exitCode}): ${stderr}`);
    }
  };
}
