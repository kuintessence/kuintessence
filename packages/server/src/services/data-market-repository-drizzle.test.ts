import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agents,
  clusterFileRoots,
  createPgDb,
  dataAssetImports,
  dataAssets,
  dataAssetVersions,
  dataScanRequests,
  orgs,
  type PgDb,
  users,
} from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { PgDataImportCoordinator } from "./data-import-coordinator-drizzle";
import { type DataMarketActor, DataMarketService, type DataUploadPort } from "./data-market";
import { PgDataMarketRepository } from "./data-market-repository-drizzle";
import { DataScanCoordinator } from "./data-scan-coordinator";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const ASSET_IDS = [
  "00000000-0000-4000-8000-00000000da01",
  "00000000-0000-4000-8000-00000000da02",
  "00000000-0000-4000-8000-00000000da03",
] as const;

const unavailableUploadPort: DataUploadPort = {
  async commitUploadSession() {
    throw new Error("not used by CP-local import tests");
  },
  async createUploadSession() {
    throw new Error("not used by CP-local import tests");
  },
  async getUploadSessionAsset() {
    throw new Error("not used by CP-local import tests");
  },
};

describe("PgDataMarketRepository", () => {
  let db: PgDb;
  let repository: PgDataMarketRepository;
  let providerOrgId: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    repository = new PgDataMarketRepository(db);
    const [org] = await db
      .insert(orgs)
      .values({ name: "test-data-market-provider-pagination" })
      .returning();
    if (!org) throw new Error("failed to create data market test organization");
    providerOrgId = org.id;

    await db.insert(dataAssets).values([
      {
        id: ASSET_IDS[0],
        providerOrgId,
        ownerKind: "provider",
        name: "Newest unrelated asset",
        metadata: { tags: ["unrelated"] },
        updatedAt: new Date("2026-08-12T03:00:00.000Z"),
      },
      {
        id: ASSET_IDS[1],
        providerOrgId,
        ownerKind: "provider",
        name: "Tagged asset A",
        metadata: { tags: ["climate"] },
        updatedAt: new Date("2026-08-12T02:00:00.000Z"),
      },
      {
        id: ASSET_IDS[2],
        providerOrgId,
        ownerKind: "provider",
        name: "Tagged asset B",
        metadata: { tags: ["climate", "simulation"] },
        updatedAt: new Date("2026-08-12T02:00:00.000Z"),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(dataAssets).where(inArray(dataAssets.id, [...ASSET_IDS]));
    await db.delete(orgs).where(eq(orgs.id, providerOrgId));
  });

  test("filters provider assets by tag before stable pagination and count", async () => {
    const firstPage = await repository.listProviderAssets([providerOrgId], {
      tag: "climate",
      limit: 1,
      offset: 0,
    });
    const secondPage = await repository.listProviderAssets([providerOrgId], {
      tag: "climate",
      limit: 1,
      offset: 1,
    });

    expect(firstPage.total).toBe(2);
    expect(firstPage.assets.map((asset) => asset.id)).toEqual([ASSET_IDS[2]]);
    expect(secondPage.total).toBe(2);
    expect(secondPage.assets.map((asset) => asset.id)).toEqual([ASSET_IDS[1]]);
  });

  test("replays a CP-local import durably across service instances and rejects a reused key with different input", async () => {
    const suffix = crypto.randomUUID();
    const [owner] = await db
      .insert(users)
      .values({
        email: `data-market-idempotency-${suffix}@example.test`,
        orgId: providerOrgId,
        role: "org_admin",
      })
      .returning();
    if (!owner) throw new Error("failed to create CP data owner");
    const agentId = `data-market-agent-${suffix}`;
    await db.insert(agents).values({
      agentId,
      providerOrgId,
      schedulerType: "slurm",
      schedulerVersion: "23",
      siteName: "idempotency-test-site",
      status: "online",
    });
    const [root] = await db
      .insert(clusterFileRoots)
      .values({
        agentId,
        label: "Idempotency test root",
        path: `/data/${suffix}`,
        providerOrgId,
      })
      .returning();
    if (!root) throw new Error("failed to create cluster file root");
    const [asset] = await db
      .insert(dataAssets)
      .values({
        createdBy: owner.id,
        name: `Idempotency dataset ${suffix}`,
        ownerKind: "provider",
        providerOrgId,
      })
      .returning();
    if (!asset) throw new Error("failed to create CP data asset");

    const actor: DataMarketActor = {
      orgId: providerOrgId,
      orgIds: [providerOrgId],
      role: "org_admin",
      userId: owner.id,
    };
    const source = {
      agentId,
      kind: "cp-local" as const,
      managedRootId: root.id,
      relativePath: "cohort/first",
    };
    let dispatchCount = 0;
    const coordinator = new DataScanCoordinator(
      new PgDataImportCoordinator(db),
      {
        pushDataScanRequest: () => {
          dispatchCount += 1;
          return true;
        },
      },
      { findByFingerprint: async () => null },
    );
    const createService = () =>
      new DataMarketService({
        dataScanCoordinator: coordinator,
        repository: new PgDataMarketRepository(db),
        uploadPort: unavailableUploadPort,
      });

    try {
      const first = await createService().startProviderImport(
        actor,
        { assetId: asset.id, source, version: "v1" },
        "cp-import-replay-key",
      );
      const replay = await createService().startProviderImport(
        actor,
        { assetId: asset.id, source, version: "v1" },
        "cp-import-replay-key",
      );

      expect(replay).toMatchObject({
        dataImport: { id: first.dataImport.id },
        replayed: true,
        version: { id: first.version.id },
      });
      expect(first.replayed).toBe(false);
      expect(dispatchCount).toBe(1);
      await db
        .update(dataAssetImports)
        .set({ errorMessage: "Agent scan failed", status: "failed" })
        .where(eq(dataAssetImports.id, first.dataImport.id));
      const failedReplay = await createService().startProviderImport(
        actor,
        { assetId: asset.id, source, version: "v1" },
        "cp-import-replay-key",
      );
      expect(failedReplay).toMatchObject({
        dataImport: { errorMessage: "Agent scan failed", status: "failed" },
        replayed: true,
      });
      expect(dispatchCount).toBe(1);

      await db
        .update(dataAssetImports)
        .set({ errorMessage: null, status: "completed" })
        .where(eq(dataAssetImports.id, first.dataImport.id));
      const completedReplay = await createService().startProviderImport(
        actor,
        { assetId: asset.id, source, version: "v1" },
        "cp-import-replay-key",
      );
      expect(completedReplay).toMatchObject({
        dataImport: { status: "completed" },
        replayed: true,
      });
      expect(dispatchCount).toBe(1);
      const imports = await db
        .select()
        .from(dataAssetImports)
        .where(eq(dataAssetImports.requesterUserId, owner.id));
      expect(imports).toHaveLength(1);

      await expect(
        createService().startProviderImport(
          actor,
          {
            assetId: asset.id,
            source: { ...source, relativePath: "cohort/different" },
            version: "conflicting-import",
          },
          "cp-import-replay-key",
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await db.delete(dataAssets).where(eq(dataAssets.id, asset.id));
      await db.delete(clusterFileRoots).where(eq(clusterFileRoots.id, root.id));
      await db.delete(agents).where(eq(agents.agentId, agentId));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });

  test("repairs a missing scan request on idempotent replay without duplicating the import", async () => {
    const suffix = crypto.randomUUID();
    const [owner] = await db
      .insert(users)
      .values({
        email: `data-market-repair-${suffix}@example.test`,
        orgId: providerOrgId,
        role: "org_admin",
      })
      .returning();
    if (!owner) throw new Error("failed to create repair-import owner");
    const agentId = `data-market-repair-agent-${suffix}`;
    await db.insert(agents).values({
      agentId,
      providerOrgId,
      schedulerType: "slurm",
      schedulerVersion: "23",
      siteName: "repair-import-test-site",
      status: "online",
    });
    const [root] = await db
      .insert(clusterFileRoots)
      .values({
        agentId,
        label: "Repair import root",
        path: `/data/${suffix}`,
        providerOrgId,
      })
      .returning();
    if (!root) throw new Error("failed to create repair-import root");
    const [asset] = await db
      .insert(dataAssets)
      .values({
        createdBy: owner.id,
        name: `Repair import dataset ${suffix}`,
        ownerKind: "provider",
        providerOrgId,
      })
      .returning();
    if (!asset) throw new Error("failed to create repair-import asset");
    const actor: DataMarketActor = {
      orgId: providerOrgId,
      orgIds: [providerOrgId],
      role: "org_admin",
      userId: owner.id,
    };
    const source = {
      agentId,
      kind: "cp-local" as const,
      managedRootId: root.id,
      relativePath: "cohort/repair",
    };

    try {
      const failingService = new DataMarketService({
        dataScanCoordinator: {
          requestScan: async () => {
            throw new Error("scan request persistence unavailable");
          },
        },
        repository: new PgDataMarketRepository(db),
        uploadPort: unavailableUploadPort,
      });
      await expect(
        failingService.startProviderImport(
          actor,
          { assetId: asset.id, source, version: "v1" },
          "cp-import-repair-key",
        ),
      ).rejects.toThrow("scan request persistence unavailable");

      let dispatchCount = 0;
      const recoveringService = new DataMarketService({
        dataScanCoordinator: new DataScanCoordinator(
          new PgDataImportCoordinator(db),
          {
            pushDataScanRequest: () => {
              dispatchCount += 1;
              return true;
            },
          },
          { findByFingerprint: async () => null },
        ),
        repository: new PgDataMarketRepository(db),
        uploadPort: unavailableUploadPort,
      });
      const replay = await recoveringService.startProviderImport(
        actor,
        { assetId: asset.id, source, version: "v1" },
        "cp-import-repair-key",
      );

      expect(replay).toMatchObject({ dispatchState: "dispatched", replayed: true });
      expect(dispatchCount).toBe(1);
      const [imports, versions, scans] = await Promise.all([
        db.select().from(dataAssetImports).where(eq(dataAssetImports.targetAssetId, asset.id)),
        db.select().from(dataAssetVersions).where(eq(dataAssetVersions.dataAssetId, asset.id)),
        db
          .select()
          .from(dataScanRequests)
          .where(eq(dataScanRequests.importId, replay.dataImport.id)),
      ]);
      expect(imports).toHaveLength(1);
      expect(versions).toHaveLength(1);
      expect(scans).toHaveLength(1);
    } finally {
      await db.delete(dataAssets).where(eq(dataAssets.id, asset.id));
      await db.delete(clusterFileRoots).where(eq(clusterFileRoots.id, root.id));
      await db.delete(agents).where(eq(agents.agentId, agentId));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });

  test("keeps a queued CP-local import pending until the reconnected Agent accepts dispatch", async () => {
    const suffix = crypto.randomUUID();
    const [owner] = await db
      .insert(users)
      .values({
        email: `data-market-queued-${suffix}@example.test`,
        orgId: providerOrgId,
        role: "org_admin",
      })
      .returning();
    if (!owner) throw new Error("failed to create queued-import owner");
    const agentId = `data-market-queued-agent-${suffix}`;
    await db.insert(agents).values({
      agentId,
      providerOrgId,
      schedulerType: "slurm",
      schedulerVersion: "23",
      siteName: "queued-import-test-site",
      status: "offline",
    });
    const [root] = await db
      .insert(clusterFileRoots)
      .values({
        agentId,
        label: "Queued import root",
        path: `/data/${suffix}`,
        providerOrgId,
      })
      .returning();
    if (!root) throw new Error("failed to create queued-import root");
    const [asset] = await db
      .insert(dataAssets)
      .values({
        createdBy: owner.id,
        name: `Queued import dataset ${suffix}`,
        ownerKind: "provider",
        providerOrgId,
      })
      .returning();
    if (!asset) throw new Error("failed to create queued-import asset");

    let acceptsDispatch = false;
    const coordinator = new DataScanCoordinator(
      new PgDataImportCoordinator(db),
      {
        pushDataScanRequest: () => acceptsDispatch,
      },
      { findByFingerprint: async () => null },
    );
    const service = new DataMarketService({
      dataScanCoordinator: coordinator,
      repository: new PgDataMarketRepository(db),
      uploadPort: unavailableUploadPort,
    });
    const actor: DataMarketActor = {
      orgId: providerOrgId,
      orgIds: [providerOrgId],
      role: "org_admin",
      userId: owner.id,
    };

    try {
      const created = await service.startProviderImport(
        actor,
        {
          assetId: asset.id,
          source: {
            agentId,
            kind: "cp-local",
            managedRootId: root.id,
            relativePath: "cohort/queued",
          },
          version: "v1",
        },
        "cp-import-queued-key",
      );

      const [queued] = await db
        .select({ status: dataAssetImports.status })
        .from(dataAssetImports)
        .where(eq(dataAssetImports.id, created.dataImport.id));
      expect(queued?.status).toBe("pending");

      acceptsDispatch = true;
      await coordinator.onAgentConnected(agentId);

      const [running] = await db
        .select({ status: dataAssetImports.status })
        .from(dataAssetImports)
        .where(eq(dataAssetImports.id, created.dataImport.id));
      expect(running?.status).toBe("running");
    } finally {
      await db.delete(dataAssets).where(eq(dataAssets.id, asset.id));
      await db.delete(clusterFileRoots).where(eq(clusterFileRoots.id, root.id));
      await db.delete(agents).where(eq(agents.agentId, agentId));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
