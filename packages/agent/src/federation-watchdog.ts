import { Database } from "bun:sqlite";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import * as schema from "@kuintessence/db";
import { createLogger, loadConfig, logLevelSchema, SchedulerTypeEnum } from "@kuintessence/shared";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { realSpawner, type Spawner } from "./adapters/base";
import { detectScheduler } from "./adapters/detect";
import { ContainerSpawner } from "./adapters/spawner-container";
import { FederationRuntimeWatchdog } from "./queue/federation-runtime-watchdog";

const WatchdogConfig = z.object({
  AGENT_DB_PATH: z.string().min(1),
  AGENT_SCHEDULER_TYPE: SchedulerTypeEnum.optional(),
  AGENT_SCHEDULER_VERSION: z.string().min(1).optional(),
  AGENT_SPAWNER_BACKEND: z.enum(["host", "container"]).default("host"),
  AGENT_SLURM_CONTAINER_ID: z.string().min(1).optional(),
  LOG_LEVEL: logLevelSchema,
});

/** Does not enroll, connect to Server, submit jobs or run database migrations. */
export async function runFederationWatchdog(): Promise<void> {
  const config = loadConfig(WatchdogConfig, process.env, "Federation watchdog");
  const logger = createLogger("federation-watchdog", config.LOG_LEVEL);
  const path = resolve(config.AGENT_DB_PATH);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Federation watchdog requires the Agent's private SQLite file");
  if (config.AGENT_SPAWNER_BACKEND === "container" && !config.AGENT_SLURM_CONTAINER_ID)
    throw new Error("Container watchdog requires AGENT_SLURM_CONTAINER_ID");
  const transport =
    config.AGENT_SPAWNER_BACKEND === "container" && config.AGENT_SLURM_CONTAINER_ID
      ? new ContainerSpawner(config.AGENT_SLURM_CONTAINER_ID)
      : realSpawner;
  const spawner: Spawner = {
    run: (args, options) =>
      transport.run(args, { ...options, timeoutMs: Math.min(options?.timeoutMs ?? 5000, 5000) }),
  };
  const adapter = await detectScheduler({
    spawner,
    forceType: config.AGENT_SCHEDULER_TYPE,
    forceVersion: config.AGENT_SCHEDULER_VERSION,
  });
  if (!["slurm", "pbs-pro", "torque", "kubernetes"].includes(adapter.type))
    throw new Error(
      "Independent federation watchdog requires Slurm, PBS Pro, Torque or Kubernetes",
    );
  const sqlite = new Database(path, { readwrite: true });
  sqlite.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
  const watchdog = new FederationRuntimeWatchdog(drizzle(sqlite, { schema }), adapter, logger);
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    // The supervisor starts both processes together; only the Agent owns schema initialization.
    const initialized = sqlite.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inbound_dispatch_pending'",
    );
    if (!initialized.get()) {
      logger.info("Waiting for Agent database initialization");
      while (running && !initialized.get()) await Bun.sleep(250);
    }
    if (running) logger.info("Federation watchdog database ready");
    while (running) {
      await watchdog.tick();
      if (running) await Bun.sleep(250);
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    sqlite.close();
  }
}
