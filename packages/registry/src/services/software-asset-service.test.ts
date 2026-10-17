import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  authzOutbox,
  createPgDb,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import { asc, eq, inArray, like } from "drizzle-orm";
import { SoftwareAssetService, type UpsertSoftwareAssetInput } from "./software-asset-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("SoftwareAssetService", () => {
  let db: PgDb;
  let service: SoftwareAssetService;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    service = new SoftwareAssetService(db);
  });

  afterAll(async () => {
    const assets = await db
      .select({ id: softwareAssets.id })
      .from(softwareAssets)
      .where(like(softwareAssets.name, "assetsvc-test-%"));
    if (assets.length)
      await db.delete(authzOutbox).where(
        inArray(
          authzOutbox.resourceId,
          assets.map((asset) => asset.id),
        ),
      );
    await db.delete(softwareAssets).where(like(softwareAssets.name, "assetsvc-test-%"));
  });

  test("syncUpstreamPackages is idempotent and writes one revision", async () => {
    const name = "assetsvc-test-zlib";
    const first = await service.syncUpstreamPackages([
      {
        name,
        metadata: {
          licenses: [],
          maintainers: [],
          versions: ["1.3"],
          variants: [],
          dependencies: [],
          provides: [],
          conflicts: [],
        },
      },
    ]);
    const second = await service.syncUpstreamPackages([
      {
        name,
        metadata: {
          licenses: [],
          maintainers: [],
          versions: ["1.3"],
          variants: [],
          dependencies: [],
          provides: [],
          conflicts: [],
        },
      },
    ]);
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);

    const rows = await db.select().from(softwareAssets).where(eq(softwareAssets.name, name));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("official-upstream");
    expect(rows[0]?.trustedForGlobalUse).toBe(true);

    const revisions = rows[0]
      ? await db
          .select()
          .from(softwareAssetRevisions)
          .where(eq(softwareAssetRevisions.assetId, rows[0].id))
      : [];
    expect(revisions).toHaveLength(1);
    if (!rows[0]) throw new Error("synced asset missing");
    const outbox = await db
      .select()
      .from(authzOutbox)
      .where(eq(authzOutbox.resourceId, rows[0].id));
    expect(outbox).toHaveLength(4);
    expect(outbox.every((row) => row.operation === "create")).toBe(true);
  });

  test("metadata changes do not requeue grants, but trust and visibility changes do", async () => {
    const input: UpsertSoftwareAssetInput = {
      kind: "spack-package",
      name: "assetsvc-test-permissions",
      version: "1.0",
      source: "official-upstream",
      lifecycle: "published",
      visibility: "platform-public",
      trustedForGlobalUse: true,
      payload: {
        kind: "spack-package",
        spack: { packageName: "test", metadata: {}, dependencies: [], providers: [], variants: [] },
      },
      provenance: {},
    };
    const asset = await service.upsertAsset(input);
    const mutations = () =>
      db
        .select()
        .from(authzOutbox)
        .where(eq(authzOutbox.resourceId, asset.id))
        .orderBy(asc(authzOutbox.sequence));
    await service.upsertAsset({ ...input, provenance: { note: "metadata only" } });
    expect(await mutations()).toHaveLength(4);
    await service.upsertAsset({ ...input, trustedForGlobalUse: false });
    expect((await mutations()).map(({ operation, relation }) => [operation, relation])).toEqual([
      ["create", "platform"],
      ["create", "viewer"],
      ["create", "user"],
      ["create", "installer"],
      ["delete", "installer"],
    ]);
    await service.upsertAsset({ ...input, visibility: "private" });
    expect(
      (await mutations()).slice(5).map(({ operation, relation }) => [operation, relation]),
    ).toEqual([
      ["delete", "viewer"],
      ["delete", "user"],
    ]);
    await service.upsertAsset(input);
    expect(
      (await mutations()).slice(7).map(({ operation, relation }) => [operation, relation]),
    ).toEqual([
      ["create", "viewer"],
      ["create", "user"],
      ["create", "installer"],
    ]);
  });

  test("archiving twice queues revocations once and republishing restores access", async () => {
    const input: UpsertSoftwareAssetInput = {
      kind: "spack-package",
      name: "assetsvc-test-archive",
      version: "1.0",
      source: "official-upstream",
      lifecycle: "published",
      visibility: "platform-public",
      trustedForGlobalUse: true,
      payload: {
        kind: "spack-package",
        legacyAppTemplateId: "archive-test",
        spack: { packageName: "test", metadata: {}, dependencies: [], providers: [], variants: [] },
      },
      provenance: {},
      grants: [
        {
          subjectKind: "org",
          subjectId: "00000000-0000-4000-8000-000000000001",
          capabilities: ["view", "use"],
        },
      ],
    };
    const asset = await service.upsertAsset(input);
    for (let i = 0; i < 2; i++)
      await service.archiveLegacyAsset("spack-package", "legacyAppTemplateId", "archive-test");
    let rows = await db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, asset.id));
    expect(rows.filter((row) => row.operation === "delete")).toHaveLength(5);
    await service.upsertAsset(input);
    rows = await db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, asset.id));
    expect(rows.filter((row) => row.operation === "create")).toHaveLength(11);
  });

  test("concurrent trust changes leave the projected installer permission consistent", async () => {
    const input: UpsertSoftwareAssetInput = {
      kind: "spack-package",
      name: "assetsvc-test-concurrent",
      version: "1.0",
      source: "official-upstream",
      lifecycle: "published",
      visibility: "platform-public",
      trustedForGlobalUse: true,
      payload: {
        kind: "spack-package",
        spack: { packageName: "test", metadata: {}, dependencies: [], providers: [], variants: [] },
      },
      provenance: {},
    };
    const asset = await service.upsertAsset(input);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.upsertAsset({ ...input, trustedForGlobalUse: index % 2 === 1 }),
      ),
    );
    const [current] = await db.select().from(softwareAssets).where(eq(softwareAssets.id, asset.id));
    const rows = await db
      .select()
      .from(authzOutbox)
      .where(eq(authzOutbox.resourceId, asset.id))
      .orderBy(asc(authzOutbox.sequence));
    const last = rows.filter((row) => row.relation === "installer").at(-1);
    if (!current) throw new Error("updated asset missing");
    expect(last?.operation === "create").toBe(current.trustedForGlobalUse);
  });
});
