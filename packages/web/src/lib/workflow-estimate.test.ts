import { describe, expect, test } from "vitest";
import { estimateWorkflow } from "./workflow-estimate";

const ESTIMATE_WORKFLOW = `name: estimate
spec:
  nodeDrafts:
    - type: Script
      id: prepare
      name: Prepare
      source:
        type: AssetRevision
        assetId: 3f2504e0-4f89-41d3-9a0c-0305e82c3302
        revision: 1
        sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      runtimeProfileId: 3f2504e0-4f89-41d3-9a0c-0305e82c3303
      executionIdentity:
        type: MappedAuto
      requirements:
        cpuCores: 2
        maxWallTime: 1800
      inputs: {}
      outputs: {}
    - type: Script
      id: convert
      name: Convert
      source:
        type: AssetRevision
        assetId: 3f2504e0-4f89-41d3-9a0c-0305e82c3304
        revision: 1
        sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      runtimeProfileId: 3f2504e0-4f89-41d3-9a0c-0305e82c3303
      executionIdentity:
        type: MappedAuto
      requirements:
        cpuCores: 1
        maxWallTime: 3600
      inputs: {}
      outputs: {}
  nodeRelations:
    - fromId: prepare
      toId: convert
      slotRelations: []
`;

describe("workflow estimate", () => {
  test("estimates critical-path duration and queue-rate cost range", () => {
    const estimate = estimateWorkflow(ESTIMATE_WORKFLOW, [
      { queueId: "cheap", costRate: 0.5 },
      { queueId: "fast", costRate: 1 },
    ]);

    expect(estimate.durationSec).toBe(5_400);
    expect(estimate.fallbackNodeCount).toBe(0);
    expect(estimate.minCost).toBeCloseTo(1);
    expect(estimate.maxCost).toBeCloseTo(2);
    expect(estimate.unpricedNodeCount).toBe(0);
  });

  test("discloses the fallback duration and unavailable billing rate", () => {
    const estimate = estimateWorkflow(
      ESTIMATE_WORKFLOW.replace("        maxWallTime: 1800\n", ""),
      [],
    );

    expect(estimate.durationSec).toBe(7_200);
    expect(estimate.fallbackNodeCount).toBe(1);
    expect(estimate.minCost).toBeNull();
    expect(estimate.maxCost).toBeNull();
    expect(estimate.unpricedNodeCount).toBe(2);
  });
});
