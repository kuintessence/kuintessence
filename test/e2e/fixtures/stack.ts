import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { GenericContainer, Wait } from "testcontainers";
import {
  type SlurmCluster,
  startSlurmCluster,
} from "../../../packages/agent/test/fixtures/slurm-cluster";
import { E2E_SPACK_PACKAGE } from "./governed-package";
import {
  freePort,
  waitForAgentOnline,
  waitForAgentSoftware,
  waitForHttp,
  waitForTcp,
} from "./util";

export interface Stack {
  serverBaseUrl: string;
  serverGrpcUrl: string;
  adminToken: string;
  slurm: SlurmCluster;
  agentId: string;
  databaseUrl: string;
  netdrive?: {
    endpoint: string;
    port: number;
    bucket: string;
  };
  restartServer(): Promise<void>;
  restartAgent(): Promise<void>;
  stop(): Promise<void>;
}

// fileURLToPath correctly decodes percent-encoded characters (e.g. Chinese chars in path).
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const NETDRIVE_BUCKET = "kq-netdrive";
const DATA_MARKET_STAGING_BUCKET = "kq-data-market-staging";
const DATA_MARKET_IMMUTABLE_BUCKET = "kq-data-market-immutable";
const MINIO_COMMITTER_ACCESS_KEY = "kq-e2e-committer";
const MINIO_COMMITTER_SECRET_KEY = "kq-e2e-committer-secret";

export interface StartStackOptions {
  netdrive?: boolean;
  serverEnv?: Record<string, string>;
  agentEnv?: Record<string, string>;
}

export async function startStack(options: StartStackOptions = {}): Promise<Stack> {
  // Collect resources for partial-failure cleanup
  const cleanup: Array<() => Promise<void>> = [];

  try {
    // -----------------------------------------------------------------------
    // 1. Postgres
    // Use Wait.forLogMessage to avoid the InternalPortCheck exec hang that
    // occurs in Bun + OrbStack (testcontainers v11 keeps stdin open indefinitely).
    // -----------------------------------------------------------------------
    const pg = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_PASSWORD: "kq",
        POSTGRES_USER: "kq",
        POSTGRES_DB: "kq",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .withStartupTimeout(60_000)
      .start();
    cleanup.push(() => pg.stop());

    const pgUrl = `postgres://kq:kq@${pg.getHost()}:${pg.getMappedPort(5432)}/kq`;

    // -----------------------------------------------------------------------
    // 2. Redis — intentionally NOT started.
    // Server validates REDIS_URL but uses an in-process event bus, so no Redis
    // container is needed. If Redis becomes a runtime dependency, add a
    // container with connection-based readiness rather than a log-message wait.
    const redisUrl = "redis://localhost:6379";

    // -----------------------------------------------------------------------
    // 3. Migrate DB
    // -----------------------------------------------------------------------
    const migrate = Bun.spawn(["bunx", "drizzle-kit", "migrate"], {
      cwd: join(REPO_ROOT, "packages/db"),
      env: { ...process.env, DATABASE_URL: pgUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [migrateExit, migrateStdout, migrateStderr] = await Promise.all([
      migrate.exited,
      new Response(migrate.stdout).text(),
      new Response(migrate.stderr).text(),
    ]);
    if (migrateExit !== 0) {
      throw new Error(
        `drizzle-kit migrate failed with exit code ${migrateExit}\nstdout: ${migrateStdout}\nstderr: ${migrateStderr}`,
      );
    }

    // -----------------------------------------------------------------------
    // 4. Optional MinIO / NetDrive backend
    // -----------------------------------------------------------------------
    let netdrive:
      | {
          endpoint: string;
          port: number;
          bucket: string;
        }
      | undefined;
    let stopNetdrive: (() => Promise<void>) | undefined;
    if (options.netdrive) {
      const minio = await new GenericContainer("quay.io/minio/minio:RELEASE.2025-04-08T15-41-24Z")
        .withCommand(["server", "/data"])
        .withEnvironment({
          MINIO_ROOT_USER: "minioadmin",
          MINIO_ROOT_PASSWORD: "minioadmin",
        })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forLogMessage("API:"))
        .withStartupTimeout(60_000)
        .start();
      cleanup.push(() => minio.stop());
      stopNetdrive = () => minio.stop();
      await ensureMinioStorage(minio.getId());
      netdrive = {
        endpoint: "127.0.0.1",
        port: minio.getMappedPort(9000),
        bucket: NETDRIVE_BUCKET,
      };
    }

    // -----------------------------------------------------------------------
    // 5. Server
    // -----------------------------------------------------------------------
    const serverPort = await freePort();
    const serverGrpcPort = await freePort();
    const serverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: pgUrl,
      REDIS_URL: redisUrl,
      JWT_SECRET: "e2e-secret-must-be-at-least-32-characters-long!!",
      SERVER_PORT: String(serverPort),
      SERVER_GRPC_PORT: String(serverGrpcPort),
      LOG_LEVEL: "warn",
      WORKFLOW_RUN_BASE: "/var/tmp/kq-workflows",
    };
    if (netdrive) {
      Object.assign(serverEnv, {
        NETDRIVE_ENABLED: "true",
        NETDRIVE_ENDPOINT: netdrive.endpoint,
        NETDRIVE_PORT: String(netdrive.port),
        NETDRIVE_USE_SSL: "false",
        NETDRIVE_ACCESS_KEY: MINIO_COMMITTER_ACCESS_KEY,
        NETDRIVE_SECRET_KEY: MINIO_COMMITTER_SECRET_KEY,
        NETDRIVE_BUCKET: netdrive.bucket,
        NETDRIVE_PUBLIC_URL: `http://localhost:${netdrive.port}`,
        DATA_MARKET_COMMITTER_ACCESS_KEY: MINIO_COMMITTER_ACCESS_KEY,
        DATA_MARKET_COMMITTER_SECRET_KEY: MINIO_COMMITTER_SECRET_KEY,
        DATA_MARKET_STAGING_BUCKET,
        DATA_MARKET_IMMUTABLE_BUCKET,
        MINIO_ROOT_USER: "minioadmin",
      });
    }
    Object.assign(serverEnv, options.serverEnv);

    const spawnServer = (): Subprocess =>
      Bun.spawn(["bun", "run", join(REPO_ROOT, "packages/server/src/index.ts")], {
        cwd: REPO_ROOT,
        env: serverEnv,
        stdout: "inherit",
        stderr: "inherit",
      });
    let serverProc: Subprocess = spawnServer();
    cleanup.push(async () => {
      await terminateProcess(serverProc);
    });

    await waitForHttp(`http://127.0.0.1:${serverPort}/api/health`, 30_000);
    await waitForTcp("127.0.0.1", serverGrpcPort, 10_000);

    // -----------------------------------------------------------------------
    // 6. Slurm cluster
    // -----------------------------------------------------------------------
    const slurm = await startSlurmCluster();
    cleanup.push(() => slurm.stop());
    await installE2eSpackShim(slurm.containerId);

    // -----------------------------------------------------------------------
    // 7. Admin token (login upserts the user row for FK resolution)
    // -----------------------------------------------------------------------
    const loginRes = await fetch(`http://127.0.0.1:${serverPort}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@e2e.test", role: "platform_admin" }),
    });
    if (!loginRes.ok) {
      throw new Error(`admin login failed: ${loginRes.status} ${await loginRes.text()}`);
    }
    const { token } = (await loginRes.json()) as { token: string };

    // -----------------------------------------------------------------------
    // 8. Agent process
    // -----------------------------------------------------------------------
    const agentDbDir = mkdtempSync(join(tmpdir(), "kq-agent-e2e-"));
    cleanup.push(async () => {
      rmSync(agentDbDir, { recursive: true, force: true });
    });

    const agentId = "agent-e2e-1";
    const agentEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SERVER_GRPC_URL: `http://127.0.0.1:${serverGrpcPort}`,
      AGENT_ID: agentId,
      AGENT_SITE_NAME: "e2e-site",
      AGENT_DB_PATH: join(agentDbDir, "agent.db"),
      AGENT_LICENSED_MATERIAL_ROOT: join(agentDbDir, "licensed-materials"),
      AGENT_DATASET_ROOT: join(agentDbDir, "datasets"),
      AGENT_JOB_WORK_ROOT: join(agentDbDir, "jobs"),
      AGENT_SPACK_ENABLED: "true",
      HEARTBEAT_INTERVAL_SEC: "1",
      AGENT_SPAWNER_BACKEND: "container",
      AGENT_SLURM_CONTAINER_ID: slurm.containerId,
      LOG_LEVEL: "warn",
    };
    if (netdrive) {
      agentEnv.AGENT_FILE_TRANSFER_CONNECT_TO = "";
      agentEnv.AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO = `localhost:${netdrive.port}:host.docker.internal:${netdrive.port}`;
    }
    Object.assign(agentEnv, options.agentEnv);

    const spawnAgent = (): Subprocess =>
      Bun.spawn(["bun", "run", join(REPO_ROOT, "packages/agent/src/index.ts")], {
        cwd: REPO_ROOT,
        env: agentEnv,
        stdout: "inherit",
        stderr: "inherit",
      });
    let agentProc: Subprocess = spawnAgent();
    cleanup.push(async () => {
      await terminateProcess(agentProc);
    });

    await waitForAgentOnline(`http://127.0.0.1:${serverPort}`, token, agentId, 30_000);
    await waitForAgentSoftware(
      `http://127.0.0.1:${serverPort}`,
      token,
      agentId,
      E2E_SPACK_PACKAGE,
      30_000,
    );

    // -----------------------------------------------------------------------
    // Build and return stack handle
    // -----------------------------------------------------------------------
    return {
      serverBaseUrl: `http://127.0.0.1:${serverPort}`,
      serverGrpcUrl: `http://127.0.0.1:${serverGrpcPort}`,
      adminToken: token,
      slurm,
      agentId,
      databaseUrl: pgUrl,
      ...(netdrive ? { netdrive } : {}),
      async restartServer() {
        await terminateProcess(serverProc);
        serverProc = spawnServer();
        await waitForHttp(`http://127.0.0.1:${serverPort}/api/health`, 30_000);
        await waitForTcp("127.0.0.1", serverGrpcPort, 10_000);
        await Bun.sleep(6_000);
        await waitForAgentOnline(`http://127.0.0.1:${serverPort}`, token, agentId, 30_000);
      },
      async restartAgent() {
        await terminateProcess(agentProc);
        agentProc = spawnAgent();
        await waitForAgentOnline(`http://127.0.0.1:${serverPort}`, token, agentId, 30_000);
      },
      async stop() {
        // Kill processes first so they release sockets / DB connections.
        // Guard each kill in case the process already exited (some Bun versions throw).
        await Promise.allSettled([terminateProcess(agentProc), terminateProcess(serverProc)]);
        // Stop containers and clean temp (no Redis container — see above)
        await Promise.allSettled([slurm.stop(), pg.stop(), stopNetdrive?.()]);
        rmSync(agentDbDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    // Partial failure: run all cleanup handlers in reverse order.
    // Use [...cleanup].reverse() to avoid mutating the original array.
    for (const fn of [...cleanup].reverse()) {
      await fn().catch(() => {});
    }
    throw err;
  }
}

async function terminateProcess(proc: Subprocess, graceMs = 5_000): Promise<void> {
  try {
    proc.kill();
  } catch {}
  const exited = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(graceMs).then(() => false),
  ]);
  if (exited) return;
  try {
    proc.kill("SIGKILL");
  } catch {}
  await proc.exited;
}

async function ensureMinioStorage(containerId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    const result = await dockerExec(containerId, [
      "sh",
      "-c",
      [
        "mc alias set local http://127.0.0.1:9000 minioadmin minioadmin >/dev/null",
        `mc mb --ignore-existing local/${NETDRIVE_BUCKET} >/dev/null`,
        `mc mb --ignore-existing local/${DATA_MARKET_STAGING_BUCKET} >/dev/null`,
        `mc mb --ignore-existing --with-lock local/${DATA_MARKET_IMMUTABLE_BUCKET} >/dev/null`,
        `mc version enable local/${DATA_MARKET_IMMUTABLE_BUCKET} >/dev/null`,
        `mc retention set --default COMPLIANCE 365d local/${DATA_MARKET_IMMUTABLE_BUCKET} >/dev/null`,
        `mc admin user add local ${MINIO_COMMITTER_ACCESS_KEY} ${MINIO_COMMITTER_SECRET_KEY} >/dev/null 2>&1 || mc admin user info local ${MINIO_COMMITTER_ACCESS_KEY} >/dev/null`,
        `mc admin policy attach local readwrite --user ${MINIO_COMMITTER_ACCESS_KEY} >/dev/null`,
      ].join(" && "),
    ]);
    last = result.stderr || result.stdout;
    if (result.exitCode === 0) {
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`MinIO storage was not ready: ${last.trim()}`);
}

async function installE2eSpackShim(containerId: string): Promise<void> {
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    '  --version) echo "1.0.0" ;;',
    `  find) echo '[{"name":"${E2E_SPACK_PACKAGE}","version":"1","hash":"e2e"}]' ;;`,
    "  load) ;;",
    "esac",
  ].join("\n");
  const result = await dockerExec(
    containerId,
    [
      "sh",
      "-c",
      `printf '%s' ${shellQuote(script)} > /usr/local/bin/spack && chmod 755 /usr/local/bin/spack`,
    ],
    "root",
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to install the E2E Spack shim: ${result.stderr.trim()}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function dockerExec(
  containerId: string,
  cmd: string[],
  user?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["docker", "exec", ...(user ? ["-u", user] : []), containerId, ...cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
