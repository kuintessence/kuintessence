import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createPgDb,
  netdriveFiles,
  netdriveTransferLog,
  orgs,
  type PgDb,
  userOrgMemberships,
  users,
  workflowRuns,
} from "@kuintessence/db";
import { inArray } from "drizzle-orm";
import { MeteringWorkflowAttributionService } from "../metering-workflow-attribution";

const PG_URL =
  process.env.KQ_PG_URL ??
  process.env.DATABASE_URL ??
  "postgres://kq:kq@localhost:5432/kuintessence";
const describeIfPg = PG_URL ? describe : describe.skip;

const ORG_A = "00000000-0000-0000-0000-0000000ea1a0";
const ORG_B = "00000000-0000-0000-0000-0000000ea1b0";
const USER_A = "00000000-0000-0000-0000-0000000ea2a0";
const USER_B = "00000000-0000-0000-0000-0000000ea2b0";
const RUN_A = "00000000-0000-4000-8000-0000000ea3a0";
const RUN_B = "00000000-0000-4000-8000-0000000ea3b0";
const FILE_A = "00000000-0000-4000-8000-0000000ea4a0";
const FILE_EXTRA = "00000000-0000-4000-8000-0000000ea4a1";

describeIfPg("MeteringWorkflowAttributionService", () => {
  let db: PgDb;
  let svc: MeteringWorkflowAttributionService;

  beforeAll(() => {
    db = createPgDb(PG_URL);
    svc = new MeteringWorkflowAttributionService(db);
  });

  beforeEach(async () => {
    await cleanup();
    await db.insert(orgs).values([
      { id: ORG_A, name: "workflow-attribution-org-A" },
      { id: ORG_B, name: "workflow-attribution-org-B" },
    ]);
    await db.insert(users).values([
      {
        id: USER_A,
        email: "workflow-attribution-a@example.test",
        role: "user",
        orgId: ORG_A,
      },
      {
        id: USER_B,
        email: "workflow-attribution-b@example.test",
        role: "user",
        orgId: ORG_B,
      },
    ]);
    await db.insert(userOrgMemberships).values([
      { userId: USER_A, orgId: ORG_A, role: "member" },
      { userId: USER_B, orgId: ORG_B, role: "member" },
    ]);
    await db.insert(workflowRuns).values([
      { id: RUN_A, name: "workflow-attribution-run-A", submittedBy: USER_A },
      { id: RUN_B, name: "workflow-attribution-run-B", submittedBy: USER_B },
    ]);
    await db.insert(netdriveFiles).values([
      {
        id: FILE_A,
        ownerId: USER_A,
        path: "runs/a/input.bin",
        size: 40,
        sha256: "a".repeat(64),
        contentType: "application/octet-stream",
        storageKey: "netdrive/workflow-attribution/a",
      },
      {
        id: FILE_EXTRA,
        ownerId: USER_A,
        path: "runs/a/extra.bin",
        size: 90,
        sha256: "b".repeat(64),
        contentType: "application/octet-stream",
        storageKey: "netdrive/workflow-attribution/extra",
      },
    ]);
    await db.insert(netdriveTransferLog).values([
      {
        fileId: FILE_A,
        actorId: USER_A,
        orgId: ORG_A,
        direction: "upload",
        bytes: 5,
        workflowRunId: RUN_A,
        netdriveFileIds: [FILE_A],
      },
      {
        fileId: FILE_A,
        actorId: USER_A,
        orgId: ORG_A,
        direction: "download",
        bytes: 7,
        workflowRunId: RUN_A,
        netdriveFileIds: [FILE_A],
      },
      {
        actorId: USER_A,
        orgId: ORG_A,
        direction: "mirror",
        bytes: 11,
        workflowRunId: RUN_A,
        netdriveFileIds: [FILE_A, FILE_EXTRA],
      },
      {
        actorId: USER_B,
        orgId: ORG_B,
        direction: "download",
        bytes: 99,
        workflowRunId: RUN_B,
        netdriveFileIds: [],
      },
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await db
      .delete(netdriveTransferLog)
      .where(inArray(netdriveTransferLog.actorId, [USER_A, USER_B]));
    await db.delete(netdriveFiles).where(inArray(netdriveFiles.ownerId, [USER_A, USER_B]));
    await db.delete(workflowRuns).where(inArray(workflowRuns.id, [RUN_A, RUN_B]));
    await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.userId, [USER_A, USER_B]));
    await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
    await db.delete(orgs).where(inArray(orgs.id, [ORG_A, ORG_B]));
  }

  test("aggregates run-level NetDrive bytes and linked file storage", async () => {
    const result = await svc.getWorkflowNetDriveAttribution(RUN_A, {
      kind: "orgs",
      orgIds: [ORG_A],
    });

    expect(result?.workflowRunId).toBe(RUN_A);
    expect(result?.workflowName).toBe("workflow-attribution-run-A");
    expect(result?.transferCount).toBe(3);
    expect(result?.byDirection).toEqual({ upload: 5, download: 7, mirror: 11 });
    expect(result?.totalTransferBytes).toBe(23);
    expect(result?.networkEgressBytes).toBe(18);
    expect(result?.storageBytes).toBe(130);
    expect(result?.netdriveFileIds).toEqual([FILE_A, FILE_EXTRA]);
  });

  test("returns null for a workflow run outside the tenant scope", async () => {
    const result = await svc.getWorkflowNetDriveAttribution(RUN_B, {
      kind: "orgs",
      orgIds: [ORG_A],
    });

    expect(result).toBeNull();
  });
});
