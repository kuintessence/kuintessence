// CP Console service — aggregates data from existing services for the
// `/api/cp/*` routes.
//
// This file is the integration point for the CP Console UI. It does NOT
// duplicate any existing service logic — it composes audit-log,
// agents-registry, jobs, software-governance, and metering services.
// The aggregation enforces tenant scope on every read; the route layer
// supplies the scope from the cpRbac middleware.
//
// Design intent: dependency injection. All collaborators are passed in
// the constructor so tests can use in-memory fakes without forking the
// service.

import type { CpScope } from "../middleware/cp-rbac";
import { rejectLegacyCpGovernanceWrite } from "./cp-governance-write-gate";

// ─────────────────────────────────────────────────────────────────────────────
// Collaborator interfaces (slimmed to what we actually call).
// The integrator wires real services in via `wireCpConsole(...)` at
// app-bootstrap time.
// ─────────────────────────────────────────────────────────────────────────────

export interface JobsServicePort {
  countCompletedSince(orgIds: string[], since: Date): Promise<number>;
  countFailedSince(orgIds: string[], since: Date): Promise<number>;
  topUsersByJobs(
    orgIds: string[],
    since: Date,
    limit: number,
  ): Promise<Array<{ userId: string; jobs: number }>>;
  topAppsByJobs(
    orgIds: string[],
    since: Date,
    limit: number,
  ): Promise<Array<{ appKey: string; jobs: number }>>;
}

export interface AgentsServicePort {
  countByHealth(orgIds: string[]): Promise<{ healthy: number; sick: number; offline: number }>;
  listForOrgs(
    orgIds: string[],
  ): Promise<Array<{ id: string; hostname: string; siteId: string; status: string }>>;
  listByIds(
    agentIds: string[],
  ): Promise<Array<{ id: string; hostname: string; siteId: string; status: string }>>;
}

export interface AuditServicePort {
  search(opts: {
    orgIds: string[];
    from: Date;
    to: Date;
    text?: string;
    limit: number;
    offset: number;
  }): Promise<{ total: number; items: Array<unknown> }>;
}

export interface SoftwareGovernancePort {
  listPolicies(orgIds: string[]): Promise<LegacySoftwarePolicy[]>;
  getOverview(scope: CpScope): Promise<CpSoftwareOverview>;
  saveProviderPolicy(scope: CpScope, input: ProviderPolicyInput): Promise<CpSoftwareOverview>;
  saveClusterPolicy(
    scope: CpScope,
    clusterId: string,
    input: PolicyOverlayInput,
  ): Promise<CpSoftwareOverview>;
  saveAgentPolicy(
    scope: CpScope,
    agentId: string,
    input: PolicyOverlayInput,
  ): Promise<CpSoftwareOverview>;
  setPolicy(opts: {
    scope: CpScope;
    cluster: string;
    list: "whitelist" | "blacklist";
    specs: string[];
  }): Promise<void>;
  reviewPreinstalledMapping(
    scope: CpScope,
    input: PreinstalledMappingReviewInput,
  ): Promise<CpSoftwareOverview>;
}

export interface PreinstalledMappingReviewInput {
  agentId: string;
  mappingId: string;
  decision: "approve" | "reject";
  reviewedBy: string;
}

export type InstallMode =
  | "preinstalled-only"
  | "trusted-public-auto-install"
  | "explicit-install-grant";

export interface MirrorInput {
  name: string;
  url: string;
  priority?: number;
}

export interface PolicyOverlayInput {
  installMode: InstallMode;
  allowList: string[];
  denyList: string[];
  lockEnabled: boolean;
  trustedPublicAutoInstall: boolean;
  usecaseDefaultAllow: boolean;
  usecaseAllowList: string[];
  usecaseDenyList: string[];
  mirrors: MirrorInput[];
  preinstallList: string[];
}

export interface ProviderPolicyInput extends PolicyOverlayInput {
  providerOrgId?: string;
}

export interface PolicyOverlayView extends PolicyOverlayInput {
  scope: "provider" | "cluster" | "agent";
  providerOrgId: string | null;
  clusterId: string | null;
  agentId: string | null;
  version: string;
  updatedAt: string | null;
}

export interface LegacySoftwarePolicy {
  cluster: string;
  whitelist: string[];
  blacklist: string[];
  locked: boolean;
}

export interface CpSoftwareAgentView {
  agentId: string;
  cluster: string;
  siteId: string | null;
  providerOrgId: string | null;
  status: string;
  runtimeStatus: string;
  controlChannelOnline: boolean;
  lastHeartbeat: string | null;
  schedulerType: string;
  schedulerVersion: string;
  providerPolicy: PolicyOverlayView | null;
  clusterPolicy: PolicyOverlayView | null;
  agentPolicy: PolicyOverlayView | null;
  effectivePolicy: PolicyOverlayInput;
  installedCount: number;
  installedSpecs: string[];
  preinstalledMappings: Array<{
    id: string;
    localSpec: string;
    assetId: string;
    confidence: string;
    auditedBy: string | null;
    auditedAt: string | null;
  }>;
}

export interface CpSoftwareClusterView {
  cluster: string;
  providerOrgId: string | null;
  clusterPolicy: PolicyOverlayView | null;
  agents: CpSoftwareAgentView[];
  lockedAgents: number;
  mirrorCount: number;
  preinstallCount: number;
  installedCount: number;
  installModes: InstallMode[];
}

export interface CpSoftwareOverview {
  providerOrgIds: string[];
  providerPolicy: PolicyOverlayView | null;
  clusters: CpSoftwareClusterView[];
  agents: CpSoftwareAgentView[];
  summary: {
    clusters: number;
    agents: number;
    lockedAgents: number;
    overrides: number;
    mirrors: number;
    preinstalledSpecs: number;
    installedSpecs: number;
  };
}

export interface UsersServicePort {
  listInOrgs(opts: { orgIds: string[]; query?: string; limit: number; offset: number }): Promise<{
    total: number;
    items: Array<{ id: string; email: string; role: string; suspended: boolean; quota: number }>;
  }>;
  setSuspended(
    userId: string,
    suspended: boolean,
    audit: { actor: string; orgId: string | null },
  ): Promise<void>;
  setQuota(
    userId: string,
    quota: number,
    audit: { actor: string; orgId: string | null },
  ): Promise<void>;
}

export interface NetdriveServicePort {
  bytesTransferredSince(orgIds: string[], since: Date): Promise<number>;
}

export interface QueueDepthSamplerPort {
  peakSince(orgIds: string[], since: Date): Promise<number>;
}

export interface OrganizationDirectoryPort {
  listVisible(scope: CpScope): Promise<Array<{ id: string; name: string }>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardKpis {
  windowFrom: string;
  windowTo: string;
  jobsCompleted: number;
  jobsFailed: number;
  bytesTransferred: number;
  queueDepthPeak: number;
  agentsHealthy: number;
  agentsSick: number;
  agentsOffline: number;
  topUsers: Array<{
    userId: string;
    jobs: number;
    displayName: string | null;
    email: string | null;
    organizationName: string | null;
  }>;
  topApps: Array<{ appKey: string; jobs: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export interface CpConsoleDeps {
  jobs: JobsServicePort;
  agents: AgentsServicePort;
  audit: AuditServicePort;
  software: SoftwareGovernancePort;
  users: UsersServicePort;
  netdrive: NetdriveServicePort;
  queueSampler: QueueDepthSamplerPort;
  organizations: OrganizationDirectoryPort;
  /** Injectable wall clock. */
  now?: () => Date;
}

export class CpConsoleService {
  private readonly d: CpConsoleDeps;
  private readonly now: () => Date;
  constructor(deps: CpConsoleDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async getDashboardKpis(scope: CpScope): Promise<DashboardKpis> {
    const now = this.now();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const orgIds = scope.orgIds;
    const [completed, failed, bytes, peak, agents, topUsers, topApps, users, organizations] =
      await Promise.all([
        this.d.jobs.countCompletedSince(orgIds, since),
        this.d.jobs.countFailedSince(orgIds, since),
        this.d.netdrive.bytesTransferredSince(orgIds, since),
        this.d.queueSampler.peakSince(orgIds, since),
        this.d.agents.countByHealth(orgIds),
        this.d.jobs.topUsersByJobs(orgIds, since, 5),
        this.d.jobs.topAppsByJobs(orgIds, since, 5),
        this.d.users.listInOrgs({ orgIds, limit: 1_000, offset: 0 }),
        this.d.organizations.listVisible(scope),
      ]);
    const usersById = new Map(users.items.map((user) => [user.id, user]));
    const organizationName =
      orgIds.length === 1
        ? (organizations.find((organization) => organization.id === orgIds[0])?.name ?? null)
        : null;
    return {
      windowFrom: since.toISOString(),
      windowTo: now.toISOString(),
      jobsCompleted: completed,
      jobsFailed: failed,
      bytesTransferred: bytes,
      queueDepthPeak: peak,
      agentsHealthy: agents.healthy,
      agentsSick: agents.sick,
      agentsOffline: agents.offline,
      topUsers: topUsers.map((entry) => {
        const user = usersById.get(entry.userId);
        return {
          ...entry,
          displayName: user?.email.split("@")[0] ?? null,
          email: user?.email ?? null,
          organizationName,
        };
      }),
      topApps,
    };
  }

  async listSoftwarePolicies(scope: CpScope) {
    return this.d.software.listPolicies(scope.orgIds);
  }

  async getSoftwareOverview(scope: CpScope) {
    return this.d.software.getOverview(scope);
  }

  async saveProviderSoftwarePolicy(scope: CpScope, input: ProviderPolicyInput) {
    return this.d.software.saveProviderPolicy(scope, input);
  }

  async saveClusterSoftwarePolicy(scope: CpScope, clusterId: string, input: PolicyOverlayInput) {
    return this.d.software.saveClusterPolicy(scope, clusterId, input);
  }

  async saveAgentSoftwarePolicy(scope: CpScope, agentId: string, input: PolicyOverlayInput) {
    return this.d.software.saveAgentPolicy(scope, agentId, input);
  }

  async editSoftwarePolicy(
    scope: CpScope,
    payload: { cluster: string; list: "whitelist" | "blacklist"; specs: string[] },
  ) {
    return this.d.software.setPolicy({ scope, ...payload });
  }

  async reviewPreinstalledMapping(scope: CpScope, input: PreinstalledMappingReviewInput) {
    return this.d.software.reviewPreinstalledMapping(scope, input);
  }

  async listUsers(
    scope: CpScope,
    query: { search?: string; limit?: number; offset?: number } = {},
  ) {
    return this.d.users.listInOrgs({
      orgIds: scope.orgIds,
      query: query.search,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  async setUserSuspended(
    scope: CpScope,
    userId: string,
    _suspended: boolean,
    _audit: { actor: string; orgId: string | null },
  ) {
    // Preserve the existing scope read before rejecting the legacy write.
    await ensureUserInScope(this.d, scope, userId);
    rejectLegacyCpGovernanceWrite();
  }

  async setUserQuota(
    scope: CpScope,
    userId: string,
    quota: number,
    _audit: { actor: string; orgId: string | null },
  ) {
    if (!Number.isInteger(quota) || quota < 0) {
      throw new Error("quota must be a non-negative integer");
    }
    await ensureUserInScope(this.d, scope, userId);
    rejectLegacyCpGovernanceWrite();
  }

  async searchAudit(
    scope: CpScope,
    query: {
      from: string;
      to: string;
      text?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (Number.isNaN(from.getTime())) throw new Error("invalid 'from' timestamp");
    if (Number.isNaN(to.getTime())) throw new Error("invalid 'to' timestamp");
    if (from > to) throw new Error("'from' must be <= 'to'");
    return this.d.audit.search({
      orgIds: scope.orgIds,
      from,
      to,
      text: query.text,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  async listAgents(scope: CpScope) {
    return this.d.agents.listForOrgs(scope.orgIds);
  }

  async listAgentsByIds(agentIds: string[]) {
    return this.d.agents.listByIds(agentIds);
  }

  async listRegistrationProviderOrgs(scope: CpScope) {
    return this.d.organizations.listVisible(scope);
  }
}

async function ensureUserInScope(
  deps: CpConsoleDeps,
  scope: CpScope,
  userId: string,
): Promise<void> {
  if (scope.isPlatformWide) return;
  const r = await deps.users.listInOrgs({
    orgIds: scope.orgIds,
    query: undefined,
    limit: 1000,
    offset: 0,
  });
  if (!r.items.some((u) => u.id === userId)) {
    throw new Error(`user ${userId} not in CP scope`);
  }
}
