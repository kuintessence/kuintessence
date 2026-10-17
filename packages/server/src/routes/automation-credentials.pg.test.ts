import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  auditLog,
  authzOutbox,
  automationCredentials,
  createPgDb,
  jobs,
  netdriveFiles,
  orgs,
  userOrgMemberships,
  users,
  workflowRuns,
} from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { AutomationScopeSchema, hashAutomationToken } from "../auth/automation-credentials";
import { authMiddleware } from "../middleware/auth";
import { automationScopeMiddleware } from "../middleware/automation-scope";
import { createErrorHandler } from "../middleware/error-handler";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { principalBinder } from "../middleware/principal-binder";
import { signToken } from "../services/auth";
import { createAuthRoutes } from "./auth";
import { createAutomationCredentialRoutes } from "./automation-credentials";

const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
const secret = "test-automation-auth-secret-not-for-production";
const adminId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const orgId = crypto.randomUUID();
const otherOrgId = crypto.randomUUID();
const accountIds: string[] = [adminId, otherId];
const resourceIds: string[] = [];
let adminToken: string;
let otherToken: string;
let downstreamCalls = 0;
const app = new Hono();
app.onError(createErrorHandler(pino({ level: "silent" })));
app.use("*", authMiddleware(secret, db), principalBinder(db), automationScopeMiddleware(db));
app.route("/api", createAutomationCredentialRoutes(db));
for (const path of [
  "/api/agents",
  "/api/software/agents/:id/installed",
  "/api/queues/visible",
  "/api/workflows/:id",
  "/api/jobs/:id",
  "/api/jobs/:id/logs",
  "/api/netdrive/files/:id",
  "/api/netdrive/files/:id/download-url",
  "/api/admin/queues",
]) {
  app.get(path, (c) => {
    downstreamCalls++;
    return c.json({ principal: c.get("principal" as never) as BoundPrincipal });
  });
}
for (const path of ["/api/workflows", "/api/workflows/:id/cancel", "/api/cp/software/operations"]) {
  app.post(path, (c) => {
    downstreamCalls++;
    return c.json({ ok: true });
  });
}
function request(path: string, token: string, body?: unknown, method?: string) {
  return app.request(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
type Created = {
  token: string;
  credential: { id: string; userId: string; expiresAt: string; orgId: string; scopes: string[] };
};
async function create(overrides: Record<string, unknown> = {}): Promise<Created> {
  const res = await request("/automation/credentials", adminToken, {
    name: "CI smoke",
    orgId,
    scopes: AutomationScopeSchema.options,
    ttlSeconds: 3600,
    ...overrides,
  });
  expect(res.status).toBe(201);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = (await res.json()) as Created;
  if (!accountIds.includes(body.credential.userId)) accountIds.push(body.credential.userId);
  return body;
}

beforeAll(async () => {
  await db.insert(orgs).values([
    { id: orgId, name: "automation-test" },
    { id: otherOrgId, name: "other-automation-test" },
  ]);
  await db.insert(users).values([
    { id: adminId, email: `${adminId}@test.invalid`, role: "platform_admin" },
    { id: otherId, email: `${otherId}@test.invalid`, role: "user" },
  ]);
  adminToken = await signToken(
    { sub: adminId, email: `${adminId}@test.invalid`, role: "platform_admin" },
    secret,
    3600,
  );
  otherToken = await signToken(
    { sub: otherId, email: `${otherId}@test.invalid`, role: "user" },
    secret,
    3600,
  );
});
afterAll(async () => {
  if (resourceIds.length) {
    await db.delete(netdriveFiles).where(inArray(netdriveFiles.id, resourceIds));
    await db.delete(jobs).where(inArray(jobs.id, resourceIds));
    await db.delete(workflowRuns).where(inArray(workflowRuns.id, resourceIds));
  }
  await db.delete(auditLog).where(inArray(auditLog.actor, accountIds));
  await db.delete(authzOutbox).where(inArray(authzOutbox.subjectId, accountIds));
  await db.delete(users).where(inArray(users.id, accountIds));
  await db.delete(orgs).where(inArray(orgs.id, [orgId, otherOrgId]));
});

test("administrator creates a separate least-privilege principal and only the digest is stored", async () => {
  const created = await create();
  expect(created.credential.userId).not.toBe(adminId);
  expect(created.credential).not.toHaveProperty("secretHash");
  const [stored] = await db
    .select()
    .from(automationCredentials)
    .where(eq(automationCredentials.id, created.credential.id));
  expect(stored?.secretHash).toBe(hashAutomationToken(created.token));
  const res = await request("/agents", created.token);
  expect(res.status).toBe(200);
  const { principal } = (await res.json()) as { principal: BoundPrincipal };
  expect(principal).toMatchObject({
    userId: created.credential.userId,
    role: "user",
    orgId,
    orgIds: [orgId],
    capabilities: [],
    sessionId: null,
  });
  const listed = await request(`/automation/credentials?orgId=${orgId}`, adminToken);
  const text = await listed.text();
  expect(text).not.toContain(created.token);
  expect(text).not.toContain(stored?.secretHash ?? "missing-hash");
  const audits = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.target, `automation_credential:${created.credential.id}`));
  expect(audits.map((row) => row.action)).toContain("automation.credential.use");
  expect(JSON.stringify(audits)).not.toContain(created.token);
  const tuples = await db
    .select()
    .from(authzOutbox)
    .where(eq(authzOutbox.subjectId, created.credential.userId));
  expect(tuples.map((row) => row.relation)).toEqual(["member", "member"]);
});

test("invalid, expired, revoked and cookie-delivered credentials cannot authenticate", async () => {
  const created = await create();
  const before = downstreamCalls;
  expect((await request("/agents", `${created.token.slice(0, -1)}!`)).status).toBe(401);
  expect((await request("/agents", `${created.token.slice(0, -8)}AAAAAAAA`)).status).toBe(401);
  const cookie = await app.request("/api/agents", {
    headers: { Cookie: `kq_access_token=${created.token}` },
  });
  expect(cookie.status).toBe(401);
  await db
    .update(automationCredentials)
    .set({ expiresAt: new Date(0) })
    .where(eq(automationCredentials.id, created.credential.id));
  expect((await request("/agents", created.token)).status).toBe(401);
  const valid = await create();
  expect(
    (await request(`/automation/credentials/${valid.credential.id}/revoke`, adminToken, {})).status,
  ).toBe(200);
  expect((await request("/agents", valid.token)).status).toBe(401);
  expect(downstreamCalls).toBe(before);
});

test("suspension, membership removal and role elevation disable the machine identity", async () => {
  const created = await create();
  const userId = created.credential.userId;
  await db.update(users).set({ suspended: true }).where(eq(users.id, userId));
  expect((await request("/agents", created.token)).status).toBe(401);
  await db
    .update(users)
    .set({ suspended: false, role: "platform_admin" })
    .where(eq(users.id, userId));
  expect((await request("/agents", created.token)).status).toBe(401);
  await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
  await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, userId));
  expect((await request("/agents", created.token)).status).toBe(401);
});

test("scope is an allowlist and cannot create credentials or invoke administrator mutations", async () => {
  const created = await create({ scopes: ["agents:read"] });
  expect((await request("/agents", created.token)).status).toBe(200);
  const before = downstreamCalls;
  for (const [path, body] of [
    ["/workflows", {}],
    ["/cp/software/operations", {}],
    ["/automation/credentials", {}],
    ["/admin/queues", undefined],
    ["/software/agents/test/installed", undefined],
    ["/queues/visible", undefined],
  ] as const) {
    expect((await request(path, created.token, body)).status).toBe(403);
  }
  expect(downstreamCalls).toBe(before);
  expect(
    (
      await request("/automation/credentials", otherToken, {
        name: "bad",
        orgId,
        scopes: ["agents:read"],
        ttlSeconds: 3600,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/automation/credentials", adminToken, {
        name: "bad",
        orgId,
        scopes: ["admin:*"],
        ttlSeconds: 3600,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/automation/credentials", adminToken, {
        name: "bad",
        orgId,
        scopes: ["agents:read"],
        ttlSeconds: 91 * 86400,
      })
    ).status,
  ).toBe(400);
});

test("own workflow/job/log/file reads succeed but cross-subject and cross-org resources never reach handlers", async () => {
  const a = await create();
  const b = await create();
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  resourceIds.push(runId, jobId, fileId);
  await db
    .insert(workflowRuns)
    .values({ id: runId, name: "run", submittedBy: a.credential.userId });
  await db.insert(jobs).values({
    id: jobId,
    name: "job",
    command: "true",
    cpus: 1,
    memoryMb: 128,
    submittedBy: a.credential.userId,
    orgId,
  });
  await db.insert(netdriveFiles).values({
    id: fileId,
    ownerId: a.credential.userId,
    path: "/test",
    size: 1,
    contentType: "text/plain",
    storageKey: "test",
    sha256: "a".repeat(64),
  });
  for (const [path, body] of [
    [`/workflows/${runId}`, undefined],
    [`/workflows/${runId}/cancel`, {}],
    [`/jobs/${jobId}`, undefined],
    [`/jobs/${jobId}/logs`, undefined],
    [`/netdrive/files/${fileId}`, undefined],
    [`/netdrive/files/${fileId}/download-url`, undefined],
  ] as const) {
    expect((await request(path, a.token, body)).status).toBe(200);
    const before = downstreamCalls;
    expect((await request(path, b.token, body)).status).toBe(404);
    expect(downstreamCalls).toBe(before);
  }
  await db.update(jobs).set({ orgId: otherOrgId }).where(eq(jobs.id, jobId));
  expect((await request(`/jobs/${jobId}`, a.token)).status).toBe(404);
  expect((await request(`/workflows/${crypto.randomUUID()}`, a.token)).status).toBe(404);
  const rotated = await create({ rotateFrom: a.credential.id });
  expect(rotated.credential.userId).toBe(a.credential.userId);
  await request(`/automation/credentials/${a.credential.id}/revoke`, adminToken, {});
  expect((await request(`/workflows/${runId}`, a.token)).status).toBe(401);
  expect((await request(`/workflows/${runId}`, rotated.token)).status).toBe(200);
  expect(
    (
      await request("/automation/credentials", adminToken, {
        name: "wrong-org",
        orgId: otherOrgId,
        scopes: ["agents:read"],
        ttlSeconds: 3600,
        rotateFrom: a.credential.id,
      })
    ).status,
  ).toBe(404);
});

test("service identities cannot exchange their identity for an unrestricted browser JWT", async () => {
  const created = await create();
  const jwt = await signToken(
    {
      sub: created.credential.userId,
      role: "user",
      email: `${created.credential.userId}@automation.invalid`,
    },
    secret,
    3600,
  );
  expect((await request("/agents", jwt)).status).toBe(401);
  const login = new Hono();
  login.onError(createErrorHandler(pino({ level: "silent" })));
  login.route(
    "/",
    createAuthRoutes(secret, db, { devLoginEnabled: true, ssoSecretWrappingKey: secret }),
  );
  const res = await login.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${created.credential.userId}@automation.invalid`,
      role: "platform_admin",
    }),
  });
  expect(res.status).toBe(403);
  const [account] = await db.select().from(users).where(eq(users.id, created.credential.userId));
  expect(account?.role).toBe("user");
  expect((await request("/agents", otherToken)).status).toBe(200);
});
