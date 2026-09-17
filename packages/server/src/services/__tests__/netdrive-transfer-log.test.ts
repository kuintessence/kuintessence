// Integration tests for the `netdrive_transfer_log` ledger.
//
// Mirrors the `describe.if(KQ_PG_URL)` pattern used by every other PG-backed
// integration test in this package: the suite is skipped unless a Postgres
// instance is reachable and the migration set (≥ 0014) has been applied.
//
// Coverage:
//   1. NetDriveService appends an `upload` row on every successful commit.
//   2. NetDriveService appends a `download` row on every successful
//      `mintDownloadUrl` call.
//   3. Manual mirror-direction inserts (the future cross-site replicator
//      will hit the same path) sum correctly via `bytesTransferredSince`.
//   4. The cp-bindings adapter reads `sum(bytes)` filtered by `orgId` and
//      `occurred_at`, not from `netdrive_files`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createPgDb,
  jobs,
  netdriveFiles,
  netdriveTransferLog,
  orgs,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { PolicyStore } from "../../software-governance/policy-store";
import { FakeMinioBackend } from "../../storage/minio-client.test";
import { AgentManager } from "../agent-manager";
import { buildCpBindings } from "../cp-bindings";
import { NetDriveService } from "../netdrive";

// Default to the local dev PG when no env is set — matches the suite-wide
// convention so these DB tests RUN in the default `test:unit` flow instead of
// silently skipping.
const PG_URL =
  process.env.KQ_PG_URL ??
  process.env.DATABASE_URL ??
  "postgres://kq:kq@localhost:5432/kuintessence";
const describeIfPg = PG_URL ? describe : describe.skip;

const COMMIT_SECRET = "netdrive-transfer-log-test-secret-please-rotate-in-prod";

const ORG_A = "00000000-0000-0000-0000-0000000df1a0";
const ORG_B = "00000000-0000-0000-0000-0000000df1b0";
const USER_A = "00000000-0000-0000-0000-0000000df2a0";
const USER_B = "00000000-0000-0000-0000-0000000df2b0";
const JOB_A = "00000000-0000-4000-8000-0000000df3a0";

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describeIfPg("netdrive_transfer_log", () => {
  let db: PgDb;
  let svc: NetDriveService;
  let bindings: ReturnType<typeof buildCpBindings>;
  let fake: FakeMinioBackend;

  beforeAll(async () => {
    if (!PG_URL) throw new Error("Postgres URL is required for netdrive_transfer_log tests");
    db = createPgDb(PG_URL);
    fake = new FakeMinioBackend();
    svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const agentManager = new AgentManager(db);
    const policyStore = new PolicyStore(db);
    bindings = buildCpBindings({ db, agentManager, policyStore });
  });

  beforeEach(async () => {
    // FK order: transfer_log → netdrive_files → users → orgs.
    await db
      .delete(netdriveTransferLog)
      .where(inArray(netdriveTransferLog.actorId, [USER_A, USER_B]));
    await db.delete(netdriveFiles).where(inArray(netdriveFiles.ownerId, [USER_A, USER_B]));
    await db.delete(jobs).where(inArray(jobs.submittedBy, [USER_A, USER_B]));
    await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.userId, [USER_A, USER_B]));
    await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
    await db.delete(orgs).where(inArray(orgs.id, [ORG_A, ORG_B]));

    await db.insert(orgs).values([
      { id: ORG_A, name: "transfer-log-test-org-A" },
      { id: ORG_B, name: "transfer-log-test-org-B" },
    ]);
    await db.insert(users).values([
      {
        id: USER_A,
        email: "transfer-log-a@example.test",
        displayName: "Transfer A",
        role: "user",
        orgId: ORG_A,
      },
      {
        id: USER_B,
        email: "transfer-log-b@example.test",
        displayName: "Transfer B",
        role: "user",
        orgId: ORG_B,
      },
    ]);
    await db.insert(userOrgMemberships).values([
      { userId: USER_A, orgId: ORG_A, role: "member" },
      { userId: USER_B, orgId: ORG_B, role: "member" },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(netdriveTransferLog)
      .where(inArray(netdriveTransferLog.actorId, [USER_A, USER_B]));
    await db.delete(netdriveFiles).where(inArray(netdriveFiles.ownerId, [USER_A, USER_B]));
    await db.delete(jobs).where(inArray(jobs.submittedBy, [USER_A, USER_B]));
    await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.userId, [USER_A, USER_B]));
    await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
    await db.delete(orgs).where(inArray(orgs.id, [ORG_A, ORG_B]));
  });

  async function uploadOnce(ownerId: string, path: string, body: string): Promise<string> {
    const minted = await svc.mintUploadUrl(ownerId, {
      path,
      size: body.length,
      contentType: "application/octet-stream",
    });
    await fake.putBlob(minted.storageKey, Buffer.from(body), "application/octet-stream");
    const file = await svc.commitFile(ownerId, {
      path,
      size: body.length,
      contentType: "application/octet-stream",
      sha256: await sha256Hex(body),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });
    return file.id;
  }

  test("commitFile appends a single 'upload' row keyed by actor + org", async () => {
    await uploadOnce(USER_A, "uploads/one.bin", "hello-netdrive");

    const rows = await db
      .select()
      .from(netdriveTransferLog)
      .where(eq(netdriveTransferLog.actorId, USER_A));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.direction).toBe("upload");
    expect(row?.bytes).toBe("hello-netdrive".length);
    expect(row?.orgId).toBe(ORG_A);
    expect(row?.fileId).not.toBeNull();
    expect(row?.siteId).toBeNull();
  });

  test("mintDownloadUrl appends a 'download' row with the file's full size", async () => {
    const fileId = await uploadOnce(USER_A, "uploads/two.bin", "abc");
    await svc.mintDownloadUrl(USER_A, fileId);

    const rows = await db
      .select()
      .from(netdriveTransferLog)
      .where(eq(netdriveTransferLog.actorId, USER_A));
    const directions = rows.map((r) => r.direction).sort();
    expect(directions).toEqual(["download", "upload"]);
    const downloadRow = rows.find((r) => r.direction === "download");
    expect(downloadRow?.bytes).toBe("abc".length);
    expect(downloadRow?.orgId).toBe(ORG_A);
  });

  test("mintDownloadUrl records precise job and file attribution when provided", async () => {
    await db.insert(jobs).values({
      id: JOB_A,
      name: "transfer-log-job",
      command: "true",
      cpus: 1,
      memoryMb: 1024,
      submittedBy: USER_A,
      orgId: ORG_A,
    });
    const fileId = await uploadOnce(USER_A, "uploads/job-linked.bin", "linked");

    await svc.mintDownloadUrl(USER_A, fileId, {
      jobId: JOB_A,
      netdriveFileIds: [fileId],
    });

    const rows = await db
      .select()
      .from(netdriveTransferLog)
      .where(eq(netdriveTransferLog.jobId, JOB_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe("download");
    expect(rows[0]?.fileId).toBe(fileId);
    expect(rows[0]?.netdriveFileIds).toEqual([fileId]);
  });

  test("bytesTransferredSince sums across directions and scopes by org", async () => {
    // Org A: one 5-byte upload, one 5-byte download (same file).
    const aFile = await uploadOnce(USER_A, "uploads/a.bin", "AAAAA");
    await svc.mintDownloadUrl(USER_A, aFile);
    // Org B: one 3-byte upload only.
    await uploadOnce(USER_B, "uploads/b.bin", "BBB");
    // Manual mirror row (future replicator). Belongs to org A.
    await db.insert(netdriveTransferLog).values({
      fileId: aFile,
      actorId: USER_A,
      orgId: ORG_A,
      direction: "mirror",
      bytes: 5,
      siteId: "site-beta",
    });

    const since = new Date(Date.now() - 60_000);

    const orgABytes = await bindings.netdrive.bytesTransferredSince([ORG_A], since);
    // 5 (upload) + 5 (download) + 5 (mirror)
    expect(orgABytes).toBe(15);

    const orgBBytes = await bindings.netdrive.bytesTransferredSince([ORG_B], since);
    expect(orgBBytes).toBe(3);

    const platformBytes = await bindings.netdrive.bytesTransferredSince([], since);
    // Whole table can also contain rows from sibling tests in CI; assert ≥ 18
    // rather than exact equality so we don't get flaky cross-suite reads.
    expect(platformBytes).toBeGreaterThanOrEqual(18);
  });

  test("bytesTransferredSince ignores rows older than `since`", async () => {
    const aFile = await uploadOnce(USER_A, "uploads/old.bin", "old");
    // Backdate the upload row so it's outside the window.
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db
      .update(netdriveTransferLog)
      .set({ occurredAt: longAgo })
      .where(eq(netdriveTransferLog.fileId, aFile));

    const recent = new Date(Date.now() - 60_000);
    const orgABytes = await bindings.netdrive.bytesTransferredSince([ORG_A], recent);
    expect(orgABytes).toBe(0);
  });
});
