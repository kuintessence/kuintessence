import { createHash } from "node:crypto";
import {
  agentInstalledSoftware,
  agentSoftware,
  agents,
  type PgDb,
  softwareAssetGrants,
  softwareAssets,
  softwareConcretizeCache,
  softwarePolicies,
  softwarePolicyOverlays,
} from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  hasRole,
  matchesSpecPattern,
  type RoleName,
  type SoftwareAssetCapability,
  type SoftwareAssetSummary,
  type SoftwareAvailabilityNode,
  type SoftwareAvailabilityRequest,
  type SoftwareAvailabilityResponse,
  type SoftwareAvailabilityUsecaseRef,
  type SoftwareInstallMode,
} from "@kuintessence/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { LicenseRuntimeGovernanceService } from "./license-runtime-governance";

type AssetRow = typeof softwareAssets.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type PolicyOverlayRow = typeof softwarePolicyOverlays.$inferSelect;
type LegacyPolicyRow = typeof softwarePolicies.$inferSelect;
export type AccessDecision = { allowed: true } | { allowed: false; reason: string };

interface InstalledIndex {
  byAgent: Map<string, Set<string>>;
}

export interface EffectivePolicy {
  installMode: SoftwareInstallMode;
  allowList: string[];
  denyList: string[];
  lockEnabled: boolean;
  trustedPublicAutoInstall: boolean;
  usecaseDefaultAllow: boolean;
  usecaseAllowList: string[];
  usecaseDenyList: string[];
}

export interface AvailabilityPolicyLayer {
  installMode?: string | null;
  allowList?: string[] | null;
  denyList?: string[] | null;
  lockEnabled?: boolean | null;
  trustedPublicAutoInstall?: boolean | null;
  usecaseDefaultAllow?: boolean | null;
  usecaseAllowList?: string[] | null;
  usecaseDenyList?: string[] | null;
}

export interface SoftwareAvailabilityRuntimeOptions {
  onlineAgentIds?: () => string[];
  governance?: LicenseRuntimeGovernanceService;
}

const TERMINAL_BLOCKED_LIFECYCLES = new Set(["revoked", "archived"]);
const SOFT_HIDDEN_LIFECYCLES = new Set(["hidden"]);

export class SoftwareAvailabilityService {
  constructor(
    private readonly db: PgDb,
    private readonly runtime: SoftwareAvailabilityRuntimeOptions = {},
    private readonly authz?: AuthzService,
  ) {}

  async resolve(input: SoftwareAvailabilityRequest, principal: BoundPrincipal) {
    const asset = await this.resolveAsset(input);
    const spec = this.resolveSpec(input, asset);
    if (!spec) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "resolve-availability requires assetRef or rawSpec",
        400,
      );
    }

    const localAccess: AccessDecision = asset
      ? await this.evaluateAccess(asset, principal, "use")
      : { allowed: true };
    const access = asset
      ? await authorizeSoftwareAssetAccessThroughSpice({
          authz: this.authz,
          assetId: asset.id,
          capability: "use",
          principal,
          local: localAccess,
        })
      : localAccess;
    const localInstallAccess: AccessDecision = asset
      ? await this.evaluateAccess(asset, principal, "install")
      : hasRole(principal.role as RoleName, "org_admin")
        ? { allowed: true }
        : { allowed: false, reason: "principal role cannot trigger install" };
    const installAccess = asset
      ? await authorizeSoftwareAssetAccessThroughSpice({
          authz: this.authz,
          assetId: asset.id,
          capability: "install",
          principal,
          local: localInstallAccess,
        })
      : localInstallAccess;
    const candidates = await this.loadCandidateAgents(input);
    const controlChannelOnline = this.controlChannelOnlineByAgent(candidates);
    const installed = await this.loadInstalledIndex(candidates.map((a) => a.agentId));
    const policies = await this.loadPolicies(candidates);
    const dag = await this.resolveDag(spec, asset, input, candidates);
    const installedAvailable: SoftwareAvailabilityNode[] = [];
    const installableAvailable: SoftwareAvailabilityNode[] = [];
    const blocked: SoftwareAvailabilityNode[] = [];
    const explanations = new Set<string>();

    if (access.allowed === false) {
      explanations.add(access.reason);
    }
    if (asset && TERMINAL_BLOCKED_LIFECYCLES.has(asset.lifecycle)) {
      explanations.add(`asset lifecycle '${asset.lifecycle}' blocks new runs`);
    }
    if (asset && SOFT_HIDDEN_LIFECYCLES.has(asset.lifecycle)) {
      explanations.add(`asset lifecycle '${asset.lifecycle}' hides catalog discovery`);
    }

    for (const agent of candidates) {
      const policy = policies.get(agent.agentId) ?? defaultPolicy();
      const installedSpec = findInstalledSpec(installed.byAgent.get(agent.agentId), spec);
      const reasons = this.evaluateAgent({
        agent,
        asset,
        spec,
        policy,
        accessAllowed: access.allowed,
        installAllowed: installAccess.allowed,
        installRequested: input.installable,
        installedSpec,
        usecaseRef: input.usecaseRef,
        controlChannelOnline: controlChannelOnline.get(agent.agentId) ?? null,
      });
      const licenseBlocks = await this.evaluateLicense(
        asset,
        !installedSpec && input.installable,
        principal,
        spec,
        agent.providerOrgId ?? asset?.providerOrgId ?? null,
      );
      reasons.push(...licenseBlocks.map((block) => `${block.code}: ${block.message}`));
      const node = toAvailabilityNode(agent, reasons, policy.installMode, installedSpec);
      if (installedSpec && reasons.length === 0) {
        installedAvailable.push(node);
      } else if (!installedSpec && reasons.length === 0) {
        installableAvailable.push(node);
      } else {
        blocked.push(node);
      }
    }

    const response: SoftwareAvailabilityResponse = {
      spec,
      ...(asset ? { asset: rowToSummary(asset) } : {}),
      installedAvailable,
      installableAvailable,
      blocked,
      concretizedDag: dag,
      explanations: [...explanations],
    };
    return response;
  }

  /** Authorize a concrete asset reference without running placement discovery. */
  async assertAssetCapability(
    assetId: string,
    principal: BoundPrincipal,
    capability: SoftwareAssetCapability,
  ): Promise<void> {
    const [asset] = await this.db
      .select()
      .from(softwareAssets)
      .where(eq(softwareAssets.id, assetId))
      .limit(1);
    if (!asset) {
      throw new AppError(ErrorCode.NOT_FOUND, `Software asset ${assetId} not found`, 404);
    }
    const local = await this.evaluateAccess(asset, principal, capability);
    const access = await authorizeSoftwareAssetAccessThroughSpice({
      authz: this.authz,
      assetId,
      capability,
      principal,
      local,
    });
    if (!access.allowed) {
      throw new AppError(ErrorCode.FORBIDDEN, access.reason, 403);
    }
  }

  private async evaluateLicense(
    asset: AssetRow | null,
    installRequested: boolean,
    principal: BoundPrincipal,
    assetKey: string | null,
    providerOrgId: string | null,
  ) {
    if (!this.runtime.governance || !assetKey) return [];
    const policy = asset ? await this.runtime.governance.getCanonicalLicensePolicy(asset.id) : null;
    const identifier = policy?.identifiers?.[0] ?? assetKey;
    return this.runtime.governance.evaluateLicense({
      assetKey: identifier,
      assetId: asset?.id,
      policy: policy ?? undefined,
      providerEntitlementSubjectIds: providerOrgId ? [providerOrgId] : [],
      consumerEntitlementSubjectIds: [principal.userId, ...principal.orgIds].filter(
        (subjectId): subjectId is string => subjectId !== null,
      ),
      installRequested,
    });
  }

  private async resolveAsset(input: SoftwareAvailabilityRequest): Promise<AssetRow | null> {
    const ref = input.assetRef;
    if (!ref) return this.resolveRawSpecAsset(input.rawSpec);
    if (ref.id) {
      const [row] = await this.db
        .select()
        .from(softwareAssets)
        .where(eq(softwareAssets.id, ref.id))
        .limit(1);
      return row ?? null;
    }
    if (!ref.name) return null;
    const conditions = [eq(softwareAssets.kind, ref.kind), eq(softwareAssets.name, ref.name)];
    if (ref.version) conditions.push(eq(softwareAssets.version, ref.version));
    if (ref.source) conditions.push(eq(softwareAssets.source, ref.source));
    const [row] = await this.db
      .select()
      .from(softwareAssets)
      .where(and(...conditions))
      .limit(1);
    return row ?? null;
  }

  private async resolveRawSpecAsset(rawSpec: string | undefined): Promise<AssetRow | null> {
    if (!rawSpec) return null;
    const packageName = packageNameFromSpec(rawSpec);
    if (!packageName) return null;
    const version = versionFromSpec(rawSpec);
    const conditions = [
      eq(softwareAssets.kind, "spack-package"),
      eq(softwareAssets.name, packageName),
      eq(softwareAssets.lifecycle, "published"),
    ];
    if (version) conditions.push(eq(softwareAssets.version, version));
    const rows = await this.db
      .select()
      .from(softwareAssets)
      .where(and(...conditions))
      .limit(2);
    return rows.length === 1 && rows[0] ? rows[0] : null;
  }

  private resolveSpec(input: SoftwareAvailabilityRequest, asset: AssetRow | null): string | null {
    if (input.rawSpec) return input.rawSpec;
    if (!asset) return null;
    const payload = asset.payload;
    const spack = payload.spack;
    if (isRecord(spack)) {
      const defaultSpec = spack.defaultSpec;
      if (typeof defaultSpec === "string" && defaultSpec.length > 0) return defaultSpec;
      const packageName = spack.packageName;
      if (typeof packageName === "string" && packageName.length > 0) {
        return asset.version === "catalog" ? packageName : `${packageName}@${asset.version}`;
      }
    }
    return asset.version === "catalog" ? asset.name : `${asset.name}@${asset.version}`;
  }

  private async evaluateAccess(
    asset: AssetRow,
    principal: BoundPrincipal,
    capability: SoftwareAssetCapability,
  ): Promise<AccessDecision> {
    if (hasRole(principal.role as RoleName, "platform_admin")) return { allowed: true };
    if (TERMINAL_BLOCKED_LIFECYCLES.has(asset.lifecycle) && capability !== "view") {
      return {
        allowed: false,
        reason: `asset lifecycle '${asset.lifecycle}' blocks ${capability}`,
      };
    }
    if (softwareAvailabilityOwnsUserAsset(asset, principal)) return { allowed: true };
    if (asset.ownerOrgId && principal.orgIds.includes(asset.ownerOrgId)) return { allowed: true };
    if (asset.providerOrgId && principal.orgIds.includes(asset.providerOrgId))
      return { allowed: true };
    if (
      asset.visibility === "platform-public" &&
      (capability === "view" || capability === "use") &&
      asset.lifecycle !== "revoked"
    ) {
      return { allowed: true };
    }

    const subjectIds = softwareAvailabilityGrantSubjectIds(principal);
    const rows = await this.db
      .select()
      .from(softwareAssetGrants)
      .where(
        and(
          eq(softwareAssetGrants.assetId, asset.id),
          or(
            inArray(softwareAssetGrants.subjectId, subjectIds),
            and(
              eq(softwareAssetGrants.subjectKind, "platform"),
              eq(softwareAssetGrants.subjectId, "platform"),
            ),
          ),
        ),
      );
    const granted = rows.some((row) => row.capabilities.includes(capability));
    if (granted) return { allowed: true };
    return {
      allowed: false,
      reason: `principal lacks ${capability} permission for ${asset.kind} ${asset.name}@${asset.version}`,
    };
  }

  private async loadCandidateAgents(input: SoftwareAvailabilityRequest): Promise<AgentRow[]> {
    const conditions = [eq(agents.status, "online")];
    if (input.targetAgentIds && input.targetAgentIds.length > 0) {
      conditions.push(inArray(agents.agentId, input.targetAgentIds));
    }
    if (input.providerOrgIds && input.providerOrgIds.length > 0) {
      conditions.push(inArray(agents.providerOrgId, input.providerOrgIds));
    }
    return this.db
      .select()
      .from(agents)
      .where(and(...conditions));
  }

  private controlChannelOnlineByAgent(candidates: AgentRow[]): Map<string, boolean> {
    if (!this.runtime.onlineAgentIds) return new Map();
    const online = new Set(this.runtime.onlineAgentIds());
    return new Map(candidates.map((agent) => [agent.agentId, online.has(agent.agentId)]));
  }

  private async loadInstalledIndex(agentIds: string[]): Promise<InstalledIndex> {
    const byAgent = new Map<string, Set<string>>();
    if (agentIds.length === 0) return { byAgent };

    const [reported, legacy] = await Promise.all([
      this.db
        .select()
        .from(agentInstalledSoftware)
        .where(inArray(agentInstalledSoftware.agentId, agentIds)),
      this.db.select().from(agentSoftware).where(inArray(agentSoftware.agentId, agentIds)),
    ]);

    for (const row of reported) {
      addInstalled(byAgent, row.agentId, row.spec);
      addInstalled(byAgent, row.agentId, `${row.name}@${row.version}`);
    }
    for (const row of legacy) {
      addInstalled(byAgent, row.agentId, `${row.softwareName}@${row.softwareVersion}`);
    }
    return { byAgent };
  }

  private async loadPolicies(candidates: AgentRow[]): Promise<Map<string, EffectivePolicy>> {
    const result = new Map<string, EffectivePolicy>();
    if (candidates.length === 0) return result;
    const agentIds = candidates.map((a) => a.agentId);
    const providerOrgIds = [
      ...new Set(candidates.flatMap((a) => (a.providerOrgId ? [a.providerOrgId] : []))),
    ];

    const [overlays, legacy] = await Promise.all([
      this.db
        .select()
        .from(softwarePolicyOverlays)
        .where(
          or(
            inArray(softwarePolicyOverlays.agentId, agentIds),
            providerOrgIds.length > 0
              ? inArray(softwarePolicyOverlays.providerOrgId, providerOrgIds)
              : isNull(softwarePolicyOverlays.providerOrgId),
          ),
        ),
      this.db.select().from(softwarePolicies).where(inArray(softwarePolicies.agentId, agentIds)),
    ]);

    for (const agent of candidates) {
      const providerOverlay = overlays.find(
        (p) => p.scope === "provider" && p.providerOrgId === agent.providerOrgId,
      );
      const clusterOverlay = overlays.find(
        (p) =>
          p.scope === "cluster" &&
          p.providerOrgId === agent.providerOrgId &&
          p.clusterId === agentClusterKey(agent),
      );
      const agentOverlay = overlays.find((p) => p.scope === "agent" && p.agentId === agent.agentId);
      const legacyPolicy = legacy.find((p) => p.agentId === agent.agentId);
      result.set(
        agent.agentId,
        mergePolicy(providerOverlay, clusterOverlay, agentOverlay, legacyPolicy),
      );
    }
    return result;
  }

  private async resolveDag(
    spec: string,
    asset: AssetRow | null,
    input: SoftwareAvailabilityRequest,
    candidates: AgentRow[],
  ) {
    const contextKey = hashContext({
      spec,
      assetId: asset?.id ?? null,
      targetAgentIds: input.targetAgentIds ?? [],
      providerOrgIds: input.providerOrgIds ?? [],
      usecaseRef: input.usecaseRef ?? null,
      candidateAgents: candidates.map((a) => a.agentId).sort(),
    });
    const [cached] = await this.db
      .select()
      .from(softwareConcretizeCache)
      .where(
        and(
          eq(softwareConcretizeCache.rootSpec, spec),
          eq(softwareConcretizeCache.contextKey, contextKey),
        ),
      )
      .limit(1);
    if (cached && isRecord(cached.dag)) {
      const dependencies = Array.isArray(cached.dag.dependencies)
        ? cached.dag.dependencies.filter(isDependency)
        : [];
      return {
        rootSpec: spec,
        contextKey,
        dependencies,
        generatedAt: cached.generatedAt.toISOString(),
        cached: true,
      };
    }

    const dependencies = assetDependencies(asset);
    const generatedAt = new Date();
    await this.db
      .insert(softwareConcretizeCache)
      .values({
        assetId: asset?.id ?? null,
        rootSpec: spec,
        contextKey,
        dag: { dependencies },
        generatedAt,
      })
      .onConflictDoNothing();
    return {
      rootSpec: spec,
      contextKey,
      dependencies,
      generatedAt: generatedAt.toISOString(),
      cached: false,
    };
  }

  private evaluateAgent(input: {
    agent: AgentRow;
    asset: AssetRow | null;
    spec: string;
    policy: EffectivePolicy;
    accessAllowed: boolean;
    installAllowed: boolean;
    installRequested: boolean;
    installedSpec?: string;
    usecaseRef?: SoftwareAvailabilityUsecaseRef;
    controlChannelOnline: boolean | null;
  }): string[] {
    const reasons: string[] = [];
    reasons.push(...evaluateRuntimeAvailability(input.controlChannelOnline));
    if (!input.accessAllowed) reasons.push("asset use permission denied");
    if (input.asset && TERMINAL_BLOCKED_LIFECYCLES.has(input.asset.lifecycle)) {
      reasons.push(`asset lifecycle '${input.asset.lifecycle}' blocks scheduling`);
    }
    const packageName = packageNameFromSpec(input.spec);
    if (matchesAny(input.policy.denyList, input.spec, packageName)) {
      reasons.push("blocked by provider deny list");
    }
    reasons.push(...evaluateUsecasePolicy(input.policy, input.usecaseRef));
    if (
      input.policy.lockEnabled &&
      input.policy.allowList.length > 0 &&
      !matchesAny(input.policy.allowList, input.spec, packageName)
    ) {
      reasons.push("not present in provider allow list while lock is enabled");
    }
    if (input.installedSpec) return reasons;
    if (input.policy.installMode === "preinstalled-only") {
      reasons.push("provider policy only allows preinstalled software");
    }
    if (!input.installRequested) {
      reasons.push("installable availability was not requested");
    }
    const trustedAutoInstall =
      input.policy.installMode === "trusted-public-auto-install" &&
      input.asset?.trustedForGlobalUse === true &&
      input.asset.visibility === "platform-public";
    if (!input.installAllowed && !trustedAutoInstall) {
      reasons.push("principal lacks install permission");
    }
    return reasons;
  }
}

export function softwareAvailabilityGrantSubjectIds(principal: BoundPrincipal): string[] {
  return [
    ...new Set([...(principal.userId ? [principal.userId] : []), ...principal.orgIds, "platform"]),
  ];
}

export function softwareAvailabilityOwnsUserAsset(
  asset: Pick<AssetRow, "ownerUserId">,
  principal: BoundPrincipal,
): boolean {
  return Boolean(principal.userId && asset.ownerUserId === principal.userId);
}

export async function authorizeSoftwareAssetAccessThroughSpice(input: {
  authz?: AuthzService;
  assetId: string;
  capability: SoftwareAssetCapability;
  principal: BoundPrincipal;
  local: AccessDecision;
}): Promise<AccessDecision> {
  if (!input.authz || input.authz.mode === "off") return input.local;
  const subjectId = input.principal.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: input.principal.userId,
    actorEmail: input.principal.email,
    resource: { type: "software_asset", id: input.assetId },
    permission: input.capability,
    subject: { type: "user", id: subjectId },
    context: {
      capability: input.capability,
      localAllowed: input.local.allowed,
    },
  };
  if (input.authz.mode === "shadow") {
    await input.authz.shadowCheck({ ...check, localAllowed: input.local.allowed });
    return input.local;
  }
  await input.authz.requirePermission(check, isPlatformAdmin(input.principal));
  return input.local;
}

function isPlatformAdmin(principal: BoundPrincipal): boolean {
  return hasRole(principal.role as RoleName, "platform_admin");
}

function defaultPolicy(): EffectivePolicy {
  return {
    installMode: "explicit-install-grant",
    allowList: [],
    denyList: [],
    lockEnabled: false,
    trustedPublicAutoInstall: false,
    usecaseDefaultAllow: true,
    usecaseAllowList: [],
    usecaseDenyList: [],
  };
}

function mergePolicy(
  provider: PolicyOverlayRow | undefined,
  cluster: PolicyOverlayRow | undefined,
  agent: PolicyOverlayRow | undefined,
  legacy: LegacyPolicyRow | undefined,
): EffectivePolicy {
  return mergeEffectiveAvailabilityPolicyLayers({ provider, cluster, legacy, agentOverlay: agent });
}

export function mergeEffectiveAvailabilityPolicyLayers(input: {
  provider?: AvailabilityPolicyLayer | null;
  cluster?: AvailabilityPolicyLayer | null;
  legacy?: AvailabilityPolicyLayer | null;
  agentOverlay?: AvailabilityPolicyLayer | null;
}): EffectivePolicy {
  const base = defaultPolicy();
  return {
    installMode: normalizeInstallMode(
      input.agentOverlay?.installMode ??
        input.cluster?.installMode ??
        input.provider?.installMode ??
        base.installMode,
    ),
    allowList: uniqueSorted([
      ...(input.provider?.allowList ?? []),
      ...(input.cluster?.allowList ?? []),
      ...(input.legacy?.allowList ?? []),
      ...(input.agentOverlay?.allowList ?? []),
    ]),
    denyList: uniqueSorted([
      ...(input.provider?.denyList ?? []),
      ...(input.cluster?.denyList ?? []),
      ...(input.legacy?.denyList ?? []),
      ...(input.agentOverlay?.denyList ?? []),
    ]),
    lockEnabled:
      (input.provider?.lockEnabled ?? false) ||
      (input.cluster?.lockEnabled ?? false) ||
      (input.legacy?.lockEnabled ?? false) ||
      (input.agentOverlay?.lockEnabled ?? false),
    trustedPublicAutoInstall:
      input.agentOverlay?.trustedPublicAutoInstall ??
      input.cluster?.trustedPublicAutoInstall ??
      input.provider?.trustedPublicAutoInstall ??
      base.trustedPublicAutoInstall,
    usecaseDefaultAllow:
      input.agentOverlay?.usecaseDefaultAllow ??
      input.cluster?.usecaseDefaultAllow ??
      input.provider?.usecaseDefaultAllow ??
      base.usecaseDefaultAllow,
    usecaseAllowList: uniqueSorted([
      ...(input.provider?.usecaseAllowList ?? []),
      ...(input.cluster?.usecaseAllowList ?? []),
      ...(input.agentOverlay?.usecaseAllowList ?? []),
    ]),
    usecaseDenyList: uniqueSorted([
      ...(input.provider?.usecaseDenyList ?? []),
      ...(input.cluster?.usecaseDenyList ?? []),
      ...(input.agentOverlay?.usecaseDenyList ?? []),
    ]),
  };
}

export function evaluateUsecasePolicy(
  policy: {
    usecaseDefaultAllow: boolean;
    usecaseAllowList: string[];
    usecaseDenyList: string[];
  },
  ref: SoftwareAvailabilityUsecaseRef | undefined,
): string[] {
  if (!ref) return [];
  const identifiers = usecasePolicyIdentifiers(ref);
  if (identifiers.length === 0) return [];
  if (matchesAnyIdentifiers(policy.usecaseDenyList, identifiers)) {
    return ["blocked by usecase deny list"];
  }
  if (policy.usecaseDefaultAllow) return [];
  if (matchesAnyIdentifiers(policy.usecaseAllowList, identifiers)) return [];
  return ["usecase is not allowed by provider usecase policy"];
}

export function evaluateRuntimeAvailability(controlChannelOnline: boolean | null): string[] {
  if (controlChannelOnline === false) return ["agent control channel is offline"];
  return [];
}

function agentClusterKey(agent: AgentRow): string {
  return agent.clusterId ?? agent.siteName;
}

function normalizeInstallMode(value: string | undefined): SoftwareInstallMode {
  if (
    value === "preinstalled-only" ||
    value === "trusted-public-auto-install" ||
    value === "explicit-install-grant"
  ) {
    return value;
  }
  return "explicit-install-grant";
}

function rowToSummary(row: AssetRow): SoftwareAssetSummary {
  return {
    id: row.id,
    kind: row.kind as SoftwareAssetSummary["kind"],
    name: row.name,
    version: row.version,
    source: row.source as SoftwareAssetSummary["source"],
    lifecycle: row.lifecycle as SoftwareAssetSummary["lifecycle"],
    visibility: row.visibility as SoftwareAssetSummary["visibility"],
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    providerOrgId: row.providerOrgId,
    supplierUserId: row.supplierUserId,
    supplierOrgId: row.supplierOrgId,
    officialForkOfAssetId: row.officialForkOfAssetId,
    trustedForGlobalUse: row.trustedForGlobalUse,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAvailabilityNode(
  agent: AgentRow,
  reasons: string[],
  installMode: SoftwareInstallMode,
  installedSpec?: string,
): SoftwareAvailabilityNode {
  return {
    agentId: agent.agentId,
    siteName: agent.siteName,
    providerOrgId: agent.providerOrgId,
    status: agent.status,
    ...(installedSpec ? { installedSpec } : {}),
    installMode,
    reasons,
  };
}

function addInstalled(index: Map<string, Set<string>>, agentId: string, spec: string): void {
  if (!index.has(agentId)) index.set(agentId, new Set());
  index.get(agentId)?.add(spec);
}

function findInstalledSpec(installed: Set<string> | undefined, spec: string): string | undefined {
  if (!installed) return undefined;
  if (installed.has(spec)) return spec;
  const name = packageNameFromSpec(spec);
  return [...installed].find((entry) => entry === name || entry.startsWith(`${name}@`));
}

function packageNameFromSpec(spec: string): string {
  const trimmed = spec.trim().replace(/^\^/, "");
  const match = /^[A-Za-z0-9._+-]+/.exec(trimmed);
  return match?.[0] ?? trimmed;
}

function versionFromSpec(spec: string): string | undefined {
  const match = /^[A-Za-z0-9._+-]+@([A-Za-z0-9._+-]+)/.exec(spec.trim());
  return match?.[1];
}

function matchesAny(patterns: string[], spec: string, packageName: string): boolean {
  return patterns.some(
    (pattern) => matchesSpecPattern(spec, pattern) || patternMatches(pattern, packageName),
  );
}

function matchesAnyIdentifiers(patterns: string[], identifiers: string[]): boolean {
  return patterns.some((pattern) =>
    identifiers.some((identifier) => patternMatches(pattern, identifier)),
  );
}

function uniqueSorted(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

function usecasePolicyIdentifiers(ref: SoftwareAvailabilityUsecaseRef): string[] {
  const identifiers = new Set<string>();
  if (ref.id) {
    identifiers.add(ref.id);
    identifiers.add(`asset:${ref.id}`);
    identifiers.add(`usecase:${ref.id}`);
  }
  if (ref.name) {
    identifiers.add(ref.name);
    identifiers.add(`usecase:${ref.name}`);
    if (ref.version) {
      identifiers.add(`${ref.name}@${ref.version}`);
      identifiers.add(`usecase:${ref.name}@${ref.version}`);
    }
  }
  return [...identifiers];
}

export function patternMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function assetDependencies(asset: AssetRow | null) {
  if (!asset) return [];
  const spack = asset.payload.spack;
  if (!isRecord(spack)) return [];
  const dependencies = spack.dependencies;
  if (!Array.isArray(dependencies)) return [];
  return dependencies
    .filter((dep): dep is string => typeof dep === "string" && dep.length > 0)
    .map((dep) => ({
      name: packageNameFromSpec(dep),
      spec: dep,
      virtual: dep.startsWith("^") || dep.includes("virtual="),
      providers: [],
    }));
}

function hashContext(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDependency(
  value: unknown,
): value is { name: string; spec: string; virtual: boolean; providers: string[] } {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.spec === "string" &&
    typeof value.virtual === "boolean" &&
    Array.isArray(value.providers) &&
    value.providers.every((provider) => typeof provider === "string")
  );
}
