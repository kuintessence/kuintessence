import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, type PgDb, softwareAssetRevisions, softwareAssets } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { SoftwareAssetService } from "./software-asset-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("SoftwareAssetService", () => {
  let db: PgDb;
  let service: SoftwareAssetService;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    service = new SoftwareAssetService(db);
  });

  afterAll(async () => {
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
  });
});
