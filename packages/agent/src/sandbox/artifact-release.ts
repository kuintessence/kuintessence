import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface SandboxArtifactReleaseItem {
  replicaId: string;
  storageRef: string;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export async function releaseSandboxArtifacts(
  configuredRoot: string,
  items: readonly SandboxArtifactReleaseItem[],
): Promise<{ releasedReplicaIds: string[]; failures: Record<string, string> }> {
  const configured = resolve(configuredRoot);
  const root = await realpath(configuredRoot);
  const releasedReplicaIds: string[] = [];
  const failures: Record<string, string> = {};
  for (const item of items) {
    try {
      const target = resolve(item.storageRef);
      if (!inside(configured, target) || target === configured) {
        throw new Error("artifact path is outside the managed Sandbox root");
      }
      try {
        await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          releasedReplicaIds.push(item.replicaId);
          continue;
        }
        throw error;
      }
      const parent = await realpath(dirname(target));
      if (!inside(root, parent)) throw new Error("artifact parent resolves outside managed root");
      await rm(target, { recursive: true, force: true });
      releasedReplicaIds.push(item.replicaId);
    } catch (error) {
      failures[item.replicaId] = error instanceof Error ? error.message : "artifact release failed";
    }
  }
  return { releasedReplicaIds, failures };
}
