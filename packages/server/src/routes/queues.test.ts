import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import type {
  QueueRegistryCreate,
  QueueRegistryUpdate,
  QueueRegistryView,
} from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { QueueAccessContext, QueueRegistryService } from "../services/queue-registry";
import { createQueueRoutes } from "./queues";

const testLogger = pino({ level: "silent" });

describe("Queue routes", () => {
  const db = {} as PgDb;
  const orgId = "00000000-0000-4000-8000-00000000c001";
  const userEmail = "queue-user@kuintessence.test";
  const adminEmail = "queue-admin@kuintessence.test";
  const userId = "00000000-0000-4000-8000-00000000q001".replace("q", "0");
  const adminId = "00000000-0000-4000-8000-00000000q002".replace("q", "0");
  const alternateOrgId = "00000000-0000-4000-8000-00000000c002";
  const unrelatedOrgId = "00000000-0000-4000-8000-00000000c003";
  const contexts: QueueAccessContext[] = [];

  const queue: QueueRegistryView = {
    queueId: "q-1",
    name: "Queue 1",
    providerOrgId: "00000000-0000-4000-8000-000000000001",
    visibleOrgIds: [],
    agentId: "agent-1",
    schedulerType: "slurm",
    queueName: "batch",
    qos: null,
    enabled: true,
    policyTags: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  const service = {
    listVisible: async (ctx: QueueAccessContext) => {
      contexts.push(ctx);
      return [queue];
    },
    listAdmin: async (ctx: QueueAccessContext) => {
      contexts.push(ctx);
      return [queue];
    },
    create: async (_input: QueueRegistryCreate, ctx: QueueAccessContext) => {
      contexts.push(ctx);
      return queue;
    },
    update: async (_queueId: string, _patch: QueueRegistryUpdate, ctx: QueueAccessContext) => {
      contexts.push(ctx);
      return queue;
    },
    getAgentInventoryForAdmin: async (agentId: string, ctx: QueueAccessContext) => {
      contexts.push(ctx);
      return {
        agentId,
        providerOrgId: queue.providerOrgId,
        schedulerType: "slurm",
        queueInventoryV1: true,
        status: "available",
        defaultQueueName: "batch",
        reason: null,
        observedAt: new Date(0),
        queues: [],
        managedTargets: [],
      };
    },
  } as unknown as QueueRegistryService;

  function appFor(
    email: string,
    role: string,
    authz?: AuthzService,
    principalRole = role,
    principalUserId: string | null = email === adminEmail ? adminId : userId,
    organizationScope: { orgId: string; orgIds: string[] } = { orgId, orgIds: [orgId] },
  ) {
    const app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.use("*", async (c, next) => {
      c.set("user" as never, { sub: email, role, email });
      c.set("principal" as never, {
        sub: email,
        email,
        role: principalRole,
        userId: principalUserId,
        orgId: organizationScope.orgId,
        orgIds: organizationScope.orgIds,
        memberships: organizationScope.orgIds.map((membershipOrgId) => ({
          orgId: membershipOrgId,
          role: principalRole === "org_admin" ? "admin" : "member",
        })),
        platformRelations: [],
      });
      await next();
    });
    app.route("/api", createQueueRoutes(service, db, { authz }));
    return app;
  }

  test("visible route resolves caller org and returns service queues", async () => {
    contexts.length = 0;
    const res = await appFor(userEmail, "user").request("/api/queues/visible");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queues: QueueRegistryView[] };
    expect(body.queues[0]?.queueId).toBe("q-1");
    expect(contexts[0]).toEqual(
      expect.objectContaining({ role: "user", orgId, orgIds: [orgId], userId, email: userEmail }),
    );
  });

  test("all queue read endpoints use the validated active-organization scope", async () => {
    const app = appFor(adminEmail, "org_admin", undefined, "org_admin", adminId, {
      orgId,
      orgIds: [orgId, alternateOrgId],
    });
    const paths = [
      "/api/queues/visible",
      "/api/admin/queues",
      "/api/admin/agents/agent-1/queue-inventory",
    ];

    for (const path of paths) {
      contexts.length = 0;
      const response = await app.request(path, {
        headers: { "X-KQ-Active-Organization": alternateOrgId },
      });
      expect(response.status).toBe(200);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toEqual(
        expect.objectContaining({ orgId: alternateOrgId, orgIds: [alternateOrgId] }),
      );
    }

    contexts.length = 0;
    const denied = await app.request("/api/queues/visible", {
      headers: { "X-KQ-Active-Organization": unrelatedOrgId },
    });
    expect(denied.status).toBe(403);
    expect(contexts).toHaveLength(0);
  });

  test("visible route fails closed without a canonical principal user id", async () => {
    contexts.length = 0;
    const res = await appFor(userEmail, "user", undefined, "user", null).request(
      "/api/queues/visible",
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(contexts).toHaveLength(0);
  });

  test("admin queue create requires org_admin or above", async () => {
    const denied = await appFor(userEmail, "user").request("/api/admin/queues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queueId: "q-denied",
        name: "denied",
        agentId: "agent-1",
        schedulerType: "slurm",
        queueName: "batch",
      }),
    });
    expect(denied.status).toBe(403);

    contexts.length = 0;
    const allowed = await appFor(adminEmail, "org_admin").request("/api/admin/queues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queueId: "q-allowed",
        name: "allowed",
        agentId: "agent-1",
        schedulerType: "slurm",
        queueName: "batch",
      }),
    });
    expect(allowed.status).toBe(201);
    expect(contexts[0]).toEqual(
      expect.objectContaining({
        role: "org_admin",
        orgId,
        orgIds: [orgId],
        userId: adminId,
        email: adminEmail,
      }),
    );
  });

  test("admin inventory route resolves the bound principal and preserves provider scoping", async () => {
    contexts.length = 0;
    const response = await appFor(adminEmail, "org_admin").request(
      "/api/admin/agents/agent-1/queue-inventory",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      agentId: "agent-1",
      defaultQueueName: "batch",
    });
    expect(contexts[0]).toEqual(
      expect.objectContaining({ role: "org_admin", orgId, userId: adminId }),
    );
  });

  test("admin queue routes defer local role gating to SpiceDB in enforce mode", async () => {
    const authz = { mode: "enforce" } as unknown as AuthzService;

    contexts.length = 0;
    const listed = await appFor(userEmail, "user", authz).request("/api/admin/queues");
    expect(listed.status).toBe(200);
    expect(contexts[0]).toEqual(
      expect.objectContaining({ role: "user", orgId, orgIds: [orgId], userId, email: userEmail }),
    );

    contexts.length = 0;
    const created = await appFor(userEmail, "user", authz).request("/api/admin/queues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queueId: "q-spicedb",
        name: "spicedb",
        agentId: "agent-1",
        schedulerType: "slurm",
        queueName: "batch",
      }),
    });
    expect(created.status).toBe(201);
    expect(contexts[0]).toEqual(
      expect.objectContaining({ role: "user", orgId, orgIds: [orgId], userId, email: userEmail }),
    );
  });

  test("admin queue routes fail closed in enforce mode without a canonical principal", async () => {
    const authz = { mode: "enforce" } as unknown as AuthzService;

    contexts.length = 0;
    const res = await appFor(userEmail, "user", authz, "user", null).request("/api/admin/queues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queueId: "q-missing-principal",
        name: "missing principal",
        agentId: "agent-1",
        schedulerType: "slurm",
        queueName: "batch",
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(contexts).toHaveLength(0);
  });

  test("queue context uses bound principal role instead of stale JWT role", async () => {
    const authz = { mode: "enforce" } as unknown as AuthzService;

    contexts.length = 0;
    const res = await appFor(userEmail, "platform_admin", authz, "user").request(
      "/api/admin/queues",
    );

    expect(res.status).toBe(200);
    expect(contexts[0]).toEqual(
      expect.objectContaining({ role: "user", orgId, orgIds: [orgId], userId, email: userEmail }),
    );
  });
});
