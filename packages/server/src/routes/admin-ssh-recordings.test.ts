import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService, ShadowCheckInput } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import {
  createAdminSshRecordingRoutes,
  type RecordingRetrievalStore,
} from "./admin-ssh-recordings";

const silent = pino({ level: "silent" });
const ROUTE_USER_ID = "00000000-0000-4000-8000-00000000c003";

function fakeDb(recordings: unknown[] = []): {
  db: PgDb;
  audits: Record<string, unknown>[];
  deleted: number;
  selects: number;
} {
  const audits: Record<string, unknown>[] = [];
  const state = { deleted: 0, selects: 0 };
  const fromChain = {
    innerJoin: () => ({
      where: () => ({
        orderBy: () => ({ limit: async () => [] }),
        limit: async () => [],
      }),
    }),
    orderBy: () => ({ limit: async () => recordings }),
    where: () => ({
      orderBy: () => ({ limit: async () => [] }),
      limit: async () => recordings,
    }),
  };
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        audits.push(row);
        return { onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} };
      },
    }),
    select: () => {
      state.selects += 1;
      return { from: () => fromChain };
    },
    delete: () => ({
      where: async () => {
        state.deleted += 1;
      },
    }),
  } as unknown as PgDb;
  return {
    db,
    audits,
    get deleted() {
      return state.deleted;
    },
    get selects() {
      return state.selects;
    },
  };
}

/** Store over a mutable key set; tracks reads and deletes. */
function storeWith(
  presentKeys: Set<string>,
): RecordingRetrievalStore & { deleted: string[]; headed: string[] } {
  const deleted: string[] = [];
  const headed: string[] = [];
  return {
    deleted,
    headed,
    head: async (key) => {
      headed.push(key);
      return presentKeys.has(key) ? { size: 1234, contentType: "application/x-asciicast" } : null;
    },
    presignDownload: async (key, exp) => `https://minio.local/${key}?exp=${exp}`,
    delete: async (key) => {
      deleted.push(key);
      presentKeys.delete(key);
    },
  };
}

function makeApp(
  role: string,
  db: PgDb,
  store: RecordingRetrievalStore,
  resolveAgentProviderOrg: (agentId: string) => Promise<string | null | undefined> = async () =>
    null,
  orgId: string | null = null,
  authz?: AuthzService,
  principalUserId: string | null = ROUTE_USER_ID,
  jwtSub = `${role}@x`,
  principalEmail = `${role}@x`,
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
  app.route("/api", createAdminSshRecordingRoutes(db, store, { resolveAgentProviderOrg, authz }));
  return app;
}

function fakeEnforceAuthz() {
  const checks: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
  const enqueued: unknown[][] = [];
  const authz = {
    mode: "enforce",
    requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
      checks.push({ input, isPlatformAdmin });
    },
    enqueueMany: async (tuples: unknown[]) => {
      enqueued.push(tuples);
    },
  } as unknown as AuthzService;
  return { authz, checks, enqueued };
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

const KEY = "ssh-recordings/agent-1/sess-1.cast";

describe("admin SSH recording retrieval", () => {
  test("rejects a non-admin with 403", async () => {
    const { db } = fakeDb();
    const app = makeApp("user", db, storeWith(new Set([KEY])));
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1");
    expect(res.status).toBe(403);
  });

  test("GET lists recordings from the index (no transcript bytes)", async () => {
    const { db } = fakeDb([
      {
        agentId: "agent-1",
        sessionId: "sess-1",
        actorUser: "alice@x",
        storageKey: "ssh-recordings/agent-1/sess-1.cast",
        startedAt: new Date("2026-06-04T00:00:00Z"),
        endedAt: new Date("2026-06-04T00:05:00Z"),
        durationMs: 300000,
        sizeBytes: 4096,
      },
    ]);
    const app = makeApp("platform_admin", db, storeWith(new Set()));
    const res = await app.request("/api/admin/ssh-recordings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recordings: Array<{ sessionId: string; user: string; sizeBytes: number }>;
    };
    expect(body.recordings).toHaveLength(1);
    expect(body.recordings[0]?.sessionId).toBe("sess-1");
    expect(body.recordings[0]?.user).toBe("alice@x");
    expect(JSON.stringify(body)).not.toContain("storage_key");
  });

  test("GET list records ssh_recording#view shadow checks", async () => {
    const fake = fakeShadowAuthz();
    const { db } = fakeDb([
      {
        agentId: "agent-1",
        sessionId: "sess-1",
        actorUser: "alice@x",
        storageKey: "ssh-recordings/agent-1/sess-1.cast",
        startedAt: new Date("2026-06-04T00:00:00Z"),
        endedAt: new Date("2026-06-04T00:05:00Z"),
        durationMs: 300000,
        sizeBytes: 4096,
      },
    ]);

    const res = await makeApp(
      "platform_admin",
      db,
      storeWith(new Set()),
      undefined,
      null,
      fake.authz,
    ).request("/api/admin/ssh-recordings");

    expect(res.status).toBe(200);
    expect(fake.shadowInputs).toHaveLength(1);
    expect(fake.shadowInputs[0]).toMatchObject({
      resource: { type: "ssh_recording", id: "sess-1" },
      permission: "view",
      localAllowed: true,
    });
  });

  test("GET list fails closed in shadow mode without canonical user id", async () => {
    const fake = fakeShadowAuthz();
    const { db } = fakeDb([
      {
        agentId: "agent-1",
        sessionId: "sess-1",
        actorUser: "alice@x",
        storageKey: "ssh-recordings/agent-1/sess-1.cast",
        startedAt: new Date("2026-06-04T00:00:00Z"),
        endedAt: new Date("2026-06-04T00:05:00Z"),
        durationMs: 300000,
        sizeBytes: 4096,
      },
    ]);

    const res = await makeApp(
      "platform_admin",
      db,
      storeWith(new Set()),
      undefined,
      null,
      fake.authz,
      null,
      "casdoor-opaque-sub",
    ).request("/api/admin/ssh-recordings");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(fake.shadowInputs).toHaveLength(0);
  });

  test("GET list fails closed in enforce mode without canonical user id", async () => {
    const fake = fakeEnforceAuthz();
    const { db } = fakeDb([
      {
        agentId: "agent-1",
        sessionId: "sess-1",
        actorUser: "alice@x",
        storageKey: "ssh-recordings/agent-1/sess-1.cast",
        startedAt: new Date("2026-06-04T00:00:00Z"),
        endedAt: new Date("2026-06-04T00:05:00Z"),
        durationMs: 300000,
        sizeBytes: 4096,
      },
    ]);
    const store = storeWith(new Set([KEY]));

    const res = await makeApp(
      "user",
      db,
      store,
      async () => "org-a",
      "org-b",
      fake.authz,
      null,
      "casdoor-opaque-sub",
      "bound-user@x",
    ).request("/api/admin/ssh-recordings");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(fake.checks).toHaveLength(0);
    expect(store.headed).toHaveLength(0);
  });

  test("GET enforce list performs lookup before recording-index SQL", async () => {
    const fake = fakeDb();
    const lookups: unknown[] = [];
    const authz = {
      mode: "enforce",
      lookupResources: async (input: unknown) => {
        lookups.push(input);
        return [];
      },
    } as unknown as AuthzService;

    const res = await makeApp(
      "user",
      fake.db,
      storeWith(new Set()),
      undefined,
      null,
      authz,
    ).request("/api/admin/ssh-recordings");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recordings: [] });
    expect(lookups).toEqual([
      {
        resourceType: "ssh_recording",
        permission: "view",
        subject: { type: "user", id: ROUTE_USER_ID },
      },
    ]);
    expect(fake.selects).toBe(0);
  });

  test("GET enforce list exposes lookup failure without recording-index SQL", async () => {
    const fake = fakeDb();
    const authz = {
      mode: "enforce",
      lookupResources: async () => {
        throw new Error("lookup down");
      },
    } as unknown as AuthzService;

    const res = await makeApp(
      "user",
      fake.db,
      storeWith(new Set()),
      undefined,
      null,
      authz,
    ).request("/api/admin/ssh-recordings");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Authorization unavailable: lookup down" },
    });
    expect(fake.selects).toBe(0);
  });

  test("GET list shows provider org admins only their own agent recordings", async () => {
    const row = {
      agentId: "agent-1",
      sessionId: "sess-1",
      actorUser: "alice@x",
      storageKey: "ssh-recordings/agent-1/sess-1.cast",
      startedAt: new Date("2026-06-04T00:00:00Z"),
      endedAt: new Date("2026-06-04T00:05:00Z"),
      durationMs: 300000,
      sizeBytes: 4096,
    };
    const resolver = async () => "org-a";
    const ownDb = fakeDb([row]);
    const own = await makeApp(
      "org_admin",
      ownDb.db,
      storeWith(new Set()),
      resolver,
      "org-a",
    ).request("/api/admin/ssh-recordings");
    const ownBody = (await own.json()) as { recordings: Array<{ sessionId: string }> };
    expect(own.status).toBe(200);
    expect(ownBody.recordings).toHaveLength(1);

    const otherDb = fakeDb([row]);
    const other = await makeApp(
      "org_admin",
      otherDb.db,
      storeWith(new Set()),
      resolver,
      "org-b",
    ).request("/api/admin/ssh-recordings");
    const otherBody = (await other.json()) as { recordings: Array<{ sessionId: string }> };
    expect(other.status).toBe(200);
    expect(otherBody.recordings).toHaveLength(0);
  });

  test("404 when the recording is absent", async () => {
    const { db } = fakeDb();
    const app = makeApp("platform_admin", db, storeWith(new Set()));
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1");
    expect(res.status).toBe(404);
  });

  test("returns a presigned URL + metadata and audit-logs canonical access actor", async () => {
    const { db, audits } = fakeDb();
    const app = makeApp(
      "platform_admin",
      db,
      storeWith(new Set([KEY])),
      undefined,
      null,
      undefined,
      "server-user-1",
      "oidc|opaque-sub",
    );
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      sizeBytes: number;
      contentType: string;
      expiresSec: number;
    };
    expect(body.url).toContain(KEY);
    expect(body.sizeBytes).toBe(1234);
    expect(body.contentType).toBe("application/x-asciicast");
    expect(audits[0]?.action).toBe("ssh.recording.access");
    expect(audits[0]?.actor).toBe("server-user-1");
  });

  test("GET allows provider org admin for its own agent recording", async () => {
    const { db } = fakeDb();
    const app = makeApp("org_admin", db, storeWith(new Set([KEY])), async () => "org-a", "org-a");
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1");
    expect(res.status).toBe(200);
  });

  test("GET can be authorized by ssh_recording#view in enforce mode", async () => {
    const { db } = fakeDb();
    const fake = fakeEnforceAuthz();
    const app = makeApp(
      "user",
      db,
      storeWith(new Set([KEY])),
      async () => "org-a",
      "org-b",
      fake.authz,
      ROUTE_USER_ID,
      "casdoor-opaque-sub",
      "bound-user@x",
    );
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1");
    expect(res.status).toBe(200);
    expect(fake.checks).toEqual([
      {
        input: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "bound-user@x",
          resource: { type: "ssh_recording", id: "sess-1" },
          permission: "view",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: { route: "ssh_recording#view" },
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("GET fails closed in enforce mode without canonical user id", async () => {
    const { db } = fakeDb();
    const fake = fakeEnforceAuthz();
    const store = storeWith(new Set([KEY]));
    const app = makeApp("user", db, store, async () => "org-a", "org-b", fake.authz, null);
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1");

    expect(res.status).toBe(403);
    expect(fake.checks).toEqual([]);
    expect(store.headed).toHaveLength(0);
  });

  test("GET hides another provider org's agent recording", async () => {
    const { db } = fakeDb();
    const app = makeApp("org_admin", db, storeWith(new Set([KEY])), async () => "org-a", "org-b");
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1");
    expect(res.status).toBe(404);
  });

  test("DELETE removes the recording and audits the canonical actor", async () => {
    const { db, audits } = fakeDb();
    const store = storeWith(new Set([KEY]));
    const app = makeApp(
      "platform_admin",
      db,
      store,
      undefined,
      null,
      undefined,
      "server-user-2",
      "oidc|opaque-sub",
    );
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(store.deleted).toContain(KEY);
    expect(audits[0]?.action).toBe("ssh.recording.delete");
    expect(audits[0]?.actor).toBe("server-user-2");
  });

  test("DELETE removes SpiceDB recording relationships", async () => {
    const { db } = fakeDb([{ agentId: "agent-1", sessionId: "sess-1", actorUser: ROUTE_USER_ID }]);
    const store = storeWith(new Set([KEY]));
    const fake = fakeEnforceAuthz();
    const app = makeApp(
      "platform_admin",
      db,
      store,
      undefined,
      null,
      fake.authz,
      ROUTE_USER_ID,
      "oidc|opaque-sub",
    );

    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(fake.enqueued[0]).toEqual([
      {
        operation: "delete",
        resource: { type: "ssh_recording", id: "sess-1" },
        relation: "agent",
        subject: { type: "agent", id: "agent-1" },
      },
      {
        operation: "delete",
        resource: { type: "ssh_recording", id: "sess-1" },
        relation: "platform",
        subject: { type: "platform", id: "root" },
      },
      {
        operation: "delete",
        resource: { type: "ssh_recording", id: "sess-1" },
        relation: "actor",
        subject: { type: "user", id: ROUTE_USER_ID },
      },
    ]);
  });

  test("DELETE fails closed before storage access without canonical user id", async () => {
    const { db, audits } = fakeDb();
    const store = storeWith(new Set([KEY]));
    const app = makeApp(
      "platform_admin",
      db,
      store,
      undefined,
      null,
      undefined,
      null,
      "oidc|opaque-sub",
    );
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1", { method: "DELETE" });

    expect(res.status).toBe(403);
    expect(store.headed).toHaveLength(0);
    expect(store.deleted).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  test("DELETE on an absent recording is 404", async () => {
    const { db } = fakeDb();
    const app = makeApp("platform_admin", db, storeWith(new Set()));
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("DELETE hides another provider org's agent recording", async () => {
    const { db } = fakeDb();
    const store = storeWith(new Set([KEY]));
    const app = makeApp("org_admin", db, store, async () => "org-a", "org-b");
    const res = await app.request("/api/admin/ssh-recordings/agent-1/sess-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(store.deleted).toHaveLength(0);
  });
});
