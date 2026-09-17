// Concrete adapters for {@link CpConsoleService}'s collaborator
// ports. Bridges the dependency-injected interfaces in `cp-console.ts` to
// the live Server services and the underlying Drizzle DB.
//
// Scope semantics (used uniformly across every adapter):
//   - `orgIds.length > 0` → tenant-scoped — narrow to the listed orgs.
//   - `orgIds.length === 0` → caller (CpConsoleService) signalled
//     platform-wide reach via `scope.isPlatformWide`. We treat the empty
//     array as "no org filter" so platform/super admins see everything.
//
// Per-port notes:
//   - JobsServicePort: post-migration-0013 the `jobs` table carries
//     `org_id` and `app_template_key` directly, so the org-scope filter
//     and "top apps" group-by are first-class on `jobs` — no users join,
//     no metering join. Legacy rows where `jobs.org_id IS NULL` simply
//     drop out of org-scoped counts until ops backfills.
//   - AgentsServicePort: `agents.provider_org_id` is the CP ownership
//     boundary. Empty orgIds keeps the platform-wide convention used by
//     platform admins; SpiceDB-filtered reads use explicit agent ids.
//   - QueueDepthSamplerPort: post-migration-0013, reads `MAX(queue_depth)`
//     across `agents` rows. It intentionally stays platform-wide for now;
//     time-window org narrowing would require joining via jobs that ran on
//     the agent in the window, which is too expensive for the dashboard hot
//     path.
//   - SoftwareGovernancePort: governs cluster-scoped policies. Aggregates
//     per-agent rows up to the cluster (siteName) granularity.
//   - NetdriveServicePort: bytesTransferredSince now reads
//     `sum(bytes)` from the dedicated `netdrive_transfer_log` table
//     (migration 0014). NetDriveService appends one row per finalized
//     upload/download (and, when wired, mirror) so the dashboard sees
//     real transfer bytes instead of an upload-side approximation.
//     Historical traffic from before migration 0014 is invisible by
//     design — the table starts empty.
//
// Implementation choice: thin Drizzle queries directly against the schema
// rather than routing through JobService/UserService, because none of the
// existing services expose org-scoped helpers. This keeps the adapter
// honest and avoids growing those services for one consumer.
import {
  agentInstalledSoftware,
  agents as agentsTable,
  auditLog,
  jobs,
  netdriveTransferLog,
  orgs,
  type PgDb,
  preinstalledSoftwareMappings,
  softwarePolicies,
  softwarePolicyOverlays,
  usageQuotas,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, max, or, sql } from "drizzle-orm";
import type { CpScope } from "../middleware/cp-rbac";
import type { PolicyPusher } from "../software-governance/policy-pusher";
import type { PolicyBundle, PolicyStore } from "../software-governance/policy-store";
import type { AgentManager } from "./agent-manager";
import type {
  AgentsServicePort,
  AuditServicePort,
  CpConsoleDeps,
  CpSoftwareAgentView,
  CpSoftwareOverview,
  InstallMode,
  JobsServicePort,
  MirrorInput,
  NetdriveServicePort,
  OrganizationDirectoryPort,
  PolicyOverlayInput,
  PolicyOverlayView,
  QueueDepthSamplerPort,
  SoftwareGovernancePort,
  UsersServicePort,
} from "./cp-console";

export interface CpBindingsDeps {
  db: PgDb;
  agentManager: AgentManager;
  policyStore: PolicyStore;
  policyPusher?: PolicyPusher;
  onlineAgentIds?: () => string[];
}

/**
 * Build concrete adapter instances and return them packaged as a
 * {@link CpConsoleDeps} ready to feed into `new CpConsoleService(...)`.
 */
export function buildCpBindings(deps: CpBindingsDeps): CpConsoleDeps {
  return {
    jobs: makeJobsPort(deps),
    agents: makeAgentsPort(deps),
    audit: makeAuditPort(deps),
    software: makeSoftwarePort(deps),
    users: makeUsersPort(deps),
    netdrive: makeNetdrivePort(deps),
    queueSampler: makeQueueSamplerPort(deps),
    organizations: makeOrganizationsPort(deps),
  };
}

function makeOrganizationsPort(deps: CpBindingsDeps): OrganizationDirectoryPort {
  const { db } = deps;
  return {
    async listVisible(scope) {
      if (!scope.isPlatformWide && scope.orgIds.length === 0) return [];
      return db
        .select({ id: orgs.id, name: orgs.name })
        .from(orgs)
        .where(scope.isPlatformWide ? undefined : inArray(orgs.id, scope.orgIds))
        .orderBy(asc(orgs.name), asc(orgs.id));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────────

function makeJobsPort(deps: CpBindingsDeps): JobsServicePort {
  const { db } = deps;
  return {
    async countCompletedSince(orgIds, since) {
      return countJobsByStatus(db, orgIds, since, "completed");
    },
    async countFailedSince(orgIds, since) {
      return countJobsByStatus(db, orgIds, since, "failed");
    },
    async topUsersByJobs(orgIds, since, limit) {
      // Migration 0013 — `jobs.org_id` is the authoritative scope column;
      // no users join required.
      const filters = [gte(jobs.completedAt, since)];
      const orgCond = orgScopeOnJobs(orgIds);
      if (orgCond) filters.push(orgCond);
      const rows = await db
        .select({
          submittedBy: jobs.submittedBy,
          jobs: sql<number>`count(*)::int`,
        })
        .from(jobs)
        .where(and(...filters))
        .groupBy(jobs.submittedBy)
        .orderBy(desc(sql`count(*)`))
        .limit(limit);
      return rows
        .filter((r) => r.submittedBy !== null)
        .map((r) => ({ userId: String(r.submittedBy), jobs: r.jobs }));
    },
    async topAppsByJobs(orgIds, since, limit) {
      // Migration 0013 — `jobs.app_template_key` carries the app key
      // directly. Drop the `metering_usage_raw` join. Rows where the key
      // is NULL (e.g. raw `kq submit`) are intentionally excluded so the
      // dashboard "top apps" widget doesn't show a phantom `<no-app>`
      // bucket dwarfing real apps.
      const filters = [gte(jobs.completedAt, since), sql`${jobs.appTemplateKey} IS NOT NULL`];
      const orgCond = orgScopeOnJobs(orgIds);
      if (orgCond) filters.push(orgCond);
      const rows = await db
        .select({
          appKey: jobs.appTemplateKey,
          jobs: sql<number>`count(*)::int`,
        })
        .from(jobs)
        .where(and(...filters))
        .groupBy(jobs.appTemplateKey)
        .orderBy(desc(sql`count(*)`))
        .limit(limit);
      return rows.map((r) => ({
        // appTemplateKey is filtered NOT NULL above, but TS sees it as
        // string | null — coerce defensively for the consumer.
        appKey: r.appKey ?? "<no-app>",
        jobs: r.jobs,
      }));
    },
  };
}

async function countJobsByStatus(
  db: PgDb,
  orgIds: string[],
  since: Date,
  status: "completed" | "failed",
): Promise<number> {
  const filters = [eq(jobs.status, status), gte(jobs.completedAt, since)];
  const orgCond = orgScopeOnJobs(orgIds);
  if (orgCond) filters.push(orgCond);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(...filters));
  return rows[0]?.count ?? 0;
}

/**
 * Migration 0013 — org-scope predicate on `jobs.org_id`. Returns
 * `undefined` when the caller passed an empty array — by convention we
 * interpret that as "platform-wide, no filter".
 */
function orgScopeOnJobs(orgIds: string[]) {
  if (orgIds.length === 0) return undefined;
  return inArray(jobs.orgId, orgIds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agents (platform-wide; agents table has no org_id)
// ─────────────────────────────────────────────────────────────────────────────

function makeAgentsPort(deps: CpBindingsDeps): AgentsServicePort {
  const { db, agentManager } = deps;
  return {
    async countByHealth(orgIds) {
      const filters = orgIds.length > 0 ? [inArray(agentsTable.providerOrgId, orgIds)] : [];
      const rows = await db
        .select({
          status: agentsTable.status,
          count: sql<number>`count(*)::int`,
        })
        .from(agentsTable)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .groupBy(agentsTable.status);
      let healthy = 0;
      let sick = 0;
      let offline = 0;
      for (const r of rows) {
        if (r.status === "online") healthy += r.count;
        else if (r.status === "unhealthy") sick += r.count;
        else if (r.status === "offline") offline += r.count;
      }
      return { healthy, sick, offline };
    },
    async listForOrgs(orgIds) {
      const all = await agentManager.list();
      return all
        .filter((agent) => orgIds.length === 0 || orgIds.includes(agent.providerOrgId ?? ""))
        .map((a) => ({
          id: a.agentId,
          hostname: a.siteName,
          siteId: a.siteName,
          status: a.status,
        }));
    },
    async listByIds(agentIds) {
      if (agentIds.length === 0) return [];
      const rows = await db
        .select({
          id: agentsTable.agentId,
          hostname: agentsTable.siteName,
          siteId: agentsTable.siteName,
          status: agentsTable.status,
        })
        .from(agentsTable)
        .where(inArray(agentsTable.agentId, agentIds));
      return rows;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

function makeAuditPort(deps: CpBindingsDeps): AuditServicePort {
  const { db } = deps;
  return {
    async search({ orgIds, from, to, text, limit, offset }) {
      // Migration 0013 — `audit_log.org_id` is stamped at write time, so
      // the previous actor-IN-(subquery on users) workaround is gone.
      const filters = [gte(auditLog.createdAt, from), lte(auditLog.createdAt, to)];
      if (orgIds.length > 0) {
        filters.push(inArray(auditLog.orgId, orgIds));
      }
      if (text) {
        const pattern = `%${text}%`;
        const textFilter = or(ilike(auditLog.action, pattern), ilike(auditLog.target, pattern));
        if (textFilter) filters.push(textFilter);
      }
      const where = and(...filters);
      const items = await db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(limit)
        .offset(offset);
      const totalRow = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(where);
      return { total: totalRow[0]?.count ?? 0, items };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Software governance
// ─────────────────────────────────────────────────────────────────────────────

function makeSoftwarePort(deps: CpBindingsDeps): SoftwareGovernancePort {
  const { db } = deps;
  return {
    async listPolicies(orgIds) {
      const overview = await buildSoftwareOverview(deps, {
        orgIds,
        isPlatformWide: orgIds.length === 0,
      });
      return overview.clusters.map((cluster) => ({
        cluster: cluster.cluster,
        whitelist: uniqueSorted(cluster.agents.flatMap((agent) => agent.effectivePolicy.allowList)),
        blacklist: uniqueSorted(cluster.agents.flatMap((agent) => agent.effectivePolicy.denyList)),
        locked: cluster.lockedAgents === cluster.agents.length && cluster.agents.length > 0,
      }));
    },
    async getOverview(scope) {
      return buildSoftwareOverview(deps, scope);
    },
    async saveProviderPolicy(scope, input) {
      const providerOrgIds = await resolveProviderOrgIds(db, scope, input.providerOrgId);
      for (const providerOrgId of providerOrgIds) {
        await upsertPolicyOverlay(db, {
          scope: "provider",
          providerOrgId,
          clusterId: null,
          agentId: null,
          input,
        });
      }
      await syncLegacyPoliciesForProviders(deps, scope, providerOrgIds);
      return buildSoftwareOverview(deps, scope);
    },
    async saveClusterPolicy(scope, clusterId, input) {
      const targets = (await loadScopedAgentRows(db, scope)).filter(
        (agent) => agentClusterKey(agent) === clusterId,
      );
      if (targets.length === 0) {
        throw new Error(`cluster ${clusterId} not in CP scope`);
      }
      const providerOrgIds = uniqueSorted(
        targets.flatMap((agent) => (agent.providerOrgId ? [agent.providerOrgId] : [])),
      );
      for (const providerOrgId of providerOrgIds) {
        await upsertPolicyOverlay(db, {
          scope: "cluster",
          providerOrgId,
          clusterId,
          agentId: null,
          input,
        });
      }
      for (const agent of targets) {
        await syncLegacyPolicyForAgent(deps, agent);
      }
      return buildSoftwareOverview(deps, scope);
    },
    async saveAgentPolicy(scope, agentId, input) {
      const targets = await loadScopedAgentRows(db, scope);
      const agent = targets.find((row) => row.agentId === agentId);
      if (!agent) {
        throw new Error(`agent ${agentId} not in CP scope`);
      }
      await upsertPolicyOverlay(db, {
        scope: "agent",
        providerOrgId: agent.providerOrgId,
        clusterId: agentClusterKey(agent),
        agentId,
        input,
      });
      await syncLegacyPolicyForAgent(deps, agent);
      return buildSoftwareOverview(deps, scope);
    },
    async setPolicy({ scope, cluster, list, specs }) {
      const targets = (await loadScopedAgentRows(db, scope)).filter(
        (row) => agentClusterKey(row) === cluster,
      );
      const currentOverview = await buildSoftwareOverview(deps, scope);
      const current = currentOverview.clusters.find((row) => row.cluster === cluster);
      const effective =
        current?.clusterPolicy ?? current?.agents[0]?.effectivePolicy ?? defaultPolicyInput();
      const input = {
        ...effective,
        allowList: list === "whitelist" ? specs : effective.allowList,
        denyList: list === "blacklist" ? specs : effective.denyList,
      };
      for (const providerOrgId of uniqueSorted(
        targets.flatMap((agent) => (agent.providerOrgId ? [agent.providerOrgId] : [])),
      )) {
        await upsertPolicyOverlay(db, {
          scope: "cluster",
          providerOrgId,
          clusterId: cluster,
          agentId: null,
          input,
        });
      }
      for (const agent of targets) {
        await syncLegacyPolicyForAgent(deps, agent);
      }
    },
    async reviewPreinstalledMapping(scope, input) {
      const targets = await loadScopedAgentRows(db, scope);
      const agent = targets.find((row) => row.agentId === input.agentId);
      if (!agent) {
        throw new Error(`agent ${input.agentId} not in CP scope`);
      }
      const where = and(
        eq(preinstalledSoftwareMappings.id, input.mappingId),
        eq(preinstalledSoftwareMappings.agentId, input.agentId),
      );
      if (input.decision === "approve") {
        await db
          .update(preinstalledSoftwareMappings)
          .set({
            confidence: "platform-locked",
            auditedBy: input.reviewedBy,
            auditedAt: new Date(),
          })
          .where(where);
      } else {
        await db.delete(preinstalledSoftwareMappings).where(where);
      }
      return buildSoftwareOverview(deps, scope);
    },
  };
}

type SoftwareScope = Pick<CpScope, "orgIds" | "isPlatformWide">;
type AgentRow = typeof agentsTable.$inferSelect;
type InstalledSoftwareRow = typeof agentInstalledSoftware.$inferSelect;
type LegacyPolicyRow = typeof softwarePolicies.$inferSelect;
type OverlayRow = typeof softwarePolicyOverlays.$inferSelect;
type PreinstalledMappingRow = typeof preinstalledSoftwareMappings.$inferSelect;

interface UpsertOverlayInput {
  scope: "provider" | "cluster" | "agent";
  providerOrgId: string | null;
  clusterId: string | null;
  agentId: string | null;
  input: PolicyOverlayInput;
}

async function buildSoftwareOverview(
  deps: CpBindingsDeps,
  scope: SoftwareScope,
): Promise<CpSoftwareOverview> {
  const { db } = deps;
  const agentRows = await loadScopedAgentRows(db, scope);
  const agentIds = agentRows.map((agent) => agent.agentId);
  const providerOrgIds = uniqueSorted(
    agentRows.flatMap((agent) => (agent.providerOrgId ? [agent.providerOrgId] : [])),
  );

  const [overlays, installedRows, mappingRows, legacyPolicies] = await Promise.all([
    loadPolicyOverlays(db, agentIds, providerOrgIds),
    agentIds.length > 0
      ? db
          .select()
          .from(agentInstalledSoftware)
          .where(inArray(agentInstalledSoftware.agentId, agentIds))
      : [],
    agentIds.length > 0
      ? db
          .select()
          .from(preinstalledSoftwareMappings)
          .where(inArray(preinstalledSoftwareMappings.agentId, agentIds))
      : [],
    agentIds.length > 0
      ? db.select().from(softwarePolicies).where(inArray(softwarePolicies.agentId, agentIds))
      : [],
  ]);

  const providerOverlays = overlays.filter((overlay) => overlay.scope === "provider");
  const clusterOverlays = overlays.filter((overlay) => overlay.scope === "cluster");
  const firstProviderPolicy = providerOverlays[0] ? overlayToView(providerOverlays[0]) : null;
  const installedByAgent = groupInstalledSoftwareByAgent(installedRows);
  const mappingsByAgent = groupPreinstalledMappingsByAgent(mappingRows);
  const onlineAgentIds = new Set(deps.onlineAgentIds?.() ?? []);
  const agentsView = agentRows.map((agent): CpSoftwareAgentView => {
    const providerOverlay = overlays.find(
      (overlay) => overlay.scope === "provider" && overlay.providerOrgId === agent.providerOrgId,
    );
    const agentOverlay = overlays.find(
      (overlay) => overlay.scope === "agent" && overlay.agentId === agent.agentId,
    );
    const clusterOverlay = clusterOverlays.find(
      (overlay) =>
        overlay.providerOrgId === agent.providerOrgId &&
        overlay.clusterId === agentClusterKey(agent),
    );
    const legacyPolicy = legacyPolicies.find((policy) => policy.agentId === agent.agentId);
    const installed = installedByAgent.get(agent.agentId) ?? [];
    const mappings = mappingsByAgent.get(agent.agentId) ?? [];
    const controlChannelOnline = onlineAgentIds.has(agent.agentId);
    return {
      agentId: agent.agentId,
      cluster: agentClusterKey(agent),
      siteId: agent.siteId,
      providerOrgId: agent.providerOrgId,
      status: agent.status,
      runtimeStatus: runtimeStatusForAgent(agent.status, controlChannelOnline),
      controlChannelOnline,
      lastHeartbeat: agent.lastHeartbeat?.toISOString() ?? null,
      schedulerType: agent.schedulerType,
      schedulerVersion: agent.schedulerVersion,
      providerPolicy: providerOverlay ? overlayToView(providerOverlay) : null,
      clusterPolicy: clusterOverlay ? overlayToView(clusterOverlay) : null,
      agentPolicy: agentOverlay ? overlayToView(agentOverlay) : null,
      effectivePolicy: mergePolicyInputs(
        providerOverlay,
        clusterOverlay,
        agentOverlay,
        legacyPolicy,
      ),
      installedCount: installed.length,
      installedSpecs: installed.map((row) => row.spec).sort(),
      preinstalledMappings: mappings
        .map((row) => ({
          id: row.id,
          localSpec: row.localSpec,
          assetId: row.assetId,
          confidence: row.confidence,
          auditedBy: row.auditedBy,
          auditedAt: row.auditedAt?.toISOString() ?? null,
        }))
        .sort((a, b) => a.localSpec.localeCompare(b.localSpec)),
    };
  });

  const clusters = Array.from(groupByAgentCluster(agentsView).entries())
    .map(([cluster, agents]) => ({
      cluster,
      providerOrgId: agents.find((agent) => agent.providerOrgId)?.providerOrgId ?? null,
      clusterPolicy: agents.find((agent) => agent.clusterPolicy)?.clusterPolicy ?? null,
      agents,
      lockedAgents: agents.filter((agent) => agent.effectivePolicy.lockEnabled).length,
      mirrorCount: uniqueSorted(
        agents.flatMap((agent) => agent.effectivePolicy.mirrors.map((mirror) => mirror.name)),
      ).length,
      preinstallCount: uniqueSorted(agents.flatMap((agent) => agent.effectivePolicy.preinstallList))
        .length,
      installedCount: agents.reduce((sum, agent) => sum + agent.installedCount, 0),
      installModes: uniqueInstallModes(agents.map((agent) => agent.effectivePolicy.installMode)),
    }))
    .sort((a, b) => a.cluster.localeCompare(b.cluster));

  return {
    providerOrgIds,
    providerPolicy: firstProviderPolicy,
    clusters,
    agents: agentsView,
    summary: {
      clusters: clusters.length,
      agents: agentsView.length,
      lockedAgents: agentsView.filter((agent) => agent.effectivePolicy.lockEnabled).length,
      overrides: agentsView.filter(
        (agent) => agent.clusterPolicy !== null || agent.agentPolicy !== null,
      ).length,
      mirrors: uniqueSorted(
        agentsView.flatMap((agent) => agent.effectivePolicy.mirrors.map((mirror) => mirror.name)),
      ).length,
      preinstalledSpecs: uniqueSorted(
        agentsView.flatMap((agent) => agent.effectivePolicy.preinstallList),
      ).length,
      installedSpecs: uniqueSorted(agentsView.flatMap((agent) => agent.installedSpecs)).length,
    },
  };
}

function runtimeStatusForAgent(status: string, controlChannelOnline: boolean): string {
  if (!controlChannelOnline) return "offline";
  if (status === "online" || status === "offline" || status === "unhealthy") return status;
  return "unhealthy";
}

async function loadScopedAgentRows(db: PgDb, scope: SoftwareScope): Promise<AgentRow[]> {
  if (scope.orgIds.length === 0 && scope.isPlatformWide) {
    return db.select().from(agentsTable).orderBy(agentsTable.siteName, agentsTable.agentId);
  }
  if (scope.orgIds.length === 0) return [];
  return db
    .select()
    .from(agentsTable)
    .where(inArray(agentsTable.providerOrgId, scope.orgIds))
    .orderBy(agentsTable.siteName, agentsTable.agentId);
}

async function loadPolicyOverlays(
  db: PgDb,
  agentIds: string[],
  providerOrgIds: string[],
): Promise<OverlayRow[]> {
  const conditions = [];
  if (agentIds.length > 0) conditions.push(inArray(softwarePolicyOverlays.agentId, agentIds));
  if (providerOrgIds.length > 0) {
    conditions.push(inArray(softwarePolicyOverlays.providerOrgId, providerOrgIds));
  }
  if (conditions.length === 0) return [];
  const where = conditions.length === 1 ? conditions[0] : or(...conditions);
  return db.select().from(softwarePolicyOverlays).where(where);
}

async function resolveProviderOrgIds(
  db: PgDb,
  scope: SoftwareScope,
  requestedProviderOrgId?: string,
): Promise<string[]> {
  if (requestedProviderOrgId) {
    if (scope.orgIds.length > 0 && !scope.orgIds.includes(requestedProviderOrgId)) {
      throw new Error(`provider org ${requestedProviderOrgId} not in CP scope`);
    }
    return [requestedProviderOrgId];
  }
  if (scope.orgIds.length > 0) return scope.orgIds;
  const agents = await loadScopedAgentRows(db, scope);
  const ids = uniqueSorted(
    agents.flatMap((agent) => (agent.providerOrgId ? [agent.providerOrgId] : [])),
  );
  if (ids.length === 0) {
    throw new Error("no provider org available for provider-level software policy");
  }
  return ids;
}

async function upsertPolicyOverlay(db: PgDb, data: UpsertOverlayInput): Promise<void> {
  const version = `v${Date.now()}`;
  const existing = await db
    .select({ id: softwarePolicyOverlays.id })
    .from(softwarePolicyOverlays)
    .where(
      and(
        eq(softwarePolicyOverlays.scope, data.scope),
        data.providerOrgId
          ? eq(softwarePolicyOverlays.providerOrgId, data.providerOrgId)
          : isNull(softwarePolicyOverlays.providerOrgId),
        data.clusterId
          ? eq(softwarePolicyOverlays.clusterId, data.clusterId)
          : isNull(softwarePolicyOverlays.clusterId),
        data.agentId
          ? eq(softwarePolicyOverlays.agentId, data.agentId)
          : isNull(softwarePolicyOverlays.agentId),
      ),
    )
    .limit(1);
  const values = {
    scope: data.scope,
    providerOrgId: data.providerOrgId,
    clusterId: data.clusterId,
    agentId: data.agentId,
    installMode: data.input.installMode,
    allowList: uniqueSorted(data.input.allowList),
    denyList: uniqueSorted(data.input.denyList),
    lockEnabled: data.input.lockEnabled,
    trustedPublicAutoInstall: data.input.trustedPublicAutoInstall,
    usecaseDefaultAllow: data.input.usecaseDefaultAllow,
    usecaseAllowList: uniqueSorted(data.input.usecaseAllowList),
    usecaseDenyList: uniqueSorted(data.input.usecaseDenyList),
    mirrors: uniqueMirrors(data.input.mirrors),
    preinstallList: uniqueSorted(data.input.preinstallList),
    version,
    updatedAt: new Date(),
  };
  const existingId = existing[0]?.id;
  if (existingId) {
    await db
      .update(softwarePolicyOverlays)
      .set(values)
      .where(eq(softwarePolicyOverlays.id, existingId));
    return;
  }
  await db.insert(softwarePolicyOverlays).values(values);
}

async function syncLegacyPoliciesForProviders(
  deps: CpBindingsDeps,
  scope: SoftwareScope,
  providerOrgIds: string[],
): Promise<void> {
  const agents = (await loadScopedAgentRows(deps.db, scope)).filter(
    (agent) => agent.providerOrgId && providerOrgIds.includes(agent.providerOrgId),
  );
  for (const agent of agents) {
    await syncLegacyPolicyForAgent(deps, agent);
  }
}

async function syncLegacyPolicyForAgent(deps: CpBindingsDeps, agent: AgentRow): Promise<void> {
  const overview = await buildSoftwareOverview(deps, {
    orgIds: agent.providerOrgId ? [agent.providerOrgId] : [],
    isPlatformWide: agent.providerOrgId === null,
  });
  const view = overview.agents.find((item) => item.agentId === agent.agentId);
  if (!view) return;
  const bundle: PolicyBundle = {
    allowList: view.effectivePolicy.allowList,
    denyList: view.effectivePolicy.denyList,
    lockEnabled: view.effectivePolicy.lockEnabled,
    mirrors: view.effectivePolicy.mirrors,
    preinstallList: view.effectivePolicy.preinstallList,
  };
  const stored = await deps.policyStore.upsertForAgent(agent.agentId, bundle);
  deps.policyPusher?.pushToAgent(agent.agentId, {
    version: stored.version,
    allowList: stored.allowList,
    denyList: stored.denyList,
    lockEnabled: stored.lockEnabled,
    mirrors: stored.mirrors,
    preinstallList: stored.preinstallList,
  });
}

function overlayToView(row: OverlayRow): PolicyOverlayView {
  return {
    scope: row.scope === "provider" ? "provider" : row.scope === "cluster" ? "cluster" : "agent",
    providerOrgId: row.providerOrgId,
    clusterId: row.clusterId,
    agentId: row.agentId,
    installMode: normalizeInstallMode(row.installMode),
    allowList: row.allowList,
    denyList: row.denyList,
    lockEnabled: row.lockEnabled,
    trustedPublicAutoInstall: row.trustedPublicAutoInstall,
    usecaseDefaultAllow: row.usecaseDefaultAllow,
    usecaseAllowList: row.usecaseAllowList,
    usecaseDenyList: row.usecaseDenyList,
    mirrors: row.mirrors,
    preinstallList: row.preinstallList,
    version: row.version,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

function mergePolicyInputs(
  provider: OverlayRow | undefined,
  cluster: OverlayRow | undefined,
  agent: OverlayRow | undefined,
  legacy: LegacyPolicyRow | undefined,
): PolicyOverlayInput {
  const base = defaultPolicyInput();
  return {
    installMode: normalizeInstallMode(
      agent?.installMode ?? cluster?.installMode ?? provider?.installMode ?? base.installMode,
    ),
    allowList: uniqueSorted([
      ...(provider?.allowList ?? []),
      ...(cluster?.allowList ?? []),
      ...(legacy?.allowList ?? []),
      ...(agent?.allowList ?? []),
    ]),
    denyList: uniqueSorted([
      ...(provider?.denyList ?? []),
      ...(cluster?.denyList ?? []),
      ...(legacy?.denyList ?? []),
      ...(agent?.denyList ?? []),
    ]),
    lockEnabled:
      (provider?.lockEnabled ?? false) ||
      (cluster?.lockEnabled ?? false) ||
      (legacy?.lockEnabled ?? false) ||
      (agent?.lockEnabled ?? false),
    trustedPublicAutoInstall:
      agent?.trustedPublicAutoInstall ??
      cluster?.trustedPublicAutoInstall ??
      provider?.trustedPublicAutoInstall ??
      false,
    usecaseDefaultAllow:
      agent?.usecaseDefaultAllow ??
      cluster?.usecaseDefaultAllow ??
      provider?.usecaseDefaultAllow ??
      true,
    usecaseAllowList: uniqueSorted([
      ...(provider?.usecaseAllowList ?? []),
      ...(cluster?.usecaseAllowList ?? []),
      ...(agent?.usecaseAllowList ?? []),
    ]),
    usecaseDenyList: uniqueSorted([
      ...(provider?.usecaseDenyList ?? []),
      ...(cluster?.usecaseDenyList ?? []),
      ...(agent?.usecaseDenyList ?? []),
    ]),
    mirrors: uniqueMirrors([
      ...(agent?.mirrors ?? []),
      ...(legacy?.mirrors ?? []),
      ...(cluster?.mirrors ?? []),
      ...(provider?.mirrors ?? []),
    ]),
    preinstallList: uniqueSorted([
      ...(agent?.preinstallList ?? []),
      ...(legacy?.preinstallList ?? []),
      ...(cluster?.preinstallList ?? []),
      ...(provider?.preinstallList ?? []),
    ]),
  };
}

function defaultPolicyInput(): PolicyOverlayInput {
  return {
    installMode: "explicit-install-grant",
    allowList: [],
    denyList: [],
    lockEnabled: false,
    trustedPublicAutoInstall: false,
    usecaseDefaultAllow: true,
    usecaseAllowList: [],
    usecaseDenyList: [],
    mirrors: [],
    preinstallList: [],
  };
}

function normalizeInstallMode(value: string): InstallMode {
  if (
    value === "preinstalled-only" ||
    value === "trusted-public-auto-install" ||
    value === "explicit-install-grant"
  ) {
    return value;
  }
  return "explicit-install-grant";
}

function uniqueSorted(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

function uniqueInstallModes(values: InstallMode[]): InstallMode[] {
  return [...new Set(values)].sort();
}

function uniqueMirrors(mirrors: MirrorInput[]): MirrorInput[] {
  const byName = new Map<string, MirrorInput>();
  for (const mirror of mirrors) {
    const name = mirror.name.trim();
    const url = mirror.url.trim();
    if (!name || !url || byName.has(name)) continue;
    byName.set(name, {
      name,
      url,
      ...(mirror.priority != null ? { priority: mirror.priority } : {}),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function groupInstalledSoftwareByAgent(
  rows: InstalledSoftwareRow[],
): Map<string, InstalledSoftwareRow[]> {
  const grouped = new Map<string, InstalledSoftwareRow[]>();
  for (const row of rows) {
    grouped.set(row.agentId, [...(grouped.get(row.agentId) ?? []), row]);
  }
  return grouped;
}

function groupPreinstalledMappingsByAgent(
  rows: PreinstalledMappingRow[],
): Map<string, PreinstalledMappingRow[]> {
  const grouped = new Map<string, PreinstalledMappingRow[]>();
  for (const row of rows) {
    grouped.set(row.agentId, [...(grouped.get(row.agentId) ?? []), row]);
  }
  return grouped;
}

function groupByAgentCluster(agents: CpSoftwareAgentView[]): Map<string, CpSoftwareAgentView[]> {
  const grouped = new Map<string, CpSoftwareAgentView[]>();
  for (const agent of agents) {
    grouped.set(agent.cluster, [...(grouped.get(agent.cluster) ?? []), agent]);
  }
  return grouped;
}

function agentClusterKey(agent: AgentRow): string {
  return agent.clusterId ?? agent.siteName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

function makeUsersPort(deps: CpBindingsDeps): UsersServicePort {
  const { db } = deps;
  return {
    async listInOrgs({ orgIds, query, limit, offset }) {
      const filters = [];
      if (query) {
        const pattern = `%${query}%`;
        const queryFilter = or(ilike(users.email, pattern), ilike(users.displayName, pattern));
        if (queryFilter) filters.push(queryFilter);
      }
      if (orgIds.length > 0) filters.push(inArray(userOrgMemberships.orgId, orgIds));
      const where = filters.length > 0 ? and(...filters) : undefined;

      const baseSelection = {
        id: users.id,
        email: users.email,
        role: users.role,
        suspended: users.suspended,
        quota: usageQuotas.remainingCreditUnits,
      };
      const quotaJoin = and(eq(usageQuotas.scope, "user"), eq(usageQuotas.scopeId, users.id));
      const rows =
        orgIds.length > 0
          ? await db
              .selectDistinct(baseSelection)
              .from(users)
              .innerJoin(userOrgMemberships, eq(userOrgMemberships.userId, users.id))
              .leftJoin(usageQuotas, quotaJoin)
              .where(where)
              .limit(limit)
              .offset(offset)
          : await db
              .select(baseSelection)
              .from(users)
              .leftJoin(usageQuotas, quotaJoin)
              .where(where)
              .limit(limit)
              .offset(offset);

      const totalRow =
        orgIds.length > 0
          ? await db
              .select({ count: sql<number>`count(distinct ${users.id})::int` })
              .from(users)
              .innerJoin(userOrgMemberships, eq(userOrgMemberships.userId, users.id))
              .where(where)
          : await db.select({ count: sql<number>`count(*)::int` }).from(users).where(where);

      return {
        total: totalRow[0]?.count ?? 0,
        items: rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          suspended: r.suspended,
          quota: r.quota ?? 0,
        })),
      };
    },
    async setSuspended(userId, suspended, audit) {
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ suspended, updatedAt: new Date() })
          .where(eq(users.id, userId));
        await tx.insert(auditLog).values({
          actor: audit.actor,
          orgId: audit.orgId,
          action: "cp.user.suspend",
          target: `user:${userId}`,
          diff: { after: { suspended } },
        });
      });
    },
    async setQuota(userId, quota, audit) {
      await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: usageQuotas.id })
          .from(usageQuotas)
          .where(and(eq(usageQuotas.scope, "user"), eq(usageQuotas.scopeId, userId)))
          .limit(1);
        if (existing) {
          await tx
            .update(usageQuotas)
            .set({ remainingCreditUnits: quota, updatedAt: new Date() })
            .where(eq(usageQuotas.id, existing.id));
        } else {
          await tx.insert(usageQuotas).values({
            scope: "user",
            scopeId: userId,
            remainingCreditUnits: quota,
            updatedAt: new Date(),
          });
        }
        await tx.insert(auditLog).values({
          actor: audit.actor,
          orgId: audit.orgId,
          action: "cp.user.quota",
          target: `user:${userId}`,
          diff: { after: { quota } },
        });
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NetDrive (real per-event ledger via netdrive_transfer_log)
// ─────────────────────────────────────────────────────────────────────────────

function makeNetdrivePort(deps: CpBindingsDeps): NetdriveServicePort {
  const { db } = deps;
  return {
    async bytesTransferredSince(orgIds, since) {
      // Migration 0014 — `netdrive_transfer_log` is the authoritative byte
      // ledger. NetDriveService appends one row per finalized upload /
      // download (and, when wired, mirror); we sum across every direction
      // because the dashboard widget shows total transfer bytes. A future
      // direction-broken-out widget should group-by direction at its own
      // call site instead of changing this aggregate.
      //
      // Empty `orgIds` means "platform-wide" by the file-level convention —
      // we omit the org filter so super-/platform-admins see everything.
      const filters = [gte(netdriveTransferLog.occurredAt, since)];
      if (orgIds.length > 0) {
        filters.push(inArray(netdriveTransferLog.orgId, orgIds));
      }
      const rows = await db
        .select({
          total: sql<number>`coalesce(sum(${netdriveTransferLog.bytes}), 0)::bigint`,
        })
        .from(netdriveTransferLog)
        .where(and(...filters));
      // postgres-js returns `bigint` columns as either string or number
      // depending on the driver mode; coerce defensively.
      const raw = rows[0]?.total ?? 0;
      const n = typeof raw === "string" ? Number(raw) : raw;
      return Number.isFinite(n) ? n : 0;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue depth sampler — Migration 0013 reads agents.queue_depth directly.
// ─────────────────────────────────────────────────────────────────────────────

function makeQueueSamplerPort(deps: CpBindingsDeps): QueueDepthSamplerPort {
  const { db } = deps;
  return {
    async peakSince(_orgIds, _since) {
      // Migration 0013 — `agents.queue_depth` is the live snapshot maintained
      // by every heartbeat. We return MAX(queueDepth) across the agents
      // table; this is platform-wide because the `agents` table has no
      // `org_id` column. Org-narrowing would require joining agents to
      // jobs that ran for an org in the window — heavier than warranted
      // for the dashboard hot path.
      //
      // The `since` parameter is currently unused — `agents.queue_depth`
      // tracks the live value, not a time-series. A real peak-over-window
      // read would source from `agent_metrics`
      // (metric='scheduler_queued_jobs'); flagged here so the upgrade
      // path is obvious when the timescale view lands.
      const rows = await db.select({ peak: max(agentsTable.queueDepth) }).from(agentsTable);
      const raw = rows[0]?.peak ?? 0;
      // `max()` over an integer column is typed as `string | null` under
      // postgres-js; coerce defensively.
      const n = typeof raw === "string" ? Number(raw) : raw;
      return Number.isFinite(n) ? Number(n) : 0;
    },
  };
}
