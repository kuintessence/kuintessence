import { describe, expect, test } from "bun:test";
import { startSlurmCluster } from "./slurm-cluster";

describe("slurm-cluster fixture", () => {
  // 180s = 60s container startup + 45s Slurm readiness wait + image pull slack on first run.
  test("starts cluster, sinfo shows idle node, exposes containerId, stops cleanly", async () => {
    const cluster = await startSlurmCluster();
    try {
      expect(cluster.containerId).toMatch(/^[0-9a-f]{12,}$/);
      const r = await cluster.exec(["sinfo", "-h", "-o", "%T"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("idle");
    } finally {
      await cluster.stop();
    }
  }, 180_000);
});
