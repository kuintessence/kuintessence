import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  type DetectOptions,
  detectScheduler,
  type SchedulerAdapter,
  type Spawner,
} from "@kuintessence/agent/adapters";
import {
  expandTilde,
  type LocalJobStore,
  LocalPackageStore,
  LocalSoftwareCatalog,
  LocalWorkflowRunner,
  PoolJobLauncher,
  realSpawner,
  resolveDataDir,
  SqliteLocalJobStore,
  SqliteWorkflowRunStore,
} from "@kuintessence/agent/embedded";
import {
  readDiskUsedPercent,
  readGpuMetrics,
  readMetrics,
  readSchedulerQueueDepth,
} from "@kuintessence/agent/monitor";
import { createSqliteDb } from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { ApiClient } from "../../lib/api-client";
import { type CliConfig, loadCliConfig } from "../../lib/config";
import { ExternalAgentBackend } from "./external-agent";
import { LocalBackend, type LocalResourceSampler, type LocalWorkflowSupport } from "./local";
import { createLocalWorkflowSupport, listWorkflowDir } from "./local-workflows";
import { RemoteBackend } from "./remote";
import type { TuiBackend } from "./types";

export { expandTilde };

const logger = createLogger("kq-tui");

/** Open the all-in-one binary's local SQLite store. Path precedence:
 *  `dbPath` (an explicit `--db`, with `~` expansion) > `KUINTESSENCE_HOME` env
 *  override > `~/.kuintessence/local.db` (the default, via {@link resolveDataDir}).
 *  `noDb` disables persistence entirely.
 *  On first run after the `~/.kq` → `~/.kuintessence` rename, an existing legacy
 *  `~/.kq/local.db` is copied once to the new location (the legacy file is kept
 *  as a fallback). Returns undefined — degrading to pure live querying — when
 *  disabled or the DB can't be opened (no HOME, read-only FS), so the TUI never
 *  fails to start over it. `home` is injectable for testing. Exported for
 *  testing. */
export function makeLocalStore(
  opts: { noDb?: boolean; dbPath?: string; home?: string } = {},
): LocalJobStore | undefined {
  if (opts.noDb) return undefined;
  try {
    const home = opts.home ?? homedir();
    if (!home && !opts.dbPath) return undefined;
    const path = opts.dbPath
      ? expandTilde(opts.dbPath, home)
      : join(resolveDataDir({ form: "tui", home, env: process.env.KUINTESSENCE_HOME }), "local.db");
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
      // One-time copy from the pre-rename location; the legacy file is kept as a
      // fallback. Only the default path migrates — an explicit --db is verbatim.
      const legacy = join(home, ".kq", "local.db");
      if (!opts.dbPath && !existsSync(path) && existsSync(legacy)) {
        copyFileSync(legacy, path);
        logger.info(
          { from: legacy, to: path },
          "migrated legacy ~/.kq/local.db to ~/.kuintessence",
        );
      }
    }
    return new SqliteLocalJobStore(createSqliteDb(path));
  } catch (err) {
    logger.warn({ err }, "local SQLite store unavailable; jobs will not persist");
    return undefined;
  }
}

/** Real login-node sampler: CPU/mem from `/proc`, disk from `df`, GPUs from
 *  `nvidia-smi`, queue depth from the scheduler CLI. Each read is best-effort
 *  (absent tool → field omitted), so it never throws on a bare login node. The
 *  optional `spawner` is injected by the integration test to drive the real
 *  readers without a real `df`/`nvidia-smi`/scheduler on the box. */
export function makeLocalSampler(schedulerType: string, spawner?: Spawner): LocalResourceSampler {
  const withSpawner = spawner ? { spawner } : {};
  return {
    async sample() {
      const m = readMetrics();
      const [diskUsedPercent, gpus, queueDepth] = await Promise.all([
        readDiskUsedPercent(withSpawner),
        readGpuMetrics(withSpawner),
        readSchedulerQueueDepth({ schedulerType, ...withSpawner }),
      ]);
      return {
        cpuPercent: m.cpuUsagePercent,
        memoryUsedMb: m.memoryUsedMb,
        memoryTotalMb: m.memoryTotalMb,
        queueDepth,
        diskUsedPercent: diskUsedPercent ?? undefined,
        gpus,
      };
    },
  };
}

/** Best-effort probe of the login node's software stack. Returns the catalog
 *  plus whether spack/module was detected, so {@link LocalBackend} can flip the
 *  Software capability synchronously. Never throws — a bare login node (no
 *  spack/module) degrades to `{ catalog: undefined, detected: false }`, so the
 *  Software pane simply stays empty and the TUI still starts. */
async function probeSoftwareCatalog(): Promise<{
  catalog: LocalSoftwareCatalog | undefined;
  detected: boolean;
}> {
  try {
    const catalog = new LocalSoftwareCatalog({ spawner: realSpawner });
    const { spack, modules } = await catalog.detect();
    const detected = spack || modules;
    return detected ? { catalog, detected } : { catalog: undefined, detected: false };
  } catch (err) {
    logger.warn({ err }, "local software catalog probe failed; Software pane disabled");
    return { catalog: undefined, detected: false };
  }
}

/**
 * Best-effort wiring of local workflow execution.
 *
 * Gate: the Workflows capability turns on when `<dataDir>/workflows` exists and
 * holds at least one valid workflow spec. The catalog at `<dataDir>/packages.yaml`
 * is loaded when present; otherwise an empty catalog is used. A usecase node
 * without a matching package fails during resolution.
 *
 * Never throws: a missing workflows dir, no parseable spec, or an
 * unopenable DB degrades to `undefined`, so the TUI still starts with workflows
 * disabled. `home` is injectable for testing.
 */
export function probeWorkflowSupport(
  adapter: SchedulerAdapter,
  opts: { home?: string } = {},
): LocalWorkflowSupport | undefined {
  try {
    const home = opts.home ?? homedir();
    if (!home) return undefined;
    const dataDir = resolveDataDir({ form: "tui", home, env: process.env.KUINTESSENCE_HOME });
    const workflowsDir = join(dataDir, "workflows");
    if (listWorkflowDir(workflowsDir).length === 0) return undefined;
    const catalogPath = join(dataDir, "packages.yaml");
    const packageStore = existsSync(catalogPath)
      ? LocalPackageStore.fromYaml(readFileSync(catalogPath, "utf8"))
      : LocalPackageStore.fromEntries({});
    const runStore = new SqliteWorkflowRunStore(createSqliteDb(join(dataDir, "local.db")));
    const launcher = new PoolJobLauncher({ adapter, workingDir: dataDir });
    const runner = new LocalWorkflowRunner({
      launcher,
      runStore,
      packageStore,
    });
    return createLocalWorkflowSupport(workflowsDir, runner, runStore);
  } catch (err) {
    logger.warn({ err }, "local workflow support unavailable; Workflows pane disabled");
    return undefined;
  }
}

export interface SelectBackendOptions {
  /** Force the all-in-one local scheduler backend (scenario 2). */
  local?: boolean;
  /** Skip scheduler auto-detection and force a type (local mode only). */
  scheduler?: NonNullable<DetectOptions["forceType"]>;
  /** Disable the local SQLite job store (ephemeral; local mode only). */
  noDb?: boolean;
  /** Relocate the local SQLite store (default `~/.kuintessence/local.db`; local mode only). */
  dbPath?: string;
  /** Drive a remote `kq agent serve` over HTTP (scenario 3, no Server). Highest
   *  precedence — short-circuits local/remote/auto resolution. */
  agentUrl?: string;
  /** Bearer token for the external agent, when its `serve` requires auth. */
  agentToken?: string;
  config?: CliConfig;
}

export type TuiMode = "local" | "remote" | "auto";

/**
 * Decide which backend the TUI should use, from flags + environment + config.
 * Pure and synchronous so the decision is unit-testable. Precedence:
 *   1. `--local` / `KQ_TUI_LOCAL=1`            → local (explicit)
 *   2. `KQ_TUI_LOCAL=0`                          → remote (explicit opt-out)
 *   3. no auth token (not logged in)            → auto: try the local scheduler
 *      and fall back to remote — so an all-in-one binary downloaded to a login
 *      node "just works" with a bare `kq tui`.
 *   4. otherwise (logged in)                     → remote
 */
export function resolveTuiMode(
  opts: SelectBackendOptions,
  env: NodeJS.ProcessEnv,
  config: CliConfig,
): TuiMode {
  if (opts.local) return "local";
  const flag = env.KQ_TUI_LOCAL;
  if (flag === "1" || flag === "true") return "local";
  if (flag === "0" || flag === "false") return "remote";
  if (!config.token) return "auto";
  return "remote";
}

/** Wire the concrete backend for the resolved mode. */
export async function selectBackend(opts: SelectBackendOptions = {}): Promise<TuiBackend> {
  if (opts.agentUrl) {
    return await ExternalAgentBackend.create(opts.agentUrl, { token: opts.agentToken });
  }
  const config = opts.config ?? loadCliConfig();
  const mode = resolveTuiMode(opts, process.env, config);
  const detectOpts: DetectOptions = opts.scheduler ? { forceType: opts.scheduler } : {};

  if (mode === "local") {
    // Explicit local: a detection failure surfaces (the user asked for local).
    const adapter = await detectScheduler(detectOpts);
    const software = await probeSoftwareCatalog();
    return new LocalBackend(
      adapter,
      makeLocalSampler(adapter.type),
      hostname(),
      makeLocalStore({ noDb: opts.noDb, dbPath: opts.dbPath }),
      software.catalog,
      software.detected,
      probeWorkflowSupport(adapter),
    );
  }

  if (mode === "auto") {
    // Try the local scheduler; silently fall back to remote when none is found.
    try {
      const adapter = await detectScheduler(detectOpts);
      const software = await probeSoftwareCatalog();
      return new LocalBackend(
        adapter,
        makeLocalSampler(adapter.type),
        hostname(),
        makeLocalStore({ noDb: opts.noDb, dbPath: opts.dbPath }),
        software.catalog,
        software.detected,
        probeWorkflowSupport(adapter),
      );
    } catch {
      return new RemoteBackend(ApiClient.fromConfig(config), config);
    }
  }

  return new RemoteBackend(ApiClient.fromConfig(config), config);
}
