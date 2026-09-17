import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import type { AgentManager } from "../services/agent-manager";
import { createAgentRoutes } from "./agents";

const testLogger = pino({ level: "silent" });

describe("Agent routes", () => {
  const orgA = "00000000-0000-4000-8000-0000000000a1";
  const orgB = "00000000-0000-4000-8000-0000000000b1";
  const routeAgents = [
    {
      agentId: "route-test-agent",
      siteName: "route-site",
      providerOrgId: orgA,
      siteId: "route-site",
      clusterId: "cluster-a",
      topology: {},
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      status: "online",
      cpuUsagePercent: 0,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
      queueDepth: 0,
      historicalP95WaitSec: null,
      lastHeartbeat: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      diskUsedPercent: undefined,
      gpus: [],
    },
    {
      agentId: "route-test-agent-b",
      siteName: "route-site-b",
      providerOrgId: orgB,
      siteId: "route-site-b",
      clusterId: "cluster-b",
      topology: {},
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      status: "online",
      cpuUsagePercent: 0,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
      queueDepth: 0,
      historicalP95WaitSec: null,
      lastHeartbeat: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      diskUsedPercent: undefined,
      gpus: [],
    },
  ] as const;
  const manager = {
    list: async () => [...routeAgents],
    getById: async (agentId: string) =>
      routeAgents.find((agent) => agent.agentId === agentId) ?? null,
  } as unknown as AgentManager;

  function appFor(role: "platform_admin" | "org_admin" | "user", orgId: string | null = null) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { sub: `${role}@agent.test`, email: `${role}@agent.test`, role });
      c.set("principal" as never, {
        sub: `${role}@agent.test`,
        userId: "00000000-0000-4000-8000-0000000000c1",
        email: `${role}@agent.test`,
        role,
        orgId,
        orgIds: orgId ? [orgId] : [],
      });
      await next();
    });
    app.onError(createErrorHandler(testLogger));
    app.route("/api", createAgentRoutes(manager));
    return app;
  }

  test("GET /api/agents returns all agents for platform admin", async () => {
    const res = await appFor("platform_admin").request("/api/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ agentId: string }> };
    expect(body.agents).toBeInstanceOf(Array);
    expect(body.agents.some((a) => a.agentId === "route-test-agent")).toBe(true);
    expect(body.agents.some((a) => a.agentId === "route-test-agent-b")).toBe(true);
  });

  test("GET /api/agents filters provider org admins to their agents", async () => {
    const res = await appFor("org_admin", orgA).request("/api/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ agentId: string }> };
    expect(body.agents.some((a) => a.agentId === "route-test-agent")).toBe(true);
    expect(body.agents.some((a) => a.agentId === "route-test-agent-b")).toBe(false);
  });

  test("GET /api/agents hides provider agents from plain users", async () => {
    const res = await appFor("user", orgA).request("/api/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ agentId: string }> };
    expect(body.agents.some((a) => a.agentId === "route-test-agent")).toBe(false);
  });

  test("GET /api/agents/:id returns agent", async () => {
    const res = await appFor("org_admin", orgA).request("/api/agents/route-test-agent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string };
    expect(body.agentId).toBe("route-test-agent");
  });

  test("GET /api/agents/:id hides another provider org's agent", async () => {
    const res = await appFor("org_admin", orgB).request("/api/agents/route-test-agent");
    expect(res.status).toBe(404);
  });

  test("GET /api/agents/:id returns 404 for unknown", async () => {
    const res = await appFor("platform_admin").request("/api/agents/nonexistent-xyz");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
