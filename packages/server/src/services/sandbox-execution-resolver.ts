import {
  agents,
  clusterExecutionAccounts,
  type PgDb,
  type PgTransaction,
  sandboxRuntimeContractBindings,
  sandboxRuntimeProfiles,
  scriptAttestations,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
  userClusterAccountMappings,
  userOrgMemberships,
} from "@kuintessence/db";
import {
  type ExecutionIdentity,
  type SandboxDispatchIdentity,
  type SandboxRuntimeContractRef,
  SoftwareAssetPayloadSchema,
  type workflowDsl,
} from "@kuintessence/shared";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { sandboxRuntimeContractKey } from "./license-runtime-governance";
import { hashSandboxScript } from "./sandbox-script";

export class SandboxAuthorizationError extends Error {}

export interface ResolvedSandboxSource {
  language: workflowDsl.SandboxLanguage;
  entrypoint: string;
  content: string;
  sha256: string;
  assetRevisionId: string | null;
  assetLifecycle: string | null;
  runtimeContractRef: SandboxRuntimeContractRef | null;
}

export interface ResolvedSandboxRuntime {
  id: string;
  language: workflowDsl.SandboxLanguage;
  ociDigest: string | null;
  sifDigest: string | null;
  adapters: string[];
}

interface RuntimeTarget {
  runtimeContractRef: SandboxRuntimeContractRef;
  providerOrgId: string | null;
  agentId: string;
  clusterId: string | null;
  schedulerType: string;
}

function activeMappingCondition() {
  const now = new Date(Date.now());
  return and(
    eq(userClusterAccountMappings.status, "approved"),
    isNull(userClusterAccountMappings.revokedAt),
    or(isNull(userClusterAccountMappings.expiresAt), gt(userClusterAccountMappings.expiresAt, now)),
  );
}

function dispatchIdentity(
  row: typeof clusterExecutionAccounts.$inferSelect,
  mode: "SharedService" | "MappedAccount",
): SandboxDispatchIdentity {
  if (!row.enabled) throw new SandboxAuthorizationError("Sandbox execution account is disabled");
  if (row.backendType === "unix" && row.username && row.uid && row.gid) {
    return {
      mode,
      accountId: row.id,
      backend: "Unix",
      username: row.username,
      uid: row.uid,
      gid: row.gid,
      schedulerAccount: row.schedulerAccount,
      allowedQueues: row.allowedQueues,
    };
  }
  if (row.backendType === "kubernetes" && row.namespace && row.serviceAccount) {
    return {
      mode,
      accountId: row.id,
      backend: "Kubernetes",
      namespace: row.namespace,
      serviceAccount: row.serviceAccount,
      quotaPolicy: Object.keys(row.quotaPolicy).length > 0 ? JSON.stringify(row.quotaPolicy) : null,
    };
  }
  throw new SandboxAuthorizationError("Sandbox execution account backend facts are incomplete");
}

export class SandboxExecutionResolver {
  constructor(
    private readonly db: PgDb | PgTransaction,
    private readonly lockReads = false,
  ) {}

  async resolveSource(
    node: Extract<workflowDsl.WorkflowNode, { type: "Script" }>,
    userId: string,
    orgId?: string,
  ): Promise<ResolvedSandboxSource> {
    const source = node.source;
    if (!source) {
      throw new SandboxAuthorizationError(
        "Sandbox Script must resolve its source before execution",
      );
    }
    if (source.type === "Inline") {
      return {
        language: source.language,
        entrypoint: this.defaultEntrypoint(source.language),
        content: source.content,
        sha256: hashSandboxScript(source.content),
        assetRevisionId: null,
        assetLifecycle: null,
        runtimeContractRef: null,
      };
    }
    const query = this.db
      .select({ asset: softwareAssets, revision: softwareAssetRevisions })
      .from(softwareAssetRevisions)
      .innerJoin(softwareAssets, eq(softwareAssets.id, softwareAssetRevisions.assetId))
      .where(
        and(
          eq(softwareAssetRevisions.assetId, source.assetId),
          eq(softwareAssetRevisions.revision, source.revision),
          ...(source.assetRevisionId
            ? [eq(softwareAssetRevisions.id, source.assetRevisionId)]
            : []),
          eq(softwareAssets.kind, "sandbox-script"),
        ),
      )
      .limit(1);
    const [row] = await (this.lockReads ? query.for("share", { noWait: true }) : query);
    if (!row) throw new SandboxAuthorizationError("Pinned Sandbox script revision was not found");
    if (!(await this.canUseAsset(row.asset, userId, orgId))) {
      throw new SandboxAuthorizationError(
        "User is not authorized to use this Sandbox script revision",
      );
    }
    const parsed = SoftwareAssetPayloadSchema.safeParse(row.revision.payload);
    if (!parsed.success || parsed.data.kind !== "sandbox-script")
      throw new SandboxAuthorizationError("Asset revision is not a Sandbox script");
    const payload = parsed.data;
    const sha256 = hashSandboxScript(payload.content);
    if (
      sha256 !== payload.sha256 ||
      sha256 !== source.sha256 ||
      (row.revision.contentSha256 != null && row.revision.contentSha256 !== sha256)
    ) {
      throw new SandboxAuthorizationError(
        "Pinned Sandbox script revision hash does not match its content",
      );
    }
    return {
      language: payload.language,
      entrypoint: payload.entrypoint,
      content: payload.content,
      sha256,
      assetRevisionId: row.revision.id,
      assetLifecycle: row.asset.lifecycle,
      runtimeContractRef: payload.runtimeContractRef ?? null,
    };
  }

  async resolveRuntime(profileId: string): Promise<ResolvedSandboxRuntime> {
    const query = this.db
      .select()
      .from(sandboxRuntimeProfiles)
      .where(
        and(
          eq(sandboxRuntimeProfiles.id, profileId),
          eq(sandboxRuntimeProfiles.lifecycle, "active"),
        ),
      )
      .limit(1);
    const [row] = await (this.lockReads ? query.for("share", { noWait: true }) : query);
    if (!row) throw new SandboxAuthorizationError("Sandbox runtime profile is not active");
    return {
      id: row.id,
      language: row.language as workflowDsl.SandboxLanguage,
      ociDigest: row.ociDigest,
      sifDigest: row.sifDigest,
      adapters: row.adapters,
    };
  }

  async resolveRuntimeForTarget(target: RuntimeTarget): Promise<ResolvedSandboxRuntime> {
    if (!target.providerOrgId) {
      throw new SandboxAuthorizationError(
        "A provider organization is required to bind a Sandbox runtime contract",
      );
    }
    // A newly inserted, more-specific binding can change the selected runtime.
    if (this.lockReads)
      await this.db.execute(sql`lock table sandbox_runtime_contract_bindings in share mode nowait`);
    const query = this.db
      .select({ binding: sandboxRuntimeContractBindings, profile: sandboxRuntimeProfiles })
      .from(sandboxRuntimeContractBindings)
      .innerJoin(
        sandboxRuntimeProfiles,
        eq(sandboxRuntimeContractBindings.runtimeProfileId, sandboxRuntimeProfiles.id),
      )
      .where(
        and(
          eq(sandboxRuntimeContractBindings.providerOrgId, target.providerOrgId),
          eq(
            sandboxRuntimeContractBindings.runtimeContractRef,
            sandboxRuntimeContractKey(target.runtimeContractRef),
          ),
          eq(sandboxRuntimeContractBindings.status, "active"),
          isNull(sandboxRuntimeContractBindings.revokedAt),
          eq(sandboxRuntimeProfiles.lifecycle, "active"),
        ),
      );
    const rows = await (this.lockReads ? query.for("share", { noWait: true }) : query);
    const matching = rows.filter(
      ({ binding }) =>
        (binding.agentId === null || binding.agentId === target.agentId) &&
        (binding.clusterId === null || binding.clusterId === target.clusterId),
    );
    const rank = (binding: (typeof matching)[number]["binding"]) =>
      Number(binding.agentId !== null) + Number(binding.clusterId !== null);
    const highestRank = Math.max(...matching.map(({ binding }) => rank(binding)));
    const candidates = matching.filter(({ binding }) => rank(binding) === highestRank);
    const selected = candidates[0];
    if (!selected || candidates.length !== 1) {
      throw new SandboxAuthorizationError(
        "Sandbox runtime contract has no unambiguous active binding for the target",
      );
    }
    const runtime: ResolvedSandboxRuntime = {
      id: selected.profile.id,
      language: selected.profile.language as workflowDsl.SandboxLanguage,
      ociDigest: selected.profile.ociDigest,
      sifDigest: selected.profile.sifDigest,
      adapters: selected.profile.adapters,
    };
    const schedulerRuntime = this.runtimeForScheduler(runtime, target.schedulerType);
    if (schedulerRuntime.digest !== selected.binding.runtimeDigest) {
      throw new SandboxAuthorizationError(
        "Sandbox runtime contract binding digest does not match its concrete profile",
      );
    }
    return {
      ...runtime,
      ociDigest: schedulerRuntime.kind === "OCI" ? schedulerRuntime.digest : null,
      sifDigest: schedulerRuntime.kind === "SIF" ? schedulerRuntime.digest : null,
    };
  }

  async resolveRuntimeForAgent(input: {
    runtimeContractRef: SandboxRuntimeContractRef;
    agentId: string;
  }): Promise<ResolvedSandboxRuntime> {
    const query = this.db
      .select({
        agentId: agents.agentId,
        providerOrgId: agents.providerOrgId,
        clusterId: agents.clusterId,
        schedulerType: agents.schedulerType,
      })
      .from(agents)
      .where(eq(agents.agentId, input.agentId))
      .limit(1);
    const [agent] = await (this.lockReads ? query.for("share", { noWait: true }) : query);
    if (!agent) throw new SandboxAuthorizationError("Planned Sandbox Agent is unavailable");
    return this.resolveRuntimeForTarget({ ...input, ...agent });
  }

  runtimeForScheduler(runtime: ResolvedSandboxRuntime, schedulerType: string) {
    const adapter = this.adapterName(schedulerType);
    if (!adapter || !runtime.adapters.includes(adapter)) {
      throw new SandboxAuthorizationError(
        "Sandbox runtime does not support the selected scheduler adapter",
      );
    }
    const digest = adapter === "kubernetes" ? runtime.ociDigest : runtime.sifDigest;
    if (!digest)
      throw new SandboxAuthorizationError(
        "Sandbox runtime lacks the required adapter image digest",
      );
    return { kind: adapter === "kubernetes" ? ("OCI" as const) : ("SIF" as const), digest };
  }

  async resolveIdentity(input: {
    requested: ExecutionIdentity;
    pinnedAccountId?: string;
    userId: string;
    agentId: string;
    providerOrgId: string | null;
    source: ResolvedSandboxSource;
    runtimeProfileId: string;
    runtimeDigest: string;
  }): Promise<SandboxDispatchIdentity> {
    return (await this.resolveIdentityAuthorization(input)).identity;
  }

  async resolveIdentityAuthorization(
    input: Parameters<SandboxExecutionResolver["resolveIdentity"]>[0],
  ): Promise<{
    identity: SandboxDispatchIdentity;
    expiresAtUnixMs: number;
  }> {
    if (!input.providerOrgId)
      throw new SandboxAuthorizationError("Sandbox execution requires a provider organization");
    const accountScope = and(
      eq(clusterExecutionAccounts.providerOrgId, input.providerOrgId),
      input.pinnedAccountId ? eq(clusterExecutionAccounts.id, input.pinnedAccountId) : undefined,
    );
    if (input.requested.type === "Inherit") {
      throw new SandboxAuthorizationError(
        "Sandbox execution identity must be resolved before dispatch",
      );
    }
    if (input.requested.type === "SharedService") {
      const expiresAtUnixMs = await this.assertSharedServiceEligible(input);
      const accountQuery = this.db
        .select()
        .from(clusterExecutionAccounts)
        .where(
          and(
            eq(clusterExecutionAccounts.agentId, input.agentId),
            eq(clusterExecutionAccounts.sharedService, true),
            accountScope,
            eq(clusterExecutionAccounts.enabled, true),
          ),
        )
        .limit(1);
      const [account] = await (this.lockReads
        ? accountQuery.for("share", { noWait: true })
        : accountQuery);
      if (!account)
        throw new SandboxAuthorizationError("Selected Agent has no enabled shared service account");
      return { identity: dispatchIdentity(account, "SharedService"), expiresAtUnixMs };
    }
    const mappingFilter =
      input.requested.type === "MappedAccount"
        ? eq(userClusterAccountMappings.id, input.requested.mappingId)
        : undefined;
    const mappingQuery = this.db
      .select({ account: clusterExecutionAccounts, mapping: userClusterAccountMappings })
      .from(userClusterAccountMappings)
      .innerJoin(
        clusterExecutionAccounts,
        eq(clusterExecutionAccounts.id, userClusterAccountMappings.accountId),
      )
      .where(
        and(
          eq(userClusterAccountMappings.userId, input.userId),
          eq(clusterExecutionAccounts.agentId, input.agentId),
          eq(clusterExecutionAccounts.enabled, true),
          activeMappingCondition(),
          accountScope,
          mappingFilter,
        ),
      )
      .orderBy(desc(userClusterAccountMappings.isDefault), userClusterAccountMappings.requestedAt)
      .limit(1);
    const rows = await (this.lockReads
      ? mappingQuery.for("share", { noWait: true })
      : mappingQuery);
    const selected = rows[0];
    if (!selected)
      throw new SandboxAuthorizationError(
        "No approved mapped account exists for the selected Agent",
      );
    return {
      identity: dispatchIdentity(selected.account, "MappedAccount"),
      expiresAtUnixMs: selected.mapping.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
    };
  }

  private defaultEntrypoint(language: workflowDsl.SandboxLanguage): string {
    if (language === "python") return "main.py";
    if (language === "nodejs") return "main.js";
    return "main.sh";
  }

  private adapterName(schedulerType: string): string | null {
    const value = schedulerType.toLowerCase();
    if (value.includes("slurm")) return "slurm";
    if (value.includes("pbs")) return "pbs-pro";
    if (value.includes("torque")) return "torque";
    if (value.includes("k8s") || value.includes("kubernetes")) return "kubernetes";
    return null;
  }

  private async canUseAsset(
    asset: typeof softwareAssets.$inferSelect,
    userId: string,
    orgId?: string,
  ): Promise<boolean> {
    if (["revoked", "archived"].includes(asset.lifecycle)) return false;
    if (asset.ownerUserId === userId) return true;
    if (asset.visibility === "platform-public" && asset.lifecycle === "published") return true;
    const orgQuery = this.db
      .select({ orgId: userOrgMemberships.orgId })
      .from(userOrgMemberships)
      .where(
        and(
          eq(userOrgMemberships.userId, userId),
          orgId ? eq(userOrgMemberships.orgId, orgId) : undefined,
        ),
      );
    const orgRows = await (this.lockReads ? orgQuery.for("share", { noWait: true }) : orgQuery);
    const orgIds = orgRows.map((row) => row.orgId);
    const grantsQuery = this.db
      .select({ capabilities: softwareAssetGrants.capabilities })
      .from(softwareAssetGrants)
      .where(
        and(
          eq(softwareAssetGrants.assetId, asset.id),
          or(
            and(
              eq(softwareAssetGrants.subjectKind, "user"),
              eq(softwareAssetGrants.subjectId, userId),
            ),
            ...(orgIds.length > 0
              ? [
                  and(
                    inArray(softwareAssetGrants.subjectKind, ["org", "provider-org"]),
                    inArray(softwareAssetGrants.subjectId, orgIds),
                  ),
                ]
              : []),
          ),
        ),
      );
    const grants = await (this.lockReads
      ? grantsQuery.for("share", { noWait: true })
      : grantsQuery);
    return grants.some((grant) =>
      grant.capabilities.some((capability) => capability === "use" || capability === "admin"),
    );
  }

  private async assertSharedServiceEligible(input: {
    source: ResolvedSandboxSource;
    providerOrgId: string | null;
    runtimeProfileId: string;
    runtimeDigest: string;
  }): Promise<number> {
    if (!input.source.assetRevisionId || input.source.assetLifecycle !== "published") {
      throw new SandboxAuthorizationError(
        "Inline, draft, and unpublished scripts cannot use a shared service account",
      );
    }
    const attestationQuery = this.db
      .select()
      .from(scriptAttestations)
      .where(
        and(
          eq(scriptAttestations.assetRevisionId, input.source.assetRevisionId),
          eq(scriptAttestations.scriptSha256, input.source.sha256),
          eq(scriptAttestations.runtimeProfileId, input.runtimeProfileId),
          eq(scriptAttestations.runtimeDigest, input.runtimeDigest),
          eq(scriptAttestations.status, "active"),
          isNull(scriptAttestations.revokedAt),
          or(
            isNull(scriptAttestations.expiresAt),
            gt(scriptAttestations.expiresAt, new Date(Date.now())),
          ),
        ),
      );
    const rows = await (this.lockReads
      ? attestationQuery.for("share", { noWait: true })
      : attestationQuery);
    const eligible = rows.filter(
      (row) =>
        (row.scope === "platform" || row.providerOrgId === input.providerOrgId) &&
        row.allowedIdentities.some(
          (identity) =>
            typeof identity === "object" && identity !== null && identity.type === "SharedService",
        ),
    );
    if (!eligible.length)
      throw new SandboxAuthorizationError(
        "No valid attestation allows shared service execution here",
      );
    return Math.max(...eligible.map((row) => row.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY));
  }
}
