import { realSpawner, type Spawner } from "../adapters/base";

/**
 * Single GPU snapshot reported to the Server. Mirrors the proto `GpuMetric`
 * message shape (kuintessence.v1.GpuMetric) one-to-one.
 */
export interface GpuMetric {
  index: number;
  model: string;
  memUsedMb: number;
  memTotalMb: number;
  utilPercent: number;
}

/**
 * Parse the CSV output of:
 *   nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu
 *              --format=csv,noheader,nounits
 *
 * Lines with non-numeric values in numeric fields are silently dropped so a
 * partially-corrupt nvidia-smi (driver hiccup, mig partition mid-update)
 * cannot kill the heartbeat loop.
 */
export function parseNvidiaSmiCsv(csv: string): GpuMetric[] {
  if (!csv) return [];
  const out: GpuMetric[] = [];
  for (const rawLine of csv.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 5) continue;
    const [idxStr, model, usedStr, totalStr, utilStr] = parts;
    const index = Number.parseInt(idxStr ?? "", 10);
    const memUsedMb = Number.parseInt(usedStr ?? "", 10);
    const memTotalMb = Number.parseInt(totalStr ?? "", 10);
    const utilPercent = Number.parseFloat(utilStr ?? "");
    if (
      Number.isNaN(index) ||
      Number.isNaN(memUsedMb) ||
      Number.isNaN(memTotalMb) ||
      Number.isNaN(utilPercent)
    ) {
      continue;
    }
    out.push({
      index,
      model: model ?? "",
      memUsedMb,
      memTotalMb,
      utilPercent,
    });
  }
  return out;
}

export interface ReadGpuMetricsOptions {
  /** Injected spawner; defaults to realSpawner. Tests pass a mock. */
  spawner?: Spawner;
  /** Path to nvidia-smi. Defaults to "nvidia-smi" (must be on PATH). */
  binary?: string;
}

/**
 * Best-effort GPU snapshot. Returns an empty array when:
 *  - nvidia-smi is missing (spawner throws ENOENT-style errors),
 *  - nvidia-smi exits non-zero (no devices, driver failure),
 *  - nvidia-smi prints nothing (rare, but possible mid-driver-reset).
 *
 * The agent heartbeat loop calls this on every tick, so the no-op path
 * MUST stay cheap and silent — no logger noise, no exceptions.
 */
export async function readGpuMetrics(options: ReadGpuMetricsOptions = {}): Promise<GpuMetric[]> {
  const spawner = options.spawner ?? realSpawner;
  const binary = options.binary ?? "nvidia-smi";
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await spawner.run([
      binary,
      "--query-gpu=index,name,memory.used,memory.total,utilization.gpu",
      "--format=csv,noheader,nounits",
    ]);
  } catch {
    return [];
  }
  if (result.exitCode !== 0 || !result.stdout) return [];
  return parseNvidiaSmiCsv(result.stdout);
}
