import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { GenericContainer } from "testcontainers";

// ---------------------------------------------------------------------------
// DOCKER_HOST auto-detection for OrbStack / Docker Desktop / native.
// testcontainers v11 reads DOCKER_HOST lazily (first call to getContainerRuntimeConfig),
// so setting it here — at module load time, before any startSlurmCluster() call —
// is sufficient. We never overwrite a value the caller has already set.
// ---------------------------------------------------------------------------
if (!process.env.DOCKER_HOST) {
  const candidates = [
    `unix://${homedir()}/.orbstack/run/docker.sock`, // OrbStack (macOS)
    `unix://${homedir()}/.docker/run/docker.sock`, // Docker Desktop (macOS)
    "unix:///var/run/docker.sock", // native Linux / Docker Engine
  ];
  for (const candidate of candidates) {
    // candidate is "unix:///path" — extract the path after "unix://"
    const socketPath = candidate.replace(/^unix:\/\//, "");
    if (existsSync(socketPath)) {
      process.env.DOCKER_HOST = candidate;
      break;
    }
  }
}

export interface SlurmCluster {
  exec(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Container ID — needed by Task 4's stack fixture to wire ContainerSpawner. */
  readonly containerId: string;
  stop(): Promise<void>;
}

// Use /var/tmp so it survives across the sudo boundary inside the container;
// it is world-writable after chmod 1777, suitable for test scripts dropped via exec.
const CONTAINER_WORK_DIR = "/var/tmp/kq-slurm-shared";

/**
 * Start a self-contained Slurm-in-Docker cluster for integration testing.
 *
 * Requirements:
 * - `docker` CLI must be on PATH and a reachable daemon must be running.
 * - DOCKER_HOST is auto-detected for OrbStack, Docker Desktop, and native installs;
 *   set it explicitly in the environment to override.
 *
 * Throws on container startup failure, setup exec failure, or Slurm readiness timeout.
 */
export async function startSlurmCluster(): Promise<SlurmCluster> {
  // Guard: ensure `docker` CLI is reachable before attempting container start.
  const probe = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
  if ((await probe.exited) !== 0) {
    throw new Error(
      "slurm-cluster fixture requires `docker` CLI on PATH and a reachable daemon. " +
        "Set DOCKER_HOST or install OrbStack/Docker Desktop.",
    );
  }

  const started = await new GenericContainer("nathanhess/slurm:full")
    // The image's default CMD is `bash -l`, which exits immediately under `docker run -d`.
    // Override with startup.sh + tail so the container stays alive while tests run.
    .withHostname("ernie")
    .withCommand(["/bin/sh", "-c", "sudo /etc/startup.sh ; tail -f /dev/null"])
    .withStartupTimeout(60_000)
    .start();

  const id = started.getId();

  // testcontainers v11 exec hangs in Bun+OrbStack because exec.start({ stdin: true })
  // keeps the docker socket open waiting for stdin input and the stream never fires "end".
  // Workaround: use Bun.spawn to call `docker exec` as a subprocess instead.
  const containerExec = makeDockerExec(id);

  try {
    // Ensure the shared test work directory is writable by scheduled jobs.
    const setup = await containerExec([
      "sh",
      "-c",
      `mkdir -p ${CONTAINER_WORK_DIR} && chmod 1777 ${CONTAINER_WORK_DIR}`,
    ]);
    if (setup.exitCode !== 0) {
      throw new Error(
        `Failed to create test work directory: ${setup.stderr.trim() || setup.stdout.trim()}`,
      );
    }

    await waitForSinfo(containerExec);
  } catch (err) {
    await started.stop({ remove: true, removeVolumes: true }).catch(() => {});
    throw err;
  }

  return {
    containerId: id,
    exec: containerExec,
    stop: () => started.stop({ remove: true, removeVolumes: true }),
  };
}

type ExecFn = (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Build an exec function that shells out to `docker exec` via Bun.spawn.
 * This bypasses testcontainers' exec path which hangs due to stdin:true keeping
 * the docker socket open indefinitely under Bun + OrbStack.
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

async function waitForSinfo(exec: ExecFn): Promise<void> {
  const deadline = Date.now() + 45_000;
  let last: { exitCode: number; stdout: string; stderr: string } = {
    exitCode: -1,
    stdout: "",
    stderr: "",
  };
  while (Date.now() < deadline) {
    last = await exec(["sinfo", "-h", "-o", "%T"]);
    // Partition is `debug` in this image; check for `idle` substring rather than pinning the name.
    if (last.exitCode === 0 && last.stdout.includes("idle")) return;
    await Bun.sleep(1500);
  }
  throw new Error(
    `Slurm did not become ready within 45s — last sinfo exit=${last.exitCode} stdout=${JSON.stringify(last.stdout.trim())} stderr=${JSON.stringify(last.stderr.trim())}`,
  );
}
