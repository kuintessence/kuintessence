import { describe, expect, test } from "bun:test";
import type { DataPrerequisiteRepository } from "./data-prerequisite";
import { DataPrerequisitePlanner } from "./data-prerequisite";
import {
  isReplicaEligible,
  PgDataPrerequisiteRepository,
} from "./data-prerequisite-repository-drizzle";

function repository(
  overrides: Partial<DataPrerequisiteRepository> = {},
): DataPrerequisiteRepository {
  return {
    resolveVersion: async ({ versionId, manifestDigest }) => ({
      id: versionId,
      manifestDigest,
      available: true,
    }),
    listLocations: async (versionId) =>
      versionId.startsWith("object")
        ? []
        : [
            {
              locationId: "location-a",
              agentId: "agent-a",
              siteId: "site-a",
              clusterId: "cluster-a",
              kind: "cp-local",
            },
          ],
    verifyAccess: async () => true,
    ...overrides,
  };
}

describe("DataPrerequisitePlanner", () => {
  test("object data keeps every placement candidate globally eligible", async () => {
    const planner = new DataPrerequisitePlanner(repository());
    const plan = await planner.build({
      actorUserId: "user",
      orgId: "org",
      requirements: [
        { assetId: "object-data", versionId: "object-v1", manifestDigest: "digest-1" },
      ],
      candidateAgentIds: ["agent-a", "agent-b"],
    });
    expect(plan.eligibleAgentIds).toEqual(["agent-a", "agent-b"]);
    expect(plan.localCandidateAgentIds).toEqual([]);
  });

  test("CP-local replicas intersect candidate locations", async () => {
    const planner = new DataPrerequisitePlanner(
      repository({
        listLocations: async (versionId) => [
          {
            locationId: `location-${versionId}`,
            agentId: versionId.startsWith("left") ? "agent-a" : "agent-b",
            siteId: "site",
            clusterId: "cluster",
            kind: "cp-local",
          },
        ],
      }),
    );
    await expect(
      planner.build({
        actorUserId: "user",
        orgId: "org",
        requirements: [
          { assetId: "left", versionId: "left-v1", manifestDigest: "digest-1" },
          { assetId: "right", versionId: "right-v1", manifestDigest: "digest-2" },
        ],
        candidateAgentIds: ["agent-a", "agent-b"],
      }),
    ).rejects.toThrow("DATA_LOCATION_CONFLICT");
  });

  test("candidate locations preserve only the logical delivery coordinates", async () => {
    const planner = new DataPrerequisitePlanner(
      repository({
        listLocations: async () => [
          {
            locationId: "location-safe",
            agentId: "agent-a",
            siteId: "site-a",
            clusterId: "cluster-a",
            kind: "cp-local",
            managedRootId: "managed-root-a",
            relativePath: "pseudopotentials/POTCAR",
          },
        ],
      }),
    );
    const plan = await planner.build({
      actorUserId: "user",
      orgId: "org",
      requirements: [{ assetId: "local-data", versionId: "local-v1", manifestDigest: "digest-1" }],
      candidateAgentIds: ["agent-a"],
    });
    expect(plan.requirements[0]?.locations).toEqual([
      {
        locationId: "location-safe",
        agentId: "agent-a",
        siteId: "site-a",
        clusterId: "cluster-a",
        kind: "cp-local",
        managedRootId: "managed-root-a",
        relativePath: "pseudopotentials/POTCAR",
      },
    ]);
  });

  test("dispatch repeats prerequisite validation for its selected Agent", async () => {
    const planner = new DataPrerequisitePlanner(repository());
    await expect(
      planner.assertDispatchable({
        actorUserId: "user",
        orgId: "org",
        requirements: [
          { assetId: "local-data", versionId: "local-v1", manifestDigest: "digest-1" },
        ],
        agentId: "agent-b",
      }),
    ).rejects.toThrow("DATA_LOCATION_CONFLICT");
  });

  test("access denial fails before placement", async () => {
    const planner = new DataPrerequisitePlanner(repository({ verifyAccess: async () => false }));
    await expect(
      planner.build({
        actorUserId: "user",
        orgId: "org",
        requirements: [
          { assetId: "local-data", versionId: "local-v1", manifestDigest: "digest-1" },
        ],
        candidateAgentIds: ["agent-a"],
      }),
    ).rejects.toThrow("Data access is not granted");
  });

  test("grant lifecycle is rechecked for the exact asset version before execution", async () => {
    let granted = true;
    const checks: Array<{ assetId: string; versionId: string }> = [];
    const planner = new DataPrerequisitePlanner(
      repository({
        verifyAccess: async (input) => {
          checks.push({ assetId: input.assetId, versionId: input.versionId });
          return granted;
        },
      }),
    );
    const request = {
      actorUserId: "user",
      orgId: "org",
      requirements: [
        { assetId: "object-data", versionId: "object-v1", manifestDigest: "digest-1" },
      ],
      candidateAgentIds: ["agent-a"],
    };

    await expect(planner.build(request)).resolves.toBeDefined();
    granted = false;
    await expect(planner.build(request)).rejects.toThrow("Data access is not granted");
    expect(checks).toEqual([
      { assetId: "object-data", versionId: "object-v1" },
      { assetId: "object-data", versionId: "object-v1" },
    ]);
  });
});

describe("replica eligibility", () => {
  const manifestDigest = "sha256:immutable";
  const now = new Date("2026-07-27T12:00:00.000Z");

  test("accepts only a verified available replica with the immutable manifest", () => {
    expect(
      isReplicaEligible(
        {
          status: "available",
          manifestDigest,
          verifiedAt: new Date("2026-07-27T11:59:59.999Z"),
        },
        manifestDigest,
        now,
        60_000,
      ),
    ).toBe(true);
  });

  test("rejects unavailable, stale, unverified, and manifest-mismatched replica records", () => {
    const replicas = [
      { status: "pending", manifestDigest, verifiedAt: now },
      { status: "syncing", manifestDigest, verifiedAt: now },
      { status: "failed", manifestDigest, verifiedAt: now },
      { status: "stale", manifestDigest, verifiedAt: now },
      { status: "deleted", manifestDigest, verifiedAt: now },
      { status: "mismatch", manifestDigest, verifiedAt: now },
      { status: "expired", manifestDigest, verifiedAt: now },
      { status: "available", manifestDigest: "sha256:different", verifiedAt: now },
      { status: "available", manifestDigest, verifiedAt: null },
      {
        status: "available",
        manifestDigest,
        verifiedAt: new Date("2026-07-27T11:58:59.999Z"),
      },
    ];
    for (const replica of replicas) {
      expect(isReplicaEligible(replica, manifestDigest, now, 60_000)).toBe(false);
    }
  });
});

describe("private licensed-material entitlement", () => {
  const asset = {
    id: "asset-potcar",
    kind: "licensed-material",
    accessMode: "entitlement",
    ownerUserId: "owner",
    ownerOrgId: null,
    providerOrgId: null,
    visibility: "private",
    lifecycle: "draft",
  };

  function pgRepository(hasAccess: boolean) {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [asset] }),
        }),
      }),
    };
    return new PgDataPrerequisiteRepository(db as never, {
      hasActiveAccess: async () => hasAccess,
    });
  }

  test("owner cannot use a private POTCAR without an active entitlement", async () => {
    await expect(
      pgRepository(false).verifyAccess({
        actorUserId: "owner",
        orgId: null,
        assetId: "asset-potcar",
        versionId: "version-potcar",
      }),
    ).resolves.toBe(false);
  });

  test("an active entitlement grants owner use and a revoked entitlement removes it", async () => {
    const input = {
      actorUserId: "owner",
      orgId: null,
      assetId: "asset-potcar",
      versionId: "version-potcar",
    };
    await expect(pgRepository(true).verifyAccess(input)).resolves.toBe(true);
    await expect(pgRepository(false).verifyAccess(input)).resolves.toBe(false);
  });
});
