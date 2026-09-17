import { realSpawner, type Spawner } from "../adapters/base";

/**
 * Subset of `SchedulerAdapter['type']` strings the platform recognizes.
 * Anything outside this set yields a 0-depth result without shelling out.
 */
export type SchedulerKind = "slurm" | "pbs-pro" | "torque" | "kubernetes";

export interface ReadQueueDepthOptions {
  schedulerType: SchedulerKind | string;
  spawner?: Spawner;
  timeoutMs?: number;
}

export interface CachedQueueDepthReaderOptions extends ReadQueueDepthOptions {
  refreshIntervalMs: number;
  now?: () => number;
}

/**
 * Best-effort scheduler queue depth. Each adapter has a distinct CLI shape:
 *
 *  - slurm:      `squeue -h` — one job per line, `-h` strips the header.
 *  - pbs-pro:    `qstat` — first two lines are headers; subtract them.
 *  - torque:     `qstat` — same shape as PBS.
 *  - kubernetes: `kubectl get jobs -o name` — one job per line, no header.
 *
 * On missing tool / error / parse failure we return 0 — the caller treats
 * "unknown queue depth" identically to "empty queue" for monitoring
 * purposes. This keeps the heartbeat loop robust on a half-configured
 * cluster.
 */
export async function readSchedulerQueueDepth(options: ReadQueueDepthOptions): Promise<number> {
  const { schedulerType } = options;
  const spawner = options.spawner ?? realSpawner;

  let cmd: string[];
  let headerLines: number;
  switch (schedulerType) {
    case "slurm":
      cmd = ["squeue", "-h"];
      headerLines = 0;
      break;
    case "pbs-pro":
    case "torque":
      cmd = ["qstat"];
      headerLines = 2;
      break;
    case "kubernetes":
      cmd = ["kubectl", "get", "jobs", "-o", "name"];
      headerLines = 0;
      break;
    default:
      return 0;
  }

  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await spawner.run(cmd, { timeoutMs: options.timeoutMs });
  } catch {
    return 0;
  }
  if (result.exitCode !== 0) return 0;

  const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - headerLines);
}

export function createCachedSchedulerQueueDepthReader(
  options: CachedQueueDepthReaderOptions,
): () => Promise<number> {
  const now = options.now ?? Date.now;
  let cachedAt = Number.NEGATIVE_INFINITY;
  let cachedValue = 0;
  let inFlight: Promise<number> | undefined;

  return async () => {
    if (now() - cachedAt < options.refreshIntervalMs) return cachedValue;
    if (inFlight) return inFlight;

    inFlight = readSchedulerQueueDepth(options).then((value) => {
      cachedValue = value;
      cachedAt = now();
      return value;
    });
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}
