import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createPgDb,
  netdriveFiles,
  netdriveTransferLog,
  orgs,
  type PgDb,
  users,
} from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { deriveDataSites } from "./data-locality";

const PG_URL =
  process.env.KQ_PG_URL ??
  process.env.DATABASE_URL ??
  "postgres://kq:kq@localhost:5432/kuintessence";

const ORG_ID = "00000000-0000-0000-0000-0000000dc1a0";
const USER_ID = "00000000-0000-0000-0000-0000000dc2a0";
const FILE_A = "00000000-0000-0000-0000-0000000dc3a0";
const FILE_B = "00000000-0000-0000-0000-0000000dc3b0";
const FILE_OTHER = "00000000-0000-0000-0000-0000000dc3c0";

describe("deriveDataSites", () => {
  test("short-circuits to empty for no file ids (DB-free)", async () => {
    const db = createPgDb(PG_URL);
    expect(await deriveDataSites(db, [])).toEqual([]);
  });
});

describe("deriveDataSites (PG-backed)", () => {
  let db: PgDb;

  beforeAll(() => {
    db = createPgDb(PG_URL);
  });

  beforeEach(async () => {
    await cleanup(db);
    await db.insert(orgs).values({ id: ORG_ID, name: "data-locality-test-org" });
    await db.insert(users).values({
      id: USER_ID,
      email: "data-locality@example.test",
      displayName: "Data Locality",
      role: "user",
      orgId: ORG_ID,
    });
    await db
      .insert(netdriveFiles)
      .values([
        fileRow(FILE_A, "a.bin"),
        fileRow(FILE_B, "b.bin"),
        fileRow(FILE_OTHER, "other.bin"),
      ]);
  });

  afterAll(async () => {
    await cleanup(db);
  });

  test("returns distinct mirror sites for the requested NetDrive files", async () => {
    await db
      .insert(netdriveTransferLog)
      .values([
        transferRow(FILE_A, "mirror", "site-alpha"),
        transferRow(FILE_A, "mirror", "site-alpha"),
        transferRow(FILE_B, "mirror", "site-beta"),
        transferRow(FILE_A, "upload", "site-upload-ignored"),
        transferRow(FILE_B, "mirror", null),
        transferRow(FILE_OTHER, "mirror", "site-other-ignored"),
      ]);

    const sites = await deriveDataSites(db, [FILE_A, FILE_B]);
    expect(sites.sort()).toEqual(["site-alpha", "site-beta"]);
  });
});

function fileRow(id: string, name: string): typeof netdriveFiles.$inferInsert {
  return {
    id,
    ownerId: USER_ID,
    path: `data-locality/${name}`,
    size: 1,
    sha256: "a".repeat(64),
    storageKey: `netdrive/data-locality/${name}`,
  };
}

function transferRow(
  fileId: string,
  direction: "upload" | "download" | "mirror",
  siteId: string | null,
): typeof netdriveTransferLog.$inferInsert {
  return {
    fileId,
    actorId: USER_ID,
    orgId: ORG_ID,
    direction,
    bytes: 1,
    siteId,
    occurredAt: new Date(),
  };
}

async function cleanup(db: PgDb): Promise<void> {
  const fileIds = [FILE_A, FILE_B, FILE_OTHER];
  await db.delete(netdriveTransferLog).where(inArray(netdriveTransferLog.fileId, fileIds));
  await db.delete(netdriveFiles).where(inArray(netdriveFiles.id, fileIds));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(orgs).where(eq(orgs.id, ORG_ID));
}
