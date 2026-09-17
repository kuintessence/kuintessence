import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createPgDb,
  netdriveFiles,
  netdriveTransferLog,
  type PgDb,
  storageQuotaGrants,
  storageQuotaPolicies,
  storageQuotaRequests,
  users,
} from "@kuintessence/db";
import { ErrorCode } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { StorageQuotaService } from "./storage-quota";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const USER_ID = "00000000-0000-0000-0000-00000000d401";
const ADMIN_ID = "00000000-0000-0000-0000-00000000d402";
const AUTO_SCOPE_ID = "storage-quota-auto-test";
const LIMITED_SCOPE_ID = "storage-quota-limited-test";
const NOW = new Date("2026-07-20T08:00:00.000Z");

describe("StorageQuotaService", () => {
  let db: PgDb;
  let service: StorageQuotaService;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    service = new StorageQuotaService(db, () => NOW);
    await db
      .insert(users)
      .values([
        { id: USER_ID, email: "storage-quota-user@test", displayName: "quota user", role: "user" },
        {
          id: ADMIN_ID,
          email: "storage-quota-admin@test",
          displayName: "quota admin",
          role: "platform_admin",
        },
      ])
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    await db.delete(storageQuotaGrants).where(eq(storageQuotaGrants.userId, USER_ID));
    await db.delete(storageQuotaRequests).where(eq(storageQuotaRequests.userId, USER_ID));
    await db.delete(storageQuotaPolicies).where(eq(storageQuotaPolicies.scopeId, AUTO_SCOPE_ID));
    await db.delete(storageQuotaPolicies).where(eq(storageQuotaPolicies.scopeId, LIMITED_SCOPE_ID));
    await db.delete(netdriveTransferLog).where(eq(netdriveTransferLog.actorId, USER_ID));
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, USER_ID));
  });

  afterAll(async () => {
    await db.delete(storageQuotaGrants).where(eq(storageQuotaGrants.userId, USER_ID));
    await db.delete(storageQuotaRequests).where(eq(storageQuotaRequests.userId, USER_ID));
    await db.delete(storageQuotaPolicies).where(eq(storageQuotaPolicies.scopeId, AUTO_SCOPE_ID));
    await db.delete(storageQuotaPolicies).where(eq(storageQuotaPolicies.scopeId, LIMITED_SCOPE_ID));
    await db.delete(netdriveTransferLog).where(eq(netdriveTransferLog.actorId, USER_ID));
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, USER_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
    await db.delete(users).where(eq(users.id, ADMIN_ID));
  });

  test("reports live object usage and 30-day transfer metering", async () => {
    const [file] = await db
      .insert(netdriveFiles)
      .values({
        ownerId: USER_ID,
        path: "research/input.dat",
        size: 4096,
        sha256: "a".repeat(64),
        storageKey: `netdrive/${USER_ID}/research/input.dat`,
        createdAt: new Date("2026-07-19T08:00:00.000Z"),
      })
      .returning();
    expect(file).toBeDefined();
    await db.insert(netdriveTransferLog).values([
      { fileId: file?.id, actorId: USER_ID, direction: "upload", bytes: 4096, occurredAt: NOW },
      { fileId: file?.id, actorId: USER_ID, direction: "download", bytes: 1024, occurredAt: NOW },
    ]);

    const summary = await service.getSummary(USER_ID);

    expect(summary.usedBytes).toBe(4096);
    expect(summary.fileCount).toBe(1);
    expect(summary.uploadedBytes30d).toBe(4096);
    expect(summary.downloadedBytes30d).toBe(1024);
    expect(summary.storedByteHours30d).toBe(4096 * 24);
    expect(summary.quotaBytes).toBe(50 * 1024 * 1024 * 1024);
  });

  test("turns an approved request into an expiry-aware quota grant", async () => {
    const request = await service.createRequest(USER_ID, {
      scope: "cloud",
      scopeId: "global",
      requestedQuotaBytes: 80 * 1024 * 1024 * 1024,
      requestedExpiresAt: "2026-08-20T08:00:00.000Z",
      reason: "temporary dataset",
    });
    expect(request.status).toBe("pending");

    await service.decideRequest(request.id, ADMIN_ID, {
      decision: "approved",
      note: "approved for project window",
    });
    const summary = await service.getSummary(USER_ID);

    expect(summary.quotaBytes).toBe(80 * 1024 * 1024 * 1024);
    expect(summary.activeGrant?.source).toBe("request");
    expect(summary.activeGrant?.expiresAt).toBe("2026-08-20T08:00:00.000Z");
  });

  test("rejects writes whose projected usage exceeds the effective quota", async () => {
    await expect(
      service.assertCloudWriteAllowed(USER_ID, "research/oversized.bin", 51 * 1024 * 1024 * 1024),
    ).rejects.toMatchObject({ code: ErrorCode.STORAGE_QUOTA_EXCEEDED, statusCode: 413 });
  });

  test("auto-approves within an auto policy when no additional approval cap is set", async () => {
    await service.upsertPolicy(ADMIN_ID, {
      scope: "cluster_root",
      scopeId: AUTO_SCOPE_ID,
      defaultQuotaBytes: 1024,
      maxQuotaBytes: 4096,
      requestMode: "auto",
      autoApproveLimitBytes: null,
      enabled: true,
    });

    const request = await service.createRequest(USER_ID, {
      scope: "cluster_root",
      scopeId: AUTO_SCOPE_ID,
      requestedQuotaBytes: 2048,
      reason: "scratch workspace",
    });

    expect(request.status).toBe("approved");
    expect((await service.getSummary(USER_ID, "cluster_root", AUTO_SCOPE_ID)).quotaBytes).toBe(
      2048,
    );
  });

  test("rejects manual grants that have already expired", async () => {
    await expect(
      service.createGrant(ADMIN_ID, {
        userId: USER_ID,
        scope: "cloud",
        scopeId: "global",
        quotaBytes: 1024,
        expiresAt: "2026-07-20T07:59:59.000Z",
        note: "expired",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  test("rejects a second pending request for the same storage scope", async () => {
    const input = {
      scope: "cloud" as const,
      scopeId: "global",
      requestedQuotaBytes: 60 * 1024 * 1024 * 1024,
      reason: "first request",
    };
    await service.createRequest(USER_ID, input);

    await expect(
      service.createRequest(USER_ID, { ...input, reason: "duplicate request" }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR, statusCode: 409 });
  });

  test("rechecks the current policy limit before approving a pending request", async () => {
    const request = await service.createRequest(USER_ID, {
      scope: "cluster_root",
      scopeId: LIMITED_SCOPE_ID,
      requestedQuotaBytes: 4096,
      reason: "large workspace",
    });
    await service.upsertPolicy(ADMIN_ID, {
      scope: "cluster_root",
      scopeId: LIMITED_SCOPE_ID,
      defaultQuotaBytes: 1024,
      maxQuotaBytes: 2048,
      requestMode: "manual",
      autoApproveLimitBytes: null,
      enabled: true,
    });

    await expect(
      service.decideRequest(request.id, ADMIN_ID, {
        decision: "approved",
        note: "stale approval",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR, statusCode: 409 });
  });

  test("rejects a manual grant for an unknown user", async () => {
    await expect(
      service.createGrant(ADMIN_ID, {
        userId: "00000000-0000-0000-0000-00000000ffff",
        scope: "cloud",
        scopeId: "global",
        quotaBytes: 1024,
        note: "unknown user",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND, statusCode: 404 });
  });
});
