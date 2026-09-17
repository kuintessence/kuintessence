import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import type { OwnershipPrincipal } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import type { AgentDispatcher } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import type { SoftwareAvailabilityService } from "../services/software-availability";
import type { InstalledRegistry } from "../software-governance/installed-registry";
import type { PolicyPusher } from "../software-governance/policy-pusher";
import type { PolicyStore, StoredPolicy } from "../software-governance/policy-store";
import {
  createSoftwareRoutes,
  softwarePolicyVisibleToPrincipal,
  subjectIdForSoftwareAuthz,
} from "./software";

function storedPolicy(agentId: string): StoredPolicy {
  return {
    agentId,
    scope: "agent",
    version: "v1",
    updatedAt: new Date("2026-07-13T00:00:00Z"),
    allowList: [],
    denyList: [],
    lockEnabled: false,
    mirrors: [],
    preinstallList: [],
  };
}

function policyListApp(principalUserId: string | null) {
  const policies = [
    storedPolicy("agent-a"),
    storedPolicy("agent-b"),
    storedPolicy("legacy-agent"),
    storedPolicy("orphan-agent"),
  ];
  const listCalls: string[] = [];
  const db = {
    select: () => ({
      from: async () => [
        { agentId: "agent-a", providerOrgId: "org-a" },
        { agentId: "agent-b", providerOrgId: "org-b" },
        { agentId: "legacy-agent", providerOrgId: null },
      ],
    }),
  } as unknown as PgDb;
  const policyStore = {
    listAll: async () => {
      listCalls.push("listAll");
      return policies;
    },
  } as unknown as PolicyStore;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("user" as never, { sub: "user-a", role: "org_admin", email: "a@example.test" });
    c.set("principal" as never, {
      sub: "user-a",
      userId: principalUserId,
      role: "org_admin",
      email: "a@example.test",
      orgId: "org-a",
      orgIds: ["org-a"],
      memberships: [{ orgId: "org-a", role: "admin" }],
    });
    await next();
  });
  app.route(
    "/api",
    createSoftwareRoutes({
      db,
      policyStore,
      installedRegistry: {} as InstalledRegistry,
      policyPusher: {} as PolicyPusher,
      dispatcher: {} as AgentDispatcher,
    }),
  );
  return { app, listCalls };
}

function unboundGovernanceReadApp() {
  const calls = { db: 0, installed: 0, availability: 0 };
  const db = {
    select: () => {
      calls.db += 1;
      throw new Error("database should not be read");
    },
  } as unknown as PgDb;
  const installedRegistry = {
    listForAgent: async () => {
      calls.installed += 1;
      return [];
    },
  } as unknown as InstalledRegistry;
  const availability = {
    resolve: async () => {
      calls.availability += 1;
      throw new Error("availability should not run");
    },
  } as unknown as SoftwareAvailabilityService;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("user" as never, { sub: "opaque-sub", role: "org_admin", email: "a@example.test" });
    c.set("principal" as never, {
      sub: "opaque-sub",
      userId: null,
      role: "org_admin",
      email: "a@example.test",
      orgId: "org-a",
      orgIds: ["org-a"],
      memberships: [{ orgId: "org-a", role: "admin" }],
    });
    await next();
  });
  app.route(
    "/api",
    createSoftwareRoutes({
      db,
      installedRegistry,
      availability,
      policyStore: {} as PolicyStore,
      policyPusher: {} as PolicyPusher,
      dispatcher: {} as AgentDispatcher,
    }),
  );
  return { app, calls };
}

describe("software route authz subject binding", () => {
  test("uses the canonical user id in enforce mode", () => {
    const authz = { mode: "enforce" } as AuthzService;
    expect(subjectIdForSoftwareAuthz(authz, "user-uuid")).toBe("user-uuid");
  });

  test("fails closed in enforce mode when the canonical user id is missing", () => {
    const authz = { mode: "enforce" } as AuthzService;
    expect(subjectIdForSoftwareAuthz(authz, null)).toBeNull();
  });

  test("requires canonical user id in shadow mode", () => {
    const shadow = { mode: "shadow" } as AuthzService;
    expect(subjectIdForSoftwareAuthz(shadow, null)).toBeNull();
  });

  test("does not use authenticated subject fallback when authz is off", () => {
    expect(subjectIdForSoftwareAuthz(undefined, null)).toBeNull();
    expect(subjectIdForSoftwareAuthz({ mode: "off" } as AuthzService, null)).toBeNull();
    expect(subjectIdForSoftwareAuthz({ mode: "off" } as AuthzService, "user-uuid")).toBe(
      "user-uuid",
    );
  });

  test("scopes local software policy visibility to the provider organization", () => {
    const principal: OwnershipPrincipal = {
      sub: "user-1",
      userId: "user-1",
      email: "provider-a@example.test",
      role: "org_admin",
      orgId: "org-a",
      orgIds: ["org-a"],
    };
    expect(softwarePolicyVisibleToPrincipal(principal, "agent-a", "org-a")).toBe(true);
    expect(softwarePolicyVisibleToPrincipal(principal, "agent-b", "org-b")).toBe(false);
    expect(softwarePolicyVisibleToPrincipal(principal, "legacy-agent", null)).toBe(true);
    expect(softwarePolicyVisibleToPrincipal(null, "agent-a", "org-a")).toBe(false);
  });

  test("filters the local policy list by provider ownership", async () => {
    const { app, listCalls } = policyListApp("user-a");

    const res = await app.request("/api/software/policies");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: StoredPolicy[] };
    expect(body.data.map((policy) => policy.agentId)).toEqual(["agent-a", "legacy-agent"]);
    expect(listCalls).toEqual(["listAll"]);
  });

  test("rejects an unbound policy-list caller before loading policies", async () => {
    const { app, listCalls } = policyListApp(null);

    const res = await app.request("/api/software/policies");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { message: "Authorization principal is not bound" },
    });
    expect(listCalls).toEqual([]);
  });

  test("rejects unbound Agent software reads before DB or registry access", async () => {
    const { app, calls } = unboundGovernanceReadApp();

    const installed = await app.request("/api/software/agents/agent-a/installed");
    const policy = await app.request("/api/software/policies/agent-a");

    expect(installed.status).toBe(403);
    expect(policy.status).toBe(403);
    expect(calls).toEqual({ db: 0, installed: 0, availability: 0 });
  });

  test("rejects unbound availability resolution before service access", async () => {
    const { app, calls } = unboundGovernanceReadApp();

    const res = await app.request("/api/software/resolve-availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specs: ["hdf5"] }),
    });

    expect(res.status).toBe(403);
    expect(calls).toEqual({ db: 0, installed: 0, availability: 0 });
  });

  test("rejects unbound asset governance reads before DB access", async () => {
    const { app, calls } = unboundGovernanceReadApp();

    const responses = await Promise.all([
      app.request("/api/software/assets/asset-a/review-detail"),
      app.request("/api/software/assets/asset-a/impact"),
      app.request("/api/software/assets/asset-a/grants"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(calls).toEqual({ db: 0, installed: 0, availability: 0 });
  });
});
