import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import { AUTH_SESSION_COOKIE } from "../auth/session-cookie";
import type { AuthzService } from "../authz/service";
import { AgentDispatcher } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import { signToken } from "../services/auth";
import { type SshCredentials, SshGateway } from "../services/ssh-gateway";
import {
  authorizeSshThroughSpice,
  createSshRoutes,
  parseResizeFrame,
  sshActorLookupKey,
} from "./ssh";

const JWT_SECRET = "test-ssh-secret-do-not-use-in-prod";
const silent = pino({ level: "silent" });

// -----------------------------------------------------------------------------
// Build a fake PgDb that captures audit-log inserts but never touches Postgres.
// We only exercise the `.insert(...).values(...)` chain the SSH route uses.
// -----------------------------------------------------------------------------
interface InsertedRow {
  actor: string;
  action: string;
  target: string;
  diff?: unknown;
}

function fakeDb(
  boundActor: { userId: string; role: string; email?: string } | null = null,
  membershipOrgIds: string[] = [],
): {
  db: PgDb;
  rows: InsertedRow[];
} {
  const rows: InsertedRow[] = [];
  const db = {
    insert: (_table: unknown) => ({
      values: async (row: InsertedRow) => {
        rows.push(row);
      },
    }),
    select: (fields?: Record<string, unknown>) => {
      const rowsForSelection = async () => {
        if (fields && "orgId" in fields) {
          return membershipOrgIds.map((orgId) => ({ orgId }));
        }
        return boundActor
          ? [
              {
                id: boundActor.userId,
                role: boundActor.role,
                email: boundActor.email ?? `${boundActor.userId}@bound.test`,
              },
            ]
          : [];
      };
      const whereChain = {
        limit: rowsForSelection,
        orderBy: () => ({ limit: rowsForSelection }),
      };
      const fromChain = {
        where: () => whereChain,
        innerJoin: () => ({ where: () => whereChain }),
      };
      return { from: () => fromChain };
    },
  } as unknown as PgDb;
  return { db, rows };
}

function mockChannel() {
  const messages: unknown[] = [];
  return {
    messages,
    push: (m: unknown) => messages.push(m),
    close: () => {},
  };
}

function buildApp(opts: {
  agentOnline: boolean;
  credentials?: SshCredentials | null;
  resolveError?: Error;
  providerOrgId?: string | null;
  userOrgIds?: string[];
  providerAdminOrgIds?: string[];
  membershipOrgIds?: string[];
  useDefaultOrgResolver?: boolean;
  authz?: AuthzService;
  boundActor?: { userId: string; role: string; email?: string } | null;
}) {
  const dispatcher = new AgentDispatcher();
  if (opts.agentOnline) {
    dispatcher.register("agent-1", mockChannel() as never);
  }
  const gateway = new SshGateway({
    dispatcher,
    logger: silent,
    newSessionId: () => "fixed-uuid",
  });
  const { db, rows } = fakeDb(opts.boundActor, opts.membershipOrgIds);
  const app = new Hono();
  app.onError(createErrorHandler(silent));
  const orgResolver = opts.useDefaultOrgResolver
    ? {}
    : { resolveUserOrgIds: async () => opts.userOrgIds ?? [] };
  app.route(
    "/api/ssh",
    createSshRoutes({
      db,
      jwtSecret: JWT_SECRET,
      gateway,
      resolveAgentProviderOrg: async () => opts.providerOrgId ?? null,
      resolveUserProviderAdminOrgIds: async () => opts.providerAdminOrgIds ?? [],
      resolveCredentials: () => {
        if (opts.resolveError) throw opts.resolveError;
        return opts.credentials ?? null;
      },
      authz: opts.authz,
      ...orgResolver,
    }),
  );
  return { app, gateway, dispatcher, rows };
}

describe("SSH routes — auth + RBAC", () => {
  const validCreds: SshCredentials = {
    host: "login01",
    port: 22,
    username: "alice",
    password: "secret",
  };

  test("rejects /api/ssh/sessions/:agentId without a token (401)", async () => {
    const { app } = buildApp({ agentOnline: true, credentials: validCreds });
    const res = await app.request("/api/ssh/sessions/agent-1", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects with an invalid token (401)", async () => {
    const { app } = buildApp({ agentOnline: true, credentials: validCreds });
    const res = await app.request("/api/ssh/sessions/agent-1?token=not-a-real-jwt", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects regular user with 403", async () => {
    const userToken = await signToken(
      { sub: "uid", role: "user", email: "u@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({ agentOnline: true, credentials: validCreds });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${userToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("stale JWT platform_admin cannot open SSH when Server role is user", async () => {
    const staleAdminToken = await signToken(
      { sub: "uid", role: "platform_admin", email: "a@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      boundActor: { userId: "server-user-1", role: "user" },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${staleAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("stale JWT platform_admin cannot open SSH without a Server binding", async () => {
    const staleAdminToken = await signToken(
      { sub: "uid", role: "platform_admin", email: "a@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      boundActor: null,
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${staleAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("returns 404 when agent has no configured credentials", async () => {
    const adminToken = await signToken(
      { sub: "uid", role: "platform_admin", email: "a@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: null,
      boundActor: { userId: "server-admin-1", role: "platform_admin" },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${adminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });

  test("returns a clear 502 (not an opaque 500) when credential decryption fails", async () => {
    const adminToken = await signToken(
      { sub: "uid", role: "platform_admin", email: "a@kq.test" },
      JWT_SECRET,
      300,
    );
    // Simulate the AES-GCM auth-tag mismatch a rotated wrapping key produces.
    const { app } = buildApp({
      agentOnline: true,
      resolveError: new Error("Unsupported state or unable to authenticate data"),
      boundActor: { userId: "server-admin-1", role: "platform_admin" },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${adminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(JSON.stringify(body)).toContain("could not be decrypted");
  });

  test("returns 404 when agent is offline", async () => {
    const adminToken = await signToken(
      { sub: "uid", role: "platform_admin", email: "a@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: false,
      credentials: validCreds,
      boundActor: { userId: "server-admin-1", role: "platform_admin" },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${adminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });

  test("platform_admin with online agent passes through and writes audit row", async () => {
    const actorUserId = "00000000-0000-4000-8000-00000000d001";
    const adminToken = await signToken(
      { sub: "casdoor|ssh-open-actor", role: "platform_admin", email: "a@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app, rows } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      boundActor: { userId: actorUserId, role: "platform_admin" },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${adminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    // Test path returns 200 once the auth/RBAC + dispatcher gate has passed.
    expect([200, 101, 426, 500]).toContain(res.status);
    const openAudit = rows.find((r) => r.action === "ssh.session_open");
    expect(openAudit).toBeDefined();
    expect(openAudit?.actor).toBe(actorUserId);
    expect(openAudit?.actor).not.toBe("a@kq.test");
  });

  test("org_admin can open SSH for its provider-owned agent", async () => {
    const orgAdminToken = await signToken(
      { sub: "uid", role: "org_admin", email: "o@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      providerOrgId: "org-a",
      userOrgIds: ["org-a"],
      boundActor: { userId: "server-org-admin-1", role: "org_admin" },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${orgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("provider owner membership can open SSH without a technical admin role", async () => {
    const userToken = await signToken(
      { sub: "uid", role: "user", email: "owner@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      providerOrgId: "org-a",
      userOrgIds: ["org-a"],
      providerAdminOrgIds: ["org-a"],
      boundActor: { userId: "server-provider-owner-1", role: "user" },
    });

    const res = await app.request(`/api/ssh/sessions/agent-1?token=${userToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("org_admin SSH local scope uses canonical user membership instead of token email", async () => {
    const actorUserId = "00000000-0000-4000-8000-000000000001";
    const orgAdminToken = await signToken(
      { sub: actorUserId, role: "org_admin", email: "stale-email@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      providerOrgId: "org-a",
      membershipOrgIds: ["org-a"],
      useDefaultOrgResolver: true,
      boundActor: { userId: actorUserId, role: "org_admin" },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${orgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("org_admin cannot open SSH for another provider org's agent", async () => {
    const orgAdminToken = await signToken(
      { sub: "uid", role: "org_admin", email: "o@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      providerOrgId: "org-a",
      userOrgIds: ["org-b"],
      boundActor: { userId: "server-org-admin-1", role: "org_admin" },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${orgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });

  test("stale JWT platform_admin cannot bypass SSH provider ownership when Server role is org_admin", async () => {
    const staleAdminToken = await signToken(
      { sub: "uid", role: "platform_admin", email: "old-admin@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      providerOrgId: "org-a",
      userOrgIds: ["org-b"],
      boundActor: {
        userId: "server-org-admin-1",
        role: "org_admin",
        email: "bound-org-admin@kq.test",
      },
    });
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${staleAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });

  test("Authorization Bearer header is accepted (kq CLI path)", async () => {
    const adminToken = await signToken(
      { sub: "uid", role: "platform_admin", email: "a@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      boundActor: { userId: "server-admin-1", role: "platform_admin" },
    });
    const res = await app.request("/api/ssh/sessions/agent-1", {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("auth session cookie is accepted for browser SSH upgrades", async () => {
    const adminToken = await signToken(
      { sub: "uid", role: "platform_admin", email: "a@kq.test" },
      JWT_SECRET,
      300,
    );
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      boundActor: { userId: "server-admin-1", role: "platform_admin" },
    });
    const res = await app.request("/api/ssh/sessions/agent-1", {
      headers: {
        Upgrade: "websocket",
        Cookie: `${AUTH_SESSION_COOKIE}=${adminToken}`,
      },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("returns 429 when canonical caller is at the concurrent-session cap", async () => {
    const actorUserId = "server-admin-1";
    const adminToken = await signToken(
      { sub: "aid", role: "platform_admin", email: "rotated-email@kq.test" },
      JWT_SECRET,
      300,
    );
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel() as never);
    let n = 0;
    const gateway = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      limits: { maxPerUserAgent: 1 },
    });
    // Pre-fill the cap by canonical Server user id; a changed token email must not bypass it.
    gateway.openSession({
      agentId: "agent-1",
      ws: { send() {}, close() {} },
      credentials: validCreds,
      user: actorUserId,
      actorUserId,
    });
    const { db } = fakeDb({ userId: actorUserId, role: "platform_admin" });
    const app = new Hono();
    app.onError(createErrorHandler(silent));
    app.route(
      "/api/ssh",
      createSshRoutes({
        db,
        jwtSecret: JWT_SECRET,
        gateway,
        resolveAgentProviderOrg: async () => null,
        resolveCredentials: () => validCreds,
      }),
    );
    const res = await app.request(`/api/ssh/sessions/agent-1?token=${adminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(429);
  });
});

describe("SSH SpiceDB authorization", () => {
  const validCreds: SshCredentials = {
    host: "login01",
    port: 22,
    username: "alice",
    password: "secret",
  };

  test("enforce rejects before resolving SSH credentials", async () => {
    const userId = "00000000-0000-4000-8000-000000000009";
    const userToken = await signToken(
      { sub: userId, role: "user", email: "user@kq.test" },
      JWT_SECRET,
      300,
    );
    const writes: unknown[][] = [];
    const authz = {
      mode: "enforce",
      writeRelationships: async (tuples: unknown[]) => {
        writes.push(tuples);
      },
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      },
    };
    const { app } = buildApp({
      agentOnline: true,
      resolveError: new Error("credential resolver must not run"),
      authz: authz as unknown as AuthzService,
      boundActor: { userId, role: "user", email: "user@kq.test" },
    });

    const response = await app.request(`/api/ssh/sessions/agent-1?token=${userToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(writes).toHaveLength(2);
    expect(
      writes[0]?.every((tuple) => (tuple as { operation?: string }).operation === "create"),
    ).toBe(true);
    expect(
      writes[1]?.every((tuple) => (tuple as { operation?: string }).operation === "delete"),
    ).toBe(true);
  });

  test("enforce cleans provisional authorization when credentials are missing", async () => {
    const userId = "00000000-0000-4000-8000-000000000010";
    const adminToken = await signToken(
      { sub: userId, role: "platform_admin", email: "admin@kq.test" },
      JWT_SECRET,
      300,
    );
    const writes: unknown[][] = [];
    const authz = {
      mode: "enforce",
      writeRelationships: async (tuples: unknown[]) => {
        writes.push(tuples);
      },
      requirePermission: async () => {},
    };
    const { app } = buildApp({
      agentOnline: true,
      credentials: null,
      authz: authz as unknown as AuthzService,
      boundActor: { userId, role: "platform_admin", email: "admin@kq.test" },
    });

    const response = await app.request(`/api/ssh/sessions/agent-1?token=${adminToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(404);
    expect(writes).toHaveLength(2);
    expect(
      writes[1]?.every((tuple) => (tuple as { operation?: string }).operation === "delete"),
    ).toBe(true);
  });

  test("shadow cleans provisional authorization after local denial", async () => {
    const userId = "00000000-0000-4000-8000-000000000011";
    const userToken = await signToken(
      { sub: userId, role: "user", email: "user@kq.test" },
      JWT_SECRET,
      300,
    );
    const writes: unknown[][] = [];
    const authz = {
      mode: "shadow",
      writeRelationships: async (tuples: unknown[]) => {
        writes.push(tuples);
      },
      shadowCheck: async () => ({ allowed: false }),
    };
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      authz: authz as unknown as AuthzService,
      boundActor: { userId, role: "user", email: "user@kq.test" },
    });

    const response = await app.request(`/api/ssh/sessions/agent-1?token=${userToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(writes).toHaveLength(2);
    expect(
      writes[1]?.every((tuple) => (tuple as { operation?: string }).operation === "delete"),
    ).toBe(true);
  });

  test("enforce delegates SSH open to ssh_session#open instead of local provider ownership", async () => {
    const orgAdminToken = await signToken(
      {
        sub: "00000000-0000-4000-8000-000000000001",
        role: "org_admin",
        email: "stale-ssh-token@kq.test",
      },
      JWT_SECRET,
      300,
    );
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      writeRelationships: async (tuples: unknown[]) => {
        calls.push({ kind: "writeRelationships", tuples });
      },
      enqueueMany: async (tuples: unknown[]) => {
        calls.push({ kind: "enqueueMany", tuples });
      },
      requirePermission: async (input: unknown, isPlatformAdmin: boolean) => {
        calls.push({ kind: "requirePermission", input, isPlatformAdmin });
      },
    };
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      providerOrgId: "org-a",
      userOrgIds: ["org-b"],
      authz: authz as unknown as AuthzService,
      boundActor: {
        userId: "00000000-0000-4000-8000-000000000001",
        role: "org_admin",
        email: "bound-ssh@kq.test",
      },
    });

    const res = await app.request(`/api/ssh/sessions/agent-1?token=${orgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(res.status).toBe(200);
    expect(calls.some((call) => JSON.stringify(call).includes('"permission":"open"'))).toBe(true);
    const permissionCall = calls.find(
      (call) => (call as { kind?: string }).kind === "requirePermission",
    ) as { input?: { actorEmail?: string } } | undefined;
    expect(permissionCall?.input?.actorEmail).toBe("bound-ssh@kq.test");
    const enqueueCall = calls.find((call) => (call as { kind?: string }).kind === "enqueueMany") as
      | {
          tuples: Array<{
            operation: string;
            resource: { type: string; id: string };
            relation: string;
            subject: { type: string; id: string };
          }>;
        }
      | undefined;
    expect(enqueueCall?.tuples.map((tuple) => tuple.relation)).toEqual([
      "agent",
      "opener",
      "platform",
    ]);
    expect(enqueueCall?.tuples[0]).toMatchObject({
      operation: "create",
      resource: { type: "ssh_session" },
      subject: { type: "agent", id: "agent-1" },
    });
    expect(enqueueCall?.tuples[1]).toMatchObject({
      operation: "create",
      resource: { type: "ssh_session" },
      subject: { type: "user", id: "00000000-0000-4000-8000-000000000001" },
    });
    expect(enqueueCall?.tuples[2]).toMatchObject({
      operation: "create",
      resource: { type: "ssh_session" },
      subject: { type: "platform", id: "root" },
    });
  });

  test("shadow fails closed without a canonical SSH actor", async () => {
    const orgAdminToken = await signToken(
      { sub: "uid", role: "org_admin", email: "o@kq.test" },
      JWT_SECRET,
      300,
    );
    const shadowInputs: unknown[] = [];
    const authz = {
      mode: "shadow",
      writeRelationships: async () => {},
      shadowCheck: async (input: unknown) => {
        shadowInputs.push(input);
        return { allowed: true };
      },
    };
    const { app } = buildApp({
      agentOnline: true,
      credentials: validCreds,
      providerOrgId: "org-a",
      userOrgIds: ["org-b"],
      authz: authz as unknown as AuthzService,
    });

    const res = await app.request(`/api/ssh/sessions/agent-1?token=${orgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(res.status).toBe(403);
    expect(shadowInputs).toEqual([]);
  });

  test("checks ssh_session#open with a pre-created session agent relation", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      writeRelationships: async (tuples: unknown[]) => {
        calls.push({ kind: "writeRelationships", tuples });
      },
      requirePermission: async (input: unknown, isPlatformAdmin: boolean) => {
        calls.push({ kind: "requirePermission", input, isPlatformAdmin });
      },
    };

    await authorizeSshThroughSpice(
      authz as unknown as AuthzService,
      { sub: "subject-1", email: "admin@example.com", role: "platform_admin" },
      "user-1",
      "agent-1",
      "session-1",
      true,
      null,
      "bound-admin@example.com",
    );

    expect(calls).toEqual([
      {
        kind: "writeRelationships",
        tuples: [
          {
            operation: "create",
            resource: { type: "ssh_session", id: "session-1" },
            relation: "agent",
            subject: { type: "agent", id: "agent-1" },
          },
          {
            operation: "create",
            resource: { type: "ssh_session", id: "session-1" },
            relation: "platform",
            subject: { type: "platform", id: "root" },
          },
        ],
      },
      {
        kind: "requirePermission",
        input: {
          actorUserId: "user-1",
          actorEmail: "bound-admin@example.com",
          resource: { type: "ssh_session", id: "session-1" },
          permission: "open",
          subject: { type: "user", id: "user-1" },
          context: { route: "GET /ssh/sessions/:agentId" },
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("ssh_session#open degraded fallback uses bound Server role", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      writeRelationships: async (tuples: unknown[]) => {
        calls.push({ kind: "writeRelationships", tuples });
      },
      requirePermission: async (input: unknown, isPlatformAdmin: boolean) => {
        calls.push({ kind: "requirePermission", input, isPlatformAdmin });
      },
    };

    await authorizeSshThroughSpice(
      authz as unknown as AuthzService,
      { sub: "subject-1", email: "admin@example.com", role: "platform_admin" },
      "user-1",
      "agent-1",
      "session-1",
      true,
      "user",
    );

    expect(calls).toContainEqual(
      expect.objectContaining({
        kind: "requirePermission",
        isPlatformAdmin: false,
      }),
    );
  });

  test("ssh_session#open fails closed in enforce mode without canonical user id", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      writeRelationships: async (tuples: unknown[]) => {
        calls.push({ kind: "writeRelationships", tuples });
      },
      requirePermission: async (input: unknown) => {
        calls.push({ kind: "requirePermission", input });
      },
    };

    await expect(
      authorizeSshThroughSpice(
        authz as unknown as AuthzService,
        { sub: "subject-1", email: "admin@example.com", role: "platform_admin" },
        null,
        "agent-1",
        "session-1",
        false,
      ),
    ).rejects.toThrow("Authorization principal is not bound");

    expect(calls).toEqual([]);
  });

  test("cleans up the temporary session relation when enforce denies", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      writeRelationships: async (tuples: unknown[]) => {
        calls.push({ kind: "writeRelationships", tuples });
      },
      requirePermission: async () => {
        throw new Error("denied");
      },
    };

    await expect(
      authorizeSshThroughSpice(
        authz as unknown as AuthzService,
        { sub: "subject-1", email: "admin@example.com", role: "platform_admin" },
        "user-1",
        "agent-1",
        "session-1",
        false,
      ),
    ).rejects.toThrow("denied");

    expect(calls).toEqual([
      {
        kind: "writeRelationships",
        tuples: [
          {
            operation: "create",
            resource: { type: "ssh_session", id: "session-1" },
            relation: "agent",
            subject: { type: "agent", id: "agent-1" },
          },
          {
            operation: "create",
            resource: { type: "ssh_session", id: "session-1" },
            relation: "platform",
            subject: { type: "platform", id: "root" },
          },
        ],
      },
      {
        kind: "writeRelationships",
        tuples: [
          {
            operation: "delete",
            resource: { type: "ssh_session", id: "session-1" },
            relation: "agent",
            subject: { type: "agent", id: "agent-1" },
          },
          {
            operation: "delete",
            resource: { type: "ssh_session", id: "session-1" },
            relation: "platform",
            subject: { type: "platform", id: "root" },
          },
        ],
      },
    ]);
  });
});

describe("SSH canonical actor lookup", () => {
  test("uses email for opaque OIDC subjects", () => {
    expect(sshActorLookupKey({ sub: "casdoor-opaque-subject", email: "user@example.com" })).toBe(
      "user@example.com",
    );
  });

  test("keeps local UUID subjects for dev and legacy clients", () => {
    expect(
      sshActorLookupKey({
        sub: "11111111-1111-4111-8111-111111111111",
        email: "user@example.com",
      }),
    ).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("parseResizeFrame", () => {
  test("accepts a well-formed resize control frame", () => {
    expect(parseResizeFrame(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  test("rejects binary stdin (non-string)", () => {
    expect(parseResizeFrame(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseResizeFrame(new ArrayBuffer(4))).toBeNull();
  });

  test("rejects non-resize JSON, malformed JSON, and bad dimensions", () => {
    expect(parseResizeFrame(JSON.stringify({ type: "data", cols: 80, rows: 24 }))).toBeNull();
    expect(parseResizeFrame("not json")).toBeNull();
    expect(parseResizeFrame(JSON.stringify({ type: "resize", cols: 80 }))).toBeNull();
    expect(parseResizeFrame(JSON.stringify({ type: "resize", cols: 0, rows: 24 }))).toBeNull();
    expect(parseResizeFrame(JSON.stringify({ type: "resize", cols: 5000, rows: 24 }))).toBeNull();
    expect(parseResizeFrame(JSON.stringify({ type: "resize", cols: 80.5, rows: 24 }))).toBeNull();
  });
});
