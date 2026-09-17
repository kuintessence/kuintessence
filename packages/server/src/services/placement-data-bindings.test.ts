import { describe, expect, test } from "bun:test";
import { assertSandboxDataDeliveryMode, dataRequirementsFromJob } from "./placement-orchestrator";

describe("placement data bindings", () => {
  test("resolves only immutable Data Market input references into prerequisites", () => {
    const requirements = dataRequirementsFromJob({
      name: "data-bound-job",
      command: "echo ok",
      resources: { cpus: 1, memoryMb: 256 },
      dataInputs: {
        local: {
          source: "netdrive",
          fileMetadataId: "00000000-0000-4000-8000-000000000101",
          fileMetadataName: "local.txt",
        },
        market: {
          source: "data-market",
          assetId: "00000000-0000-4000-8000-000000000201",
          versionId: "00000000-0000-4000-8000-000000000202",
          manifestDigest: "sha256:immutable-manifest",
          selectedEntries: ["input/mesh.dat"],
        },
      },
    });
    expect(requirements).toEqual([
      {
        assetId: "00000000-0000-4000-8000-000000000201",
        versionId: "00000000-0000-4000-8000-000000000202",
        manifestDigest: "sha256:immutable-manifest",
        requiredPaths: ["input/mesh.dat"],
      },
    ]);
  });

  test("rejects unsigned non-restricted Data Market delivery for Sandbox execution", () => {
    expect(() => assertSandboxDataDeliveryMode(false, 1)).toThrow(
      "requires restricted no-egress signed mounts",
    );
    expect(() => assertSandboxDataDeliveryMode(true, 1)).not.toThrow();
    expect(() => assertSandboxDataDeliveryMode(false, 0)).not.toThrow();
  });
});
