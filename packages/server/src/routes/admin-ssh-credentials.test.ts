import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import type { SshCredentialView } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import { decryptSshRow } from "../auth/ssh-credential-vault";
import type { AuthzCheck, AuthzService, ShadowCheckInput } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminSshCredentialRoutes } from "./admin-ssh-credentials";

const SECRET_KEY = "test-ssh-admin-wrapping-key-32-chars-long!!";
const ROUTE_USER_ID = "00000000-0000-4000-8000-00000000c001";
const silent = pino({ level: "silent" });

interface FakeState {
  saved: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  deleted: string[];
  listRows: Record<string, unknown>[];
  selects: number;
}

/** Minimal in-memory db covering the insert/select/delete chains the route +
 *  resolveActorOrgId use, without a real Postgres. */
function fakeDb(): { db: PgDb; state: FakeState } {
  const state: FakeState = { saved: [], audits: [], deleted: [], listRows: [], selects: 0 };
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        // Audit inserts await `.values(...)` directly; the save chain calls
        // `.onConflictDoUpdate(...)`. Capture each at the point it lands.
        if ("action" in row) state.audits.push(row);
        return {
          onConflictDoUpdate: async () => {
            state.saved.push(row);
          },
        };
      },
    }),
    select: () => {
      state.selects += 1;
      return {
        from: () => {
          const arr = [...state.listRows] as Record<string, unknown>[] & {
            where?: () => {
              orderBy: () => { limit: () => Promise<unknown[]> };
              limit: () => Promise<unknown[]>;
            };
          };
          arr.where = () => ({
            orderBy: () => ({ limit: async () => [] }),
            limit: async () => [],
          });
          return arr;
        },
      };
    },
    delete: () => ({
      where: async () => {
        state.deleted.push("x");
      },
    }),
  };
  return { db: db as unknown as PgDb, state };
}

function makeApp(
  role: string,
  db: PgDb,
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
  app.route(
    "/api",
    createAdminSshCredentialRoutes(db, {
      secretWrappingKey: SECRET_KEY,
      resolveAgentProviderOrg,
      authz,
    }),
  );
  return app;
}

function fakeEnforceAuthz() {
  const checks: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
  const authz = {
    mode: "enforce",
    requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
      checks.push({ input, isPlatformAdmin });
    },
    enqueueMany: async () => undefined,
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

describe("admin SSH credential routes", () => {
  test("rejects a non-admin with 403", async () => {
    const { db } = fakeDb();
    const res = await makeApp("user", db).request("/api/admin/ssh-credentials/agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "h", port: 22, username: "u", password: "p" }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects an invalid body with 400", async () => {
    const { db } = fakeDb();
    const res = await makeApp("platform_admin", db).request("/api/admin/ssh-credentials/agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 22 }), // missing host + username
    });
    expect(res.status).toBe(400);
  });

  test("PUT encrypts the secret at rest and writes an audit row without it", async () => {
    const { db, state } = fakeDb();
    const actorUserId = "00000000-0000-4000-8000-00000000e001";
    const res = await makeApp(
      "platform_admin",
      db,
      undefined,
      null,
      undefined,
      actorUserId,
      "casdoor-opaque-sub",
    ).request("/api/admin/ssh-credentials/agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "login01", port: 22, username: "alice", password: "hunter2" }),
    });
    expect(res.status).toBe(200);

    expect(state.saved).toHaveLength(1);
    const row = state.saved[0];
    expect(row?.updatedBy).toBe(actorUserId);
    const enc = row?.secretEncrypted as string;
    expect(enc).not.toBe("");
    expect(enc).not.toContain("hunter2");
    const creds = await decryptSshRow(
      { host: "login01", port: 22, username: "alice", secretEncrypted: enc },
      SECRET_KEY,
    );
    expect(creds.password).toBe("hunter2");

    // Audit row records metadata, never the secret.
    expect(state.audits).toHaveLength(1);
    const audit = state.audits[0];
    expect(audit?.actor).toBe(actorUserId);
    expect(audit?.action).toBe("ssh.credential.update");
    expect(JSON.stringify(audit?.diff)).not.toContain("hunter2");
  });

  test("PUT fails closed without canonical user id in local mode", async () => {
    const { db, state } = fakeDb();
    const res = await makeApp(
      "platform_admin",
      db,
      undefined,
      null,
      undefined,
      null,
      "casdoor-opaque-sub",
    ).request("/api/admin/ssh-credentials/agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "login01", port: 22, username: "alice", password: "hunter2" }),
    });

    expect(res.status).toBe(403);
    expect(state.saved).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  test("GET lists configured agents without secrets", async () => {
    const { db, state } = fakeDb();
    state.listRows = [
      {
        agentId: "agent-1",
        host: "login01",
        port: 22,
        username: "alice",
        secretEncrypted: "blob",
        updatedAt: new Date("2026-06-04T00:00:00Z"),
        updatedBy: "admin@x",
      },
    ];
    const res = await makeApp("platform_admin", db).request("/api/admin/ssh-credentials");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: SshCredentialView[] };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]?.hasSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("blob");
  });

  test("GET list records ssh_credential#view shadow checks", async () => {
    const { db, state } = fakeDb();
    const fake = fakeShadowAuthz();
    state.listRows = [
      {
        agentId: "agent-1",
        host: "login01",
        port: 22,
        username: "alice",
        secretEncrypted: "blob",
        updatedAt: new Date("2026-06-04T00:00:00Z"),
        updatedBy: "admin@x",
      },
    ];

    const res = await makeApp("platform_admin", db, undefined, null, fake.authz).request(
      "/api/admin/ssh-credentials",
    );

    expect(res.status).toBe(200);
    expect(fake.shadowInputs).toHaveLength(1);
    expect(fake.shadowInputs[0]).toMatchObject({
      resource: { type: "ssh_credential", id: "agent-1" },
      permission: "view",
      localAllowed: true,
    });
  });

  test("GET list fails closed in shadow mode without canonical user id", async () => {
    const { db, state } = fakeDb();
    const fake = fakeShadowAuthz();
    state.listRows = [
      {
        agentId: "agent-1",
        host: "login01",
        port: 22,
        username: "alice",
        secretEncrypted: "blob",
        updatedAt: new Date("2026-06-04T00:00:00Z"),
        updatedBy: "admin@x",
      },
    ];

    const res = await makeApp(
      "platform_admin",
      db,
      undefined,
      null,
      fake.authz,
      null,
      "casdoor-opaque-sub",
    ).request("/api/admin/ssh-credentials");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(fake.shadowInputs).toHaveLength(0);
  });

  test("GET list fails closed in enforce mode without canonical user id", async () => {
    const { db, state } = fakeDb();
    const fake = fakeEnforceAuthz();
    state.listRows = [
      {
        agentId: "agent-1",
        host: "login01",
        port: 22,
        username: "alice",
        secretEncrypted: "blob",
        updatedAt: new Date("2026-06-04T00:00:00Z"),
        updatedBy: "admin@x",
      },
    ];

    const res = await makeApp(
      "user",
      db,
      async () => "org-a",
      "org-b",
      fake.authz,
      null,
      "casdoor-opaque-sub",
      "bound-user@x",
    ).request("/api/admin/ssh-credentials");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(fake.checks).toHaveLength(0);
  });

  test("GET enforce list performs lookup before credential SQL", async () => {
    const { db, state } = fakeDb();
    const lookups: unknown[] = [];
    const authz = {
      mode: "enforce",
      lookupResources: async (input: unknown) => {
        lookups.push(input);
        return [];
      },
    } as unknown as AuthzService;

    const res = await makeApp("user", db, undefined, null, authz).request(
      "/api/admin/ssh-credentials",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ credentials: [] });
    expect(lookups).toEqual([
      {
        resourceType: "ssh_credential",
        permission: "view",
        subject: { type: "user", id: ROUTE_USER_ID },
      },
    ]);
    expect(state.selects).toBe(0);
  });

  test("GET enforce list exposes lookup failure without credential SQL", async () => {
    const { db, state } = fakeDb();
    const authz = {
      mode: "enforce",
      lookupResources: async () => {
        throw new Error("lookup down");
      },
    } as unknown as AuthzService;

    const res = await makeApp("user", db, undefined, null, authz).request(
      "/api/admin/ssh-credentials",
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Authorization unavailable: lookup down" },
    });
    expect(state.selects).toBe(0);
  });

  test("DELETE removes the credential and audits it", async () => {
    const { db, state } = fakeDb();
    const actorUserId = "00000000-0000-4000-8000-00000000e002";
    const res = await makeApp(
      "platform_admin",
      db,
      undefined,
      null,
      undefined,
      actorUserId,
      "casdoor-opaque-sub",
    ).request("/api/admin/ssh-credentials/agent-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(state.deleted).toHaveLength(1);
    expect(state.audits[0]?.actor).toBe(actorUserId);
    expect(state.audits[0]?.action).toBe("ssh.credential.delete");
  });

  test("PUT allows the provider org admin for its own agent", async () => {
    const { db } = fakeDb();
    const res = await makeApp("org_admin", db, async () => "org-a", "org-a").request(
      "/api/admin/ssh-credentials/agent-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "h", port: 22, username: "u", password: "p" }),
      },
    );
    expect(res.status).toBe(200);
  });

  test("PUT bootstraps through agent#manage in enforce mode", async () => {
    const { db, state } = fakeDb();
    const fake = fakeEnforceAuthz();
    const res = await makeApp(
      "user",
      db,
      async () => "org-a",
      "org-b",
      fake.authz,
      ROUTE_USER_ID,
      "casdoor-opaque-sub",
      "bound-user@x",
    ).request("/api/admin/ssh-credentials/agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "h", port: 22, username: "u", password: "p" }),
    });
    expect(res.status).toBe(200);
    expect(state.saved).toHaveLength(1);
    expect(fake.checks).toEqual([
      {
        input: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "bound-user@x",
          resource: { type: "agent", id: "agent-1" },
          permission: "manage",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: { route: "agent#manage" },
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("PUT fails closed in enforce mode without canonical user id", async () => {
    const { db, state } = fakeDb();
    const fake = fakeEnforceAuthz();
    const res = await makeApp("user", db, async () => "org-a", "org-b", fake.authz, null).request(
      "/api/admin/ssh-credentials/agent-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "h", port: 22, username: "u", password: "p" }),
      },
    );

    expect(res.status).toBe(403);
    expect(state.saved).toHaveLength(0);
    expect(fake.checks).toEqual([]);
  });

  test("PUT hides another provider org's agent from org admin", async () => {
    const { db } = fakeDb();
    const res = await makeApp("org_admin", db, async () => "org-a", "org-b").request(
      "/api/admin/ssh-credentials/agent-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "h", port: 22, username: "u", password: "p" }),
      },
    );
    expect(res.status).toBe(404);
  });
});
