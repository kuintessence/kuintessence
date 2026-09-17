import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { GenericContainer, Wait } from "testcontainers";

// ---------------------------------------------------------------------------
// DOCKER_HOST auto-detection (mirrors spack-container.ts / slurm-cluster.ts).
// ---------------------------------------------------------------------------
if (!process.env.DOCKER_HOST) {
  const candidates = [
    `unix://${homedir()}/.orbstack/run/docker.sock`,
    `unix://${homedir()}/.docker/run/docker.sock`,
    "unix:///var/run/docker.sock",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate.replace(/^unix:\/\//, ""))) {
      process.env.DOCKER_HOST = candidate;
      break;
    }
  }
}

/**
 * linuxserver.io OpenSSH server — password auth, configurable user, listens on
 * 2222 inside the container. Chosen because it self-configures from env and
 * generates fresh host keys at startup.
 */
const SSHD_IMAGE = "lscr.io/linuxserver/openssh-server:latest";
const SSHD_INTERNAL_PORT = 2222;
export const SSHD_USER = "kq";
export const SSHD_PASSWORD = "kq-test-password";

export interface SshdContainer {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  /** Base64 SHA-256 of the container's ed25519 host key (the pin to test). */
  readonly hostKeySha256: string;
  stop(): Promise<void>;
}

/** Probe whether a Docker daemon is reachable (tests `skipIf` cleanly, even
 *  when the `docker` CLI itself is absent). */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const probe = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    return (await probe.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Start an OpenSSH server container for integration testing. Throws on startup
 * failure. Callers should gate on {@link dockerAvailable} first.
 */
export async function startSshdContainer(): Promise<SshdContainer> {
  if (!(await dockerAvailable())) {
    throw new Error("sshd-container fixture requires a reachable Docker daemon.");
  }

  const started = await new GenericContainer(SSHD_IMAGE)
    .withEnvironment({
      PUID: "1000",
      PGID: "1000",
      PASSWORD_ACCESS: "true",
      USER_NAME: SSHD_USER,
      USER_PASSWORD: SSHD_PASSWORD,
      SUDO_ACCESS: "false",
    })
    .withExposedPorts(SSHD_INTERNAL_PORT)
    // Wait for the linuxserver init to finish — sshd starts listening BEFORE
    // the user is created, so a port-only wait races auth.
    .withWaitStrategy(Wait.forLogMessage(/\[ls\.io-init\] done\./))
    .withStartupTimeout(120_000)
    .start();

  const id = started.getId();
  // Read the ed25519 host key the server presents and compute the same base64
  // SHA-256 the agent's hostVerifier compares against (sha256 of the raw key
  // blob — i.e. the base64 field of the .pub file, decoded).
  const pub = await dockerExec(id, [
    "sh",
    "-c",
    "cat /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || cat /config/ssh_host_keys/ssh_host_ed25519_key.pub",
  ]);
  const b64Key = pub.stdout.trim().split(/\s+/)[1] ?? "";
  const hostKeySha256 = createHash("sha256").update(Buffer.from(b64Key, "base64")).digest("base64");

  return {
    host: started.getHost(),
    port: started.getMappedPort(SSHD_INTERNAL_PORT),
    username: SSHD_USER,
    password: SSHD_PASSWORD,
    hostKeySha256,
    stop: () => started.stop({ remove: true, removeVolumes: true }),
  };
}

async function dockerExec(
  containerId: string,
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["docker", "exec", containerId, ...cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}
