import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlatformCapability } from "@kuintessence/shared/browser";
import { describe, expect, test } from "vitest";
import { canSeeMapRoute, type MapAccess, mapDestination, visibleMap } from "./access";
import catalog from "./catalog.json";
import type { FunctionMap, MapNode } from "./model";
import { acquisitionState, authorizationRuntime, infrastructureRuntime } from "./runtime";

const maps = catalog as FunctionMap[];
const access: MapAccess = {
  role: "user",
  local: false,
  localCapabilities: null,
  ready: true,
  platform: new Set<PlatformCapability>([
    "workspace.consumer.access",
    "workspace.ecosystem.view",
    "workspace.personal.access",
  ]),
  federation: new Set(),
};
describe("fixed-scope catalog", () => {
  test("keeps all 42 selected positions, typed relations, real source files and bilingual content", () => {
    expect(maps.map((map) => map.id).sort()).toEqual([
      ...Array.from({ length: 6 }, (_, i) => `D${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 30 }, (_, i) => `G${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 6 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`),
    ]);
    const sourceRoot = resolve(import.meta.dirname, "../../../../..");
    const allIds = new Set<string>();
    for (const map of maps) {
      expect(map.type).toMatch(/^(process|dependency|runtime)$/);
      for (const file of map.sources)
        expect(existsSync(resolve(sourceRoot, file)), file).toBe(true);
      const ids = new Set(map.nodes.map((node) => node.id));
      for (const node of map.nodes) {
        expect(allIds.has(node.id), node.id).toBe(false);
        allIds.add(node.id);
        expect(node.name.zh).toBeTruthy();
        expect(node.name.en).toBeTruthy();
        expect(node.purpose.zh).toBeTruthy();
        expect(node.purpose.en).toBeTruthy();
        expect(node.route).toMatch(/^\/(?:[^#]*)(?:#.*)?$/);
        if (map.type === "process") {
          expect(node.prerequisites?.zh).toBeTruthy();
          expect(node.input?.zh).toBeTruthy();
          expect(node.output?.zh).toBeTruthy();
        }
      }
      for (const edge of map.edges) {
        expect(ids.has(edge.source)).toBe(true);
        expect(ids.has(edge.target)).toBe(true);
        expect(edge.basis).toBe("design");
        expect(edge.label.zh).toBeTruthy();
        expect(edge.label.en).toBeTruthy();
      }
    }
  });
  test("includes independent signatures, non-arbitrated settlement and recoverable original requests", () => {
    const agreement = maps.find((map) => map.id === "G23");
    expect(
      agreement?.edges.some((edge) => edge.source === "g23.n2" && edge.target === "g23.n3"),
    ).toBe(false);
    expect(agreement?.edges.filter((edge) => edge.target === "g23.n4")).toHaveLength(2);
    expect(
      maps
        .find((map) => map.id === "T04")
        ?.edges.some((edge) => edge.source === "t04.n2" && edge.target === "t04.n5"),
    ).toBe(true);
    expect(
      maps.find((map) => map.id === "G21")?.edges.some((edge) => edge.source === edge.target),
    ).toBe(true);
  });
  test("all selected positions have a production host integration", () => {
    const sourceRoot = resolve(import.meta.dirname, "..");
    const files = [
      "dashboard/Dashboard.tsx",
      "cp/CpDashboard.tsx",
      "interconnect/InterconnectDashboard.tsx",
      "software/SoftwarePage.tsx",
      "settings/SettingsPage.tsx",
      "federation/FederationPage.tsx",
      "jobs/JobsPage.tsx",
      "workflows/WorkflowsPage.tsx",
      "files/FilesPage.tsx",
      "data-market/DataMarketPage.tsx",
      "cp/CpInfrastructurePage.tsx",
      "cp/CpQueuesPage.tsx",
      "cp/UsersTable.tsx",
      "cp/SoftwarePolicyTable.tsx",
      "cp/CpDataPage.tsx",
      "cp/MeteringPage.tsx",
      "settings/OperationsPage.tsx",
      "settings/AuthzAdminPanel.tsx",
      "federation/CommercialPanel.tsx",
    ];
    const hosts = files.map((file) => readFileSync(resolve(sourceRoot, file), "utf8")).join("\n");
    for (const model of maps) expect(hosts.includes(`"${model.id}"`), model.id).toBe(true);
  });
});
describe("authorization and navigation", () => {
  test("fails closed before grants load and never inherits federation grants from platform admin", () => {
    const admin = {
      ...access,
      role: "super_admin",
      platform: new Set<PlatformCapability>(["workspace.platform.manage"]),
    };
    expect(canSeeMapRoute("/federation#agreements", admin)).toBe(false);
    expect(canSeeMapRoute("/settings#security/authz", admin)).toBe(true);
    expect(
      canSeeMapRoute("/settings#infrastructure/cost-rates", { ...admin, role: "platform_admin" }),
    ).toBe(false);
    expect(canSeeMapRoute("/jobs", { ...access, ready: false })).toBe(false);
  });
  test("removes unauthorized nodes and incident edges without inferring replacement links", () => {
    const model = maps.find((map) => map.id === "G21");
    if (!model) throw new Error("Missing G21");
    const visible = visibleMap(model, { ...access, federation: new Set(["delegation.read"]) });
    expect(visible.nodes.map((node) => node.id)).toEqual(["g21.n3"]);
    expect(
      visible.edges.every((edge) => edge.source === "g21.n3" && edge.target === "g21.n3"),
    ).toBe(true);
  });
  test("retains only global context parameters and the destination's actual hash", () => {
    const node = { route: "/settings#security/authz" } as MapNode;
    expect(
      mapDestination(node, {
        tenantId: "t",
        projectId: "p",
        region: "r",
        orgId: "o",
        token: "secret",
        jobId: "unrelated",
        offset: 20,
      }),
    ).toEqual({
      to: "/settings",
      hash: "security/authz",
      search: { tenantId: "t", projectId: "p", region: "r", orgId: "o" },
    });
  });
});
describe("actual runtime semantics", () => {
  test("never converts a refresh failure into a resource fault or preserves forbidden rows", () => {
    expect(acquisitionState({ error: { status: 403 }, isPending: false, data: [] })).toBe(
      "forbidden",
    );
    const model = infrastructureRuntime({
      agents: [{ id: "a", hostname: "private", siteId: "s", status: "online" }],
      state: "forbidden",
      overviewState: "error",
      fetchedAt: 1000,
      overviewFetchedAt: 0,
    });
    expect(model.nodes?.some((node) => node.name.zh === "private")).toBe(false);
    expect(model.observations[0]?.health).not.toBe("confirmed-fault");
    expect(model.observations[0]?.acquisition).toBe("forbidden");
  });
  test("online without a health probe remains unknown and does not invent observation time", () => {
    const model = infrastructureRuntime({
      agents: [{ id: "a", hostname: "node", siteId: "s", status: "online" }],
      state: "ready",
      overviewState: "no-data",
      fetchedAt: 1000,
      overviewFetchedAt: 0,
    });
    expect(model.observations[0]).toMatchObject({
      lifecycle: "online",
      health: "unknown",
      observedAt: null,
      fetchedAt: "1970-01-01T00:00:01.000Z",
    });
    expect(model.nodes?.[0]?.route).toContain("#function-map-agent-a");
  });
  test("keeps readiness separate from health and records missing observation timestamps", () => {
    const runtime = authorizationRuntime({
      state: "ready",
      fetchedAt: "2026-11-15T00:00:00Z",
      health: {
        mode: "enforce",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: true,
        outbox: { pending: 1, processing: 0, dead: 1 },
      },
      readiness: {
        outbox: { pending: 1, processing: 0, dead: 1 },
        shadowDiffs: 2,
        enforceReady: false,
        externalSmokeRequired: true,
        blockers: [],
      },
    });
    expect(runtime.observations.find((row) => row.nodeId === "t01.n2")?.health).toBe(
      "confirmed-fault",
    );
    expect(runtime.observations.find((row) => row.nodeId === "t01.n3")?.health).toBe("reported-ok");
    expect(runtime.observations.find((row) => row.nodeId === "t01.n4")?.health).toBe("unknown");
    expect(runtime.observations.every((row) => row.observedAt === null)).toBe(true);
  });
});
