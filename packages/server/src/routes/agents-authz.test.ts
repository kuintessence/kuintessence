import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode, type RoleName } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { AgentManager } from "../services/agent-manager";
import { createAgentRoutes } from "./agents";

const agentRow = {
  agentId: "agent-1",
  siteName: "site-1",
  status: "online",
  lastHeartbeat: null,
  cpuCores: 8,
  gpuCount: 1,
  memGb: 32,
  tags: [],
  schedulerType: "slurm",
  schedulerVersion: "23.02.7",
  queueDepth: 0,
  providerOrgId: "provider-org",
  siteId: "site-1",
  clusterId: "cluster-1",
  capabilities: [],
};

function fakeAgentManager(): AgentManager {
  return {
    list: async () => [agentRow],
    getById: async (agentId: string) => (agentId === agentRow.agentId ? agentRow : null),
  } as unknown as AgentManager;
}

function appWithAuthz(
  authz: AuthzService,
  orgId = "provider-org",
  principalUserId: string | null = "user-1",
  options: {
    principalEmail?: string;
    principalRole?: RoleName | null;
    userEmail?: string;
    userRole?: RoleName;
  } = {},
  agentManager: AgentManager = fakeAgentManager(),
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const userRole = options.userRole ?? "org_admin";
    const principalRole = options.principalRole === undefined ? userRole : options.principalRole;
    const userEmail = options.userEmail ?? "admin@example.com";
    const principalEmail = options.principalEmail ?? userEmail;
    c.set("user", {
      sub: "user-sub",
      email: userEmail,
      role: userRole,
    });
    c.set("principal" as never, {
      sub: "user-sub",
      email: principalEmail,
      role: principalRole,
      userId: principalUserId,
      orgId,
      orgIds: [orgId],
      memberships: [{ orgId, role: "admin" }],
    });
    await next();
  });
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.route("/api", createAgentRoutes(agentManager, { authz }));
  return app;
}

describe("Agent routes SpiceDB authorization", () => {
  test("filters agent inventory through agent#view lookup in enforce mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      lookupResources: async (input: unknown) => {
        calls.push(input);
        return [];
      },
    } as unknown as AuthzService;
    const manager = {
      list: async () => {
        throw new Error("full list should not be read");
      },
      listByIds: async (ids: string[]) => {
        expect(ids).toEqual([]);
        return [];
      },
    } as unknown as AgentManager;

    const res = await appWithAuthz(authz, "provider-org", "user-1", {}, manager).request(
      "/api/agents",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [] });
    expect(calls).toEqual([
      {
        resourceType: "agent",
        permission: "view",
        subject: { type: "user", id: "user-1" },
      },
    ]);
  });

  test("uses bound principal email instead of token email for agent#view actor display", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;

    const res = await appWithAuthz(authz, "provider-org", "user-1", {
      principalEmail: "bound-agent@example.com",
      userEmail: "stale-token-agent@example.com",
    }).request("/api/agents/agent-1");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "bound-agent@example.com",
        resource: { type: "agent", id: "agent-1" },
        permission: "view",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: true, providerOrgId: "provider-org" },
        localAllowed: true,
      },
    ]);
  });

  test("rejects agent detail when agent#view is denied in enforce mode", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      },
    } as unknown as AuthzService;

    const res = await appWithAuthz(authz).request("/api/agents/agent-1");

    expect(res.status).toBe(403);
  });

  test("fails closed without canonical user id in enforce mode", async () => {
    const calls: unknown[] = [];
    const reads: string[] = [];
    const authz = {
      mode: "enforce",
      lookupResources: async (input: unknown) => {
        calls.push(input);
        return ["agent-1"];
      },
    } as unknown as AuthzService;
    const manager = {
      list: async () => {
        reads.push("list");
        return [agentRow];
      },
      listByIds: async () => {
        reads.push("listByIds");
        return [agentRow];
      },
      getById: async () => {
        reads.push("getById");
        return agentRow;
      },
    } as unknown as AgentManager;

    const app = appWithAuthz(authz, "provider-org", null, {}, manager);
    const listRes = await app.request("/api/agents");
    expect(listRes.status).toBe(403);

    const detailRes = await app.request("/api/agents/agent-1");
    expect(detailRes.status).toBe(403);
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("fails closed without canonical user id in shadow mode", async () => {
    const calls: unknown[] = [];
    const reads: string[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;
    const manager = {
      list: async () => {
        reads.push("list");
        return [agentRow];
      },
      getById: async () => {
        reads.push("getById");
        return agentRow;
      },
    } as unknown as AgentManager;

    const app = appWithAuthz(authz, "provider-org", null, {}, manager);
    const listRes = await app.request("/api/agents");
    expect(listRes.status).toBe(403);

    const detailRes = await app.request("/api/agents/agent-1");
    expect(detailRes.status).toBe(403);
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("allows agents visible only through agent#view in enforce mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      lookupResources: async (input: unknown) => {
        calls.push(input);
        return ["agent-1"];
      },
    } as unknown as AuthzService;
    const manager = {
      list: async () => {
        throw new Error("full list should not be read");
      },
      listByIds: async (ids: string[]) => {
        expect(ids).toEqual(["agent-1"]);
        return [agentRow];
      },
    } as unknown as AgentManager;

    const res = await appWithAuthz(authz, "other-org", "user-1", {}, manager).request(
      "/api/agents",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ agentId: string }> };
    expect(body.agents.map((agent) => agent.agentId)).toEqual(["agent-1"]);
    expect(calls).toEqual([
      {
        resourceType: "agent",
        permission: "view",
        subject: { type: "user", id: "user-1" },
      },
    ]);
  });

  test("fails closed before reading inventory when agent lookup is unavailable", async () => {
    let reads = 0;
    const authz = {
      mode: "enforce",
      lookupResources: async () => {
        throw new Error("lookup down");
      },
    } as unknown as AuthzService;
    const manager = {
      list: async () => {
        reads += 1;
        return [agentRow];
      },
      listByIds: async () => {
        reads += 1;
        return [agentRow];
      },
    } as unknown as AgentManager;

    const res = await appWithAuthz(authz, "provider-org", "user-1", {}, manager).request(
      "/api/agents",
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Authorization unavailable: lookup down" },
    });
    expect(reads).toBe(0);
  });

  test("allows agent detail authorized only through agent#view in enforce mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;

    const res = await appWithAuthz(authz, "other-org").request("/api/agents/agent-1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string };
    expect(body.agentId).toBe("agent-1");
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "admin@example.com",
        resource: { type: "agent", id: "agent-1" },
        permission: "view",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false, providerOrgId: "provider-org" },
        localAllowed: false,
      },
    ]);
  });

  test("degraded fallback does not trust JWT platform_admin without a bound role", async () => {
    const fallbackDecisions: boolean[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (_input: unknown, isPlatformAdmin: boolean) => {
        fallbackDecisions.push(isPlatformAdmin);
      },
    } as unknown as AuthzService;

    const res = await appWithAuthz(authz, "other-org", "user-1", {
      principalRole: null,
      userRole: "platform_admin",
    }).request("/api/agents/agent-1");

    expect(res.status).toBe(200);
    expect(fallbackDecisions).toEqual([false]);
  });
});
