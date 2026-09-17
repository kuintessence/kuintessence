import { describe, expect, test } from "bun:test";
import {
  backfillDataMarket0043StagePaths,
  type DataMarket0043UpgradePort,
  normalizeInputDescriptor,
  planStagePathBackfill,
  preflightDataMarket0043Upgrade,
} from "./data-market-0043-upgrade";

class MemoryUpgradePort implements DataMarket0043UpgradePort {
  staleReplicaCount = 0;
  stagePaths: Array<{ id: string; stagePath: string }> = [];

  constructor(
    private readonly bindings: Array<{ id: string; jobId: string; inputDescriptor: string }>,
  ) {}

  async markAvailableReplicasStale() {
    this.staleReplicaCount += 1;
    return 3;
  }

  async listBindingsForStagePathPreflight() {
    return this.bindings;
  }

  async listBindingsMissingStagePath() {
    return this.bindings;
  }

  async setStagePaths(bindings: readonly { id: string; stagePath: string }[]) {
    this.stagePaths = [...bindings];
  }
}

describe("Data Market 0043 upgrade helper", () => {
  test("normalizes input descriptors into deterministic stage path components", () => {
    expect(normalizeInputDescriptor("  POTCAR / Si ")).toBe("potcar-si");
    expect(normalizeInputDescriptor("... ")).toBeNull();
  });

  test("blocks normalized path collisions within a job before touching replicas", async () => {
    const port = new MemoryUpgradePort([
      { id: "one", jobId: "job", inputDescriptor: "POTCAR Si" },
      { id: "two", jobId: "job", inputDescriptor: "potcar-si" },
    ]);
    const result = await preflightDataMarket0043Upgrade(port);
    expect(result).toMatchObject({ ready: false, staleReplicaCount: 0 });
    expect(result.blockers).toHaveLength(2);
    expect(port.staleReplicaCount).toBe(0);
  });

  test("stales unverified replicas before migration and backfills unique paths afterward", async () => {
    const port = new MemoryUpgradePort([
      { id: "one", jobId: "job", inputDescriptor: "reference" },
      { id: "two", jobId: "job", inputDescriptor: "potcar" },
    ]);
    await expect(preflightDataMarket0043Upgrade(port)).resolves.toMatchObject({
      ready: true,
      staleReplicaCount: 3,
    });
    await backfillDataMarket0043StagePaths(port);
    expect(port.stagePaths).toEqual([
      { id: "one", stagePath: "inputs/reference" },
      { id: "two", stagePath: "inputs/potcar" },
    ]);
  });

  test("reports invalid descriptors without a default fallback", () => {
    expect(
      planStagePathBackfill([{ id: "one", jobId: "job", inputDescriptor: "///" }]).blockers,
    ).toEqual([
      {
        jobId: "job",
        inputDescriptor: "///",
        reason: "input_descriptor cannot produce a canonical stage path",
      },
    ]);
  });
});
