import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPgDb, users } from "@kuintessence/db";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminAuthzRoutes } from "./admin-authz";

const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
const prefix = `audit-search-${crypto.randomUUID()}`;
const ids = Array.from({ length: 502 }, () => crypto.randomUUID());
const app = new Hono();
app.onError(createErrorHandler(pino({ level: "silent" })));
app.use("*", async (c, next) => {
  c.set("user" as never, { id: ids[0], role: "platform_admin" });
  c.set("principal" as never, {
    userId: ids[0],
    role: "platform_admin",
    email: "admin@example.test",
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
  await db.insert(users).values(
    ids.map((id, i) => ({
      id,
      email: `${prefix}-${String(i).padStart(3, "0")}@example.test`,
      displayName: i === 501 ? `${prefix}-末位用户` : null,
    })),
  );
});
afterAll(async () => {
  await db.delete(users).where(inArray(users.id, ids));
  await db.$client.end();
});
test("users after the first 500 remain searchable and reachable by paging", async () => {
  const read = async (query: string) => {
    const r = await app.request(`/api/admin/authz/audit-capabilities?${query}`);
    expect(r.status).toBe(200);
    return r.json() as Promise<{
      data: { id: string; displayName: string | null }[];
      hasMore: boolean;
    }>;
  };
  const first = await read(`search=${prefix}&limit=500&offset=0`);
  expect(first.data).toHaveLength(500);
  expect(first.hasMore).toBe(true);
  const second = await read(`search=${prefix}&limit=500&offset=500`);
  expect(second.data).toHaveLength(2);
  expect(second.hasMore).toBe(false);
  expect(new Set([...first.data, ...second.data].map((x) => x.id)).size).toBe(502);
  const target = await read(`search=${encodeURIComponent(`${prefix}-末位用户`)}&limit=50`);
  expect(target.data.map((x) => x.id)).toEqual(ids.slice(501));
  expect((await app.request("/api/admin/authz/audit-capabilities?offset=-1")).status).toBe(400);
});
