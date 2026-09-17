import { describe, expect, test } from "bun:test";
import type {
  DataAccessGrant,
  DataAccessRequest,
  DataAccessReviewInput,
  DataAsset,
  DataAssetFile,
  DataAssetImport,
  DataAssetReplica,
  DataAssetVersion,
  DataMarketRepository,
  DataUploadPort,
  DataUploadSession,
  PublicAssetReviewInput,
} from "./data-market";
import { DataMarketService, localPermission } from "./data-market";

const now = new Date("2026-07-24T00:00:00.000Z");

class MemoryRepository implements DataMarketRepository {
  assets: DataAsset[] = [
    {
      id: "public-asset",
      providerOrgId: "provider-org",
      ownerUserId: "owner",
      ownerOrgId: null,
      ownerKind: "provider",
      kind: "scientific-dataset",
      name: "Public data",
      description: null,
      visibility: "public",
      lifecycle: "published",
      accessMode: "open",
      sensitivity: "open",
      tags: ["genomics"],
      elements: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "private-asset",
      providerOrgId: null,
      ownerUserId: "owner",
      ownerOrgId: null,
      ownerKind: "user",
      kind: "scientific-dataset",
      name: "Private data",
      description: null,
      visibility: "private",
      lifecycle: "published",
      accessMode: "entitlement",
      sensitivity: "internal",
      tags: [],
      elements: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
  accessRequests = new Map<string, DataAccessRequest>([
    [
      "access-request-1",
      {
        id: "access-request-1",
        assetId: "public-asset",
        requesterUserId: "consumer",
        requesterOrgId: "consumer-org",
        status: "pending",
        reason: "Need the cohort",
        reviewedBy: null,
        reviewedAt: null,
        createdAt: now,
        capability: "use",
        subjectKind: "user",
        subjectId: "consumer",
        decisionReason: null,
        expiresAt: null,
      },
    ],
  ]);
  accessGrants = new Map<string, DataAccessGrant>();
  versions: DataAssetVersion[] = [
    {
      id: "version-1",
      assetId: "public-asset",
      version: "v1",
      status: "ready",
      manifestDigest: "a".repeat(64),
      manifest: {
        checksum: "a".repeat(64),
        sizeBytes: 10,
        mediaType: "application/octet-stream",
        source: "platform-object",
      },
      immutableAt: now,
      createdBy: "owner",
      createdAt: now,
    },
  ];
  saved = new Map<string, unknown>();

  async listCatalogCandidates(query: { query?: string; tag?: string }) {
    return this.assets.filter(
      (asset) =>
        (!query.query || asset.name.toLowerCase().includes(query.query.toLowerCase())) &&
        (!query.tag || asset.tags.includes(query.tag)),
    );
  }
  async listProviderAssets(providerOrgIds: string[]) {
    const assets = this.assets.filter(
      (asset) => asset.providerOrgId && providerOrgIds.includes(asset.providerOrgId),
    );
    return { assets, total: assets.length };
  }
  async listVersions(assetId: string) {
    const versions = this.versions.filter((version) => version.assetId === assetId);
    return { versions, total: versions.length };
  }
  async listReplicas() {
    return { replicas: [], total: 0 };
  }
  async listImports() {
    return { imports: [], total: 0 };
  }
  async getAsset(assetId: string) {
    return this.assets.find((asset) => asset.id === assetId) ?? null;
  }
  async hasActiveAccess(input: {
    assetId: string;
    actorUserId: string;
    orgIds: string[];
    capability: "view" | "use";
  }) {
    return [...this.accessGrants.values()].some(
      (grant) =>
        grant.assetId === input.assetId &&
        grant.status === "active" &&
        (grant.expiresAt === null || grant.expiresAt > now) &&
        ((grant.subjectKind === "user" && grant.subjectId === input.actorUserId) ||
          (grant.subjectKind === "org" && input.orgIds.includes(grant.subjectId))) &&
        grant.capabilities.some((capability) =>
          input.capability === "view"
            ? ["view", "use", "download", "derive", "manage"].includes(capability)
            : ["use", "download", "derive", "manage"].includes(capability),
        ),
    );
  }
  async getVersion(assetId: string, version: string) {
    return (
      this.versions.find((value) => value.assetId === assetId && value.version === version) ?? null
    );
  }
  async getVersionById(versionId: string) {
    return this.versions.find((value) => value.id === versionId) ?? null;
  }
  async listFiles(_versionId: string): Promise<DataAssetFile[]> {
    return [];
  }
  async createAsset(input: Parameters<DataMarketRepository["createAsset"]>[0]) {
    const asset: DataAsset = {
      id: `asset-${this.assets.length + 1}`,
      providerOrgId: input.providerOrgId ?? null,
      ownerUserId: input.ownerUserId,
      ownerOrgId: null,
      ownerKind: input.providerOrgId ? "provider" : "user",
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      visibility: input.visibility,
      lifecycle: input.lifecycle ?? "draft",
      accessMode: input.accessMode,
      sensitivity: input.sensitivity,
      tags: input.tags,
      elements: input.elements ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.assets.push(asset);
    return asset;
  }
  async createVersion(input: Parameters<DataMarketRepository["createVersion"]>[0]) {
    const version: DataAssetVersion = {
      id: `version-${this.versions.length + 1}`,
      assetId: input.assetId,
      version: input.version,
      status: "ready",
      manifestDigest: input.manifest.checksum,
      manifest: input.manifest,
      immutableAt: now,
      createdBy: input.createdBy,
      createdAt: now,
    };
    this.versions.push(version);
    return version;
  }
  async createCpLocalImport(input: Parameters<DataMarketRepository["createCpLocalImport"]>[0]) {
    const version: DataAssetVersion = {
      id: `version-${this.versions.length + 1}`,
      assetId: input.assetId,
      version: input.version,
      status: "draft",
      manifestDigest: null,
      manifest: {},
      immutableAt: null,
      createdBy: input.createdBy,
      createdAt: now,
    };
    this.versions.push(version);
    const dataImport: DataAssetImport = {
      id: `import-${version.id}`,
      assetId: input.assetId,
      version: input.version,
      sourceKind: "cp-local",
      status: "pending",
      agentId: input.agentId,
      managedRootId: input.managedRootId,
      relativePath: input.relativePath,
      errorMessage: null,
      createdAt: now,
      completedAt: null,
    };
    return { version, dataImport, created: true };
  }
  async createReplica(input: Parameters<DataMarketRepository["createReplica"]>[0]) {
    return {
      id: "replica-1",
      ...input,
      status: "pending",
      verifiedAt: null,
    } satisfies DataAssetReplica;
  }
  async createAccessRequest(input: Parameters<DataMarketRepository["createAccessRequest"]>[0]) {
    const request = {
      id: "request-1",
      ...input,
      status: "pending",
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now,
      capability: "use",
      subjectKind: "user",
      subjectId: input.requesterUserId,
      decisionReason: null,
      expiresAt: null,
    } satisfies DataAccessRequest;
    this.accessRequests.set(request.id, request);
    return request;
  }
  async listAccessRequests(input: Parameters<DataMarketRepository["listAccessRequests"]>[0]) {
    const requests = [...this.accessRequests.values()].filter((request) => {
      const asset = this.assets.find((value) => value.id === request.assetId);
      return (
        asset?.providerOrgId !== null &&
        asset?.providerOrgId !== undefined &&
        input.providerOrgIds.includes(asset.providerOrgId) &&
        (input.status === undefined || request.status === input.status)
      );
    });
    return {
      requests: requests.slice(input.offset, input.offset + input.limit),
      total: requests.length,
    };
  }
  async getAccessState(input: { requesterUserId: string; orgIds: string[]; assetIds: string[] }) {
    const requests = input.assetIds.flatMap((assetId) => {
      const latest = [...this.accessRequests.values()]
        .filter(
          (request) =>
            request.requesterUserId === input.requesterUserId && request.assetId === assetId,
        )
        .at(-1);
      return latest ? [latest] : [];
    });
    return {
      requests,
      activeUseAssetIds: input.assetIds.filter((assetId) =>
        [...this.accessGrants.values()].some(
          (grant) =>
            grant.assetId === assetId &&
            grant.status === "active" &&
            grant.subjectKind === "user" &&
            grant.subjectId === input.requesterUserId &&
            grant.capabilities.includes("use"),
        ),
      ),
    };
  }
  async getAccessRequest(requestId: string) {
    return this.accessRequests.get(requestId) ?? null;
  }
  async getAccessGrant(grantId: string) {
    return [...this.accessGrants.values()].find((grant) => grant.id === grantId) ?? null;
  }
  async reviewAccessRequest(input: {
    requestId: string;
    reviewedBy: string;
    review: DataAccessReviewInput;
  }) {
    const request = this.accessRequests.get(input.requestId);
    if (!request) throw new Error("not found");
    const targetStatus = input.review.decision === "approve" ? "approved" : "rejected";
    if (request.status !== "pending") {
      if (request.status !== targetStatus) throw new Error("already reviewed");
      return {
        request,
        grant: request.status === "approved" ? this.grantForRequest(request) : null,
        capabilityChange: null,
        idempotent: true,
      };
    }
    const reviewed: DataAccessRequest = {
      ...request,
      status: targetStatus,
      reviewedBy: input.reviewedBy,
      reviewedAt: now,
      decisionReason: input.review.reason ?? null,
      expiresAt: input.review.decision === "approve" ? (input.review.expiresAt ?? null) : null,
    };
    this.accessRequests.set(request.id, reviewed);
    if (input.review.decision === "reject") {
      return { request: reviewed, grant: null, capabilityChange: null, idempotent: false };
    }
    const previous = this.grantForRequest(request);
    const grant: DataAccessGrant = {
      id: previous?.id ?? `grant-${request.id}`,
      assetId: request.assetId,
      versionId: null,
      subjectKind: request.subjectKind,
      subjectId: request.subjectId,
      capabilities: [request.capability],
      status: "active",
      expiresAt: input.review.expiresAt ?? null,
    };
    for (const [key, value] of this.accessGrants) {
      if (
        value.assetId === request.assetId &&
        value.versionId === null &&
        value.subjectKind === request.subjectKind &&
        value.subjectId === request.subjectId
      ) {
        this.accessGrants.delete(key);
      }
    }
    this.accessGrants.set(request.id, grant);
    return {
      request: reviewed,
      grant,
      capabilityChange: {
        previousCapabilities: previous?.capabilities ?? [],
        nextCapabilities: grant.capabilities,
        outboxEnqueued: false,
      },
      idempotent: false,
    };
  }
  async revokeAccessGrant(input: { grantId: string; revokedBy: string; reason: string }) {
    const entry = [...this.accessGrants.entries()].find(([, grant]) => grant.id === input.grantId);
    if (!entry) throw new Error("not found");
    const [key, grant] = entry;
    if (grant.status === "revoked") {
      return {
        grant,
        capabilityChange: {
          previousCapabilities: grant.capabilities,
          nextCapabilities: [],
          outboxEnqueued: false,
        },
        idempotent: true,
      };
    }
    const revoked = {
      ...grant,
      status: "revoked" as const,
      reason: input.reason,
      grantedBy: input.revokedBy,
      revokedAt: now,
    };
    this.accessGrants.set(key, revoked);
    return {
      grant: revoked,
      capabilityChange: {
        previousCapabilities: grant.capabilities,
        nextCapabilities: [],
        outboxEnqueued: false,
      },
      idempotent: false,
    };
  }
  async listReviewingPublicAssets(input: { limit: number; offset: number }) {
    const assets = this.assets.filter(
      (asset) => asset.visibility === "public" && asset.lifecycle === "reviewing",
    );
    return { assets: assets.slice(input.offset, input.offset + input.limit), total: assets.length };
  }
  async reviewPublicAsset(input: {
    assetId: string;
    reviewedBy: string;
    review: PublicAssetReviewInput;
  }) {
    const index = this.assets.findIndex((asset) => asset.id === input.assetId);
    const asset = this.assets[index];
    if (!asset) throw new Error("not found");
    const target = input.review.decision === "approve" ? "published" : "draft";
    if (asset.lifecycle !== "reviewing") {
      if (asset.lifecycle === target) return { asset, idempotent: true };
      throw new Error("conflict");
    }
    const reviewed = { ...asset, lifecycle: target, updatedAt: now } as DataAsset;
    this.assets[index] = reviewed;
    return { asset: reviewed, idempotent: false };
  }
  async runIdempotent<T>(input: {
    scope: string;
    key: string;
    create: () => Promise<T>;
  }): Promise<T> {
    const stored = this.saved.get(`${input.scope}:${input.key}`) as T | undefined;
    if (stored) return stored;
    const created = await input.create();
    this.saved.set(`${input.scope}:${input.key}`, created);
    return created;
  }

  private grantForRequest(request: DataAccessRequest): DataAccessGrant | null {
    return (
      [...this.accessGrants.values()].find(
        (grant) =>
          grant.assetId === request.assetId &&
          grant.versionId === null &&
          grant.subjectKind === request.subjectKind &&
          grant.subjectId === request.subjectId,
      ) ?? null
    );
  }
}

const uploadPort: DataUploadPort = {
  async createUploadSession(input): Promise<DataUploadSession> {
    return {
      id: "upload-1",
      assetId: input.assetId,
      version: input.version,
      locationKind: input.locationKind,
      objectKey: input.objectPath,
      uploadUrl: "https://object.example.test/upload",
      expiresAt: now,
    };
  },
  async getUploadSessionAsset() {
    return "public-asset";
  },
  async commitUploadSession() {
    return {
      id: "version-upload",
      assetId: "public-asset",
      version: "v-upload",
      status: "ready",
      manifestDigest: "a".repeat(64),
      manifest: {},
      immutableAt: now,
      createdBy: "owner",
      createdAt: now,
    };
  },
};

function actor(
  overrides: Partial<{
    userId: string;
    role: "user" | "org_admin" | "platform_admin";
    orgId: string | null;
    orgIds: string[];
    providerManagerOrgIds: string[];
  }> = {},
) {
  return {
    userId: "consumer",
    role: "user" as const,
    orgId: "consumer-org",
    orgIds: ["consumer-org"],
    ...overrides,
  };
}

describe("DataMarketService", () => {
  test("catalog filters private assets through local visibility", async () => {
    const service = new DataMarketService({ repository: new MemoryRepository(), uploadPort });
    const result = await service.listCatalog(actor(), { limit: 25, offset: 0 });
    expect(result.assets.map((asset) => asset.id)).toEqual(["public-asset"]);
  });

  test("catalog authorizes before pagination and returns a precise visible total", async () => {
    const repository = new MemoryRepository();
    repository.assets = [
      repository.assets[1] as DataAsset,
      {
        ...(repository.assets[0] as DataAsset),
        id: "second-public-asset",
        name: "Second public data",
      },
      repository.assets[0] as DataAsset,
    ];
    const service = new DataMarketService({ repository, uploadPort });

    const firstPage = await service.listCatalog(actor(), { limit: 1, offset: 0 });
    const secondPage = await service.listCatalog(actor(), { limit: 1, offset: 1 });
    const pastEnd = await service.listCatalog(actor(), { limit: 1, offset: 2 });

    expect(firstPage.assets.map((asset) => asset.id)).toEqual(["second-public-asset"]);
    expect(secondPage.assets.map((asset) => asset.id)).toEqual(["public-asset"]);
    expect(pastEnd.assets).toEqual([]);
    expect([firstPage.total, secondPage.total, pastEnd.total]).toEqual([2, 2, 2]);
  });

  test("catalog applies tags before pagination", async () => {
    const service = new DataMarketService({ repository: new MemoryRepository(), uploadPort });

    const result = await service.listCatalog(actor(), {
      tag: "genomics",
      limit: 1,
      offset: 0,
    });

    expect(result.assets.map((asset) => asset.id)).toEqual(["public-asset"]);
    expect(result.total).toBe(1);
  });

  test("private asset creation is idempotent and cannot become provider-owned", async () => {
    const repository = new MemoryRepository();
    const service = new DataMarketService({ repository, uploadPort });
    const input = {
      name: "Notebook input",
      description: null,
      visibility: "public" as const,
      kind: "scientific-dataset" as const,
      accessMode: "request" as const,
      sensitivity: "internal" as const,
      tags: ["private"],
      providerOrgId: "provider-org",
    };
    const first = await service.createPrivateAsset(actor(), input, "same-key");
    const second = await service.createPrivateAsset(actor(), input, "same-key");
    expect(second).toEqual(first);
    expect(first.visibility).toBe("private");
    expect(first.providerOrgId).toBeNull();
    expect(repository.assets).toHaveLength(3);
  });

  test("private licensed material is always entitlement-only restricted metadata", async () => {
    const repository = new MemoryRepository();
    const service = new DataMarketService({ repository, uploadPort });
    const created = await service.createPrivateAsset(
      actor(),
      {
        name: "VASP POTCAR",
        visibility: "public",
        kind: "licensed-material",
        accessMode: "open",
        sensitivity: "open",
        tags: ["vasp"],
        elements: ["si", "O", "SI"],
      },
      "licensed-key",
    );
    expect(created).toMatchObject({
      visibility: "private",
      accessMode: "entitlement",
      sensitivity: "restricted",
      elements: ["Si", "O"],
    });
  });

  test("private licensed material requires a non-empty element set", async () => {
    const service = new DataMarketService({ repository: new MemoryRepository(), uploadPort });
    await expect(
      service.createPrivateAsset(
        actor(),
        {
          name: "VASP POTCAR",
          visibility: "private",
          kind: "licensed-material",
          accessMode: "entitlement",
          sensitivity: "restricted",
          tags: [],
        },
        "licensed-empty-elements",
      ),
    ).rejects.toThrow("requires at least one chemical element");
  });

  test("owner selection of private licensed material requires an active entitlement", async () => {
    const repository = new MemoryRepository();
    const privateAsset = repository.assets[1];
    if (!privateAsset) throw new Error("Missing private asset fixture");
    const asset: DataAsset = {
      ...privateAsset,
      kind: "licensed-material",
      accessMode: "entitlement",
      sensitivity: "restricted",
    };
    repository.assets[1] = asset;
    const owner = actor({ userId: "owner" });
    await expect(localPermission(owner, asset, "use", repository)).resolves.toBe(false);
    repository.accessGrants.set("owner-entitlement", {
      id: "owner-entitlement",
      assetId: asset.id,
      versionId: null,
      subjectKind: "user",
      subjectId: "owner",
      capabilities: ["use"],
      status: "active",
      expiresAt: null,
    });
    await expect(localPermission(owner, asset, "use", repository)).resolves.toBe(true);
    const activeGrant = repository.accessGrants.get("owner-entitlement");
    if (!activeGrant) throw new Error("Missing active entitlement fixture");
    repository.accessGrants.set("owner-entitlement", {
      ...activeGrant,
      status: "revoked",
    });
    await expect(localPermission(owner, asset, "use", repository)).resolves.toBe(false);
  });

  test("private licensed owner entitlement is platform-reviewed and revocable", async () => {
    const repository = new MemoryRepository();
    const privateAsset = repository.assets[1];
    if (!privateAsset) throw new Error("Missing private asset fixture");
    const licensedAsset: DataAsset = {
      ...privateAsset,
      kind: "licensed-material",
      accessMode: "entitlement",
      sensitivity: "restricted",
    };
    repository.assets[1] = licensedAsset;
    const audits: unknown[] = [];
    const revokedDeliveries: unknown[] = [];
    const service = new DataMarketService({
      repository,
      uploadPort,
      grantProjector: { enqueueMany: async () => undefined },
      audit: { record: async (input) => void audits.push(input) },
      deliveryRevoker: {
        revoke: async (input) => {
          revokedDeliveries.push(input);
          return 1;
        },
      },
    });
    await expect(
      service.requestOwnerEntitlement(actor(), licensedAsset.id, "Need licensed use", "denied"),
    ).rejects.toThrow("Only the private asset owner");
    const requested = await service.requestOwnerEntitlement(
      actor({ userId: "owner" }),
      licensedAsset.id,
      "Need licensed use",
      "owner-request",
    );
    await expect(
      localPermission(actor({ userId: "owner" }), licensedAsset, "use", repository),
    ).resolves.toBe(false);
    const reviewed = await service.reviewOwnerEntitlement(
      actor({ userId: "platform", role: "platform_admin", orgIds: [] }),
      requested.id,
      { decision: "approve", reason: "License verified" },
    );
    expect(reviewed.grant).toMatchObject({ subjectId: "owner", status: "active" });
    await expect(
      service.getMyAccessState(actor({ userId: "owner" }), [licensedAsset.id]),
    ).resolves.toMatchObject({
      activeUseAssetIds: [licensedAsset.id],
      requests: [expect.objectContaining({ id: requested.id, status: "approved" })],
    });
    await expect(
      localPermission(actor({ userId: "owner" }), licensedAsset, "use", repository),
    ).resolves.toBe(true);
    const grantId = reviewed.grant?.id;
    if (!grantId) throw new Error("Missing approved grant");
    await service.revokeOwnerEntitlement(
      actor({ userId: "platform", role: "platform_admin", orgIds: [] }),
      grantId,
      "License withdrawn",
    );
    await expect(
      service.getMyAccessState(actor({ userId: "owner" }), [licensedAsset.id]),
    ).resolves.toMatchObject({ activeUseAssetIds: [] });
    await expect(
      localPermission(actor({ userId: "owner" }), licensedAsset, "use", repository),
    ).resolves.toBe(false);
    expect(audits).toHaveLength(3);
    expect(revokedDeliveries).toEqual([
      { assetId: licensedAsset.id, versionId: null, reasonCode: "DATA_GRANT_REVOKED" },
    ]);
  });

  test("replica creation is unavailable before it can persist a pending replica", async () => {
    const repository = new MemoryRepository();
    let replicaWrites = 0;
    repository.createReplica = async () => {
      replicaWrites += 1;
      throw new Error("replica persistence must not be reached");
    };
    const service = new DataMarketService({ repository, uploadPort });
    await expect(
      service.createReplica(
        actor({
          userId: "owner",
          role: "org_admin",
          orgId: "provider-org",
          orgIds: ["provider-org"],
        }),
        {
          versionId: "version-1",
          agentId: "a1",
          siteId: "s1",
          clusterId: "c1",
          locationKind: "cp-local",
        },
        "replica-key",
      ),
    ).rejects.toThrow("DATA_REPLICA_UNAVAILABLE");
    expect(replicaWrites).toBe(0);
  });

  test("SpiceDB hook receives the local decision and can deny an otherwise public asset", async () => {
    let localAllowed: boolean | undefined;
    const service = new DataMarketService({
      repository: new MemoryRepository(),
      uploadPort,
      authz: {
        check: async (input) => {
          localAllowed = input.localAllowed;
          return false;
        },
      },
    });
    await expect(service.getAsset(actor(), "public-asset")).rejects.toThrow("Not authorized");
    expect(localAllowed).toBe(true);
  });

  test("published request assets require an active unexpired grant", async () => {
    const repository = new MemoryRepository();
    const publicAsset = repository.assets[0];
    if (!publicAsset) throw new Error("Missing public test asset");
    repository.assets[0] = { ...publicAsset, accessMode: "request" };
    const service = new DataMarketService({ repository, uploadPort });

    await expect(service.getAsset(actor(), "public-asset")).rejects.toThrow("Not authorized");
    repository.accessGrants.set("runtime-grant", {
      id: "runtime-grant",
      assetId: "public-asset",
      versionId: null,
      subjectKind: "user",
      subjectId: "consumer",
      capabilities: ["use"],
      status: "active",
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await expect(service.getAsset(actor(), "public-asset")).resolves.toMatchObject({
      id: "public-asset",
    });
    const activeGrant = repository.accessGrants.get("runtime-grant");
    if (!activeGrant) throw new Error("Missing active test grant");
    repository.accessGrants.set("runtime-grant", {
      ...activeGrant,
      expiresAt: new Date("2026-07-23T00:00:00.000Z"),
    });
    await expect(service.getAsset(actor(), "public-asset")).rejects.toThrow("Not authorized");
    repository.accessGrants.set("runtime-grant", {
      ...activeGrant,
      status: "revoked",
    });
    await expect(service.getAsset(actor(), "public-asset")).rejects.toThrow("Not authorized");
  });

  test("enforce mode flushes creation tuples before the new asset is managed", async () => {
    let projected = false;
    let processedResource:
      | { forcePending?: boolean; resourceType?: string; resourceId?: string }
      | undefined;
    const repository = new MemoryRepository();
    const service = new DataMarketService({
      repository,
      uploadPort,
      grantProjector: {
        mode: "enforce",
        enqueueMany: async () => {},
        processOutbox: async (_limit, options) => {
          processedResource = options;
          projected = true;
          return { processed: 1, dead: 0 };
        },
      },
      authz: { check: async () => projected },
    });
    const provider = actor({
      userId: "owner",
      role: "org_admin",
      orgId: "provider-org",
      orgIds: ["provider-org"],
    });
    const asset = await service.createProviderAsset(
      provider,
      {
        name: "Immediate projection",
        visibility: "organization",
        kind: "scientific-dataset",
        accessMode: "request",
        sensitivity: "internal",
        tags: [],
        providerOrgId: "provider-org",
      },
      "immediate-projection",
    );

    expect(projected).toBe(true);
    expect(processedResource).toEqual({
      forcePending: true,
      resourceType: "data_asset",
      resourceId: asset.id,
    });
    await expect(service.getAsset(provider, asset.id)).resolves.toMatchObject({ id: asset.id });
  });

  test("private assets neither delegate use nor allow access requests", async () => {
    const service = new DataMarketService({ repository: new MemoryRepository(), uploadPort });
    await expect(service.getAsset(actor(), "private-asset")).rejects.toThrow("Not authorized");
    await expect(
      service.requestAccess(actor(), "private-asset", null, "private-request"),
    ).rejects.toThrow("cannot be requested or shared");
    await expect(
      service.requestAccess(actor({ userId: "owner" }), "private-asset", null, "owner-request"),
    ).rejects.toThrow("cannot be requested or shared");
  });

  test("upload commit rechecks current asset management permission", async () => {
    let committed = false;
    const service = new DataMarketService({
      repository: new MemoryRepository(),
      uploadPort: {
        ...uploadPort,
        getUploadSessionAsset: async () => "public-asset",
        commitUploadSession: async () => {
          committed = true;
          return uploadPort.commitUploadSession({
            sessionId: "upload-1",
            ownerUserId: "consumer",
          });
        },
      },
    });
    await expect(service.commitUploadSession(actor(), "upload-1")).rejects.toThrow(
      "Not authorized",
    );
    expect(committed).toBe(false);
  });

  test("public provider assets await platform review while other provider assets publish directly", async () => {
    const repository = new MemoryRepository();
    const service = new DataMarketService({ repository, uploadPort });
    const provider = actor({
      userId: "owner",
      role: "org_admin",
      orgId: "provider-org",
      orgIds: ["provider-org"],
    });
    const base = {
      name: "Provider asset",
      description: null,
      kind: "scientific-dataset" as const,
      accessMode: "open" as const,
      sensitivity: "open" as const,
      tags: [],
      providerOrgId: "provider-org",
    };
    const publicAsset = await service.createProviderAsset(
      provider,
      { ...base, visibility: "public" },
      "public-provider",
    );
    const organizationAsset = await service.createProviderAsset(
      provider,
      { ...base, visibility: "organization" },
      "organization-provider",
    );
    const platformPublicAsset = await service.createProviderAsset(
      actor({ userId: "platform", role: "platform_admin", orgIds: [] }),
      { ...base, visibility: "public" },
      "public-platform",
    );

    expect(publicAsset.lifecycle).toBe("reviewing");
    expect(organizationAsset.lifecycle).toBe("published");
    expect(platformPublicAsset.lifecycle).toBe("published");
  });

  test("CP approval creates one projected grant and repeated review is idempotent", async () => {
    const projected: unknown[][] = [];
    const service = new DataMarketService({
      repository: new MemoryRepository(),
      uploadPort,
      grantProjector: {
        enqueueMany: async (tuples) => {
          projected.push(tuples);
        },
      },
    });
    const provider = actor({
      userId: "reviewer",
      role: "org_admin",
      orgId: "provider-org",
      orgIds: ["provider-org"],
    });
    const first = await service.reviewProviderAccessRequest(provider, "access-request-1", {
      decision: "approve",
      reason: "Approved",
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const repeated = await service.reviewProviderAccessRequest(provider, "access-request-1", {
      decision: "approve",
    });

    expect(first.idempotent).toBe(false);
    expect(first.grant).toMatchObject({ capabilities: ["use"], subjectId: "consumer" });
    expect(repeated.idempotent).toBe(true);
    expect(projected).toEqual([
      [
        expect.objectContaining({
          operation: "create",
          resource: { type: "data_asset", id: "public-asset" },
          relation: "user",
          subject: { type: "user", id: "consumer" },
        }),
      ],
    ]);
    await expect(
      service.reviewProviderAccessRequest(provider, "access-request-1", { decision: "reject" }),
    ).rejects.toThrow("already reviewed");
  });

  test("CP capability replacement removes stale SpiceDB tuples before granting the next capability", async () => {
    const repository = new MemoryRepository();
    const projected: Array<Array<{ operation: "create" | "delete"; relation: string }>> = [];
    const service = new DataMarketService({
      repository,
      uploadPort,
      grantProjector: {
        enqueueMany: async (tuples) => {
          projected.push(
            tuples.map((tuple) => ({ operation: tuple.operation, relation: tuple.relation })),
          );
        },
      },
    });
    const first = repository.accessRequests.get("access-request-1");
    if (!first) throw new Error("Missing access request fixture");
    repository.accessRequests.set(first.id, { ...first, capability: "view" });
    repository.accessRequests.set("access-request-2", {
      ...first,
      id: "access-request-2",
      capability: "use",
    });
    const provider = actor({
      userId: "reviewer",
      role: "org_admin",
      orgId: "provider-org",
      orgIds: ["provider-org"],
    });

    await service.reviewProviderAccessRequest(provider, "access-request-1", {
      decision: "approve",
    });
    await service.reviewProviderAccessRequest(provider, "access-request-2", {
      decision: "approve",
    });

    const assetIndex = repository.assets.findIndex((asset) => asset.id === "public-asset");
    const publicAsset = repository.assets[assetIndex];
    if (!publicAsset) throw new Error("Missing public asset fixture");
    repository.assets[assetIndex] = {
      ...publicAsset,
      providerOrgId: null,
      ownerUserId: "consumer",
      ownerKind: "user",
      kind: "licensed-material",
      visibility: "private",
      accessMode: "entitlement",
      sensitivity: "restricted",
    };
    await service.revokeOwnerEntitlement(
      actor({ userId: "platform", role: "platform_admin", orgIds: [] }),
      "grant-access-request-1",
      "revoked",
    );

    const tuples = projected.flat();
    const fakeSpiceTuples = new Set<string>();
    for (const tuple of tuples) {
      if (tuple.operation === "delete") fakeSpiceTuples.delete(tuple.relation);
      else fakeSpiceTuples.add(tuple.relation);
    }
    expect(tuples).toEqual([
      { operation: "create", relation: "viewer" },
      { operation: "delete", relation: "viewer" },
      { operation: "create", relation: "user" },
      { operation: "delete", relation: "user" },
    ]);
    expect(fakeSpiceTuples.has("viewer")).toBe(false);
    expect(fakeSpiceTuples.has("user")).toBe(false);
  });

  test("CP rejection records a terminal decision without a grant projection", async () => {
    const projected: unknown[][] = [];
    const service = new DataMarketService({
      repository: new MemoryRepository(),
      uploadPort,
      grantProjector: { enqueueMany: async (tuples) => void projected.push(tuples) },
    });
    const result = await service.reviewProviderAccessRequest(
      actor({
        userId: "reviewer",
        role: "org_admin",
        orgId: "provider-org",
        orgIds: ["provider-org"],
      }),
      "access-request-1",
      { decision: "reject", reason: "Insufficient justification" },
    );

    expect(result).toMatchObject({
      idempotent: false,
      grant: null,
      request: { status: "rejected" },
    });
    expect(projected).toEqual([]);
  });

  test("platform approval publishes a reviewing public asset and projects public access once", async () => {
    const repository = new MemoryRepository();
    const publicAsset = repository.assets[0];
    if (!publicAsset) throw new Error("Missing public test asset");
    repository.assets[0] = { ...publicAsset, lifecycle: "reviewing" };
    const projected: unknown[][] = [];
    const audits: unknown[] = [];
    const service = new DataMarketService({
      repository,
      uploadPort,
      grantProjector: { enqueueMany: async (tuples) => void projected.push(tuples) },
      audit: { record: async (input) => void audits.push(input) },
    });
    const admin = actor({ userId: "platform", role: "platform_admin", orgIds: [] });
    const first = await service.reviewPublicAsset(admin, "public-asset", {
      decision: "approve",
      reason: "Publication approved",
    });
    const repeated = await service.reviewPublicAsset(admin, "public-asset", {
      decision: "approve",
      reason: "Publication approved",
    });

    expect(first.asset.lifecycle).toBe("published");
    expect(repeated.idempotent).toBe(true);
    expect(projected).toHaveLength(1);
    expect(audits).toHaveLength(1);
    await expect(
      service.reviewPublicAsset(admin, "public-asset", { decision: "reject", reason: "conflict" }),
    ).rejects.toThrow("conflict");
  });

  test("CP-local imports report dispatched when the scan request reaches its Agent", async () => {
    const requests: Array<{ requestId: string; relativePath: string }> = [];
    const service = new DataMarketService({
      repository: new MemoryRepository(),
      uploadPort,
      dataScanCoordinator: {
        requestScan: async (input) => {
          requests.push({ requestId: input.requestId, relativePath: input.relativePath });
          return true;
        },
      },
    });
    const result = await service.startProviderImport(
      actor({
        userId: "owner",
        role: "org_admin",
        orgId: "provider-org",
        orgIds: ["provider-org"],
      }),
      {
        assetId: "public-asset",
        version: "dispatched-import",
        source: {
          kind: "cp-local",
          agentId: "agent-1",
          managedRootId: "00000000-0000-0000-0000-000000000001",
          relativePath: "cohort/run-1",
        },
      },
      "cp-local-import",
    );

    expect(result.version.status).toBe("draft");
    expect(result).toMatchObject({ dispatchState: "dispatched" });
    expect(requests).toEqual([{ requestId: result.dataImport.id, relativePath: "cohort/run-1" }]);
  });

  test("CP-local imports report queued when their Agent is temporarily unavailable", async () => {
    const service = new DataMarketService({
      repository: new MemoryRepository(),
      uploadPort,
      dataScanCoordinator: { requestScan: async () => false },
    });

    const result = await service.startProviderImport(
      actor({
        userId: "owner",
        role: "org_admin",
        orgId: "provider-org",
        orgIds: ["provider-org"],
      }),
      {
        assetId: "public-asset",
        version: "queued-import",
        source: {
          kind: "cp-local",
          agentId: "agent-offline",
          managedRootId: "00000000-0000-0000-0000-000000000001",
          relativePath: "cohort/queued",
        },
      },
      "cp-local-import-queued",
    );

    expect(result).toMatchObject({
      dataImport: { status: "pending" },
      dispatchState: "queued",
    });
  });

  test("NetDrive import states that a copy backend is unavailable", async () => {
    const service = new DataMarketService({ repository: new MemoryRepository(), uploadPort });
    await expect(
      service.startProviderImport(
        actor({
          userId: "owner",
          role: "org_admin",
          orgId: "provider-org",
          orgIds: ["provider-org"],
        }),
        {
          assetId: "public-asset",
          version: "netdrive-import",
          source: { kind: "netdrive", netdriveFileId: "00000000-0000-0000-0000-000000000001" },
        },
        "netdrive-import",
      ),
    ).rejects.toThrow("NetDrive copy backend");
  });

  test("unsupported import sources are rejected before looking up or writing an asset", async () => {
    const repository = new MemoryRepository();
    let importWrites = 0;
    repository.createCpLocalImport = async () => {
      importWrites += 1;
      throw new Error("import persistence must not be reached");
    };
    const service = new DataMarketService({ repository, uploadPort });
    await expect(
      service.startProviderImport(
        actor({
          userId: "owner",
          role: "org_admin",
          orgId: "provider-org",
          orgIds: ["provider-org"],
        }),
        {
          assetId: "missing-asset",
          version: "unsupported-import",
          source: {
            kind: "platform-object",
            uploadSessionId: "00000000-0000-0000-0000-000000000001",
          },
        },
        "platform-object-import",
      ),
    ).rejects.toThrow("platform-object upload commit");
    expect(importWrites).toBe(0);
  });

  test("provider manager scope cannot create a replica for another organization", async () => {
    const repository = new MemoryRepository();
    let replicaWrites = 0;
    repository.createReplica = async () => {
      replicaWrites += 1;
      throw new Error("replica persistence must not be reached");
    };
    const service = new DataMarketService({ repository, uploadPort });
    await expect(
      service.createReplica(
        actor({
          userId: "provider-b-admin",
          role: "user",
          orgId: "provider-b",
          orgIds: ["provider-b"],
          providerManagerOrgIds: ["provider-b"],
        }),
        {
          versionId: "version-1",
          agentId: "a1",
          siteId: "s1",
          clusterId: "c1",
          locationKind: "cp-local",
        },
        "cross-provider-replica",
      ),
    ).rejects.toThrow("Not authorized");
    expect(replicaWrites).toBe(0);
  });

  test("platform administrator active organization cannot manage another provider asset", async () => {
    const service = new DataMarketService({ repository: new MemoryRepository(), uploadPort });
    const platformInAnotherOrganization = actor({
      userId: "platform-admin",
      role: "platform_admin",
      orgId: "provider-b",
      orgIds: ["provider-b"],
      providerManagerOrgIds: ["provider-b"],
    });

    await expect(
      service.listProviderVersions(platformInAnotherOrganization, "public-asset", {
        limit: 25,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(
      service.getProviderAccessRequest(platformInAnotherOrganization, "access-request-1"),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  test("CP reads are provider-scoped and paginate versions and replicas through repository ports", async () => {
    const service = new DataMarketService({ repository: new MemoryRepository(), uploadPort });
    const cpActor = actor({
      userId: "owner",
      role: "org_admin",
      orgId: "provider-org",
      orgIds: ["provider-org"],
    });
    await expect(
      service.listProviderAssets(cpActor, { limit: 25, offset: 0 }),
    ).resolves.toMatchObject({
      total: 1,
      assets: [expect.objectContaining({ id: "public-asset" })],
    });
    await expect(
      service.listProviderVersions(cpActor, "public-asset", { limit: 25, offset: 0 }),
    ).resolves.toMatchObject({
      total: 1,
      versions: [expect.objectContaining({ id: "version-1" })],
    });
    await expect(
      service.listProviderReplicas(cpActor, "version-1", { limit: 25, offset: 0 }),
    ).resolves.toMatchObject({ total: 0, replicas: [] });
    await expect(
      service.listProviderImports(cpActor, { limit: 25, offset: 0 }),
    ).resolves.toMatchObject({
      total: 0,
      imports: [],
    });
  });
});
