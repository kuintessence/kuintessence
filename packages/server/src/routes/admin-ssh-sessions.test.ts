import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService, ShadowCheckInput } from "../authz/service";
import { AgentDispatcher } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import { SshGateway } from "../services/ssh-gateway";
import { createAdminSshSessionRoutes } from "./admin-ssh-sessions";

const silent = pino({ level: "silent" });
const ROUTE_USER_ID = "00000000-0000-4000-8000-00000000c002";

function fakeDb(): { db: PgDb; audits: Record<string, unknown>[] } {
  const audits: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        audits.push(row);
        return { onConflictDoUpdate: async () => {} };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
          limit: async () => [],
        }),
      }),
    }),
  } as unknown as PgDb;
  return { db, audits };
}

function makeGatewayWithSession(): {
  gateway: SshGateway;
  sessionId: string;
  closeReasons: string[];
} {
  const dispatcher = new AgentDispatcher();
  dispatcher.register("agent-1", { push: () => {}, close: () => {} } as never);
  const gateway = new SshGateway({ dispatcher, logger: silent, newSessionId: () => "sess-1" });
  const closeReasons: string[] = [];
  const sessionId = gateway.openSession({
    agentId: "agent-1",
    ws: {
      send: () => {},
      close: (_code?: number, reason?: string) => {
        closeReasons.push(reason ?? "");
      },
    },
    credentials: { host: "h", port: 22, username: "alice", password: "p" },
    user: "alice@x",
  });
  return { gateway, sessionId, closeReasons };
}

function makeApp(
  role: string,
  db: PgDb,
  gateway: SshGateway,
  resolveAgentProviderOrg: (agentId: string) => Promise<string | null | undefined> = async () =>
    null,
  orgId: string | null = null,
  authz?: AuthzService,
  principalUserId: string | null = ROUTE_USER_ID,
  jwtSub: string = `${role}@x`,
  principalEmail: string = `${role}@x`,
) {
  const app = new Hono();
  app.onError(createErrorHandler(silent));
  app.use("*", async (c, next) => {
    c.set("user" as never, { sub: jwtSub, role, email: `${role}@x` });
    c.set("principal" as never, {
      sub: jwtSub,
      role,
      email: principalEmail,
      userId: principalUserId,
      orgId,
      orgIds: orgId ? [orgId] : [],
      memberships: orgId ? [{ orgId, role: "admin" }] : [],
    });
    await next();
  });
  app.route("/api", createAdminSshSessionRoutes(db, gateway, { resolveAgentProviderOrg, authz }));
  return app;
}

function fakeEnforceAuthz() {
  const checks: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
  const authz = {
    mode: "enforce",
    requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
      checks.push({ input, isPlatformAdmin });
    },
  } as unknown as AuthzService;
  return { authz, checks };
}

function fakeShadowAuthz() {
  const shadowInputs: ShadowCheckInput[] = [];
  const authz = {
    mode: "shadow",
    shadowCheck: async (input: ShadowCheckInput) => {
      shadowInputs.push(input);
      return input.localAllowed;
    },
  } as unknown as AuthzService;
  return { authz, shadowInputs };
}

describe("admin SSH session monitoring", () => {
  test("rejects a plain user with 403", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const res = await makeApp("user", db, gateway).request("/api/admin/ssh-sessions");
    expect(res.status).toBe(403);
  });

  test("GET lists live sessions", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const res = await makeApp("platform_admin", db, gateway).request("/api/admin/ssh-sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string; user: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.sessionId).toBe("sess-1");
    expect(body.sessions[0]?.user).toBe("alice@x");
  });

  test("GET list records ssh_session#view shadow checks", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const fake = fakeShadowAuthz();
    const res = await makeApp("platform_admin", db, gateway, undefined, null, fake.authz).request(
      "/api/admin/ssh-sessions",
    );

    expect(res.status).toBe(200);
    expect(fake.shadowInputs).toHaveLength(1);
    expect(fake.shadowInputs[0]).toMatchObject({
      resource: { type: "ssh_session", id: "sess-1" },
      permission: "view",
      localAllowed: true,
    });
  });

  test("GET list fails closed in shadow mode without canonical user id", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const fake = fakeShadowAuthz();
    const res = await makeApp(
      "platform_admin",
      db,
      gateway,
      undefined,
      null,
      fake.authz,
      null,
      "casdoor-opaque-sub",
    ).request("/api/admin/ssh-sessions");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(fake.shadowInputs).toHaveLength(0);
  });

  test("GET list fails closed in enforce mode without canonical user id", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const fake = fakeEnforceAuthz();
    const res = await makeApp(
      "user",
      db,
      gateway,
      async () => "org-a",
      "org-b",
      fake.authz,
      null,
      "casdoor-opaque-sub",
      "bound-user@x",
    ).request("/api/admin/ssh-sessions");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(fake.checks).toHaveLength(0);
  });

  test("GET enforce list uses lookup results to filter live sessions", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const lookups: unknown[] = [];
    const authz = {
      mode: "enforce",
      lookupResources: async (input: unknown) => {
        lookups.push(input);
        return ["sess-1"];
      },
    } as unknown as AuthzService;

    const res = await makeApp("user", db, gateway, undefined, null, authz).request(
      "/api/admin/ssh-sessions",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    expect(body.sessions.map((session) => session.sessionId)).toEqual(["sess-1"]);
    expect(lookups).toEqual([
      {
        resourceType: "ssh_session",
        permission: "view",
        subject: { type: "user", id: ROUTE_USER_ID },
      },
    ]);
  });

  test("GET enforce list exposes lookup failure before reading live sessions", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    let reads = 0;
    const originalListSessions = gateway.listSessions.bind(gateway);
    gateway.listSessions = () => {
      reads += 1;
      return originalListSessions();
    };
    const authz = {
      mode: "enforce",
      lookupResources: async () => {
        throw new Error("lookup down");
      },
    } as unknown as AuthzService;

    const res = await makeApp("user", db, gateway, undefined, null, authz).request(
      "/api/admin/ssh-sessions",
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Authorization unavailable: lookup down" },
    });
    expect(reads).toBe(0);
  });

  test("GET shows provider org admins only their own agent sessions", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const resolver = async () => "org-a";
    const own = await makeApp("org_admin", db, gateway, resolver, "org-a").request(
      "/api/admin/ssh-sessions",
    );
    const ownBody = (await own.json()) as { sessions: Array<{ sessionId: string }> };
    expect(own.status).toBe(200);
    expect(ownBody.sessions).toHaveLength(1);

    const other = await makeApp("org_admin", db, gateway, resolver, "org-b").request(
      "/api/admin/ssh-sessions",
    );
    const otherBody = (await other.json()) as { sessions: Array<{ sessionId: string }> };
    expect(other.status).toBe(200);
    expect(otherBody.sessions).toHaveLength(0);
  });

  test("DELETE force-closes a live session and audits it", async () => {
    const { db, audits } = fakeDb();
    const { gateway, closeReasons } = makeGatewayWithSession();
    const actorUserId = "00000000-0000-4000-8000-00000000f001";
    expect(gateway.hasSession("sess-1")).toBe(true);
    const res = await makeApp(
      "platform_admin",
      db,
      gateway,
      undefined,
      null,
      undefined,
      actorUserId,
      "casdoor-opaque-sub",
    ).request("/api/admin/ssh-sessions/sess-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(gateway.hasSession("sess-1")).toBe(false);
    expect(closeReasons).toEqual([`force-closed by ${actorUserId}`]);
    expect(audits[0]?.actor).toBe(actorUserId);
    expect(audits[0]?.action).toBe("ssh.session.force_close");
    expect(audits[0]?.diff).toEqual({ after: { forcedBy: actorUserId } });
  });

  test("DELETE fails closed without canonical user id in local mode", async () => {
    const { db, audits } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const res = await makeApp(
      "platform_admin",
      db,
      gateway,
      undefined,
      null,
      undefined,
      null,
      "casdoor-opaque-sub",
    ).request("/api/admin/ssh-sessions/sess-1", { method: "DELETE" });

    expect(res.status).toBe(403);
    expect(gateway.hasSession("sess-1")).toBe(true);
    expect(audits).toHaveLength(0);
  });

  test("DELETE on an unknown session is 404", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const res = await makeApp("platform_admin", db, gateway).request(
      "/api/admin/ssh-sessions/nope",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  test("DELETE allows provider org admin for its own agent session", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const res = await makeApp("org_admin", db, gateway, async () => "org-a", "org-a").request(
      "/api/admin/ssh-sessions/sess-1",
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(gateway.hasSession("sess-1")).toBe(false);
  });

  test("DELETE can be authorized by ssh_session#close in enforce mode", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const fake = fakeEnforceAuthz();
    const res = await makeApp(
      "user",
      db,
      gateway,
      async () => "org-a",
      "org-b",
      fake.authz,
      ROUTE_USER_ID,
      "casdoor-opaque-sub",
      "bound-user@x",
    ).request("/api/admin/ssh-sessions/sess-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(gateway.hasSession("sess-1")).toBe(false);
    expect(fake.checks).toEqual([
      {
        input: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "bound-user@x",
          resource: { type: "ssh_session", id: "sess-1" },
          permission: "close",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: { route: "ssh_session#close" },
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("DELETE fails closed in enforce mode without canonical user id", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const fake = fakeEnforceAuthz();
    const res = await makeApp(
      "user",
      db,
      gateway,
      async () => "org-a",
      "org-b",
      fake.authz,
      null,
    ).request("/api/admin/ssh-sessions/sess-1", { method: "DELETE" });

    expect(res.status).toBe(403);
    expect(gateway.hasSession("sess-1")).toBe(true);
    expect(fake.checks).toEqual([]);
  });

  test("DELETE hides another provider org's agent session", async () => {
    const { db } = fakeDb();
    const { gateway } = makeGatewayWithSession();
    const res = await makeApp("org_admin", db, gateway, async () => "org-a", "org-b").request(
      "/api/admin/ssh-sessions/sess-1",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    expect(gateway.hasSession("sess-1")).toBe(true);
  });
});
