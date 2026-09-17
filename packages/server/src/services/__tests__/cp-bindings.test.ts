// Integration tests for `cp-bindings.ts`.
//
// The bindings are thin wrappers over Drizzle queries, so unit-testing
// with a hand-rolled fake DB would require re-implementing Drizzle's
// query builder. Instead we follow the same `describe.if(KQ_PG_URL)`
// pattern as `metering-repository-drizzle.test.ts`: when a real Postgres
// is reachable we exercise the full queries, otherwise we silently skip.
//
// Required tables touched:
//   - users, orgs, jobs, usage_quotas, software_policies, agents,
//     metering_usage_raw, audit_log, netdrive_files, netdrive_transfer_log
//
// The migration set already includes 0014 (netdrive_transfer_log), so the
// schema this expects is whatever `bun run db:migrate` already applied.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  agentInstalledSoftware,
  agents,
  auditLog,
  createPgDb,
  jobs,
  meteringUsageRaw,
  netdriveFiles,
  netdriveTransferLog,
  orgs,
  type PgDb,
  preinstalledSoftwareMappings,
  softwareAssets,
  softwarePolicies,
  softwarePolicyOverlays,
  usageQuotas,
  users,
} from "@kuintessence/db";
import { eq, inArray, or } from "drizzle-orm";
import { PolicyStore } from "../../software-governance/policy-store";
import { AgentManager } from "../agent-manager";
import { buildCpBindings } from "../cp-bindings";

// Default to the local dev PG when no env is set — matches the suite-wide
// convention (job-service/jobs tests etc.) so these DB tests RUN in the default
// `test:unit` flow instead of silently skipping. (describeIfPg still guards the
// theoretical no-URL case.)
const PG_URL =
  process.env.KQ_PG_URL ??
  process.env.DATABASE_URL ??
  "postgres://kq:kq@localhost:5432/kuintessence";
const describeIfPg = PG_URL ? describe : describe.skip;

const ORG_A = "00000000-0000-0000-0000-00000000c0a1";
const ORG_B = "00000000-0000-0000-0000-00000000c0a2";
const USER_A1 = "00000000-0000-0000-0000-00000000c1a1";
const USER_A2 = "00000000-0000-0000-0000-00000000c1a2";
const USER_B1 = "00000000-0000-0000-0000-00000000c1b1";
const AGENT_X = "cp-bindings-test-agent-X";
const AGENT_Y = "cp-bindings-test-agent-Y";
const SITE_ALPHA = "site-alpha-cp";
const SITE_BETA = "site-beta-cp";
const ASSET_Z = "00000000-0000-0000-0000-00000000a55e";

describeIfPg("cp-bindings (PG)", () => {
  let db: PgDb;
  let bindings: ReturnType<typeof buildCpBindings>;

  beforeAll(async () => {
    db = createPgDb(PG_URL);
    const agentManager = new AgentManager(db);
    const policyStore = new PolicyStore(db);
    bindings = buildCpBindings({
      db,
      agentManager,
      policyStore,
      onlineAgentIds: () => [AGENT_X],
    });
  });

  beforeEach(async () => {
    // Tear down test fixtures (orderly, FK-safe). The transfer-log table
    // FKs into netdrive_files and users, so it has to be cleared first.
    await db
      .delete(netdriveTransferLog)
      .where(inArray(netdriveTransferLog.actorId, [USER_A1, USER_A2, USER_B1]));
    await db.delete(meteringUsageRaw).where(inArray(meteringUsageRaw.orgId, [ORG_A, ORG_B]));
    await db.delete(auditLog).where(inArray(auditLog.orgId, [ORG_A, ORG_B]));
    await db.delete(jobs).where(inArray(jobs.submittedBy, [USER_A1, USER_A2, USER_B1]));
    await db
      .delete(netdriveFiles)
      .where(inArray(netdriveFiles.ownerId, [USER_A1, USER_A2, USER_B1]));
    await db.delete(usageQuotas).where(inArray(usageQuotas.scopeId, [USER_A1, USER_A2, USER_B1]));
    await db
      .delete(softwarePolicyOverlays)
      .where(
        or(
          inArray(softwarePolicyOverlays.agentId, [AGENT_X, AGENT_Y]),
          inArray(softwarePolicyOverlays.providerOrgId, [ORG_A, ORG_B]),
        ),
      );
    await db
      .delete(agentInstalledSoftware)
      .where(inArray(agentInstalledSoftware.agentId, [AGENT_X, AGENT_Y]));
    await db
      .delete(preinstalledSoftwareMappings)
      .where(inArray(preinstalledSoftwareMappings.agentId, [AGENT_X, AGENT_Y]));
    await db.delete(softwarePolicies).where(inArray(softwarePolicies.agentId, [AGENT_X, AGENT_Y]));
    await db.delete(agents).where(inArray(agents.agentId, [AGENT_X, AGENT_Y]));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, ASSET_Z));
    await db.delete(users).where(inArray(users.id, [USER_A1, USER_A2, USER_B1]));
    await db.delete(orgs).where(inArray(orgs.id, [ORG_A, ORG_B]));

    await db.insert(orgs).values([
      { id: ORG_A, name: "cp-test-org-A" },
      { id: ORG_B, name: "cp-test-org-B" },
    ]);
    await db.insert(users).values([
      {
        id: USER_A1,
        email: "cp-test-a1@example.test",
        displayName: "Alpha One",
        role: "user",
        orgId: ORG_A,
      },
      {
        id: USER_A2,
        email: "cp-test-a2@example.test",
        displayName: "Alpha Two",
        role: "user",
        orgId: ORG_A,
      },
      {
        id: USER_B1,
        email: "cp-test-b1@example.test",
        displayName: "Beta One",
        role: "user",
        orgId: ORG_B,
      },
    ]);
    await db.insert(agents).values([
      {
        agentId: AGENT_X,
        siteName: SITE_ALPHA,
        providerOrgId: ORG_A,
        schedulerType: "slurm",
        schedulerVersion: "20.11",
        status: "online",
      },
      {
        agentId: AGENT_Y,
        siteName: SITE_BETA,
        providerOrgId: ORG_B,
        schedulerType: "slurm",
        schedulerVersion: "23.02",
        status: "offline",
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(netdriveTransferLog)
      .where(inArray(netdriveTransferLog.actorId, [USER_A1, USER_A2, USER_B1]));
    await db.delete(meteringUsageRaw).where(inArray(meteringUsageRaw.orgId, [ORG_A, ORG_B]));
    await db.delete(auditLog).where(inArray(auditLog.orgId, [ORG_A, ORG_B]));
    await db.delete(jobs).where(inArray(jobs.submittedBy, [USER_A1, USER_A2, USER_B1]));
    await db
      .delete(netdriveFiles)
      .where(inArray(netdriveFiles.ownerId, [USER_A1, USER_A2, USER_B1]));
    await db.delete(usageQuotas).where(inArray(usageQuotas.scopeId, [USER_A1, USER_A2, USER_B1]));
    await db
      .delete(softwarePolicyOverlays)
      .where(
        or(
          inArray(softwarePolicyOverlays.agentId, [AGENT_X, AGENT_Y]),
          inArray(softwarePolicyOverlays.providerOrgId, [ORG_A, ORG_B]),
        ),
      );
    await db
      .delete(agentInstalledSoftware)
      .where(inArray(agentInstalledSoftware.agentId, [AGENT_X, AGENT_Y]));
    await db
      .delete(preinstalledSoftwareMappings)
      .where(inArray(preinstalledSoftwareMappings.agentId, [AGENT_X, AGENT_Y]));
    await db.delete(softwarePolicies).where(inArray(softwarePolicies.agentId, [AGENT_X, AGENT_Y]));
    await db.delete(agents).where(inArray(agents.agentId, [AGENT_X, AGENT_Y]));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, ASSET_Z));
    await db.delete(users).where(inArray(users.id, [USER_A1, USER_A2, USER_B1]));
    await db.delete(orgs).where(inArray(orgs.id, [ORG_A, ORG_B]));
  });

  test("jobs.countCompletedSince scopes by jobs.org_id directly (migration 0013)", async () => {
    // Migration 0013 — jobs.org_id is the authoritative scope column.
    // Stamping it on insert simulates what JobService.submit will do at
    // runtime; the cp-binding query no longer joins users.
    const finishedAt = new Date();
    await db.insert(jobs).values([
      {
        name: "j-A1",
        command: "echo a",
        status: "completed",
        cpus: 1,
        memoryMb: 100,
        submittedBy: USER_A1,
        orgId: ORG_A,
        completedAt: finishedAt,
      },
      {
        name: "j-A2",
        command: "echo a",
        status: "completed",
        cpus: 1,
        memoryMb: 100,
        submittedBy: USER_A2,
        orgId: ORG_A,
        completedAt: finishedAt,
      },
      {
        name: "j-B1",
        command: "echo b",
        status: "completed",
        cpus: 1,
        memoryMb: 100,
        submittedBy: USER_B1,
        orgId: ORG_B,
        completedAt: finishedAt,
      },
      {
        // Legacy / pre-0013 row: orgId is NULL. Org-scoped queries must
        // skip it; platform-wide queries must still see it.
        name: "j-legacy",
        command: "echo legacy",
        status: "completed",
        cpus: 1,
        memoryMb: 100,
        submittedBy: USER_A1,
        orgId: null,
        completedAt: finishedAt,
      },
    ]);
    const since = new Date(Date.now() - 60_000);
    const orgA = await bindings.jobs.countCompletedSince([ORG_A], since);
    expect(orgA).toBe(2);
    const orgB = await bindings.jobs.countCompletedSince([ORG_B], since);
    expect(orgB).toBe(1);
    const platform = await bindings.jobs.countCompletedSince([], since);
    expect(platform).toBeGreaterThanOrEqual(4);
  });

  test("jobs.topAppsByJobs groups on jobs.app_template_key, not metering (migration 0013)", async () => {
    const finishedAt = new Date();
    await db.insert(jobs).values([
      {
        name: "wrf-1",
        command: "wrf.exe",
        status: "completed",
        cpus: 4,
        memoryMb: 4096,
        submittedBy: USER_A1,
        orgId: ORG_A,
        appTemplateKey: "wrf",
        completedAt: finishedAt,
      },
      {
        name: "wrf-2",
        command: "wrf.exe",
        status: "completed",
        cpus: 4,
        memoryMb: 4096,
        submittedBy: USER_A2,
        orgId: ORG_A,
        appTemplateKey: "wrf",
        completedAt: finishedAt,
      },
      {
        name: "gromacs-1",
        command: "gmx mdrun",
        status: "completed",
        cpus: 8,
        memoryMb: 8192,
        submittedBy: USER_A1,
        orgId: ORG_A,
        appTemplateKey: "gromacs",
        completedAt: finishedAt,
      },
      {
        // app_template_key NULL — must be excluded from "top apps".
        name: "raw-submit",
        command: "echo hi",
        status: "completed",
        cpus: 1,
        memoryMb: 100,
        submittedBy: USER_A1,
        orgId: ORG_A,
        appTemplateKey: null,
        completedAt: finishedAt,
      },
    ]);
    const since = new Date(Date.now() - 60_000);
    const top = await bindings.jobs.topAppsByJobs([ORG_A], since, 5);
    const byKey = new Map(top.map((r) => [r.appKey, r.jobs]));
    expect(byKey.get("wrf")).toBe(2);
    expect(byKey.get("gromacs")).toBe(1);
    // The raw-submit row must NOT appear under "<no-app>".
    expect(byKey.has("<no-app>")).toBe(false);
  });

  test("audit.search scopes by audit_log.org_id directly (migration 0013)", async () => {
    // No actor-IN-(subquery on users) workaround: rows are filtered
    // straight on audit_log.org_id, which the audit-log writer stamps at
    // insert time.
    const now = new Date();
    await db.insert(auditLog).values([
      {
        actor: "cp-test-a1@example.test",
        orgId: ORG_A,
        action: "test.action",
        target: "target-a",
        diff: { after: { ok: true } },
      },
      {
        actor: "cp-test-b1@example.test",
        orgId: ORG_B,
        action: "test.action",
        target: "target-b",
        diff: { after: { ok: true } },
      },
      {
        // Legacy pre-0013 row: orgId NULL — invisible to org-scoped search.
        actor: "cp-test-a2@example.test",
        orgId: null,
        action: "test.action",
        target: "target-legacy",
        diff: { after: { legacy: true } },
      },
    ]);
    const from = new Date(now.getTime() - 60_000);
    const to = new Date(now.getTime() + 60_000);
    const orgA = await bindings.audit.search({ orgIds: [ORG_A], from, to, limit: 50, offset: 0 });
    expect(orgA.total).toBe(1);
    const orgB = await bindings.audit.search({ orgIds: [ORG_B], from, to, limit: 50, offset: 0 });
    expect(orgB.total).toBe(1);
    const platform = await bindings.audit.search({ orgIds: [], from, to, limit: 100, offset: 0 });
    expect(platform.total).toBeGreaterThanOrEqual(3);
  });

  test("queueSampler.peakSince reads MAX(agents.queue_depth) directly (migration 0013)", async () => {
    // Bump the seeded agents to known queue_depth values; the sampler
    // returns the max.
    await db.update(agents).set({ queueDepth: 4 }).where(eq(agents.agentId, AGENT_X));
    await db.update(agents).set({ queueDepth: 11 }).where(eq(agents.agentId, AGENT_Y));
    const since = new Date(Date.now() - 60_000);
    const peak = await bindings.queueSampler.peakSince([], since);
    expect(peak).toBeGreaterThanOrEqual(11);
  });

  test("agents.listForOrgs scopes by agents.provider_org_id", async () => {
    const orgA = await bindings.agents.listForOrgs([ORG_A]);
    const orgB = await bindings.agents.listForOrgs([ORG_B]);

    expect(orgA.map((agent) => agent.id)).toEqual([AGENT_X]);
    expect(orgB.map((agent) => agent.id)).toEqual([AGENT_Y]);
  });

  test("agents.listByIds reads only the SpiceDB-authorized agent ids", async () => {
    const visible = await bindings.agents.listByIds([AGENT_Y]);
    const none = await bindings.agents.listByIds([]);

    expect(visible.map((agent) => agent.id)).toEqual([AGENT_Y]);
    expect(none).toEqual([]);
  });

  test("agents.countByHealth scopes by agents.provider_org_id", async () => {
    const orgA = await bindings.agents.countByHealth([ORG_A]);
    const orgB = await bindings.agents.countByHealth([ORG_B]);

    expect(orgA).toEqual({ healthy: 1, sick: 0, offline: 0 });
    expect(orgB).toEqual({ healthy: 0, sick: 0, offline: 1 });
  });

  test("software.getOverview returns scoped agents even when no legacy policies exist", async () => {
    await db.insert(agentInstalledSoftware).values({
      agentId: AGENT_X,
      name: "openmpi",
      version: "4.1.6",
      compiler: "gcc@13.2.0",
      hash: "cp-bindings-openmpi-hash",
      spec: "openmpi@4.1.6%gcc@13.2.0",
    });
    const overview = await bindings.software.getOverview({
      orgIds: [ORG_A],
      isPlatformWide: false,
      principal: { sub: USER_A1, role: "org_admin", orgIds: [ORG_A] },
    });
    expect(overview.providerOrgIds).toEqual([ORG_A]);
    expect(overview.agents.map((agent) => agent.agentId)).toEqual([AGENT_X]);
    expect(overview.clusters.map((cluster) => cluster.cluster)).toEqual([SITE_ALPHA]);
    expect(overview.summary.installedSpecs).toBe(1);
    expect(overview.agents[0]?.effectivePolicy.installMode).toBe("explicit-install-grant");
    expect(overview.agents[0]?.controlChannelOnline).toBe(true);
    expect(overview.agents[0]?.runtimeStatus).toBe("online");
    expect(overview.agents[0]?.lastHeartbeat).toBeNull();
  });

  test("software.reviewPreinstalledMapping approves and rejects scoped mappings", async () => {
    const scope = {
      orgIds: [ORG_A],
      isPlatformWide: false,
      principal: { sub: USER_A1, role: "org_admin", orgIds: [ORG_A] },
    };
    await db.insert(softwareAssets).values({
      id: ASSET_Z,
      kind: "spack-package",
      name: "cp-bindings-preinstalled",
      version: "1.0",
      source: "cp-private",
      lifecycle: "approved",
      visibility: "shared-to-orgs",
      ownerOrgId: ORG_A,
      providerOrgId: ORG_A,
      createdBy: USER_A1,
    });
    const [mapping] = await db
      .insert(preinstalledSoftwareMappings)
      .values({
        agentId: AGENT_X,
        localSpec: "cp-bindings-preinstalled@1.0",
        assetId: ASSET_Z,
        confidence: "declared",
        createdBy: USER_A1,
      })
      .returning({ id: preinstalledSoftwareMappings.id });
    if (!mapping) throw new Error("test mapping insert failed");

    const approved = await bindings.software.reviewPreinstalledMapping(scope, {
      agentId: AGENT_X,
      mappingId: mapping.id,
      decision: "approve",
      reviewedBy: USER_A2,
    });
    const approvedAgent = approved.agents.find((item) => item.agentId === AGENT_X);
    const approvedMapping = approvedAgent?.preinstalledMappings.find(
      (item) => item.id === mapping.id,
    );
    expect(approvedMapping?.confidence).toBe("platform-locked");
    expect(approvedMapping?.auditedBy).toBe(USER_A2);
    expect(approvedMapping?.auditedAt).not.toBeNull();

    const rejected = await bindings.software.reviewPreinstalledMapping(scope, {
      agentId: AGENT_X,
      mappingId: mapping.id,
      decision: "reject",
      reviewedBy: USER_A2,
    });
    const rejectedAgent = rejected.agents.find((item) => item.agentId === AGENT_X);
    expect(rejectedAgent?.preinstalledMappings).toEqual([]);
    const rows = await db
      .select()
      .from(preinstalledSoftwareMappings)
      .where(eq(preinstalledSoftwareMappings.id, mapping.id));
    expect(rows).toEqual([]);
  });

  test("software.getOverview reports offline runtime status when the control channel is gone", async () => {
    const staleBindings = buildCpBindings({
      db,
      agentManager: new AgentManager(db),
      policyStore: new PolicyStore(db),
      onlineAgentIds: () => [],
    });
    const overview = await staleBindings.software.getOverview({
      orgIds: [ORG_A],
      isPlatformWide: false,
      principal: { sub: USER_A1, role: "org_admin", orgIds: [ORG_A] },
    });
    expect(overview.agents[0]?.status).toBe("online");
    expect(overview.agents[0]?.controlChannelOnline).toBe(false);
    expect(overview.agents[0]?.runtimeStatus).toBe("offline");
  });

  test("software overlays merge provider defaults with agent overrides and sync legacy policy", async () => {
    const scope = {
      orgIds: [ORG_A],
      isPlatformWide: false,
      principal: { sub: USER_A1, role: "org_admin", orgIds: [ORG_A] },
    };
    await bindings.software.saveProviderPolicy(scope, {
      installMode: "preinstalled-only",
      allowList: ["openmpi"],
      denyList: ["blocked-provider"],
      lockEnabled: true,
      trustedPublicAutoInstall: false,
      usecaseDefaultAllow: false,
      usecaseAllowList: ["usecase:provider-openfoam"],
      usecaseDenyList: ["usecase:blocked-provider"],
      mirrors: [{ name: "official", url: "https://mirror.example/spack", priority: 10 }],
      preinstallList: ["openmpi@4.1.6"],
    });
    await bindings.software.saveAgentPolicy(scope, AGENT_X, {
      installMode: "trusted-public-auto-install",
      allowList: ["gromacs"],
      denyList: ["blocked-agent"],
      lockEnabled: false,
      trustedPublicAutoInstall: true,
      usecaseDefaultAllow: true,
      usecaseAllowList: ["usecase:agent-gromacs"],
      usecaseDenyList: ["usecase:blocked-agent"],
      mirrors: [
        { name: "agent-local", url: "https://agent.example/spack", priority: 1 },
        { name: "official", url: "https://agent.example/override", priority: 2 },
      ],
      preinstallList: ["gromacs@2024.1"],
    });

    const overview = await bindings.software.getOverview(scope);
    const agent = overview.agents.find((item) => item.agentId === AGENT_X);
    expect(agent?.effectivePolicy.installMode).toBe("trusted-public-auto-install");
    expect(agent?.effectivePolicy.allowList).toEqual(["gromacs", "openmpi"]);
    expect(agent?.effectivePolicy.denyList).toEqual(["blocked-agent", "blocked-provider"]);
    expect(agent?.effectivePolicy.lockEnabled).toBe(true);
    expect(agent?.effectivePolicy.trustedPublicAutoInstall).toBe(true);
    expect(agent?.effectivePolicy.usecaseDefaultAllow).toBe(true);
    expect(agent?.effectivePolicy.usecaseAllowList).toEqual([
      "usecase:agent-gromacs",
      "usecase:provider-openfoam",
    ]);
    expect(agent?.effectivePolicy.usecaseDenyList).toEqual([
      "usecase:blocked-agent",
      "usecase:blocked-provider",
    ]);
    expect(agent?.effectivePolicy.mirrors.map((mirror) => mirror.name)).toEqual([
      "agent-local",
      "official",
    ]);
    expect(agent?.effectivePolicy.preinstallList).toEqual(["gromacs@2024.1", "openmpi@4.1.6"]);

    const [legacy] = await db
      .select()
      .from(softwarePolicies)
      .where(eq(softwarePolicies.agentId, AGENT_X))
      .limit(1);
    expect(legacy?.allowList).toEqual(["gromacs", "openmpi"]);
    expect(legacy?.denyList).toEqual(["blocked-agent", "blocked-provider"]);
    expect(legacy?.lockEnabled).toBe(true);
    expect(legacy?.mirrors.map((mirror) => mirror.name)).toEqual(["agent-local", "official"]);
  });

  test("software overlays merge provider defaults with cluster overrides", async () => {
    const scope = {
      orgIds: [ORG_A],
      isPlatformWide: false,
      principal: { sub: USER_A1, role: "org_admin", orgIds: [ORG_A] },
    };
    await bindings.software.saveProviderPolicy(scope, {
      installMode: "preinstalled-only",
      allowList: ["openmpi"],
      denyList: ["blocked-provider"],
      lockEnabled: false,
      trustedPublicAutoInstall: false,
      usecaseDefaultAllow: true,
      usecaseAllowList: ["usecase:provider-openfoam"],
      usecaseDenyList: ["usecase:blocked-provider"],
      mirrors: [{ name: "official", url: "https://mirror.example/spack", priority: 10 }],
      preinstallList: ["openmpi@4.1.6"],
    });
    await bindings.software.saveClusterPolicy(scope, SITE_ALPHA, {
      installMode: "trusted-public-auto-install",
      allowList: ["gromacs"],
      denyList: ["blocked-cluster"],
      lockEnabled: true,
      trustedPublicAutoInstall: true,
      usecaseDefaultAllow: false,
      usecaseAllowList: ["usecase:cluster-gromacs"],
      usecaseDenyList: ["usecase:blocked-cluster"],
      mirrors: [{ name: "cluster-local", url: "https://cluster.example/spack", priority: 1 }],
      preinstallList: ["gromacs@2024.1"],
    });

    const overview = await bindings.software.getOverview(scope);
    const cluster = overview.clusters.find((item) => item.cluster === SITE_ALPHA);
    const agent = overview.agents.find((item) => item.agentId === AGENT_X);
    expect(cluster?.clusterPolicy?.scope).toBe("cluster");
    expect(agent?.clusterPolicy?.scope).toBe("cluster");
    expect(agent?.effectivePolicy.installMode).toBe("trusted-public-auto-install");
    expect(agent?.effectivePolicy.allowList).toEqual(["gromacs", "openmpi"]);
    expect(agent?.effectivePolicy.denyList).toEqual(["blocked-cluster", "blocked-provider"]);
    expect(agent?.effectivePolicy.lockEnabled).toBe(true);
    expect(agent?.effectivePolicy.trustedPublicAutoInstall).toBe(true);
    expect(agent?.effectivePolicy.usecaseDefaultAllow).toBe(false);
    expect(agent?.effectivePolicy.usecaseAllowList).toEqual([
      "usecase:cluster-gromacs",
      "usecase:provider-openfoam",
    ]);
    expect(agent?.effectivePolicy.usecaseDenyList).toEqual([
      "usecase:blocked-cluster",
      "usecase:blocked-provider",
    ]);
    expect(agent?.effectivePolicy.mirrors.map((mirror) => mirror.name)).toEqual([
      "cluster-local",
      "official",
    ]);
    expect(agent?.effectivePolicy.preinstallList).toEqual(["gromacs@2024.1", "openmpi@4.1.6"]);

    const [legacy] = await db
      .select()
      .from(softwarePolicies)
      .where(eq(softwarePolicies.agentId, AGENT_X))
      .limit(1);
    expect(legacy?.allowList).toEqual(["gromacs", "openmpi"]);
    expect(legacy?.denyList).toEqual(["blocked-cluster", "blocked-provider"]);
    expect(legacy?.lockEnabled).toBe(true);
  });

  test("users.setSuspended round-trips", async () => {
    await bindings.users.setSuspended(USER_A1, true, { actor: USER_A1, orgId: ORG_A });
    const [row] = await db.select().from(users).where(eq(users.id, USER_A1)).limit(1);
    expect(row?.suspended).toBe(true);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `user:${USER_A1}`));
    expect(audit).toMatchObject({ action: "cp.user.suspend", orgId: ORG_A, actor: USER_A1 });
    await bindings.users.setSuspended(USER_A1, false, { actor: USER_A1, orgId: ORG_A });
    const [row2] = await db.select().from(users).where(eq(users.id, USER_A1)).limit(1);
    expect(row2?.suspended).toBe(false);
  });

  test("users.setSuspended rolls back when the audit insert fails", async () => {
    await expect(
      bindings.users.setSuspended(USER_A1, true, {
        actor: USER_A1,
        orgId: "00000000-0000-0000-0000-00000000dead",
      }),
    ).rejects.toThrow();
    const [row] = await db.select().from(users).where(eq(users.id, USER_A1)).limit(1);
    expect(row?.suspended).toBe(false);
  });

  test("users.setQuota inserts then updates the user's row", async () => {
    await bindings.users.setQuota(USER_A1, 250, { actor: USER_A1, orgId: ORG_A });
    const first = await db.select().from(usageQuotas).where(eq(usageQuotas.scopeId, USER_A1));
    expect(first.length).toBe(1);
    expect(first[0]?.remainingCreditUnits).toBe(250);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `user:${USER_A1}`));
    expect(audit).toMatchObject({ action: "cp.user.quota", orgId: ORG_A, actor: USER_A1 });

    await bindings.users.setQuota(USER_A1, 999, { actor: USER_A1, orgId: ORG_A });
    const second = await db.select().from(usageQuotas).where(eq(usageQuotas.scopeId, USER_A1));
    expect(second.length).toBe(1);
    expect(second[0]?.remainingCreditUnits).toBe(999);
  });

  test("users.setQuota rolls back when the audit insert fails", async () => {
    await expect(
      bindings.users.setQuota(USER_A1, 250, {
        actor: USER_A1,
        orgId: "00000000-0000-0000-0000-00000000dead",
      }),
    ).rejects.toThrow();
    const rows = await db.select().from(usageQuotas).where(eq(usageQuotas.scopeId, USER_A1));
    expect(rows).toHaveLength(0);
  });

  test("software.listPolicies aggregates per-agent rows by cluster", async () => {
    await db.insert(softwarePolicies).values([
      {
        agentId: AGENT_X,
        scope: "agent",
        allowList: ["gromacs@2024.1"],
        denyList: [],
        lockEnabled: true,
        mirrors: [],
        preinstallList: [],
        version: "v1",
      },
      {
        agentId: AGENT_Y,
        scope: "agent",
        allowList: ["wrf@4.4"],
        denyList: ["legacy-tool"],
        lockEnabled: false,
        mirrors: [],
        preinstallList: [],
        version: "v1",
      },
    ]);

    const items = await bindings.software.listPolicies([]);
    const byCluster = new Map(items.map((i) => [i.cluster, i]));
    const alphaSite = byCluster.get(SITE_ALPHA);
    const betaSite = byCluster.get(SITE_BETA);
    expect(alphaSite).toBeDefined();
    expect(betaSite).toBeDefined();
    expect(alphaSite?.whitelist).toContain("gromacs@2024.1");
    expect(alphaSite?.locked).toBe(true);
    expect(betaSite?.blacklist).toContain("legacy-tool");
    expect(betaSite?.locked).toBe(false);
  });

  test("netdrive.bytesTransferredSince reads from netdrive_transfer_log, not netdrive_files", async () => {
    // A `netdrive_files` row exists but only the transfer-log rows count
    // toward bytesTransferredSince — proves the adapter migrated off the
    // old `sum(size) by created_at` path (migration 0014 contract).
    const since = new Date(Date.now() - 60_000);

    // Distractor: a 5000-byte committed file. Under the old approximation
    // this would have shown up in the byte total; under the ledger model
    // it does not because no transfer-log row exists for it yet.
    await db.insert(netdriveFiles).values({
      ownerId: USER_A1,
      path: "uploads/distractor.bin",
      size: 5000,
      sha256: "0".repeat(64),
      contentType: "application/octet-stream",
      etag: null,
      storageKey: "netdrive/cp-bindings-test/distractor",
    });

    // Real ledger rows: org A uploads 100 + downloads 100, org B mirrors 50.
    await db.insert(netdriveTransferLog).values([
      {
        actorId: USER_A1,
        orgId: ORG_A,
        direction: "upload",
        bytes: 100,
      },
      {
        actorId: USER_A2,
        orgId: ORG_A,
        direction: "download",
        bytes: 100,
      },
      {
        actorId: USER_B1,
        orgId: ORG_B,
        direction: "mirror",
        bytes: 50,
        siteId: "site-beta-cp",
      },
    ]);

    const orgA = await bindings.netdrive.bytesTransferredSince([ORG_A], since);
    expect(orgA).toBe(200);

    const orgB = await bindings.netdrive.bytesTransferredSince([ORG_B], since);
    expect(orgB).toBe(50);

    // Platform-wide call sees ≥ 250 (cross-suite rows may add more).
    const platform = await bindings.netdrive.bytesTransferredSince([], since);
    expect(platform).toBeGreaterThanOrEqual(250);
  });
});
