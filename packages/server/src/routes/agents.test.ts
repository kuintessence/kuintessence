import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentUpdateListSchema, type AgentUpdateRequest } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import type { AgentManager } from "../services/agent-manager";
import type { AgentUpdateService } from "../services/agent-update";
import { type AgentRouteOptions, createAgentRoutes } from "./agents";

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

  function appFor(
    role: "platform_admin" | "org_admin" | "operator" | "user",
    orgId: string | null = null,
    options: AgentRouteOptions = {},
  ) {
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
    app.route("/api", createAgentRoutes(manager, options));
    return app;
  }

  test("operator discovers agents across providers without changing provider membership", async () => {
    const response = await appFor("operator").request("/api/agents");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { agents: unknown[] }).agents).toHaveLength(2);
    expect((await appFor("operator").request("/api/agents/route-test-agent-b")).status).toBe(200);
  });

  test("platform notices and remote updates preserve provider ownership and pinned release validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-update-routes-"));
    const entries: Awaited<ReturnType<AgentUpdateService["list"]>> = [];
    const updates = {
      list: async (agentId: string) => entries.filter((entry) => entry.agentId === agentId),
      request: async (agentId: string, requestedBy: string, input: AgentUpdateRequest) => {
        const entry = {
          ...input,
          agentId,
          requestedBy,
          state: "requested",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        entries.push(entry);
        return entry;
      },
    };
    const manifest = JSON.stringify({
      version: 1,
      sequence: 1,
      serverRevision: "a".repeat(40),
      stateFormat: "v1",
      architecture: "x86_64",
      minGlibc: "2.34",
      cpuFlags: [],
      redistribution: "unrestricted",
      files: ["agent", "cli"].map((role) => ({
        name: role,
        role,
        size: 1,
        sha256: "b".repeat(64),
        executable: true,
      })),
    });
    const release = createHash("sha256").update(manifest).digest("hex");
    await mkdir(join(root, "releases", release), { recursive: true });
    await writeFile(join(root, "releases", release, "manifest.json"), manifest);
    const options = { updates, siteReleasesDir: root };
    const post = (
      role: "platform_admin" | "operator" | "org_admin" | "user",
      orgId: string | null,
      kind = "update",
      target = release,
    ) =>
      appFor(role, orgId, options).request("/api/agents/route-test-agent/updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          kind,
          release: target,
          message: "Please update",
        }),
      });
    try {
      expect((await post("org_admin", orgB)).status).toBe(404);
      expect((await post("user", orgA)).status).toBe(404);
      expect((await post("org_admin", orgA, "notice")).status).toBe(403);
      expect((await post("operator", null, "notice")).status).toBe(202);
      expect((await post("org_admin", orgA)).status).toBe(202);
      expect((await post("platform_admin", null)).status).toBe(202);
      expect((await post("platform_admin", null, "update", "0".repeat(64))).status).toBe(400);
      expect((await post("platform_admin", null, "update", "../../agent")).status).toBe(400);
      expect(entries).toHaveLength(3);
      const result = await appFor("org_admin", orgA, options).request(
        "/api/agents/route-test-agent/updates",
      );
      expect(result.status).toBe(200);
      expect(AgentUpdateListSchema.parse(await result.json()).requests).toHaveLength(3);
      expect(
        (await appFor("org_admin", orgB, options).request("/api/agents/route-test-agent/updates"))
          .status,
      ).toBe(404);
      expect(
        (await appFor("operator", null, options).request("/api/agents/route-test-agent/updates"))
          .status,
      ).toBe(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
