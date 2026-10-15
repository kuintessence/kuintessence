import { readFile } from "node:fs/promises";
import { SPACK_MANAGED_MEMORY_BYTES, type SpackAuditRuntimeDeps } from "./audit-runtime";

const REQUIRED_KIB = (SPACK_MANAGED_MEMORY_BYTES + 512 * 1024 ** 2) / 1024;
const invalid = () => new Error("Managed Spack memory admission metadata unavailable or invalid");

// A host snapshot, not a reservation or proof of available ancestor cgroup budgets.
export async function admitSpackManagedMemory(
  signal: AbortSignal,
  deps: SpackAuditRuntimeDeps = {},
): Promise<void> {
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
  if (total < REQUIRED_KIB || available < REQUIRED_KIB) {
    throw new Error(
      "Managed Spack memory admission requires 4 GiB + 512 MiB available without swap",
    );
  }
}
