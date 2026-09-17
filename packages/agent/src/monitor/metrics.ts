import { readFileSync } from "node:fs";
import { createLogger } from "@kuintessence/shared";

const logger = createLogger("agent-metrics");

export interface ResourceMetrics {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
}

interface CpuStat {
  idle: number;
  total: number;
}

let lastCpuStat: CpuStat | null = null;

/** Reads /proc/stat for total/idle CPU time. */
function readCpuStat(): CpuStat | null {
  try {
    const data = readFileSync("/proc/stat", "utf-8");
    const line = data.split("\n")[0];
    if (!line) return null;
    const parts = line.split(/\s+/).slice(1, 8).map(Number);
    if (parts.length < 4 || parts.some(Number.isNaN)) return null;
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

/** /proc/meminfo: returns MemTotal and MemAvailable in kB. */
function readMemInfo(): { memTotalKb: number; memAvailableKb: number } | null {
  try {
    const data = readFileSync("/proc/meminfo", "utf-8");
    const totalMatch = data.match(/^MemTotal:\s+(\d+)/m);
    const availMatch = data.match(/^MemAvailable:\s+(\d+)/m);
    if (!totalMatch || !availMatch) return null;
    return {
      memTotalKb: Number.parseInt(totalMatch[1] ?? "0", 10),
      memAvailableKb: Number.parseInt(availMatch[1] ?? "0", 10),
    };
  } catch {
    return null;
  }
}

/**
 * Snapshot current CPU usage percent and memory.
 *
 * On non-Linux platforms (or if /proc is unreadable), returns conservative defaults.
 * The first call returns 0% CPU because we need two samples for delta.
 */
export function readMetrics(): ResourceMetrics {
  const cpuNow = readCpuStat();
  let cpuUsagePercent = 0;
  if (cpuNow) {
    if (lastCpuStat) {
      const dTotal = cpuNow.total - lastCpuStat.total;
      const dIdle = cpuNow.idle - lastCpuStat.idle;
      if (dTotal > 0) {
        cpuUsagePercent = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
      }
    }
    lastCpuStat = cpuNow;
  }

  const mem = readMemInfo();
  const memTotalMb = mem ? Math.floor(mem.memTotalKb / 1024) : 0;
  const memUsedMb = mem ? Math.floor((mem.memTotalKb - mem.memAvailableKb) / 1024) : 0;

  logger.debug({ cpuUsagePercent, memUsedMb, memTotalMb }, "Resource metrics snapshot");

  return {
    cpuUsagePercent,
    memoryUsedMb: memUsedMb,
    memoryTotalMb: memTotalMb,
  };
}

/** Test seam: reset internal state. */
export function _resetMetricsForTest(): void {
  lastCpuStat = null;
}
