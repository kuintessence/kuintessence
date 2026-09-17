import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { GenericContainer } from "testcontainers";
import type { Spawner } from "../../src/adapters/base";

// ---------------------------------------------------------------------------
// DOCKER_HOST auto-detection for OrbStack / Docker Desktop / native.
// Mirrors slurm-cluster.ts: testcontainers v11 reads DOCKER_HOST lazily, so
// setting it at module-load time (before any startSpackContainer() call) is
// sufficient. We never overwrite a value the caller already set.
// ---------------------------------------------------------------------------
if (!process.env.DOCKER_HOST) {
  const candidates = [
    `unix://${homedir()}/.orbstack/run/docker.sock`, // OrbStack (macOS)
    `unix://${homedir()}/.docker/run/docker.sock`, // Docker Desktop (macOS)
    "unix:///var/run/docker.sock", // native Linux / Docker Engine
  ];
  for (const candidate of candidates) {
    const socketPath = candidate.replace(/^unix:\/\//, "");
    if (existsSync(socketPath)) {
      process.env.DOCKER_HOST = candidate;
      break;
    }
  }
}

/**
 * Official Spack image. Ships spack under `/opt/spack`; the binary is at
 * `/opt/spack/bin/spack`. The image's ENTRYPOINT is `spack` itself, so we
 * override it to a long-running no-op to keep the container alive for `exec`.
 */
const SPACK_IMAGE = "ghcr.io/spack/ubuntu-jammy:latest";

/**
 * Absolute spack binary path inside the image. We invoke spack by absolute
 * path rather than relying on PATH because the image does not put spack on
 * PATH for a non-login `docker exec` shell.
 */
export const SPACK_BINARY = "/opt/spack/bin/spack";

export interface SpackContainer {
  exec(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Path to the spack binary inside the container — pass to bootstrap({ binary }). */
  readonly spackBinary: string;
  /** Container ID. */
  readonly containerId: string;
  /** A `Spawner` that runs every command via `docker exec` in this container. */
  readonly spawner: Spawner;
  stop(): Promise<void>;
}

/**
 * Probe whether a Docker daemon is reachable. Integration tests use this to
 * `test.skip` cleanly on machines without Docker so the suite stays green.
 */
export async function dockerAvailable(): Promise<boolean> {
  const probe = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
  return (await probe.exited) === 0;
}

/**
 * Start an official Spack-in-Docker container for integration testing.
 *
 * Requirements:
 * - `docker` CLI on PATH and a reachable daemon. DOCKER_HOST is auto-detected
 *   for OrbStack / Docker Desktop / native installs.
 *
 * Throws on container startup failure or if `spack --version` does not succeed
 * inside the container.
 */
export async function startSpackContainer(): Promise<SpackContainer> {
  if (!(await dockerAvailable())) {
    throw new Error(
      "spack-container fixture requires `docker` CLI on PATH and a reachable daemon. " +
        "Set DOCKER_HOST or install OrbStack/Docker Desktop.",
    );
  }

  const started = await new GenericContainer(SPACK_IMAGE)
    .withEntrypoint(["tail", "-f", "/dev/null"])
    .withStartupTimeout(120_000)
    .start();

  const id = started.getId();
  const containerExec = makeDockerExec(id);

  try {
    const probe = await containerExec([SPACK_BINARY, "--version"]);
    if (probe.exitCode !== 0) {
      throw new Error(
        `spack --version failed in container: ${probe.stderr.trim() || probe.stdout.trim()}`,
      );
    }
  } catch (err) {
    await started.stop({ remove: true, removeVolumes: true }).catch(() => {});
    throw err;
  }

  const spawner: Spawner = {
    run: (cmd) => containerExec(cmd),
  };

  return {
    containerId: id,
    exec: containerExec,
    spackBinary: SPACK_BINARY,
    spawner,
    stop: () => started.stop({ remove: true, removeVolumes: true }),
  };
}

type ExecFn = (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Build an exec function that shells out to `docker exec` via Bun.spawn.
 * Bypasses testcontainers' exec path, which hangs under Bun + OrbStack because
 * `exec.start({ stdin: true })` keeps the docker socket open waiting on stdin.
 */
function makeDockerExec(containerId: string): ExecFn {
  return async (cmd: string[]) => {
    const proc = Bun.spawn(["docker", "exec", containerId, ...cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  };
}
