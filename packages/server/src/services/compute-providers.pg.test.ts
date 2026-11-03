import { afterAll, describe, expect, test } from "bun:test";
import { auditLog, createPgDb, orgs, userOrgMemberships, users } from "@kuintessence/db";
import { ComputeProviderInputSchema } from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import type { OrganizationResourceScope } from "../middleware/organization-resource-scope";
import { ComputeProviderService } from "./compute-providers";

const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence", {
  max: 4,
});
const service = new ComputeProviderService(db);
const prefix = `provider-${crypto.randomUUID()}`;
const ids: string[] = [];
const userId = crypto.randomUUID();
const globalScope: OrganizationResourceScope = {
  userId,
  orgIds: null,
  key: "operator",
  canManage: true,
};
const input = (name: string) =>
  ComputeProviderInputSchema.parse({
    name,
    profile: { contactName: "Contact", email: "test@example.test" },
  });
afterAll(async () => {
  await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(auditLog).where(eq(auditLog.actor, userId));
  if (ids.length) await db.delete(orgs).where(inArray(orgs.id, ids));
});
describe("persistent compute providers", () => {
  test("CRUD, legacy defaults, scoped reads, ID tampering and safe cascade deletion", async () => {
    const a = await service.save(globalScope, null, input(`${prefix} A`));
    ids.push(a.id);
    const b = await service.save(globalScope, null, input(`${prefix} B`));
    ids.push(b.id);
    const local = { ...globalScope, orgIds: [a.id], key: `provider:${a.id}` };
    const list = await service.list(local, prefix, 1);
    expect(list.items.map((p) => p.id)).toEqual([a.id]);
    await expect(service.save(local, b.id, input("Hijack"))).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.remove(local, a.id)).rejects.toMatchObject({ statusCode: 403 });
    await service.save(local, a.id, input(`${prefix} edited`));
    expect((await service.list(globalScope, `${prefix} edited`, 1)).items[0]?.profile.email).toBe(
      "test@example.test",
    );
    await db.insert(users).values({ id: userId, email: `${prefix}@example.test` });
    await db.insert(userOrgMemberships).values({ userId, orgId: a.id, role: "admin" });
    await expect(service.remove(globalScope, a.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await db.select().from(userOrgMemberships).where(eq(userOrgMemberships.userId, userId)),
    ).toHaveLength(1);
    await service.remove(globalScope, b.id);
    expect((await service.list(globalScope, prefix, 1)).total).toBe(1);
    const audit = await db.select().from(auditLog).where(eq(auditLog.target, b.id));
    expect(audit.map((a) => a.action)).toContain("compute-provider.delete");
    await expect(service.save(globalScope, b.id, input("Missing"))).rejects.toMatchObject({
      statusCode: 404,
    });
    const [legacy] = await db
      .insert(orgs)
      .values({ name: `${prefix} %legacy` })
      .returning();
    if (!legacy) throw Error("Insert failed");
    ids.push(legacy.id);
    const found = await service.list(globalScope, `${prefix} %`, 1);
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.profile.description).toBe("");
    expect((await service.list(globalScope, prefix, 2)).items).toHaveLength(0);
  });
});
