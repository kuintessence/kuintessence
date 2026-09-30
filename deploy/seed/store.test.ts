import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createPgDb } from "../../packages/db/src/pg";
import {
  auditLog,
  orgs,
  userOrgMemberships,
  users,
  workflowTemplates,
} from "../../packages/db/src/pg/schema";
import { baseOrganization, checkpoints, demoProvider, demoTemplates, demoUsers } from "./catalog";
import { seedDatabase } from "./seed";
import { createSeedStore } from "./store";

const databaseUrl = process.env.SEED_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("seed PostgreSQL contracts (isolated migrated DB only)", () => {
  test("real writes roll back, adopt natural keys and preserve edits across reruns", async () => {
    if (!databaseUrl) throw new Error("SEED_TEST_DATABASE_URL is required");
    const db = createPgDb(databaseUrl);
    const rollback = new Error("Rollback seed integration fixture");
    try {
      await db.transaction(async (tx) => {
        expect(
          await tx
            .select()
            .from(auditLog)
            .where(inArray(auditLog.id, Object.values(checkpoints))),
        ).toHaveLength(0);
        expect(
          await tx
            .select()
            .from(orgs)
            .where(inArray(orgs.name, [baseOrganization.name, demoProvider.name])),
        ).toHaveLength(0);
        expect(
          await tx.select().from(users).where(inArray(users.email, demoUsers.map((u) => u.email))),
        ).toHaveLength(0);

        const [provider] = await tx
          .insert(orgs)
          .values({ name: demoProvider.name })
          .returning();
        const identity = demoUsers[2];
        if (!provider || !identity) throw new Error("Missing test fixture");
        const [existing] = await tx
          .insert(users)
          .values({ email: identity.email, role: "user", displayName: "Existing" })
          .returning();
        if (!existing) throw new Error("Missing existing user");
        await tx.insert(userOrgMemberships).values({
          userId: existing.id,
          orgId: provider.id,
          role: "viewer",
        });
        const store = createSeedStore(tx);
        expect(await seedDatabase(store, "demo")).toBe("applied");
        const [unchanged] = await tx.select().from(users).where(eq(users.id, existing.id));
        expect(unchanged).toEqual(existing);
        const [membership] = await tx
          .select()
          .from(userOrgMemberships)
          .where(eq(userOrgMemberships.userId, existing.id));
        expect(membership?.role).toBe("viewer");
        expect(
          await tx
            .select()
            .from(workflowTemplates)
            .where(inArray(workflowTemplates.id, demoTemplates().map((value) => value.id))),
        ).toHaveLength(2);

        await tx.update(orgs).set({ name: "Renamed provider" }).where(eq(orgs.id, provider.id));
        await tx
          .update(users)
          .set({ email: "renamed-scheduler@kuintessence.test", suspended: true })
          .where(eq(users.id, existing.id));
        expect(await seedDatabase(store, "demo")).toBe("skipped");
        expect(await seedDatabase(store, "minimal")).toBe("skipped");
        const [renamed] = await tx.select().from(users).where(eq(users.id, existing.id));
        expect(renamed?.email).toBe("renamed-scheduler@kuintessence.test");
        expect(renamed?.suspended).toBe(true);
        expect(await tx.select().from(orgs).where(eq(orgs.name, demoProvider.name))).toHaveLength(
          0,
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
      expect(
        await db
          .select()
          .from(auditLog)
          .where(inArray(auditLog.id, Object.values(checkpoints))),
      ).toHaveLength(0);
      expect(
        await db.select().from(orgs).where(eq(orgs.id, baseOrganization.id)),
      ).toHaveLength(0);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  });
});
