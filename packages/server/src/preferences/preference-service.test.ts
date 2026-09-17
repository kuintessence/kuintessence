import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  auditLog,
  createPgDb,
  orgs,
  type PgDb,
  schedulingPreferences,
  users,
} from "@kuintessence/db";
import { and, eq, like } from "drizzle-orm";
import { PreferenceService } from "./preference-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
// Test isolation prefix: "pref-"

describe("PreferenceService", () => {
  let db: PgDb;
  let service: PreferenceService;
  let testOrgId: string;
  let testUserId: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    service = new PreferenceService(db);

    // Cleanup any leftover global pref from prior runs (only one global allowed)
    await db.delete(schedulingPreferences).where(eq(schedulingPreferences.scope, "global"));

    const [org] = await db.insert(orgs).values({ name: "pref-test-org" }).returning();
    if (!org) throw new Error("create org failed");
    testOrgId = org.id;

    const [user] = await db
      .insert(users)
      .values({ email: "pref-test@kuintessence.test", role: "user", orgId: testOrgId })
      .returning();
    if (!user) throw new Error("create user failed");
    testUserId = user.id;
  });

  afterAll(async () => {
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.actor, testUserId), eq(auditLog.action, "preferences.global.update")));
    await db.delete(schedulingPreferences).where(eq(schedulingPreferences.scope, "user"));
    await db.delete(schedulingPreferences).where(eq(schedulingPreferences.scope, "org"));
    await db.delete(schedulingPreferences).where(eq(schedulingPreferences.scope, "global"));
    await db.delete(users).where(eq(users.email, "pref-test@kuintessence.test"));
    await db.delete(orgs).where(like(orgs.name, "pref-test-%"));
  });

  test("upsert + load global", async () => {
    await service.upsertGlobal({ hardLimits: { maxCpus: 64 } });
    const loaded = await service.loadGlobal();
    expect(loaded?.hardLimits?.maxCpus).toBe(64);
  });

  test("upsert overwrites existing global", async () => {
    await service.upsertGlobal({ hardLimits: { maxCpus: 64 } });
    await service.upsertGlobal({ hardLimits: { maxCpus: 32 } });
    const loaded = await service.loadGlobal();
    expect(loaded?.hardLimits?.maxCpus).toBe(32);
  });

  test("audits a global update with canonical actor and platform scope", async () => {
    await service.upsertGlobal({ hardLimits: { maxCpus: 24 } }, testUserId);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actor, testUserId), eq(auditLog.action, "preferences.global.update")))
      .orderBy(auditLog.createdAt)
      .limit(1);
    expect(audit?.orgId).toBeNull();
    expect(audit?.target).toBe("scheduling_preferences:global");
    expect(audit?.diff).toMatchObject({ after: { hardLimits: { maxCpus: 24 } } });
  });

  test("rolls back the preference when the audit insert fails", async () => {
    await service.upsertGlobal({ hardLimits: { maxCpus: 20 } });

    await expect(
      service.upsertGlobal({ hardLimits: { maxCpus: 10 } }, "x".repeat(300)),
    ).rejects.toThrow();
    const loaded = await service.loadGlobal();
    expect(loaded?.hardLimits?.maxCpus).toBe(20);
  });

  test("upsert + load org pref", async () => {
    await service.upsertScoped("org", testOrgId, {
      hardLimits: { maxWallTimeSec: 3600 },
    });
    const loaded = await service.loadScoped("org", testOrgId);
    expect(loaded?.hardLimits?.maxWallTimeSec).toBe(3600);
  });

  test("upsert + load user pref", async () => {
    await service.upsertScoped("user", testUserId, {
      hardLimits: { maxCpus: 4 },
    });
    const loaded = await service.loadScoped("user", testUserId);
    expect(loaded?.hardLimits?.maxCpus).toBe(4);
  });

  test("resolveEffective merges global -> org -> user", async () => {
    await service.upsertGlobal({ hardLimits: { maxCpus: 64, maxWallTimeSec: 86400 } });
    await service.upsertScoped("org", testOrgId, {
      hardLimits: { maxWallTimeSec: 7200 },
      sitePolicy: { deniedAgents: ["bad-agent"] },
    });
    await service.upsertScoped("user", testUserId, {
      hardLimits: { maxCpus: 8 },
    });
    const eff = await service.resolveEffective(testOrgId, testUserId);
    expect(eff.hardLimits?.maxCpus).toBe(8);
    expect(eff.hardLimits?.maxWallTimeSec).toBe(7200);
    expect(eff.sitePolicy?.deniedAgents).toEqual(["bad-agent"]);
  });

  test("resolveEffective with no orgId still works", async () => {
    await service.upsertGlobal({ hardLimits: { maxCpus: 64 } });
    await service.upsertScoped("user", testUserId, { hardLimits: { maxCpus: 16 } });
    const eff = await service.resolveEffective(null, testUserId);
    expect(eff.hardLimits?.maxCpus).toBe(16);
  });

  test("resolveEffective when no prefs at all returns empty", async () => {
    // Wipe everything
    await db.delete(schedulingPreferences);
    const eff = await service.resolveEffective(testOrgId, testUserId);
    expect(eff).toEqual({});
  });
});
