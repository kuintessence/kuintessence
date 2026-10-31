import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  auditLog,
  authzOutbox,
  createPgDb,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminAuthzRoutes } from "./admin-authz";

const db = createPgDb(
  process.env.KQ_PG_URL ??
    process.env.DATABASE_URL ??
    "postgres://kq:kq@localhost:5432/kuintessence",
);
const organizationId = crypto.randomUUID();
const actorId = crypto.randomUUID();
const userIds = [...Array.from({ length: 23 }, () => crypto.randomUUID()), actorId];
const prefix = `membership-${organizationId}`;
const app = new Hono();
app.onError(createErrorHandler(pino({ level: "silent" })));
app.use("*", async (c, next) => {
  c.set("principal" as never, {
    userId: actorId,
    email: `${prefix}-23@example.test`,
    role: "platform_admin",
    orgId: null,
    orgIds: [],
    memberships: [],
  });
  await next();
});
app.route(
  "/api",
  createAdminAuthzRoutes(db, {
    authz: { mode: "off" } as AuthzService,
    rawTupleAdminEnabled: false,
  }),
);

beforeAll(async () => {
  await db.insert(orgs).values({ id: organizationId, name: `Research ${prefix}` });
  await db.insert(users).values(
    userIds.map((id, index) => ({
      id,
      email: `${prefix}-${index}@example.test`,
      displayName: `Researcher ${prefix} ${index}`,
      role: index === 23 ? "platform_admin" : "user",
    })),
  );
  await db
    .insert(userOrgMemberships)
    .values(
      userIds.slice(0, 23).map((userId) => ({ orgId: organizationId, userId, role: "member" })),
    );
});

afterAll(async () => {
  try {
    await db.delete(auditLog).where(eq(auditLog.actor, actorId));
    await db
      .delete(authzOutbox)
      .where(inArray(authzOutbox.subjectId, [...userIds, organizationId]));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, organizationId));
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(orgs).where(eq(orgs.id, organizationId));
  } finally {
    await db.$client.end();
  }
});

test("real member search and pagination return each matching member once", async () => {
  const first = await app.request(
    `/api/admin/authz/memberships?search=${prefix.toUpperCase()}&limit=20&offset=0`,
  );
  const second = await app.request(
    `/api/admin/authz/memberships?search=${prefix}&limit=20&offset=20`,
  );
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const a = (await first.json()) as {
    data: Array<{ id: string; orgName: string }>;
    hasMore: boolean;
  };
  const b = (await second.json()) as typeof a;
  expect(a.data).toHaveLength(20);
  expect(a.hasMore).toBe(true);
  expect(b.data).toHaveLength(3);
  expect(b.hasMore).toBe(false);
  expect(new Set([...a.data, ...b.data].map((row) => row.id)).size).toBe(23);
  expect(a.data.every((row) => row.orgName === `Research ${prefix}`)).toBe(true);
  const choices = await app.request(
    `/api/admin/authz/membership-options?user=${prefix}-23%40&organization=${prefix}`,
  );
  expect(choices.status).toBe(200);
  const result = (await choices.json()) as {
    data: {
      users: Array<{ id: string; displayName: string; email: string; role: string }>;
      organizations: Array<{ id: string; name: string }>;
    };
  };
  expect(result.data.users).toEqual([
    {
      id: actorId,
      email: `${prefix}-23@example.test`,
      displayName: `Researcher ${prefix} 23`,
      role: "platform_admin",
    },
  ]);
  expect(result.data.organizations).toEqual([{ id: organizationId, name: `Research ${prefix}` }]);
});

test("create, duplicate protection, update and removal preserve other organization memberships", async () => {
  const save = (userId: string, role: string, createOnly: boolean) =>
    app.request("/api/admin/authz/memberships", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, orgId: organizationId, role, createOnly }),
    });
  expect((await save(actorId, "admin", true)).status).toBe(200);
  expect((await save(actorId, "viewer", true)).status).toBe(409);
  const [member] = await db
    .select()
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.userId, actorId));
  expect(member?.role).toBe("admin");
  expect((await save(actorId, "operator", false)).status).toBe(200);
  const removed = await app.request(`/api/admin/authz/memberships/${actorId}/${organizationId}`, {
    method: "DELETE",
  });
  expect(removed.status).toBe(200);
  const remaining = await db
    .select()
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.orgId, organizationId));
  expect(remaining).toHaveLength(23);
  expect(remaining.every((row) => row.role === "member")).toBe(true);
  expect(await db.select().from(users).where(eq(users.id, actorId))).toHaveLength(1);
  const audits = await db.select().from(auditLog).where(eq(auditLog.actor, actorId));
  expect(audits.map((row) => row.action).sort()).toEqual([
    "authz.membership.delete",
    "authz.membership.upsert",
    "authz.membership.upsert",
  ]);
});
