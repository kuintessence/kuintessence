// Test isolation: agent ID prefix `sw-routes-test-agent`, token sub "sw-routes@test".
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  agentInstalledSoftware,
  agents,
  auditLog,
  createPgDb,
  orgs,
  type PgDb,
  softwareAccessRequests,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
  softwareMirrorCache,
  softwarePolicies,
  userCapabilities,
  users,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { AgentDispatcher } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import type { SoftwareAvailabilityService } from "../services/software-availability";
import { InstalledRegistry } from "../software-governance/installed-registry";
import { PolicyPusher } from "../software-governance/policy-pusher";
import { PolicyStore } from "../software-governance/policy-store";
import { createSoftwareRoutes, localSoftwareRole } from "./software";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const AGENT_ID = "sw-routes-test-agent";
const OFFLINE_AGENT_ID = "sw-routes-offline-agent";
const OWNED_AGENT_ID = "sw-routes-owned-agent";
const ORG_A = "11111111-1111-4111-8111-1111111111aa";
const ORG_B = "11111111-1111-4111-8111-1111111111bb";
const ROUTE_USER_ID = "11111111-1111-4111-8111-111111111198";
const SOFTWARE_PROVIDER_USER = "11111111-1111-4111-8111-111111111199";
const DEFAULT_SUB = "sw-routes@test";

function makeApp(
  role: string,
  dispatcher = new AgentDispatcher(),
  orgId: string | null = null,
  availability?: SoftwareAvailabilityService,
  sub = DEFAULT_SUB,
  authz?: AuthzService,
  principalUserId: string | null = sub === DEFAULT_SUB ? ROUTE_USER_ID : sub,
  principalRole = role,
  identity: { principalEmail?: string; userEmail?: string } = {},
) {
  const db = createPgDb(TEST_DB_URL);
  const installedRegistry = new InstalledRegistry(db);
  const policyStore = new PolicyStore(db);
  const policyPusher = new PolicyPusher(dispatcher);

  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    const userEmail = identity.userEmail ?? `${sub}@example.test`;
    const principalEmail = identity.principalEmail ?? userEmail;
    c.set("user" as never, {
      sub,
      role,
      email: userEmail,
    });
    c.set("principal" as never, {
      sub,
      role: principalRole,
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
    createSoftwareRoutes({
      db,
      installedRegistry,
      policyStore,
      policyPusher,
      dispatcher,
      availability,
      authz,
    }),
  );
  return { app, db, installedRegistry, policyStore, policyPusher, dispatcher };
}

function enforcingAuthz(calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }>) {
  return {
    mode: "enforce",
    requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
      calls.push({ input, isPlatformAdmin });
    },
    enqueueMany: async () => {},
  } as unknown as AuthzService;
}

function enforcingAuthzWithOutbox(
  calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }>,
  enqueued: unknown[][],
) {
  return {
    mode: "enforce",
    requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
      calls.push({ input, isPlatformAdmin });
    },
    enqueueMany: async (tuples: unknown[]) => {
      enqueued.push(tuples);
    },
  } as unknown as AuthzService;
}

function makeAppWithoutPrincipal(role: string) {
  const db = createPgDb(TEST_DB_URL);
  const dispatcher = new AgentDispatcher();
  const installedRegistry = new InstalledRegistry(db);
  const policyStore = new PolicyStore(db);
  const policyPusher = new PolicyPusher(dispatcher);
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("user" as never, {
      sub: "stale-software-admin",
      role,
      email: "stale-software-admin@example.test",
    });
    await next();
  });
  app.route(
    "/api",
    createSoftwareRoutes({
      db,
      installedRegistry,
      policyStore,
      policyPusher,
      dispatcher,
    }),
  );
  return app;
}

async function reset(db: PgDb): Promise<void> {
  await db.delete(agentInstalledSoftware).where(eq(agentInstalledSoftware.agentId, AGENT_ID));
  await db
    .delete(agentInstalledSoftware)
    .where(eq(agentInstalledSoftware.agentId, OFFLINE_AGENT_ID));
  await db.delete(agentInstalledSoftware).where(eq(agentInstalledSoftware.agentId, OWNED_AGENT_ID));
  await db.delete(softwarePolicies).where(eq(softwarePolicies.agentId, AGENT_ID));
  await db.delete(softwarePolicies).where(eq(softwarePolicies.agentId, OFFLINE_AGENT_ID));
  await db.delete(softwarePolicies).where(eq(softwarePolicies.agentId, OWNED_AGENT_ID));
  await db.delete(auditLog).where(eq(auditLog.actor, "sw-routes@test"));
  await db.delete(auditLog).where(eq(auditLog.actor, ROUTE_USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor, SOFTWARE_PROVIDER_USER));
  await db
    .delete(softwareAccessRequests)
    .where(eq(softwareAccessRequests.requesterUserId, ROUTE_USER_ID));
  await db
    .delete(softwareMirrorCache)
    .where(eq(softwareMirrorCache.sourceUrl, "https://example.test/source.tar.gz"));
  await db.delete(softwareAssets).where(like(softwareAssets.name, "sw-routes-asset-%"));
  await db.delete(userCapabilities).where(eq(userCapabilities.userId, SOFTWARE_PROVIDER_USER));
  await db.delete(users).where(eq(users.id, ROUTE_USER_ID));
  await db.delete(users).where(eq(users.id, SOFTWARE_PROVIDER_USER));
  await db.delete(agents).where(eq(agents.agentId, AGENT_ID));
  await db.delete(agents).where(eq(agents.agentId, OFFLINE_AGENT_ID));
  await db.delete(agents).where(eq(agents.agentId, OWNED_AGENT_ID));
  await db.delete(orgs).where(eq(orgs.id, ORG_A));
  await db.delete(orgs).where(eq(orgs.id, ORG_B));
}

async function seedSupersededUpstreamAsset(db: PgDb, name: string) {
  const version = "1.0.0";
  const [asset] = await db
    .insert(softwareAssets)
    .values({
      kind: "spack-package",
      name,
      version,
      source: "official-upstream",
      lifecycle: "archived",
      visibility: "hidden",
      trustedForGlobalUse: true,
      payload: {
        kind: "spack-package",
        spack: { packageName: name, defaultSpec: `${name}@${version}`, metadata: {} },
      },
      provenance: {
        source: "official-upstream",
        upstreamName: name,
        upstreamRef: `v${version}`,
      },
      reviewState: {
        upstreamVersionSupersession: {
          kind: "versioned-upstream",
          canonicalIdentity: `official-upstream/${name}/${version}`,
          legacyRevisionId: crypto.randomUUID(),
          replacementAssetId: crypto.randomUUID(),
          replacementRevisionId: crypto.randomUUID(),
          reason: "Replaced by the governed immutable snapshot",
          supersededAt: new Date().toISOString(),
          supersededBy: ROUTE_USER_ID,
        },
      },
    })
    .returning();
  if (!asset) throw new Error("superseded upstream asset insert failed");
  return asset;
}

describe("software routes", () => {
  let dbHandle: PgDb;

  beforeAll(async () => {
    dbHandle = createPgDb(TEST_DB_URL);
    await reset(dbHandle);
    await dbHandle.insert(orgs).values([
      { id: ORG_A, name: "software-routes-org-a" },
      { id: ORG_B, name: "software-routes-org-b" },
    ]);
    await dbHandle.insert(users).values([
      {
        id: ROUTE_USER_ID,
        email: "sw-routes@test@example.test",
        role: "user",
        orgId: ORG_A,
      },
      {
        id: SOFTWARE_PROVIDER_USER,
        email: "software-provider-user@example.test",
        role: "user",
        orgId: ORG_A,
      },
    ]);
    await dbHandle.insert(agents).values({
      agentId: AGENT_ID,
      siteName: "sw-test",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await dbHandle.insert(agents).values({
      agentId: OFFLINE_AGENT_ID,
      siteName: "sw-offline-test",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await dbHandle.insert(agents).values({
      agentId: OWNED_AGENT_ID,
      siteName: "sw-owned-test",
      providerOrgId: ORG_A,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
  });

  beforeEach(async () => {
    await dbHandle
      .delete(agentInstalledSoftware)
      .where(eq(agentInstalledSoftware.agentId, AGENT_ID));
    await dbHandle.delete(softwarePolicies).where(eq(softwarePolicies.agentId, AGENT_ID));
    await dbHandle.delete(auditLog).where(eq(auditLog.actor, "sw-routes@test"));
    await dbHandle.delete(auditLog).where(eq(auditLog.actor, ROUTE_USER_ID));
    await dbHandle.delete(auditLog).where(eq(auditLog.actor, SOFTWARE_PROVIDER_USER));
    await dbHandle
      .delete(softwareAccessRequests)
      .where(eq(softwareAccessRequests.requesterUserId, ROUTE_USER_ID));
    await dbHandle
      .delete(softwareMirrorCache)
      .where(eq(softwareMirrorCache.sourceUrl, "https://example.test/source.tar.gz"));
    await dbHandle.delete(softwareAssets).where(like(softwareAssets.name, "sw-routes-asset-%"));
    await dbHandle
      .delete(userCapabilities)
      .where(eq(userCapabilities.userId, SOFTWARE_PROVIDER_USER));
  });

  afterAll(async () => {
    await reset(dbHandle);
  });

  test("GET /api/software/agents/:id/installed — 403 for plain user", async () => {
    const { app } = makeApp("user");
    const res = await app.request(`/api/software/agents/${AGENT_ID}/installed`);
    expect(res.status).toBe(403);
  });

  test("GET /api/software/agents/:id/installed — empty list when none", async () => {
    const { app } = makeApp("org_admin");
    const res = await app.request(`/api/software/agents/${AGENT_ID}/installed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test("GET /api/software/agents/:id/installed — returns rows", async () => {
    const { app, installedRegistry } = makeApp("org_admin");
    await installedRegistry.replaceForAgent(AGENT_ID, [
      { name: "gromacs", version: "2024.1", hash: "h1", spec: "gromacs@2024.1" },
    ]);
    const res = await app.request(`/api/software/agents/${AGENT_ID}/installed`);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ name: string }>;
    };
    expect(body.data[0]?.name).toBe("gromacs");
  });

  test("GET /api/software/agents/:id/installed — hides another provider org's agent", async () => {
    const { app } = makeApp("org_admin", new AgentDispatcher(), ORG_B);
    const res = await app.request(`/api/software/agents/${OWNED_AGENT_ID}/installed`);
    expect(res.status).toBe(404);
  });

  test("GET /api/software/agents/:id/installed — SpiceDB agent#view can authorize a non-admin JWT role", async () => {
    const calls: Array<{
      input: AuthzCheck & { localAllowed?: boolean };
      isPlatformAdmin: boolean;
    }> = [];
    const authz = enforcingAuthz(calls);
    const { app, installedRegistry } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      ROUTE_USER_ID,
      "user",
      {
        principalEmail: "bound-software@example.test",
        userEmail: "stale-token-software@example.test",
      },
    );
    await installedRegistry.replaceForAgent(AGENT_ID, [
      { name: "gromacs", version: "2024.1", hash: "h1", spec: "gromacs@2024.1" },
    ]);

    const res = await app.request(`/api/software/agents/${AGENT_ID}/installed`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string }> };
    expect(body.data[0]?.name).toBe("gromacs");
    expect(calls).toEqual([
      {
        input: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "bound-software@example.test",
          resource: { type: "agent", id: AGENT_ID },
          permission: "view",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: {
            localAllowed: false,
            source: "software-governance",
            path: `/api/software/agents/${AGENT_ID}/installed`,
          },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("GET /api/software/agents/:id/installed — enforce fails closed without canonical user id", async () => {
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      null,
    );

    const res = await app.request(`/api/software/agents/${AGENT_ID}/installed`);

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("GET /api/software/policies/:agentId — 404 when none", async () => {
    const { app } = makeApp("org_admin");
    const res = await app.request(`/api/software/policies/${AGENT_ID}`);
    expect(res.status).toBe(404);
  });

  test("GET /api/software/policies — SpiceDB platform#view can authorize a non-admin JWT role", async () => {
    const calls: Array<{
      input: AuthzCheck & { localAllowed?: boolean };
      isPlatformAdmin: boolean;
    }> = [];
    const authz = enforcingAuthz(calls);
    const { app, policyStore } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      ROUTE_USER_ID,
      "user",
      {
        principalEmail: "bound-software@example.test",
        userEmail: "stale-token-software@example.test",
      },
    );
    await policyStore.upsertForAgent(AGENT_ID, {
      allowList: [],
      denyList: [],
      lockEnabled: false,
      mirrors: [],
      preinstallList: [],
    });

    const res = await app.request("/api/software/policies");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        input: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "bound-software@example.test",
          resource: { type: "platform", id: "root" },
          permission: "view",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: { localAllowed: false, source: "software-policies" },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("GET /api/software/policies — stale JWT org_admin cannot list policies in local mode", async () => {
    const { app } = makeApp(
      "org_admin",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      undefined,
      ROUTE_USER_ID,
      "user",
    );

    const res = await app.request("/api/software/policies");

    expect(res.status).toBe(403);
  });

  test("GET /api/software/policies — missing principal cannot recover org_admin from JWT", async () => {
    expect(localSoftwareRole({ role: "org_admin" }, undefined)).toBe("guest");

    const res = await makeAppWithoutPrincipal("org_admin").request("/api/software/policies");

    expect(res.status).toBe(403);
  });

  test("GET /api/software/policies — enforce fails closed without canonical user id", async () => {
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      null,
    );

    const res = await app.request("/api/software/policies");

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("GET /api/software/policies — degraded fallback uses bound principal role", async () => {
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "platform_admin",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      ROUTE_USER_ID,
      "user",
    );

    const res = await app.request("/api/software/policies");

    expect(res.status).toBe(200);
    expect(calls[0]?.isPlatformAdmin).toBe(false);
  });

  test("PUT /api/software/policies/:agentId — upserts and audit-logs", async () => {
    const { app } = makeApp("platform_admin");
    const res = await app.request(`/api/software/policies/${AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowList: ["gromacs@*"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { version: string; lockEnabled: boolean };
      pushed: boolean;
    };
    expect(body.data.lockEnabled).toBe(true);
    expect(body.data.version).toBeDefined();
    // Agent is offline (no dispatcher channel) so pushed=false.
    expect(body.pushed).toBe(false);

    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.policy.upsert"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const matching = audit.find((a) => a.target === AGENT_ID);
    expect(matching).toBeDefined();
    expect(matching?.actor).toBe(ROUTE_USER_ID);
  });

  test("PUT /api/software/policies/:agentId — audit actor ignores opaque JWT sub", async () => {
    const opaqueSub = "casdoor|software-policy-actor";
    const { app } = makeApp(
      "platform_admin",
      new AgentDispatcher(),
      null,
      undefined,
      opaqueSub,
      undefined,
      ROUTE_USER_ID,
    );
    const res = await app.request(`/api/software/policies/${AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowList: ["gromacs@*"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
      }),
    });

    expect(res.status).toBe(200);
    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.policy.upsert"));
    const matching = audit.find((a) => a.target === AGENT_ID);
    expect(matching?.actor).toBe(ROUTE_USER_ID);
    expect(matching?.actor).not.toBe(opaqueSub);
  });

  test("PUT /api/software/policies/:agentId — pushes when online", async () => {
    const dispatcher = new AgentDispatcher();
    let pushed = 0;
    dispatcher.register(AGENT_ID, {
      push: () => {
        pushed += 1;
      },
      close: () => {},
    });
    const { app } = makeApp("platform_admin", dispatcher);
    const res = await app.request(`/api/software/policies/${AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowList: ["gromacs@*"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pushed: boolean };
    expect(body.pushed).toBe(true);
    expect(pushed).toBe(1);
  });

  test("PUT /api/software/policies/:agentId — allows the provider org admin", async () => {
    const { app } = makeApp("org_admin", new AgentDispatcher(), ORG_A);
    const res = await app.request(`/api/software/policies/${OWNED_AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowList: ["gromacs@*"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
      }),
    });
    expect(res.status).toBe(200);
  });

  test("PUT /api/software/policies/:agentId — SpiceDB agent#manage can authorize a non-admin JWT role", async () => {
    const calls: Array<{
      input: AuthzCheck & { localAllowed?: boolean };
      isPlatformAdmin: boolean;
    }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      ROUTE_USER_ID,
      "user",
      {
        principalEmail: "bound-software@example.test",
        userEmail: "stale-token-software@example.test",
      },
    );
    const res = await app.request(`/api/software/policies/${AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowList: ["gromacs@*"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        input: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "bound-software@example.test",
          resource: { type: "agent", id: AGENT_ID },
          permission: "manage",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: {
            localAllowed: false,
            source: "software-governance",
            path: `/api/software/policies/${AGENT_ID}`,
          },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("PUT /api/software/policies/:agentId — enforce fails closed without canonical user id", async () => {
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      null,
    );
    const res = await app.request(`/api/software/policies/${AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowList: ["gromacs@*"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
      }),
    });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("PUT /api/software/policies/:agentId — degraded fallback uses bound principal role", async () => {
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "platform_admin",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      ROUTE_USER_ID,
      "user",
    );

    const res = await app.request(`/api/software/policies/${AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowList: ["gromacs@*"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(calls[0]?.isPlatformAdmin).toBe(false);
  });

  test("PUT /api/software/policies/:agentId — hides another provider org's agent", async () => {
    const { app } = makeApp("org_admin", new AgentDispatcher(), ORG_B);
    const res = await app.request(`/api/software/policies/${OWNED_AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowList: ["gromacs@*"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
      }),
    });
    expect(res.status).toBe(404);
  });

  test("PUT /api/software/policies/:agentId — 400 on bad body", async () => {
    const { app } = makeApp("platform_admin");
    const res = await app.request(`/api/software/policies/${AGENT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/software/distribute — pushes to listed agents and audit-logs", async () => {
    const dispatcher = new AgentDispatcher();
    let pushed = 0;
    dispatcher.register(AGENT_ID, {
      push: () => {
        pushed += 1;
      },
      close: () => {},
    });
    const { app } = makeApp("platform_admin", dispatcher);
    const res = await app.request("/api/software/distribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec: "gromacs@2024.1",
        targetAgentIds: [AGENT_ID, OFFLINE_AGENT_ID],
        buildcacheUrl: "https://cache.example.com",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { results: Array<{ agentId: string; pushed: boolean }> };
    };
    expect(body.data.results.find((r) => r.agentId === AGENT_ID)?.pushed).toBe(true);
    expect(body.data.results.find((r) => r.agentId === OFFLINE_AGENT_ID)?.pushed).toBe(false);
    expect(pushed).toBe(1);

    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.spec.distribute"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.actor).toBe(ROUTE_USER_ID);
  });

  test("POST /api/software/distribute — fails before push without canonical user id", async () => {
    const dispatcher = new AgentDispatcher();
    let pushed = 0;
    dispatcher.register(AGENT_ID, {
      push: () => {
        pushed += 1;
      },
      close: () => {},
    });
    const { app } = makeApp(
      "platform_admin",
      dispatcher,
      null,
      undefined,
      "casdoor|missing-software-actor",
      undefined,
      null,
    );
    const res = await app.request("/api/software/distribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec: "gromacs@2024.1",
        targetAgentIds: [AGENT_ID],
        buildcacheUrl: "https://cache.example.com",
      }),
    });

    expect(res.status).toBe(403);
    expect(pushed).toBe(0);
  });

  test("POST /api/software/distribute — 403 for plain user", async () => {
    const { app } = makeApp("user");
    const res = await app.request("/api/software/distribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: "x", targetAgentIds: [AGENT_ID] }),
    });
    expect(res.status).toBe(403);
  });

  test("POST /api/software/resolve-availability — uses the bound principal", async () => {
    let seenOrgId: string | null | undefined;
    const availability = {
      resolve: async (_payload: unknown, principal: { orgId: string | null }) => {
        seenOrgId = principal.orgId;
        return {
          spec: "gromacs@2024.1",
          installedAvailable: [],
          installableAvailable: [],
          blocked: [],
          explanations: [],
        };
      },
    } as unknown as SoftwareAvailabilityService;
    const { app } = makeApp("user", new AgentDispatcher(), ORG_A, availability);
    const res = await app.request("/api/software/resolve-availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawSpec: "gromacs@2024.1", installable: true }),
    });
    expect(res.status).toBe(200);
    expect(seenOrgId).toBe(ORG_A);
  });

  test("GET /api/software/review-queue — SpiceDB platform#view can authorize a non-platform JWT role", async () => {
    const calls: Array<{
      input: AuthzCheck & { localAllowed?: boolean };
      isPlatformAdmin: boolean;
    }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
    );

    const res = await app.request("/api/software/review-queue");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        input: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "sw-routes@test@example.test",
          resource: { type: "platform", id: "root" },
          permission: "view",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: { localAllowed: false, source: "software-review-queue" },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("POST /api/software/assets/:assetId/submit — requires software_provider capability", async () => {
    const [asset] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-submit",
        version: "1.0.0",
        source: "sp-draft",
        lifecycle: "draft",
        visibility: "private",
        ownerUserId: SOFTWARE_PROVIDER_USER,
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-submit", metadata: {} },
        },
        provenance: { source: "sp-draft" },
      })
      .returning();
    if (!asset) throw new Error("asset insert failed");

    const denied = makeApp("user", new AgentDispatcher(), ORG_A, undefined, SOFTWARE_PROVIDER_USER);
    const deniedRes = await denied.app.request(`/api/software/assets/${asset.id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "submit without capability" }),
    });
    expect(deniedRes.status).toBe(403);

    await dbHandle.insert(userCapabilities).values({
      userId: SOFTWARE_PROVIDER_USER,
      capability: "software_provider",
    });
    const opaqueSub = "casdoor|software-provider-submit";
    const allowed = makeApp(
      "user",
      new AgentDispatcher(),
      ORG_A,
      undefined,
      opaqueSub,
      undefined,
      SOFTWARE_PROVIDER_USER,
    );
    const allowedRes = await allowed.app.request(`/api/software/assets/${asset.id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "ready for review" }),
    });
    expect(allowedRes.status).toBe(200);
    const body = (await allowedRes.json()) as { data: { lifecycle: string; visibility: string } };
    expect(body.data.lifecycle).toBe("submitted");
    expect(body.data.visibility).toBe("pending-review");
    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.asset.submit"));
    const matching = audit.find((row) => row.target === asset.id);
    expect(matching?.actor).toBe(SOFTWARE_PROVIDER_USER);
    expect(matching?.actor).not.toBe(opaqueSub);
  });

  test("POST /api/software/assets/:assetId/review — SpiceDB software_asset#manage can authorize a non-platform JWT role", async () => {
    const [asset] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-review-enforce",
        version: "1.0.0",
        source: "sp-draft",
        lifecycle: "submitted",
        visibility: "pending-review",
        ownerUserId: SOFTWARE_PROVIDER_USER,
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-review-enforce", metadata: {} },
        },
        provenance: { source: "sp-draft" },
      })
      .returning();
    if (!asset) throw new Error("asset insert failed");
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
    );

    const res = await app.request(`/api/software/assets/${asset.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", reason: "approved by SpiceDB" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { lifecycle: string } };
    expect(body.data.lifecycle).toBe("approved");
    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.asset.review"));
    const matching = audit.find((row) => row.target === asset.id);
    expect(matching?.actor).toBe(ROUTE_USER_ID);
    expect(matching?.actor).not.toBe("sw-routes@test");
    expect(calls).toEqual([
      {
        input: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "sw-routes@test@example.test",
          resource: { type: "software_asset", id: asset.id },
          permission: "manage",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: {
            route: "software_asset#manage",
            path: `/api/software/assets/${asset.id}/review`,
          },
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("POST /api/software/assets/:assetId/review — enforce fails closed without canonical user id", async () => {
    const [asset] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-review-missing-user",
        version: "1.0.0",
        source: "sp-draft",
        lifecycle: "submitted",
        visibility: "pending-review",
        ownerUserId: SOFTWARE_PROVIDER_USER,
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-review-missing-user", metadata: {} },
        },
        provenance: { source: "sp-draft" },
      })
      .returning();
    if (!asset) throw new Error("asset insert failed");
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = enforcingAuthz(calls);
    const { app } = makeApp(
      "user",
      new AgentDispatcher(),
      null,
      undefined,
      "sw-routes@test",
      authz,
      null,
    );

    const res = await app.request(`/api/software/assets/${asset.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", reason: "missing canonical id" }),
    });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("POST /api/software/assets/:assetId/fork-official — creates platform fork", async () => {
    const [asset] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-fork",
        version: "2.0.0",
        source: "sp-draft",
        lifecycle: "approved",
        visibility: "pending-review",
        ownerUserId: SOFTWARE_PROVIDER_USER,
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-fork", metadata: {}, defaultSpec: "x@2" },
        },
        provenance: { source: "sp-draft" },
      })
      .returning();
    if (!asset) throw new Error("asset insert failed");
    const { app } = makeApp("platform_admin");
    const res = await app.request(`/api/software/assets/${asset.id}/fork-official`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { source: string; lifecycle: string; officialForkOfAssetId: string };
      reused: boolean;
    };
    expect(body.reused).toBe(false);
    expect(body.data.source).toBe("platform-fork");
    expect(body.data.lifecycle).toBe("published");
    expect(body.data.officialForkOfAssetId).toBe(asset.id);
    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.asset.fork_official"));
    const matching = audit.find((row) => row.target === asset.id);
    expect(matching?.actor).toBe(ROUTE_USER_ID);
    expect(matching?.actor).not.toBe("sw-routes@test");

    const again = await app.request(`/api/software/assets/${asset.id}/fork-official`, {
      method: "POST",
    });
    const againBody = (await again.json()) as { reused: boolean };
    expect(againBody.reused).toBe(true);
  });

  test("POST /api/software/assets/:assetId/fork-official projects platform fork relationships", async () => {
    const [asset] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-fork-authz",
        version: "2.0.0",
        source: "sp-draft",
        lifecycle: "approved",
        visibility: "pending-review",
        ownerUserId: SOFTWARE_PROVIDER_USER,
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-fork-authz", metadata: {} },
        },
        provenance: { source: "sp-draft" },
      })
      .returning();
    if (!asset) throw new Error("asset insert failed");
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const enqueued: unknown[][] = [];
    const authz = enforcingAuthzWithOutbox(calls, enqueued);
    const { app } = makeApp(
      "platform_admin",
      new AgentDispatcher(),
      null,
      undefined,
      DEFAULT_SUB,
      authz,
    );

    const res = await app.request(`/api/software/assets/${asset.id}/fork-official`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    const tuples = enqueued.flat();
    expect(tuples).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: body.data.id },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(tuples).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: body.data.id },
      relation: "installer",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
  });

  test("POST /api/software/assets/:assetId/lifecycle replaces derived platform tuples", async () => {
    const [asset] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-lifecycle-authz",
        version: "1.0.0",
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        trustedForGlobalUse: true,
        ownerUserId: ROUTE_USER_ID,
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-lifecycle-authz", metadata: {} },
        },
        provenance: { source: "platform-fork" },
      })
      .returning();
    if (!asset) throw new Error("asset insert failed");
    await dbHandle.insert(softwareAssetGrants).values({
      assetId: asset.id,
      subjectKind: "platform",
      subjectId: "platform",
      capabilities: ["install"],
      reason: "explicit platform install grant",
      createdBy: ROUTE_USER_ID,
    });
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const enqueued: unknown[][] = [];
    const authz = enforcingAuthzWithOutbox(calls, enqueued);
    const { app } = makeApp(
      "platform_admin",
      new AgentDispatcher(),
      null,
      undefined,
      DEFAULT_SUB,
      authz,
    );

    const res = await app.request(`/api/software/assets/${asset.id}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lifecycle: "archived", visibility: "hidden", reason: "retire" }),
    });

    expect(res.status).toBe(200);
    const tuples = enqueued.flat();
    expect(tuples).toContainEqual({
      operation: "delete",
      resource: { type: "software_asset", id: asset.id },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(tuples).toContainEqual({
      operation: "delete",
      resource: { type: "software_asset", id: asset.id },
      relation: "installer",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
    expect(tuples).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: asset.id },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(tuples).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: asset.id },
      relation: "installer",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
  });

  test("POST /api/software/assets/:assetId/lifecycle keeps a superseded upstream asset archived", async () => {
    const asset = await seedSupersededUpstreamAsset(
      dbHandle,
      "sw-routes-asset-superseded-lifecycle-guard",
    );
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const enqueued: unknown[][] = [];
    const { app } = makeApp(
      "platform_admin",
      new AgentDispatcher(),
      null,
      undefined,
      DEFAULT_SUB,
      enforcingAuthzWithOutbox(calls, enqueued),
    );

    for (const body of [
      { lifecycle: "published", visibility: "platform-public", reason: "restore" },
      { lifecycle: "deprecated", visibility: "hidden", reason: "change state" },
    ]) {
      const response = await app.request(`/api/software/assets/${asset.id}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(409);
    }

    const [stored, grants, audits] = await Promise.all([
      dbHandle.select().from(softwareAssets).where(eq(softwareAssets.id, asset.id)),
      dbHandle.select().from(softwareAssetGrants).where(eq(softwareAssetGrants.assetId, asset.id)),
      dbHandle.select().from(auditLog).where(eq(auditLog.target, asset.id)),
    ]);
    expect(stored).toMatchObject([
      {
        lifecycle: "archived",
        visibility: "hidden",
        reviewState: asset.reviewState,
      },
    ]);
    expect(grants).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("POST /api/software/assets/:assetId/lifecycle is side-effect free for the archived superseded state", async () => {
    const asset = await seedSupersededUpstreamAsset(
      dbHandle,
      "sw-routes-asset-superseded-lifecycle-idempotent",
    );
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const enqueued: unknown[][] = [];
    const { app } = makeApp(
      "platform_admin",
      new AgentDispatcher(),
      null,
      undefined,
      DEFAULT_SUB,
      enforcingAuthzWithOutbox(calls, enqueued),
    );

    const response = await app.request(`/api/software/assets/${asset.id}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lifecycle: "archived", reason: "confirm archived" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: asset.id, lifecycle: "archived", visibility: "hidden" },
    });
    const [stored, grants, audits] = await Promise.all([
      dbHandle.select().from(softwareAssets).where(eq(softwareAssets.id, asset.id)),
      dbHandle.select().from(softwareAssetGrants).where(eq(softwareAssetGrants.assetId, asset.id)),
      dbHandle.select().from(auditLog).where(eq(auditLog.target, asset.id)),
    ]);
    expect(stored[0]?.updatedAt).toEqual(asset.updatedAt);
    expect(stored[0]?.reviewState).toEqual(asset.reviewState);
    expect(grants).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("POST /api/software/grants/complete-downstream — grants missing use permission", async () => {
    const [pkg] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-package",
        version: "1.0.0",
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-package", metadata: {} },
        },
        provenance: { source: "platform-fork" },
      })
      .returning();
    if (!pkg) throw new Error("package asset insert failed");
    const [workflow] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "workflow-template",
        name: "sw-routes-asset-workflow",
        version: "1.0.0",
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        payload: {
          kind: "workflow-template",
          workflowTemplateId: "11111111-1111-4111-8111-111111111188",
          usecaseRefs: [],
          packageRefs: [{ kind: "spack-package", id: pkg.id }],
        },
        provenance: { source: "platform-fork" },
      })
      .returning();
    if (!workflow) throw new Error("workflow asset insert failed");

    const { app } = makeApp("platform_admin");
    const res = await app.request("/api/software/grants/complete-downstream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetRef: { kind: "workflow-template", id: workflow.id },
        subject: { kind: "org", orgId: ORG_A },
        capabilities: ["use"],
      }),
    });
    expect(res.status).toBe(200);
    const grants = await dbHandle
      .select()
      .from(softwareAssetGrants)
      .where(eq(softwareAssetGrants.assetId, pkg.id));
    expect(
      grants.some((grant) => grant.subjectId === ORG_A && grant.capabilities.includes("use")),
    ).toBe(true);
    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.asset.grants.complete_downstream"));
    const matching = audit.find((row) => row.target === workflow.id);
    expect(matching?.actor).toBe(ROUTE_USER_ID);
    expect(matching?.actor).not.toBe("sw-routes@test");

    const second = await app.request("/api/software/grants/complete-downstream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetRef: { kind: "workflow-template", id: workflow.id },
        subject: { kind: "org", orgId: ORG_A },
        capabilities: ["use"],
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { completed: unknown[] } };
    expect(secondBody.data.completed).toEqual([]);
  });

  test("software access requests can be created and approved into grants", async () => {
    const [asset] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-access",
        version: "1.0.0",
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-access", metadata: {} },
        },
        provenance: { source: "platform-fork" },
      })
      .returning();
    if (!asset) throw new Error("asset insert failed");

    const requesterSub = "casdoor|software-access-requester";
    const userApp = makeApp(
      "user",
      new AgentDispatcher(),
      ORG_A,
      undefined,
      requesterSub,
      undefined,
      ROUTE_USER_ID,
    );
    const createRes = await userApp.app.request("/api/software/access-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetRef: { kind: "spack-package", id: asset.id },
        capability: "install",
        reason: "need this package",
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { data: { id: string; status: string } };
    expect(createBody.data.status).toBe("pending");
    const createAudits = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.access_request.create"));
    const createAudit = createAudits.find((row) => row.target === asset.id);
    expect(createAudit?.actor).toBe(ROUTE_USER_ID);
    expect(createAudit?.actor).not.toBe(requesterSub);

    const reviewerSub = "casdoor|software-access-reviewer";
    const platform = makeApp(
      "platform_admin",
      new AgentDispatcher(),
      null,
      undefined,
      reviewerSub,
      undefined,
      ROUTE_USER_ID,
    );
    const reviewRes = await platform.app.request(
      `/api/software/access-requests/${createBody.data.id}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved", reason: "approved for test" }),
      },
    );
    expect(reviewRes.status).toBe(200);
    const grants = await dbHandle
      .select()
      .from(softwareAssetGrants)
      .where(eq(softwareAssetGrants.assetId, asset.id));
    expect(
      grants.some(
        (grant) =>
          grant.subjectKind === "user" &&
          grant.subjectId === ROUTE_USER_ID &&
          grant.capabilities.includes("install"),
      ),
    ).toBe(true);
    const reviewAudits = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "software.access_request.review"));
    const reviewAudit = reviewAudits.find((row) => row.target === asset.id);
    expect(reviewAudit?.actor).toBe(ROUTE_USER_ID);
    expect(reviewAudit?.actor).not.toBe(reviewerSub);
  });

  test("PUT /api/software/assets/:assetId/grants deletes stale SpiceDB grant tuples", async () => {
    const [asset] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-grant-replace",
        version: "1.0.0",
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        ownerUserId: ROUTE_USER_ID,
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-grant-replace", metadata: {} },
        },
        provenance: { source: "platform-fork" },
      })
      .returning();
    if (!asset) throw new Error("asset insert failed");
    await dbHandle.insert(softwareAssetGrants).values({
      assetId: asset.id,
      subjectKind: "user",
      subjectId: SOFTWARE_PROVIDER_USER,
      capabilities: ["install"],
      reason: "stale grant",
      createdBy: ROUTE_USER_ID,
    });
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const enqueued: unknown[][] = [];
    const authz = enforcingAuthzWithOutbox(calls, enqueued);
    const { app } = makeApp("user", new AgentDispatcher(), ORG_A, undefined, DEFAULT_SUB, authz);

    const res = await app.request(`/api/software/assets/${asset.id}/grants`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grants: [
          {
            subject: { kind: "org", orgId: ORG_A },
            capabilities: ["use"],
            reason: "replace with org grant",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(enqueued).toContainEqual([
      {
        operation: "delete",
        resource: { type: "software_asset", id: asset.id },
        relation: "installer",
        subject: { type: "user", id: SOFTWARE_PROVIDER_USER },
      },
    ]);
    expect(enqueued).toContainEqual([
      {
        operation: "create",
        resource: { type: "software_asset", id: asset.id },
        relation: "user",
        subject: { type: "organization", id: ORG_A, relation: "use" },
      },
    ]);
    const grants = await dbHandle
      .select()
      .from(softwareAssetGrants)
      .where(eq(softwareAssetGrants.assetId, asset.id));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.subjectKind).toBe("org");
    expect(grants[0]?.subjectId).toBe(ORG_A);
  });

  test("review detail and impact expose revisions, downstream refs, and cache status", async () => {
    const [pkg] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name: "sw-routes-asset-review-detail",
        version: "1.0.0",
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        payload: {
          kind: "spack-package",
          spack: { packageName: "sw-routes-asset-review-detail", metadata: {} },
        },
        provenance: { source: "platform-fork" },
      })
      .returning();
    if (!pkg) throw new Error("package asset insert failed");
    const [workflow] = await dbHandle
      .insert(softwareAssets)
      .values({
        kind: "workflow-template",
        name: "sw-routes-asset-review-workflow",
        version: "1.0.0",
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        payload: {
          kind: "workflow-template",
          workflowTemplateId: "11111111-1111-4111-8111-111111111177",
          packageRefs: [{ kind: "spack-package", id: pkg.id }],
        },
        provenance: { source: "platform-fork" },
      })
      .returning();
    if (!workflow) throw new Error("workflow asset insert failed");
    await dbHandle.insert(softwareAssetRevisions).values([
      {
        assetId: pkg.id,
        revision: 1,
        payload: { spack: { defaultSpec: "sw-routes-asset-review-detail@1" } },
        provenance: { test: true },
      },
      {
        assetId: pkg.id,
        revision: 2,
        payload: { spack: { defaultSpec: "sw-routes-asset-review-detail@2" } },
        provenance: { test: true },
      },
    ]);
    await dbHandle.insert(softwareMirrorCache).values({
      assetId: pkg.id,
      kind: "source",
      status: "cached",
      sourceUrl: "https://example.test/source.tar.gz",
      localUrl: "s3://software-mirror/source.tar.gz",
      sha256: "a".repeat(64),
    });

    const { app } = makeApp("platform_admin");
    const detailRes = await app.request(`/api/software/assets/${pkg.id}/review-detail`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      data: {
        latestRevision: { revision: number };
        previousRevision: { revision: number };
        impact: { downstream: Array<{ id: string }> };
      };
    };
    expect(detail.data.latestRevision.revision).toBe(2);
    expect(detail.data.previousRevision.revision).toBe(1);
    expect(detail.data.impact.downstream.some((item) => item.id === workflow.id)).toBe(true);

    const mirrorRes = await app.request(`/api/software/mirror-cache/status?assetId=${pkg.id}`);
    expect(mirrorRes.status).toBe(200);
    const mirror = (await mirrorRes.json()) as { data: Array<{ status: string; kind: string }> };
    expect(mirror.data).toEqual([expect.objectContaining({ kind: "source", status: "cached" })]);
  });
});
