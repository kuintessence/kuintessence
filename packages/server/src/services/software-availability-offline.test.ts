import { expect, test } from "bun:test";
import {
  agentInstalledSoftware,
  agents,
  type PgDb,
  softwareConcretizeCache,
  spackInstallBindingEvents,
} from "@kuintessence/db";
import { SiteOperationsSchema } from "@kuintessence/shared";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { SoftwareAvailabilityService } from "./software-availability";

const principal: BoundPrincipal = {
  sub: "reviewer",
  userId: "reviewer",
  role: "org_admin",
  email: "reviewer@example.invalid",
  orgId: null,
  orgIds: [],
  memberships: [],
  capabilities: [],
};
const closure = "offline site material closure has not been verified";
const stale = "offline site telemetry is stale or invalid";

function telemetry(transport: "ssh-forward" | "http-proxy" | "direct", observedAt = Date.now()) {
  return SiteOperationsSchema.parse({
    version: 1,
    observedAt,
    transport,
    trust: "single-user",
    executor: "slurm",
    materials: { state: "ready" },
    installation: { state: "ready" },
    jobs: { state: "ready" },
    transfers: { state: "ready" },
    update: { phase: "activated" },
  });
}

async function availability(
  siteOperations: unknown,
  installed = false,
  bound = false,
  verified = false,
) {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === agents
              ? [
                  {
                    agentId: "agent",
                    siteName: "review",
                    providerOrgId: null,
                    status: "online",
                    siteOperations,
                  },
                ]
              : table === agentInstalledSoftware && installed
                ? [{ agentId: "agent", spec: "review@1", name: "review", version: "1" }]
                : table === softwareConcretizeCache
                  ? [{ dag: { dependencies: [] }, generatedAt: new Date() }]
                  : table === spackInstallBindingEvents && bound
                    ? [
                        {
                          state: "enabled",
                          spec: "review@1",
                          repositoryId: "a".repeat(64),
                          manifestDigest: `sha256:${"b".repeat(64)}`,
                        },
                      ]
                    : [];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
  } as unknown as PgDb;
  return new SoftwareAvailabilityService(db, {
    onlineAgentIds: () => ["agent"],
    sourceAuditAvailable: async (agentId, spec) =>
      verified && agentId === "agent" && spec === "review@1",
  }).resolve({ rawSpec: "review@1", installable: true }, principal);
}

test("both explicit offline transports block uninstalled software without verified material closure", async () => {
  for (const transport of ["ssh-forward", "http-proxy"] as const) {
    const result = await availability(telemetry(transport));
    expect(result.installableAvailable).toHaveLength(0);
    expect(result.blocked[0]?.reasons).toEqual([closure]);
  }
});

test("an enabled binding and ready telemetry do not constitute dynamic source/resource/patch closure evidence", async () => {
  const result = await availability(telemetry("ssh-forward"), false, true);
  expect(result.installableAvailable).toHaveLength(0);
  expect(result.blocked[0]?.reasons).toEqual([closure]);
});

test("installed software remains runnable, including an offline site with stale telemetry", async () => {
  const result = await availability(telemetry("http-proxy", Date.now() - 600_000), true);
  expect(result.installedAvailable[0]?.installedSpec).toBe("review@1");
  expect(result.installedAvailable[0]?.reasons).toEqual([]);
  expect(result.blocked).toHaveLength(0);
});

test("direct and legacy sites preserve their existing policy-based installation availability", async () => {
  for (const site of [telemetry("direct"), undefined, null]) {
    const result = await availability(site);
    expect(result.installableAvailable[0]?.agentId).toBe("agent");
    expect(result.blocked).toHaveLength(0);
  }
});

test("stale, future or malformed offline telemetry can never establish installation readiness", async () => {
  for (const site of [
    telemetry("ssh-forward", Date.now() - 600_000),
    telemetry("http-proxy", Date.now() + 120_000),
    { transport: "ssh-forward", materials: { state: "ready" } },
  ]) {
    const result = await availability(site);
    expect(result.installableAvailable).toHaveLength(0);
    expect(result.blocked[0]?.reasons).toEqual([stale, closure]);
  }
});

test("a matching Server proof enables installation discovery while stale telemetry still blocks it", async () => {
  const valid = await availability(telemetry("ssh-forward"), false, false, true);
  expect(valid.installableAvailable[0]?.agentId).toBe("agent");
  expect(valid.installedAvailable).toHaveLength(0);
  const invalid = await availability(
    telemetry("ssh-forward", Date.now() - 600_000),
    false,
    false,
    true,
  );
  expect(invalid.installableAvailable).toHaveLength(0);
  expect(invalid.blocked[0]?.reasons).toEqual([stale]);
});
