import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createPgDb,
  netdriveFiles,
  netdriveReplicas,
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
    expect(await deriveDataSites(db, [], USER_ID, ORG_ID)).toEqual([]);
    expect(await deriveDataSites(db, ["unregistered-input"], USER_ID, ORG_ID)).toEqual([]);
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

  test("only returns the owner's live, current and matching copies", async () => {
    const now = new Date();
    const row = { fileId: FILE_A, size: 1, sha256: "a".repeat(64), lastSeenAt: now };
    await db.insert(netdriveTransferLog).values(transferRow(FILE_A, "mirror", "history-only"));
    await db.insert(netdriveReplicas).values([
      { ...row, siteId: "alpha" },
      { ...row, siteId: "alpha", fileId: FILE_B },
      { ...row, siteId: "failed", status: "failed" },
      { ...row, siteId: "syncing", status: "syncing" },
      { ...row, siteId: "expired", lastSeenAt: new Date(now.getTime() - 86_400_000) },
      { ...row, siteId: "future", lastSeenAt: new Date(now.getTime() + 1000) },
      { ...row, siteId: "bad-digest", sha256: "b".repeat(64) },
      { ...row, siteId: "bad-size", size: 2 },
      { ...row, siteId: "other-file", fileId: FILE_OTHER },
    ]);
    expect(await deriveDataSites(db, [FILE_A, FILE_B], USER_ID, ORG_ID, now)).toEqual(["alpha"]);
    expect(await deriveDataSites(db, [FILE_A], ORG_ID, ORG_ID, now)).toEqual([]);
    await db.update(netdriveFiles).set({ deletedAt: now }).where(eq(netdriveFiles.id, FILE_A));
    expect(await deriveDataSites(db, [FILE_A], USER_ID, ORG_ID, now)).toEqual([]);
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
