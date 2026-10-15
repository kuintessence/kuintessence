import { readFile } from "node:fs/promises";
import type { SpackAuditRuntimeDeps } from "./audit-runtime";

const invalid = () => new Error("Managed Spack memory admission metadata unavailable or invalid");

// A host snapshot, not a reservation or proof of available ancestor cgroup budgets.
export async function admitSpackManagedMemory(
  signal: AbortSignal,
  deps: SpackAuditRuntimeDeps = {},
  managedMemoryMib = 4096,
): Promise<void> {
  if (!Number.isInteger(managedMemoryMib) || managedMemoryMib < 1024 || managedMemoryMib > 4096) {
    throw new Error("Invalid managed Spack memory budget");
  }
  const requiredKib = (managedMemoryMib + 512) * 1024;
  signal.throwIfAborted();
  if ((deps.platform ?? process.platform) !== "linux") throw invalid();
  let text: string;
  try {
    text = deps.readFile
      ? await deps.readFile("/proc/meminfo", signal)
      : await readFile("/proc/meminfo", { encoding: "utf8", signal });
  } catch {
    signal.throwIfAborted();
    throw invalid();
  }
  signal.throwIfAborted();
  const lines = text.split("\n");
  const memory = (name: string) => {
    const entries = lines.filter((line) => line.startsWith(`${name}:`));
    const value =
      entries.length === 1
        ? new RegExp(`^${name}: +([0-9]+) kB$`).exec(entries[0] ?? "")?.[1]
        : undefined;
    const kib = Number(value);
    if (value === undefined || !Number.isSafeInteger(kib) || kib < 0) throw invalid();
    return kib;
  };
  const total = memory("MemTotal");
  const available = memory("MemAvailable");
  if (available > total) throw invalid();
  if (total < requiredKib || available < requiredKib) {
    throw new Error(
      "Managed Spack memory admission requires configured budget + 512 MiB available without swap",
    );
  }
}
