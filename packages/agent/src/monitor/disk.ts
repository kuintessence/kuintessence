import { realSpawner, type Spawner } from "../adapters/base";

/**
 * Parse the second line of `df -P /` output and return the integer percent
 * from the "Capacity" column. Returns `null` when the output is malformed
 * (no header, no data row, or no `NN%` token).
 *
 * Both Linux GNU df and macOS BSD df emit the percent in column 5 with a
 * trailing `%`. The macOS variant ALSO emits iused/ifree columns later,
 * but the percent column position is identical, so a single regex pass
 * over the data row works on both.
 */
export function parseDfPercent(stdout: string): number | null {
  if (!stdout) return null;
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const dataLine = lines[1];
  if (!dataLine) return null;
  // Match the FIRST `NN%` token in the data line. df puts it before the
  // mount point; iused etc. on macOS come later but always after the
  // primary capacity %, so first-match wins.
  const match = dataLine.match(/(\d{1,3})%/);
  if (!match) return null;
  const pct = Number.parseInt(match[1] ?? "", 10);
  if (Number.isNaN(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

export interface ReadDiskOptions {
  /** Injected spawner; defaults to realSpawner. */
  spawner?: Spawner;
  /** Path to df. Defaults to `df` (must be on PATH). */
  binary?: string;
  /** Filesystem path. Defaults to `/`. */
  path?: string;
}

/**
 * Best-effort root filesystem usage percent. Returns `null` when df is
 * missing or fails. Works on Linux + macOS via the POSIX `df -P` output
 * shape — no /proc dependency.
 */
export async function readDiskUsedPercent(options: ReadDiskOptions = {}): Promise<number | null> {
  const spawner = options.spawner ?? realSpawner;
  const binary = options.binary ?? "df";
  const path = options.path ?? "/";
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await spawner.run([binary, "-P", path]);
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  return parseDfPercent(result.stdout);
}
