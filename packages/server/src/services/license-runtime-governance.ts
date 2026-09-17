import {
  ecosystemReleaseAssets,
  ecosystemReleases,
  licensedMaterialMappings,
  licenseEntitlementClaims,
  type PgDb,
  sandboxRuntimeContractBindings,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import type { LicensePolicy } from "@kuintessence/shared";
import {
  LicensePolicySchema,
  SoftwareAssetPayloadSchema,
  UpstreamVersionSnapshotProvenanceSchema,
  UpstreamVersionSupersededReviewStateSchema,
} from "@kuintessence/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

export type LicenseClassification = "open-source" | "source-available" | "proprietary" | "unknown";

export interface LicensePolicySnapshot {
  classification: LicenseClassification;
  identifiers?: string[];
  termsUrl?: string;
  provenance?: string;
  acceptanceRequired?: boolean;
  providerSourceInstallEntitlementRequired?: boolean;
  providerEntitlementRequiredForUse?: boolean;
  consumerUseEntitlementRequired?: boolean;
  redistributionAllowed?: boolean;
  autoInstallAllowed?: boolean;
}

export type LicenseEntitlementScope = "provider-source-install" | "consumer-use";

export interface LicenseEntitlementSnapshot {
  subjectId: string;
  scope: LicenseEntitlementScope;
  status: "pending" | "approved" | "rejected" | "revoked" | "expired";
  expiresAt?: Date | null;
}

export interface SandboxRuntimeContractSnapshot {
  id: string;
  status: "active" | "deprecated" | "revoked";
}

export interface SandboxRuntimeBindingSnapshot {
  contractId: string;
  runtimeProfileId: string;
  providerOrgId: string;
  agentId?: string | null;
  clusterId?: string | null;
  status: "active" | "revoked";
  signatureVerified: boolean;
  attestationKeyId?: string | null;
  attestationSignature?: string | null;
  attestedAt?: Date | null;
}

export interface LicensedMaterialSnapshot {
  id: string;
  providerOrgId: string;
  agentId: string;
  assetId: string;
  licenseSubject: string;
  version: string;
  elementSet: string[];
  fingerprint: string;
  status: "active" | "revoked";
}

export interface GovernanceRepository {
  getCanonicalLicensePolicy(assetId: string): Promise<LicensePolicySnapshot | null>;
  listEntitlements(input: {
    assetKey: string;
    assetId?: string;
    subjectIds: string[];
    scope: LicenseEntitlementScope;
  }): Promise<LicenseEntitlementSnapshot[]>;
  getRuntimeContract(contractId: string): Promise<SandboxRuntimeContractSnapshot | null>;
  listRuntimeBindings(input: {
    contractId: string;
    providerOrgId: string;
    agentId: string;
    clusterId?: string | null;
  }): Promise<SandboxRuntimeBindingSnapshot[]>;
  getLicensedMaterial(input: {
    selectorId: string;
    providerOrgId?: string | null;
    agentId?: string;
  }): Promise<LicensedMaterialSnapshot | null>;
}

export type GovernanceBlockCode =
  | "LICENSE_POLICY_REQUIRED"
  | "LICENSE_UNKNOWN_AUTO_INSTALL_DENIED"
  | "LICENSE_PROVIDER_ENTITLEMENT_REQUIRED"
  | "LICENSE_CONSUMER_ENTITLEMENT_REQUIRED"
  | "LICENSE_ACCEPTANCE_REQUIRED"
  | "RUNTIME_CONTRACT_UNBOUND"
  | "RUNTIME_CONTRACT_REVOKED"
  | "LICENSED_MATERIAL_NOT_FOUND"
  | "LICENSED_MATERIAL_UNAVAILABLE"
  | "LICENSED_MATERIAL_PROVIDER_MISMATCH"
  | "LICENSED_MATERIAL_AGENT_MISMATCH"
  | "LICENSED_MATERIAL_ELEMENTS_MISMATCH";

export interface GovernanceBlock {
  code: GovernanceBlockCode;
  message: string;
  remediation: string;
}

export interface LicenseGateInput {
  assetKey: string;
  assetId?: string;
  policy?: LicensePolicySnapshot;
  providerOrgId?: string | null;
  providerEntitlementSubjectIds: string[];
  consumerEntitlementSubjectIds: string[];
  installRequested: boolean;
  acceptedByConsumer?: boolean;
  now?: Date;
}

export interface RuntimeGateInput {
  contractId?: string;
  providerOrgId?: string | null;
  agentId?: string;
  clusterId?: string | null;
  runtimeProfileId?: string;
}

export interface LicensedMaterialGateInput {
  selectorId?: string;
  providerOrgId?: string | null;
  agentId?: string;
  requiredElements?: string[];
}

/**
 * A fail-closed policy evaluator shared by availability, usecase submission, and
 * workflow submission. It stores no licence evidence or material bytes: callers
 * receive only stable, actionable gate reasons.
 */
export class LicenseRuntimeGovernanceService {
  constructor(private readonly repository: GovernanceRepository) {}

  getCanonicalLicensePolicy(assetId: string): Promise<LicensePolicySnapshot | null> {
    return this.repository.getCanonicalLicensePolicy(assetId);
  }

  async evaluateLicense(input: LicenseGateInput): Promise<GovernanceBlock[]> {
    const policy = input.policy;
    if (!isValidLicensePolicy(policy)) return [licensePolicyRequired()];
    const blocks: GovernanceBlock[] = [];
    if (
      input.installRequested &&
      (policy.classification === "unknown" || policy.autoInstallAllowed === false)
    ) {
      blocks.push({
        code: "LICENSE_UNKNOWN_AUTO_INSTALL_DENIED",
        message: "License policy does not permit automatic installation",
        remediation:
          "Use a preinstalled build or obtain platform approval and a provider entitlement.",
      });
    }
    const consumerEntitled =
      policy.acceptanceRequired || policy.consumerUseEntitlementRequired
        ? await this.hasApprovedEntitlement({
            assetKey: input.assetKey,
            assetId: input.assetId,
            subjectIds: input.consumerEntitlementSubjectIds,
            scope: "consumer-use",
            now: input.now,
          })
        : false;
    if (policy.acceptanceRequired && !input.acceptedByConsumer && !consumerEntitled) {
      blocks.push({
        code: "LICENSE_ACCEPTANCE_REQUIRED",
        message: "Consumer acceptance of the license terms is required",
        remediation: "Submit and obtain approval for a consumer use entitlement.",
      });
    }
    if (policy.providerSourceInstallEntitlementRequired) {
      const allowed = await this.hasApprovedEntitlement({
        assetKey: input.assetKey,
        assetId: input.assetId,
        subjectIds: input.providerEntitlementSubjectIds,
        scope: "provider-source-install",
        now: input.now,
      });
      if (!allowed) {
        blocks.push({
          code: "LICENSE_PROVIDER_ENTITLEMENT_REQUIRED",
          message: "Provider source/install entitlement is required",
          remediation:
            "A provider organization administrator must submit an entitlement claim for this software.",
        });
      }
    }
    if (policy.consumerUseEntitlementRequired) {
      if (!consumerEntitled) {
        blocks.push({
          code: "LICENSE_CONSUMER_ENTITLEMENT_REQUIRED",
          message: "Consumer use entitlement is required",
          remediation:
            "A consumer organization administrator must submit an entitlement claim for this software.",
        });
      }
    }
    return blocks;
  }

  async evaluateRuntime(input: RuntimeGateInput): Promise<GovernanceBlock[]> {
    if (!input.contractId) return [];
    if (!input.providerOrgId || !input.agentId) return [runtimeUnbound()];
    const contract = await this.repository.getRuntimeContract(input.contractId);
    if (contract?.status === "revoked") {
      return [
        {
          code: "RUNTIME_CONTRACT_REVOKED",
          message: "The requested runtime contract is unavailable",
          remediation: "Bind an active, signed runtime profile for this provider and Agent.",
        },
      ];
    }
    const bindings = await this.repository.listRuntimeBindings({
      contractId: input.contractId,
      providerOrgId: input.providerOrgId,
      agentId: input.agentId,
      clusterId: input.clusterId,
    });
    const bound = bindings.some(
      (binding) =>
        binding.status === "active" &&
        binding.signatureVerified &&
        (input.runtimeProfileId === undefined ||
          binding.runtimeProfileId === input.runtimeProfileId) &&
        (binding.agentId == null || binding.agentId === input.agentId) &&
        (binding.clusterId == null || binding.clusterId === input.clusterId),
    );
    return bound ? [] : [runtimeUnbound()];
  }

  async evaluateLicensedMaterial(input: LicensedMaterialGateInput): Promise<GovernanceBlock[]> {
    const selectorId = input.selectorId;
    if (!selectorId) return [];
    const material = await this.repository.getLicensedMaterial({
      selectorId,
      providerOrgId: input.providerOrgId,
      agentId: input.agentId,
    });
    if (!material) {
      return [
        {
          code: "LICENSED_MATERIAL_NOT_FOUND",
          message: "Licensed material selector does not exist",
          remediation: "Configure the material on the selected provider Agent.",
        },
      ];
    }
    if (material.status !== "active") {
      return [
        {
          code: "LICENSED_MATERIAL_UNAVAILABLE",
          message: "Licensed material is not active",
          remediation: "Ask the provider to activate a verified local material mapping.",
        },
      ];
    }
    if (!input.providerOrgId || material.providerOrgId !== input.providerOrgId) {
      return [
        {
          code: "LICENSED_MATERIAL_PROVIDER_MISMATCH",
          message: "Licensed material belongs to a different provider",
          remediation: "Select a material mapping owned by the selected provider.",
        },
      ];
    }
    if (!input.agentId || material.agentId !== input.agentId) {
      return [
        {
          code: "LICENSED_MATERIAL_AGENT_MISMATCH",
          message: "Licensed material is not mapped to the selected Agent",
          remediation:
            "Place the job on the mapped Agent or configure an equivalent local mapping.",
        },
      ];
    }
    const requested = new Set((input.requiredElements ?? []).map(normalizeElement));
    const supplied = new Set(material.elementSet.map(normalizeElement));
    const missing = [...requested].filter((element) => !supplied.has(element));
    return missing.length === 0
      ? []
      : [
          {
            code: "LICENSED_MATERIAL_ELEMENTS_MISMATCH",
            message: `Licensed material does not cover required elements: ${missing.join(", ")}`,
            remediation: "Configure a local material mapping that covers every requested element.",
          },
        ];
  }

  async resolveLicensedMaterialMounts(input: {
    requests: Array<{
      selector: string;
      licenseSubject?: string;
      targetPath: string;
      requiredElements: string[];
    }>;
    providerOrgId: string | null;
    agentId: string;
    consumerEntitlementSubjectIds: string[];
  }): Promise<
    Array<{
      selector: string;
      licenseSubject: string;
      targetPath: string;
      requiredElements: string[];
      expectedFingerprint: string;
    }>
  > {
    return Promise.all(
      input.requests.map(async (request) => {
        const blocks = await this.evaluateLicensedMaterial({
          selectorId: request.selector,
          providerOrgId: input.providerOrgId,
          agentId: input.agentId,
          requiredElements: request.requiredElements,
        });
        const material = await this.repository.getLicensedMaterial({
          selectorId: request.selector,
          providerOrgId: input.providerOrgId,
          agentId: input.agentId,
        });
        if (!material) throw new Error("LICENSED_MATERIAL_NOT_FOUND");
        const policy = await this.repository.getCanonicalLicensePolicy(material.assetId);
        const licenseBlocks = await this.evaluateLicense({
          assetKey: material.licenseSubject,
          assetId: material.assetId,
          policy: policy ?? undefined,
          providerEntitlementSubjectIds: input.providerOrgId ? [input.providerOrgId] : [],
          consumerEntitlementSubjectIds: input.consumerEntitlementSubjectIds,
          installRequested: false,
        });
        const failures = [...blocks, ...licenseBlocks];
        if (failures.length > 0) {
          throw new Error(failures.map((block) => block.code).join(", "));
        }
        return {
          selector: request.selector,
          licenseSubject: material.licenseSubject,
          targetPath: request.targetPath,
          requiredElements: request.requiredElements,
          expectedFingerprint: material.fingerprint,
        };
      }),
    );
  }

  private async hasApprovedEntitlement(input: {
    assetKey: string;
    assetId?: string;
    subjectIds: string[];
    scope: LicenseEntitlementScope;
    now?: Date;
  }): Promise<boolean> {
    if (input.subjectIds.length === 0) return false;
    const now = input.now ?? new Date();
    const records = await this.repository.listEntitlements(input);
    return records.some(
      (record) =>
        record.status === "approved" && (record.expiresAt == null || record.expiresAt > now),
    );
  }
}

function isValidLicensePolicy(
  policy: LicensePolicySnapshot | undefined,
): policy is LicensePolicySnapshot {
  if (!policy) return false;
  if (
    !(["open-source", "source-available", "proprietary", "unknown"] as const).includes(
      policy.classification,
    )
  ) {
    return false;
  }
  if (!policy.provenance || policy.provenance.trim().length === 0) return false;
  return [
    policy.acceptanceRequired,
    policy.providerSourceInstallEntitlementRequired,
    policy.providerEntitlementRequiredForUse,
    policy.consumerUseEntitlementRequired,
    policy.redistributionAllowed,
    policy.autoInstallAllowed,
  ].every((value) => value === undefined || typeof value === "boolean");
}

function licensePolicyRequired(): GovernanceBlock {
  return {
    code: "LICENSE_POLICY_REQUIRED",
    message: "A valid license policy is required before software can be used or installed",
    remediation: "Publish a reviewed LicensePolicy with provenance and entitlement requirements.",
  };
}

/** PostgreSQL adapter. It intentionally returns metadata only: no evidence or
 * licensed bytes are selected from the database. */
export class PgGovernanceRepository implements GovernanceRepository {
  constructor(private readonly db: PgDb) {}

  async getCanonicalLicensePolicy(assetId: string): Promise<LicensePolicySnapshot | null> {
    const rows = await this.db
      .select({ licensePolicy: ecosystemReleaseAssets.licensePolicy })
      .from(ecosystemReleaseAssets)
      .innerJoin(
        ecosystemReleases,
        and(
          eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id),
          eq(ecosystemReleases.status, "active"),
        ),
      )
      .where(eq(ecosystemReleaseAssets.assetId, assetId))
      .limit(2);
    if (rows.length === 1 && rows[0]) return licensePolicySnapshot(rows[0].licensePolicy);
    if (rows.length > 0) return null;
    return (
      (await this.getSnapshotUpstreamLicensePolicy(assetId)) ??
      this.getSupersededUpstreamLicensePolicy(assetId)
    );
  }

  private async getSnapshotUpstreamLicensePolicy(
    assetId: string,
  ): Promise<LicensePolicySnapshot | null> {
    const [snapshot] = await this.db
      .select({
        id: softwareAssets.id,
        kind: softwareAssets.kind,
        lifecycle: softwareAssets.lifecycle,
        name: softwareAssets.name,
        payload: softwareAssets.payload,
        provenance: softwareAssets.provenance,
        source: softwareAssets.source,
        trustedForGlobalUse: softwareAssets.trustedForGlobalUse,
        version: softwareAssets.version,
        visibility: softwareAssets.visibility,
      })
      .from(softwareAssets)
      .where(eq(softwareAssets.id, assetId))
      .limit(1);
    const provenance = UpstreamVersionSnapshotProvenanceSchema.safeParse(snapshot?.provenance);
    const payload = SoftwareAssetPayloadSchema.safeParse(snapshot?.payload);
    if (
      !snapshot ||
      snapshot.kind !== "spack-package" ||
      snapshot.source !== "official-upstream" ||
      snapshot.lifecycle !== "published" ||
      snapshot.visibility !== "platform-public" ||
      !snapshot.trustedForGlobalUse ||
      !provenance.success ||
      provenance.data.upstreamName !== snapshot.name ||
      provenance.data.upstreamVersion !== snapshot.version ||
      !payload.success ||
      payload.data.kind !== "spack-package" ||
      payload.data.spack.packageName !== snapshot.name ||
      payload.data.spack.defaultSpec !== `${snapshot.name}@${snapshot.version}`
    ) {
      return null;
    }

    const revisions = await this.db
      .select({
        payload: softwareAssetRevisions.payload,
        provenance: softwareAssetRevisions.provenance,
      })
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.assetId, snapshot.id))
      .limit(2);
    const revision = revisions[0];
    if (
      revisions.length !== 1 ||
      !revision ||
      JSON.stringify(revision.payload) !== JSON.stringify(snapshot.payload) ||
      JSON.stringify(revision.provenance) !== JSON.stringify(snapshot.provenance)
    ) {
      return null;
    }

    const source = provenance.data.licensePolicySource;
    const rows = await this.db
      .select({
        kind: ecosystemReleaseAssets.kind,
        licensePolicy: ecosystemReleaseAssets.licensePolicy,
        payload: ecosystemReleaseAssets.payload,
        version: ecosystemReleaseAssets.version,
      })
      .from(ecosystemReleaseAssets)
      .innerJoin(
        ecosystemReleases,
        and(
          eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id),
          eq(ecosystemReleases.status, "active"),
        ),
      )
      .where(
        and(
          eq(ecosystemReleaseAssets.id, source.releaseAssetId),
          eq(ecosystemReleaseAssets.releaseId, source.releaseId),
        ),
      )
      .limit(2);
    const policySource = rows[0];
    const sourcePayload = SoftwareAssetPayloadSchema.safeParse(policySource?.payload);
    if (
      rows.length !== 1 ||
      !policySource ||
      policySource.kind !== "spack-package" ||
      policySource.version !== snapshot.version ||
      !sourcePayload.success ||
      sourcePayload.data.kind !== "spack-package" ||
      sourcePayload.data.spack.packageName !== snapshot.name ||
      sourcePayload.data.spack.defaultSpec !== `${snapshot.name}@${snapshot.version}`
    ) {
      return null;
    }
    return licensePolicySnapshot(policySource.licensePolicy);
  }

  private async getSupersededUpstreamLicensePolicy(
    assetId: string,
  ): Promise<LicensePolicySnapshot | null> {
    const [replacement] = await this.db
      .select({
        id: softwareAssets.id,
        kind: softwareAssets.kind,
        lifecycle: softwareAssets.lifecycle,
        name: softwareAssets.name,
        source: softwareAssets.source,
        trustedForGlobalUse: softwareAssets.trustedForGlobalUse,
        version: softwareAssets.version,
        visibility: softwareAssets.visibility,
      })
      .from(softwareAssets)
      .where(eq(softwareAssets.id, assetId))
      .limit(1);
    if (
      !replacement ||
      replacement.kind !== "spack-package" ||
      replacement.source !== "official-upstream" ||
      replacement.lifecycle !== "published" ||
      replacement.visibility !== "platform-public" ||
      !replacement.trustedForGlobalUse
    ) {
      return null;
    }

    const candidates = await this.db
      .select({
        assetRevisionId: ecosystemReleaseAssets.assetRevisionId,
        kind: softwareAssets.kind,
        licensePolicy: ecosystemReleaseAssets.licensePolicy,
        name: softwareAssets.name,
        reviewState: softwareAssets.reviewState,
        source: softwareAssets.source,
        version: softwareAssets.version,
      })
      .from(softwareAssets)
      .innerJoin(ecosystemReleaseAssets, eq(ecosystemReleaseAssets.assetId, softwareAssets.id))
      .innerJoin(
        ecosystemReleases,
        and(
          eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id),
          eq(ecosystemReleases.status, "active"),
        ),
      )
      .where(
        and(
          eq(softwareAssets.lifecycle, "archived"),
          eq(softwareAssets.visibility, "hidden"),
          sql`${softwareAssets.reviewState}->'upstreamVersionSupersession'->>'replacementAssetId' = ${assetId}`,
        ),
      )
      .limit(2);
    const candidate = candidates[0];
    if (
      candidates.length !== 1 ||
      !candidate ||
      candidate.kind !== replacement.kind ||
      candidate.source !== replacement.source ||
      candidate.name !== replacement.name ||
      candidate.version !== replacement.version
    ) {
      return null;
    }
    const reviewState = UpstreamVersionSupersededReviewStateSchema.safeParse(candidate.reviewState);
    if (!reviewState.success) return null;
    const supersession = reviewState.data.upstreamVersionSupersession;
    if (
      candidate.assetRevisionId !== supersession.legacyRevisionId ||
      supersession.replacementAssetId !== replacement.id ||
      supersession.canonicalIdentity !==
        `${replacement.source}/${replacement.name}/${replacement.version}`
    ) {
      return null;
    }
    const [replacementRevision] = await this.db
      .select({ id: softwareAssetRevisions.id })
      .from(softwareAssetRevisions)
      .where(
        and(
          eq(softwareAssetRevisions.id, supersession.replacementRevisionId),
          eq(softwareAssetRevisions.assetId, replacement.id),
        ),
      )
      .limit(1);
    if (!replacementRevision) return null;
    return licensePolicySnapshot(candidate.licensePolicy);
  }

  async listEntitlements(input: {
    assetKey: string;
    assetId?: string;
    subjectIds: string[];
    scope: LicenseEntitlementScope;
  }): Promise<LicenseEntitlementSnapshot[]> {
    if (input.subjectIds.length === 0) return [];
    const rows = await this.db
      .select({
        claimantId: licenseEntitlementClaims.claimantId,
        entitlement: licenseEntitlementClaims.entitlement,
        status: licenseEntitlementClaims.status,
        expiresAt: licenseEntitlementClaims.expiresAt,
      })
      .from(licenseEntitlementClaims)
      .where(
        and(
          eq(licenseEntitlementClaims.licenseSubject, input.assetKey),
          ...(input.assetId ? [eq(licenseEntitlementClaims.assetId, input.assetId)] : []),
          eq(licenseEntitlementClaims.entitlement, input.scope),
          inArray(licenseEntitlementClaims.claimantId, input.subjectIds),
        ),
      );
    return rows.map((row) => ({
      subjectId: row.claimantId,
      scope: row.entitlement as LicenseEntitlementScope,
      status: row.status as LicenseEntitlementSnapshot["status"],
      expiresAt: row.expiresAt,
    }));
  }

  async getRuntimeContract(contractId: string): Promise<SandboxRuntimeContractSnapshot | null> {
    const bindings = await this.db
      .select({ status: sandboxRuntimeContractBindings.status })
      .from(sandboxRuntimeContractBindings)
      .where(eq(sandboxRuntimeContractBindings.runtimeContractRef, contractId));
    if (bindings.length === 0) return null;
    return {
      id: contractId,
      status: bindings.some((binding) => binding.status === "active") ? "active" : "revoked",
    };
  }

  async listRuntimeBindings(input: {
    contractId: string;
    providerOrgId: string;
    agentId: string;
    clusterId?: string | null;
  }): Promise<SandboxRuntimeBindingSnapshot[]> {
    const rows = await this.db
      .select({
        runtimeContractRef: sandboxRuntimeContractBindings.runtimeContractRef,
        runtimeProfileId: sandboxRuntimeContractBindings.runtimeProfileId,
        providerOrgId: sandboxRuntimeContractBindings.providerOrgId,
        agentId: sandboxRuntimeContractBindings.agentId,
        clusterId: sandboxRuntimeContractBindings.clusterId,
        status: sandboxRuntimeContractBindings.status,
        runtimeDigest: sandboxRuntimeContractBindings.runtimeDigest,
        attestationKeyId: sandboxRuntimeContractBindings.attestationKeyId,
        attestationSignature: sandboxRuntimeContractBindings.attestationSignature,
        attestedAt: sandboxRuntimeContractBindings.attestedAt,
      })
      .from(sandboxRuntimeContractBindings)
      .where(
        and(
          eq(sandboxRuntimeContractBindings.runtimeContractRef, input.contractId),
          eq(sandboxRuntimeContractBindings.providerOrgId, input.providerOrgId),
        ),
      );
    return rows.map((row) => ({
      contractId: row.runtimeContractRef,
      runtimeProfileId: row.runtimeProfileId,
      providerOrgId: row.providerOrgId,
      agentId: row.agentId,
      clusterId: row.clusterId,
      status: row.status as SandboxRuntimeBindingSnapshot["status"],
      signatureVerified:
        (row.attestationKeyId?.trim().length ?? 0) > 0 &&
        (row.attestationSignature?.trim().length ?? 0) > 0 &&
        row.attestedAt !== null,
      attestationKeyId: row.attestationKeyId,
      attestationSignature: row.attestationSignature,
      attestedAt: row.attestedAt,
    }));
  }

  async getLicensedMaterial(input: {
    selectorId: string;
    providerOrgId?: string | null;
    agentId?: string;
  }): Promise<LicensedMaterialSnapshot | null> {
    const conditions = [eq(licensedMaterialMappings.selector, input.selectorId)];
    if (input.providerOrgId) {
      conditions.push(eq(licensedMaterialMappings.providerOrgId, input.providerOrgId));
    }
    if (input.agentId) {
      conditions.push(eq(licensedMaterialMappings.agentId, input.agentId));
    }
    const [row] = await this.db
      .select({
        id: licensedMaterialMappings.selector,
        providerOrgId: licensedMaterialMappings.providerOrgId,
        agentId: licensedMaterialMappings.agentId,
        assetId: licensedMaterialMappings.assetId,
        licenseSubject: licensedMaterialMappings.licenseSubject,
        version: licensedMaterialMappings.materialVersion,
        elementSet: licensedMaterialMappings.elementSet,
        fingerprint: licensedMaterialMappings.fingerprint,
        status: licensedMaterialMappings.status,
      })
      .from(licensedMaterialMappings)
      .where(and(...conditions))
      .limit(1);
    if (!row) return null;
    const { assetId, licenseSubject, ...material } = row;
    if (!assetId || !licenseSubject) return null;
    return {
      ...material,
      assetId,
      licenseSubject,
      status: material.status as LicensedMaterialSnapshot["status"],
    };
  }
}

export function licensePolicySnapshot(value: unknown): LicensePolicySnapshot | null {
  const result = LicensePolicySchema.safeParse(value);
  if (!result.success) return null;
  return toLicensePolicySnapshot(result.data);
}

export function toLicensePolicySnapshot(policy: LicensePolicy): LicensePolicySnapshot {
  return {
    classification: policy.classification,
    identifiers: policy.identifiers.map((identifier) => identifier.value),
    termsUrl: policy.termsUrl,
    provenance: policy.provenance.reference,
    acceptanceRequired: policy.acceptanceRequired,
    providerSourceInstallEntitlementRequired: policy.providerEntitlements.length > 0,
    providerEntitlementRequiredForUse: policy.providerEntitlements.length > 0,
    consumerUseEntitlementRequired: policy.consumerEntitlements.includes("use"),
    redistributionAllowed: policy.redistribution === "permitted",
    autoInstallAllowed: policy.autoInstall === "allowed",
  };
}

export function sandboxRuntimeContractKey(ref: { name: string; version: string }): string {
  return `${ref.name}@${ref.version}`;
}

function runtimeUnbound(): GovernanceBlock {
  return {
    code: "RUNTIME_CONTRACT_UNBOUND",
    message: "No active signed runtime profile is bound to this provider, cluster, and Agent",
    remediation:
      "A provider administrator must bind the runtime contract to a signed runtime profile.",
  };
}

function normalizeElement(element: string): string {
  return element.trim().toUpperCase();
}
