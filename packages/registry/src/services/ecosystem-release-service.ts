import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  authzOutbox,
  dataAssets,
  dataAssetVersions,
  ecosystemReleaseAssets,
  ecosystemReleases,
  licensedMaterialMappings,
  licenseEntitlementClaims,
  type PgDb,
  sandboxRuntimeContractBindings,
  sandboxRuntimeProfiles,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackageRevisions,
  usecasePackages,
  workflowTemplates,
} from "@kuintessence/db";
import {
  AppError,
  type AuthzProjectionTuple,
  DataAccessModeSchema,
  DataAssetKindSchema,
  DataDeliveryPolicySchema,
  DataSensitivitySchema,
  dataAssetPlatformTuple,
  dataAssetPublicAccessTuples,
  ErrorCode,
  type LicensePolicy,
  LicensePolicySchema,
  type SoftwareAssetPayload,
  SoftwareAssetPayloadSchema,
  softwareAssetAuthzProjectionTuples,
  usecase,
  workflowDsl,
} from "@kuintessence/shared";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { EcosystemOciReader, EcosystemOciReference } from "./ecosystem-oci-reader";

export type EcosystemAssetKind =
  | "data-product"
  | "spack-package"
  | "usecase"
  | "workflow-template"
  | "sandbox-script";

export interface EcosystemBundleAsset {
  ecosystemKey: string;
  kind: EcosystemAssetKind;
  name: string;
  version: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  licensePolicy: Record<string, unknown>;
  /** SHA-256 of canonical `payload.spec`; mandatory before a usecase can activate. */
  specDigest?: string;
}

export interface EcosystemManifest {
  schemaVersion: 1;
  releaseKey: string;
  version: string;
  provenance: Record<string, unknown>;
  profile?: "scientific-ecosystem-v1";
  assets: EcosystemBundleAsset[];
  runtimeReference?: Record<string, unknown>;
}

export interface SignedEcosystemBundle {
  manifest: EcosystemManifest;
  signingKeyId: string;
  signature: string;
}

const EcosystemBundleAssetEnvelopeSchema = z.strictObject({
  ecosystemKey: z.string().min(1).max(255),
  kind: z.enum(["data-product", "spack-package", "usecase", "workflow-template", "sandbox-script"]),
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), z.unknown()),
  licensePolicy: z.record(z.string(), z.unknown()),
  specDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
});

const EcosystemManifestEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseKey: z.string().min(1).max(255),
  version: z.string().min(1).max(100),
  provenance: z.record(z.string(), z.unknown()),
  profile: z.literal("scientific-ecosystem-v1").optional(),
  assets: z.array(EcosystemBundleAssetEnvelopeSchema).min(1),
  runtimeReference: z.record(z.string(), z.unknown()).optional(),
});

const SignedEcosystemBundleEnvelopeSchema = z.strictObject({
  manifest: EcosystemManifestEnvelopeSchema,
  signingKeyId: z.string().min(1).max(255),
  signature: z.string().min(1),
});

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const DataProductPayloadSchema = z.strictObject({
  kind: z.literal("data-product"),
  dataAsset: z.strictObject({
    kind: DataAssetKindSchema,
    selector: z.string().min(1).max(255),
    version: z.string().min(1).max(100),
    description: z.string().min(1).max(4_000),
    tags: z.array(z.string().min(1).max(128)).default([]),
    accessMode: DataAccessModeSchema,
    sensitivity: DataSensitivitySchema,
    deliveryPolicy: DataDeliveryPolicySchema,
    redistribution: z.enum(["permitted", "prohibited"]),
    entitlementRequired: z.boolean(),
  }),
});
type DataProductPayload = z.infer<typeof DataProductPayloadSchema>;

export const EntitlementClaimInputSchema = z.strictObject({
  assetId: z.string().uuid(),
  entitlement: z.enum(["provider-source-install", "consumer-use"]),
  claimantKind: z.enum(["org", "user"]),
  claimantId: z.string().min(1).max(255),
  providerOrgId: z.string().uuid().optional(),
  evidenceReference: z.string().min(1).max(2048),
  evidenceSummary: z.string().min(1).max(10_000),
  expiresAt: z.string().datetime().optional(),
});
export type EntitlementClaimInput = z.infer<typeof EntitlementClaimInputSchema>;

export const RuntimeContractBindingInputSchema = z.strictObject({
  providerOrgId: z.string().uuid(),
  agentId: z.string().min(1).max(255).optional(),
  clusterId: z.string().min(1).max(255).optional(),
  runtimeContractRef: z.string().min(1).max(255),
  runtimeProfileId: z.string().uuid(),
  runtimeDigest: Sha256DigestSchema,
});
export type RuntimeContractBindingInput = z.infer<typeof RuntimeContractBindingInputSchema>;

export const LicensedMaterialMappingInputSchema = z.strictObject({
  providerOrgId: z.string().uuid(),
  agentId: z.string().min(1).max(255),
  selector: z.string().min(1).max(255),
  assetId: z.string().uuid(),
  materialName: z.string().min(1).max(255),
  materialVersion: z.string().min(1).max(100),
  elementSet: z.array(z.string().min(1).max(32)).min(1),
  fingerprint: z.string().min(1).max(255),
  auditMetadata: z
    .strictObject({
      source: z.string().min(1).max(255).optional(),
      sourceVersion: z.string().min(1).max(100).optional(),
      validationMethod: z.string().min(1).max(255).optional(),
      validatedAt: z.string().datetime().optional(),
      validatedBy: z.string().min(1).max(255).optional(),
      notes: z.string().max(2_000).optional(),
      labels: z.record(z.string().min(1).max(64), z.string().max(255)).optional(),
    })
    .superRefine(validateAuditMetadata)
    .optional(),
});
export type LicensedMaterialMappingInput = z.infer<typeof LicensedMaterialMappingInputSchema>;

const MAX_AUDIT_METADATA_BYTES = 16 * 1024;
const FORBIDDEN_AUDIT_METADATA_TOKENS = new Set([
  "base64",
  "blob",
  "byte",
  "bytes",
  "content",
  "credential",
  "credentials",
  "key",
  "path",
  "secret",
  "token",
]);

function validateAuditMetadata(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size > MAX_AUDIT_METADATA_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `auditMetadata must not exceed ${MAX_AUDIT_METADATA_BYTES} bytes`,
    });
  }
  visitAuditMetadata(value, [], ctx);
}

function visitAuditMetadata(
  value: unknown,
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitAuditMetadata(item, [...path, index], ctx);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const tokens = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (tokens.some((token) => FORBIDDEN_AUDIT_METADATA_TOKENS.has(token))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: "auditMetadata cannot contain bytes, secrets, credentials, paths, or tokens",
      });
    }
    visitAuditMetadata(nested, [...path, key], ctx);
  }
}

interface MaterializedAsset {
  assetId: string;
  assetRevisionId: string;
  usecasePackageId?: string;
  usecasePackageRevisionId?: string;
  usecaseSpecDigest?: string;
  workflowTemplateId?: string;
}

type DbExecutor = Pick<PgDb, "select" | "insert" | "update" | "execute">;

interface ValidatedBundleAsset {
  asset: EcosystemBundleAsset;
  licensePolicy: LicensePolicy;
  payload: SoftwareAssetPayload | DataProductPayload;
  usecase?: usecase.GovernedUsecasePackage;
  workflow?: workflowDsl.Workflow;
}

interface ReleaseAssetIdentity {
  ecosystemKey: string;
  kind: string;
  payload: Record<string, unknown>;
}

const PINNED_SOFTWARE = new Map<string, { packageName: string; version: string }>([
  ["gromacs", { packageName: "gromacs", version: "2025.2" }],
  ["lammps", { packageName: "lammps", version: "20250612" }],
  ["namd", { packageName: "namd", version: "3.0.1" }],
  ["ambertools", { packageName: "amber", version: "20" }],
  ["cp2k", { packageName: "cp2k", version: "2025.1" }],
  ["quantumespresso", { packageName: "quantum_espresso", version: "7.4.1" }],
  ["nwchem", { packageName: "nwchem", version: "7.2.3" }],
  ["abinit", { packageName: "abinit", version: "10.2.7" }],
  ["vasp", { packageName: "vasp", version: "6.5.1" }],
  ["openfoam", { packageName: "openfoam", version: "2412" }],
  ["wrf", { packageName: "wrf", version: "4.6.1" }],
  ["nek5000", { packageName: "nek5000", version: "19.0" }],
  ["paraview", { packageName: "paraview", version: "5.13.3" }],
  ["bwa", { packageName: "bwa", version: "0.7.17" }],
  ["samtools", { packageName: "samtools", version: "1.19.2" }],
  ["bcftools", { packageName: "bcftools", version: "1.21" }],
  ["gatk", { packageName: "gatk", version: "4.5.0.0" }],
  ["blast", { packageName: "blast_plus", version: "2.16.0" }],
  ["salmon", { packageName: "salmon", version: "1.10.3" }],
  ["r", { packageName: "r", version: "4.5.1" }],
  ["julia", { packageName: "julia", version: "1.11.5" }],
]);

const OFFICIAL_RUNTIME_CONTRACT = {
  name: "python-3.12-stdlib-v1",
  version: "1",
} as const;

/** Canonical JSON makes signatures independent of transport serialization details. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new AppError(ErrorCode.VALIDATION_ERROR, "Bundle manifest contains a non-JSON value", 422);
}

export function manifestDigest(manifest: EcosystemManifest): string {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}

export function manifestEntryDigest(asset: EcosystemBundleAsset): string {
  return `sha256:${createHash("sha256").update(canonicalJson(asset)).digest("hex")}`;
}

function usecaseSpecDigest(spec: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(spec)).digest("hex")}`;
}

function verifyRuntimeProfileAttestation(
  profile: typeof sandboxRuntimeProfiles.$inferSelect,
  runtimeDigest: string,
  trustedPublicKeys: Readonly<Record<string, string>>,
): string {
  const signingKeyId = profile.securityRequirements.signingKeyId;
  if (typeof signingKeyId !== "string" || signingKeyId.trim().length === 0) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Runtime profile must name the trusted signing key used for its attestation",
      422,
    );
  }
  const publicKeyDer = trustedPublicKeys[signingKeyId];
  if (!publicKeyDer) {
    throw new AppError(ErrorCode.FORBIDDEN, "Runtime attestation signing key is not trusted", 403);
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(profile.signature, "base64");
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Runtime attestation is not base64", 422);
  }
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({
      key: Buffer.from(publicKeyDer, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new AppError(ErrorCode.FORBIDDEN, "Runtime attestation signing key is invalid", 403);
  }
  const payload = canonicalJson({
    name: profile.name,
    language: profile.language,
    languageVersion: profile.languageVersion,
    runtimeDigest,
  });
  if (!verifySignature(null, Buffer.from(payload), key, signature)) {
    throw new AppError(ErrorCode.FORBIDDEN, "Runtime attestation verification failed", 403);
  }
  return signingKeyId;
}

export function parseSignedEcosystemBundle(value: unknown): SignedEcosystemBundle {
  const result = SignedEcosystemBundleEnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw schemaError("bundle", "SignedEcosystemBundle", result.error.issues);
  }
  return result.data;
}

export function verifyEcosystemBundle(
  bundle: SignedEcosystemBundle,
  trustedPublicKeys: Readonly<Record<string, string>>,
): void {
  const publicKeyDer = trustedPublicKeys[bundle.signingKeyId];
  if (!publicKeyDer) {
    throw new AppError(ErrorCode.FORBIDDEN, "Bundle signing key is not trusted", 403);
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(bundle.signature, "base64");
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Bundle signature is not base64", 422);
  }
  const key = createPublicKey({
    key: Buffer.from(publicKeyDer, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(null, Buffer.from(canonicalJson(bundle.manifest)), key, signature)) {
    throw new AppError(ErrorCode.FORBIDDEN, "Bundle signature verification failed", 403);
  }
}

export function validateEcosystemManifest(manifest: EcosystemManifest): ValidatedBundleAsset[] {
  if (manifest.schemaVersion !== 1) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Unsupported ecosystem manifest schema", 422);
  }
  if (!nonEmpty(manifest.releaseKey) || !nonEmpty(manifest.version)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Release key and version are required", 422);
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Release must contain assets", 422);
  }
  const keys = new Set<string>();
  const selectorIdentities = new Set<string>();
  const validated: ValidatedBundleAsset[] = [];
  for (const asset of manifest.assets) {
    if (!isAssetKind(asset.kind) || !nonEmpty(asset.ecosystemKey) || !nonEmpty(asset.name)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Release asset identity is invalid", 422);
    }
    if (keys.has(asset.ecosystemKey)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Duplicate ecosystem asset key: ${asset.ecosystemKey}`,
        422,
      );
    }
    keys.add(asset.ecosystemKey);
    const selectorIdentity = assetSelectorIdentity(asset);
    if (selectorIdentities.has(selectorIdentity)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Named selector is ambiguous for ${asset.kind} ${asset.name}@${asset.version}`,
        422,
      );
    }
    selectorIdentities.add(selectorIdentity);
    validated.push(validateBundleAsset(asset));
  }
  validateNamedReferences(validated);
  if (manifest.profile === "scientific-ecosystem-v1") {
    validateScientificEcosystemManifest(manifest, validated);
  }
  return validated;
}

/** The first public catalog is intentionally exact: 21 + 79 + 12 + 4 assets. */
export function validateScientificEcosystemManifest(
  manifest: EcosystemManifest,
  alreadyValidated?: ValidatedBundleAsset[],
): void {
  const validated = alreadyValidated ?? manifest.assets.map((asset) => validateBundleAsset(asset));
  const counts = countByKind(manifest.assets);
  if (
    counts["spack-package"] !== 21 ||
    counts.usecase !== 79 ||
    counts["sandbox-script"] !== 12 ||
    counts["workflow-template"] !== 4 ||
    counts["data-product"] !== 5
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Scientific ecosystem v1 must contain 21 software, 79 usecases, 12 scripts, 4 workflows, and 5 data products",
      422,
    );
  }
  validatePinnedSoftware(validated);
  validateOfficialScripts(validated);
  validateDataProductRequirements(validated);
  const perSoftware = new Map<string, number>();
  for (const item of validated.filter(
    (entry): entry is ValidatedBundleAsset & { usecase: usecase.GovernedUsecasePackage } =>
      entry.usecase !== undefined,
  )) {
    const software = resolveNamedSelector(
      validated,
      "spack-package",
      item.usecase.softwareRef,
      item.asset.ecosystemKey,
    );
    perSoftware.set(
      software.asset.ecosystemKey,
      (perSoftware.get(software.asset.ecosystemKey) ?? 0) + 1,
    );
  }
  for (const software of manifest.assets.filter((item) => item.kind === "spack-package")) {
    if ((perSoftware.get(software.ecosystemKey) ?? 0) < 3) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Software ${software.ecosystemKey} must have at least three usecases`,
        422,
      );
    }
  }
}

export class EcosystemReleaseService {
  constructor(
    private readonly db: PgDb,
    private readonly trustedPublicKeys: Readonly<Record<string, string>>,
    private readonly ociReader?: EcosystemOciReader,
  ) {}

  async stageFromOci(reference: EcosystemOciReference, actor: string) {
    if (!this.ociReader) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Ecosystem OCI reader is not configured", 500);
    }
    const resolved = await this.ociReader.read(reference);
    return this.stage(resolved.bundle, actor, resolved.artifactDigest);
  }

  async stage(bundleInput: unknown, actor: string, artifactDigest?: string) {
    const bundle = parseSignedEcosystemBundle(bundleInput);
    const resolvedArtifactDigest = artifactDigest ?? manifestDigest(bundle.manifest);
    verifyEcosystemBundle(bundle, this.trustedPublicKeys);
    const validatedAssets = validateEcosystemManifest(bundle.manifest);
    const usecaseSpecDigests = new Map<string, string>();
    for (const asset of validatedAssets) {
      if (asset.payload.kind === "usecase") {
        usecaseSpecDigests.set(
          asset.asset.ecosystemKey,
          asset.asset.specDigest ?? usecaseSpecDigest(asset.payload.spec),
        );
      }
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(resolvedArtifactDigest)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Artifact digest is invalid", 422);
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ecosystem-release-stage:${bundle.manifest.releaseKey}`}, 0))`,
      );
      await lockDataProductIdentities(tx, bundle.manifest.assets);
      const [existing] = await tx
        .select()
        .from(ecosystemReleases)
        .where(
          and(
            eq(ecosystemReleases.releaseKey, bundle.manifest.releaseKey),
            eq(ecosystemReleases.version, bundle.manifest.version),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.artifactDigest !== resolvedArtifactDigest) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Release version already exists with another digest",
            409,
          );
        }
        return existing;
      }
      await assertStableReleaseAssetIdentities(
        tx,
        bundle.manifest.releaseKey,
        bundle.manifest.assets,
      );
      const [release] = await tx
        .insert(ecosystemReleases)
        .values({
          releaseKey: bundle.manifest.releaseKey,
          version: bundle.manifest.version,
          artifactDigest: resolvedArtifactDigest,
          manifest: jsonRecord(bundle.manifest),
          provenance: bundle.manifest.provenance,
          signature: bundle.signature,
          signingKeyId: bundle.signingKeyId,
          importedBy: actor,
        })
        .returning();
      if (!release) throw new AppError(ErrorCode.INTERNAL_ERROR, "Release staging failed", 500);
      await tx.insert(ecosystemReleaseAssets).values(
        bundle.manifest.assets.map((asset) => ({
          releaseId: release.id,
          ecosystemKey: asset.ecosystemKey,
          kind: asset.kind,
          name: asset.name,
          version: asset.version,
          payload: asset.payload,
          provenance: asset.provenance,
          licensePolicy: asset.licensePolicy,
          manifestEntryDigest: manifestEntryDigest(asset),
          usecaseSpecDigest: usecaseSpecDigests.get(asset.ecosystemKey) ?? null,
        })),
      );
      const stagedUsecases = await tx
        .select()
        .from(ecosystemReleaseAssets)
        .where(
          and(
            eq(ecosystemReleaseAssets.releaseId, release.id),
            eq(ecosystemReleaseAssets.kind, "usecase"),
          ),
        );
      for (const entry of stagedUsecases) {
        const executable = await materializeExecutableCatalogEntry(tx, entry, release);
        if (!executable.usecasePackageId || !executable.usecasePackageRevisionId) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Staged usecase was not materialized as an immutable revision",
            500,
          );
        }
        await tx
          .update(ecosystemReleaseAssets)
          .set({
            usecasePackageId: executable.usecasePackageId,
            usecasePackageRevisionId: executable.usecasePackageRevisionId,
            usecaseSpecDigest: executable.usecaseSpecDigest ?? entry.usecaseSpecDigest,
          })
          .where(eq(ecosystemReleaseAssets.id, entry.id));
      }
      return release;
    });
  }

  async activate(releaseId: string, actor: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ecosystem-release-activation'))`);
      const [release] = await tx
        .select()
        .from(ecosystemReleases)
        .where(eq(ecosystemReleases.id, releaseId))
        .limit(1);
      if (!release) throw new AppError(ErrorCode.NOT_FOUND, "Ecosystem release not found", 404);
      if (release.status === "failed") {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Failed releases cannot be activated", 422);
      }
      const entries = await tx
        .select()
        .from(ecosystemReleaseAssets)
        .where(eq(ecosystemReleaseAssets.releaseId, releaseId));
      if (entries.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Release has no staged entries", 422);
      }
      await lockDataProductIdentities(tx, entries);
      await assertStableReleaseAssetIdentities(tx, release.releaseKey, entries);
      for (const entry of entries) {
        if (entry.kind === "data-product") {
          await materializeDataProductCatalogEntry(tx, entry, release);
        } else {
          const executable = await materializeExecutableCatalogEntry(tx, entry, release);
          const materialized = await materializeReleaseAsset(tx, entry, release, executable);
          await enqueueSoftwareAssetAuthzProjection(tx, {
            assetId: materialized.assetId,
            lifecycle: "published",
            visibility: "platform-public",
            trustedForGlobalUse: true,
          });
          await tx
            .update(ecosystemReleaseAssets)
            .set({
              assetId: materialized.assetId,
              assetRevisionId: materialized.assetRevisionId,
              usecasePackageId: materialized.usecasePackageId ?? null,
              usecasePackageRevisionId: materialized.usecasePackageRevisionId ?? null,
              usecaseSpecDigest: materialized.usecaseSpecDigest ?? entry.usecaseSpecDigest,
              workflowTemplateId: materialized.workflowTemplateId ?? null,
              materializedAt: sql`now()`,
            })
            .where(eq(ecosystemReleaseAssets.id, entry.id));
        }
      }
      const oldActive = await tx
        .select({ id: ecosystemReleases.id })
        .from(ecosystemReleases)
        .where(
          and(
            eq(ecosystemReleases.releaseKey, release.releaseKey),
            eq(ecosystemReleases.status, "active"),
          ),
        );
      if (oldActive.length > 0) {
        await tx
          .update(ecosystemReleases)
          .set({ status: "inactive", deactivatedAt: sql`now()` })
          .where(
            inArray(
              ecosystemReleases.id,
              oldActive.map((item) => item.id),
            ),
          );
      }
      await tx
        .update(ecosystemReleases)
        .set({ status: "active", activatedBy: actor, activatedAt: sql`now()`, deactivatedAt: null })
        .where(eq(ecosystemReleases.id, releaseId));
      await deprecateRemovedAssets(
        tx,
        releaseId,
        oldActive.map((item) => item.id),
      );
      return { ...release, status: "active" as const };
    });
  }

  async rollback(releaseKey: string, targetReleaseId: string, actor: string) {
    const [target] = await this.db
      .select()
      .from(ecosystemReleases)
      .where(
        and(
          eq(ecosystemReleases.id, targetReleaseId),
          eq(ecosystemReleases.releaseKey, releaseKey),
        ),
      )
      .limit(1);
    if (!target) throw new AppError(ErrorCode.NOT_FOUND, "Rollback target not found", 404);
    return this.activate(target.id, actor);
  }

  async list(releaseKey?: string) {
    return this.db
      .select()
      .from(ecosystemReleases)
      .where(releaseKey ? eq(ecosystemReleases.releaseKey, releaseKey) : undefined)
      .orderBy(desc(ecosystemReleases.importedAt));
  }

  async status(releaseKey: string) {
    const [release] = await this.db
      .select()
      .from(ecosystemReleases)
      .where(
        and(eq(ecosystemReleases.releaseKey, releaseKey), eq(ecosystemReleases.status, "active")),
      )
      .limit(1);
    if (!release) return null;
    const assets = await this.db
      .select()
      .from(ecosystemReleaseAssets)
      .where(eq(ecosystemReleaseAssets.releaseId, release.id));
    return { release, assetCounts: countByKind(assets), assets };
  }

  async submitEntitlementClaim(input: EntitlementClaimInput, actor: string) {
    const parsed = EntitlementClaimInputSchema.parse(input);
    const policy = await this.getCanonicalLicensePolicy(parsed.assetId);
    const licenseSubject = policy?.identifiers[0]?.value;
    if (!licenseSubject) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Entitlement claims require one active governed software asset",
        403,
      );
    }
    const [row] = await this.db
      .insert(licenseEntitlementClaims)
      .values({
        ...parsed,
        licenseSubject,
        providerOrgId: parsed.providerOrgId ?? null,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        submittedBy: actor,
      })
      .returning();
    if (!row)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Entitlement claim creation failed", 500);
    return row;
  }

  async listEntitlementClaims(status?: string) {
    return this.db
      .select()
      .from(licenseEntitlementClaims)
      .where(status ? eq(licenseEntitlementClaims.status, status) : undefined)
      .orderBy(desc(licenseEntitlementClaims.submittedAt));
  }

  async decideEntitlementClaim(
    id: string,
    status: "approved" | "rejected" | "revoked",
    actor: string,
    reason?: string,
  ) {
    const [row] = await this.db
      .update(licenseEntitlementClaims)
      .set({
        status,
        reviewedBy: actor,
        reviewedAt: sql`now()`,
        decisionReason: reason ?? null,
        revokedAt: status === "revoked" ? sql`now()` : null,
      })
      .where(eq(licenseEntitlementClaims.id, id))
      .returning();
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Entitlement claim not found", 404);
    return row;
  }

  async bindRuntimeContract(input: RuntimeContractBindingInput, actor: string) {
    const parsed = RuntimeContractBindingInputSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const [profile] = await tx
        .select()
        .from(sandboxRuntimeProfiles)
        .where(eq(sandboxRuntimeProfiles.id, parsed.runtimeProfileId))
        .limit(1);
      if (!profile) throw new AppError(ErrorCode.NOT_FOUND, "Runtime profile not found", 404);
      if (profile.lifecycle !== "active") {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Runtime profile must be active", 422);
      }
      if (
        profile.ociDigest !== parsed.runtimeDigest &&
        profile.sifDigest !== parsed.runtimeDigest
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Runtime digest does not match active signed runtime profile",
          422,
        );
      }
      const attestationKeyId = verifyRuntimeProfileAttestation(
        profile,
        parsed.runtimeDigest,
        this.trustedPublicKeys,
      );
      const [row] = await tx
        .insert(sandboxRuntimeContractBindings)
        .values({
          ...parsed,
          agentId: parsed.agentId ?? null,
          clusterId: parsed.clusterId ?? null,
          agentScopeKey: parsed.agentId ?? "",
          clusterScopeKey: parsed.clusterId ?? "",
          attestationKeyId,
          attestationSignature: profile.signature,
          boundBy: actor,
        })
        .onConflictDoUpdate({
          target: [
            sandboxRuntimeContractBindings.providerOrgId,
            sandboxRuntimeContractBindings.agentScopeKey,
            sandboxRuntimeContractBindings.clusterScopeKey,
            sandboxRuntimeContractBindings.runtimeContractRef,
          ],
          set: {
            runtimeProfileId: parsed.runtimeProfileId,
            runtimeDigest: parsed.runtimeDigest,
            attestationKeyId,
            attestationSignature: profile.signature,
            attestedAt: sql`now()`,
            status: "active",
            boundBy: actor,
            boundAt: sql`now()`,
            revokedAt: null,
          },
        })
        .returning();
      if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR, "Runtime binding failed", 500);
      return row;
    });
  }

  async listRuntimeContractBindings(providerOrgId?: string) {
    return this.db
      .select()
      .from(sandboxRuntimeContractBindings)
      .where(
        providerOrgId ? eq(sandboxRuntimeContractBindings.providerOrgId, providerOrgId) : undefined,
      );
  }

  private async getCanonicalLicensePolicy(assetId: string): Promise<LicensePolicy | null> {
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
      .where(
        and(
          eq(ecosystemReleaseAssets.assetId, assetId),
          eq(ecosystemReleaseAssets.kind, "spack-package"),
        ),
      )
      .limit(2);
    if (rows.length !== 1 || !rows[0]) return null;
    const parsed = LicensePolicySchema.safeParse(rows[0].licensePolicy);
    return parsed.success ? parsed.data : null;
  }

  async registerLicensedMaterial(input: LicensedMaterialMappingInput, actor: string) {
    const parsed = LicensedMaterialMappingInputSchema.parse(input);
    const policy = await this.getCanonicalLicensePolicy(parsed.assetId);
    if (!policy) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Licensed material must reference one unique active governed software asset",
        403,
      );
    }
    const licenseSubject = policy.identifiers[0]?.value;
    if (!licenseSubject) {
      throw new AppError(ErrorCode.FORBIDDEN, "Governed asset lacks a license subject", 403);
    }
    const [row] = await this.db
      .insert(licensedMaterialMappings)
      .values({
        ...parsed,
        licenseSubject,
        auditMetadata: parsed.auditMetadata ?? {},
        createdBy: actor,
      })
      .onConflictDoUpdate({
        target: [
          licensedMaterialMappings.providerOrgId,
          licensedMaterialMappings.agentId,
          licensedMaterialMappings.selector,
        ],
        set: {
          assetId: parsed.assetId,
          licenseSubject,
          materialName: parsed.materialName,
          materialVersion: parsed.materialVersion,
          elementSet: parsed.elementSet,
          fingerprint: parsed.fingerprint,
          auditMetadata: parsed.auditMetadata ?? {},
          status: "active",
          revokedAt: null,
        },
      })
      .returning();
    if (!row)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Licensed material registration failed", 500);
    return row;
  }

  async listLicensedMaterials(providerOrgId?: string) {
    return this.db
      .select()
      .from(licensedMaterialMappings)
      .where(providerOrgId ? eq(licensedMaterialMappings.providerOrgId, providerOrgId) : undefined);
  }
}

async function materializeReleaseAsset(
  db: DbExecutor,
  entry: typeof ecosystemReleaseAssets.$inferSelect,
  release: typeof ecosystemReleases.$inferSelect,
  executable: ExecutableCatalogBinding,
): Promise<MaterializedAsset> {
  const [existing] = await db
    .select()
    .from(softwareAssets)
    .where(
      and(
        eq(softwareAssets.source, "platform-fork"),
        eq(softwareAssets.kind, entry.kind),
        sql`${softwareAssets.provenance}->>'ecosystemKey' = ${entry.ecosystemKey}`,
        sql`${softwareAssets.provenance}->'ecosystemRelease'->>'releaseKey' = ${release.releaseKey}`,
      ),
    )
    .limit(1);
  const payload = attachExecutableCatalogBinding(entry.payload, executable);
  const provenance = {
    ...entry.provenance,
    ecosystemKey: entry.ecosystemKey,
    licensePolicy: entry.licensePolicy,
    ecosystemRelease: {
      releaseKey: release.releaseKey,
      version: release.version,
      digest: release.artifactDigest,
    },
  };
  const asset = existing
    ? await updatePlatformAsset(db, existing.id, entry, payload, provenance)
    : await insertPlatformAsset(db, entry, payload, provenance);
  const payloadHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  const [latest] = await db
    .select()
    .from(softwareAssetRevisions)
    .where(eq(softwareAssetRevisions.assetId, asset.id))
    .orderBy(desc(softwareAssetRevisions.revision))
    .limit(1);
  if (latest?.recipeSha256 === payloadHash) {
    return {
      assetId: asset.id,
      assetRevisionId: latest.id,
      ...executable,
    };
  }
  const [revision] = await db
    .insert(softwareAssetRevisions)
    .values({
      assetId: asset.id,
      revision: (latest?.revision ?? 0) + 1,
      payload,
      provenance,
      recipeSha256: payloadHash,
      createdBy: null,
    })
    .returning();
  if (!revision)
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Asset revision materialization failed", 500);
  return { assetId: asset.id, assetRevisionId: revision.id, ...executable };
}

interface ExecutableCatalogBinding {
  usecasePackageId?: string;
  usecasePackageRevisionId?: string;
  usecaseSpecDigest?: string;
  workflowTemplateId?: string;
}

export interface MaterializedDataProduct {
  dataAssetId: string;
  dataAssetVersionId: string;
  kind: string;
  selector: string;
  version: string;
}

async function materializeDataProductCatalogEntry(
  db: DbExecutor,
  entry: typeof ecosystemReleaseAssets.$inferSelect,
  release: typeof ecosystemReleases.$inferSelect,
): Promise<MaterializedDataProduct> {
  const parsed = DataProductPayloadSchema.safeParse(entry.payload);
  if (!parsed.success) {
    throw schemaError(entry.ecosystemKey, "DataProductPayload", parsed.error.issues);
  }
  const product = parsed.data.dataAsset;
  const dataAssetId = stableUuid(`ecosystem-data-asset:${product.kind}:${product.selector}`);
  const dataAssetVersionId = stableUuid(
    `ecosystem-data-version:${product.kind}:${product.selector}:${product.version}`,
  );
  const manifest = {
    placeholder: true,
    selector: {
      kind: product.kind,
      selector: product.selector,
      version: product.version,
    },
    deliveryPolicy: product.deliveryPolicy,
    redistribution: product.redistribution,
    entitlementRequired: product.entitlementRequired,
  };
  const manifestDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(manifest))
    .digest("hex")}`;
  await db
    .insert(dataAssets)
    .values({
      id: dataAssetId,
      ownerKind: "platform",
      kind: product.kind,
      name: entry.name,
      description: product.description,
      lifecycle: "published",
      visibility: "public",
      accessMode: product.accessMode,
      sensitivity: product.sensitivity,
      metadata: {
        tags: product.tags,
        selector: product.selector,
        selectorVersion: product.version,
        ecosystemKey: entry.ecosystemKey,
        ecosystemRelease: {
          releaseKey: release.releaseKey,
          version: release.version,
          digest: release.artifactDigest,
        },
        metadataPlaceholder: true,
      },
      createdBy: null,
    })
    .onConflictDoUpdate({
      target: dataAssets.id,
      set: {
        name: entry.name,
        description: product.description,
        lifecycle: "published",
        accessMode: product.accessMode,
        sensitivity: product.sensitivity,
        metadata: {
          tags: product.tags,
          selector: product.selector,
          selectorVersion: product.version,
          ecosystemKey: entry.ecosystemKey,
          ecosystemRelease: {
            releaseKey: release.releaseKey,
            version: release.version,
            digest: release.artifactDigest,
          },
          metadataPlaceholder: true,
        },
        updatedAt: sql`now()`,
      },
    });
  await db
    .insert(dataAssetVersions)
    .values({
      id: dataAssetVersionId,
      dataAssetId,
      version: product.version,
      status: "ready",
      contentHash: manifestDigest,
      manifestDigest,
      manifest,
      provenance: {
        ...entry.provenance,
        ecosystemKey: entry.ecosystemKey,
        artifactDigest: release.artifactDigest,
      },
      immutableAt: sql`now()`,
      createdBy: null,
    })
    .onConflictDoNothing({ target: dataAssetVersions.id });
  const [revision] = await db
    .select({
      dataAssetId: dataAssetVersions.dataAssetId,
      manifestDigest: dataAssetVersions.manifestDigest,
    })
    .from(dataAssetVersions)
    .where(eq(dataAssetVersions.id, dataAssetVersionId))
    .limit(1);
  if (
    !revision ||
    revision.dataAssetId !== dataAssetId ||
    revision.manifestDigest !== manifestDigest
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Data product ${product.selector}@${product.version} conflicts with its immutable revision`,
      422,
    );
  }
  await db
    .update(dataAssetVersions)
    .set({ status: "ready", updatedAt: sql`now()` })
    .where(
      and(eq(dataAssetVersions.id, dataAssetVersionId), eq(dataAssetVersions.status, "deprecated")),
    );
  await enqueueDataProductAuthzProjection(db, dataAssetId, product.accessMode);
  return {
    dataAssetId,
    dataAssetVersionId,
    kind: product.kind,
    selector: product.selector,
    version: product.version,
  };
}

async function enqueueDataProductAuthzProjection(
  db: DbExecutor,
  dataAssetId: string,
  accessMode: string,
): Promise<void> {
  const publicOperation = accessMode === "open" ? "create" : "delete";
  const tuples = [
    dataAssetPlatformTuple(dataAssetId),
    ...dataAssetPublicAccessTuples({ assetId: dataAssetId, operation: publicOperation }),
  ];
  for (const tuple of tuples) {
    await enqueueAuthzTupleUnlessPending(db, tuple);
  }
}

async function enqueueSoftwareAssetAuthzProjection(
  db: DbExecutor,
  input: {
    assetId: string;
    lifecycle: string;
    visibility: string;
    trustedForGlobalUse: boolean;
  },
): Promise<void> {
  for (const tuple of softwareAssetAuthzProjectionTuples(input)) {
    await enqueueAuthzTupleUnlessPending(db, tuple);
  }
}

async function enqueueAuthzTupleUnlessPending(
  db: DbExecutor,
  tuple: AuthzProjectionTuple,
): Promise<void> {
  const subjectRelation = tuple.subject.relation
    ? eq(authzOutbox.subjectRelation, tuple.subject.relation)
    : isNull(authzOutbox.subjectRelation);
  const [latestPending] = await db
    .select({ operation: authzOutbox.operation })
    .from(authzOutbox)
    .where(
      and(
        eq(authzOutbox.resourceType, tuple.resource.type),
        eq(authzOutbox.resourceId, tuple.resource.id),
        eq(authzOutbox.relation, tuple.relation),
        eq(authzOutbox.subjectType, tuple.subject.type),
        eq(authzOutbox.subjectId, tuple.subject.id),
        subjectRelation,
        inArray(authzOutbox.status, ["pending", "processing"]),
      ),
    )
    .orderBy(desc(authzOutbox.sequence))
    .limit(1);
  if (latestPending?.operation === tuple.operation) return;
  await db.insert(authzOutbox).values({
    operation: tuple.operation,
    resourceType: tuple.resource.type,
    resourceId: tuple.resource.id,
    relation: tuple.relation,
    subjectType: tuple.subject.type,
    subjectId: tuple.subject.id,
    subjectRelation: tuple.subject.relation ?? null,
    payload: tuple.payload ?? {},
  });
}

export function stableDataProductCatalogReference(input: {
  kind: string;
  selector: string;
  version: string;
}): MaterializedDataProduct {
  return {
    dataAssetId: stableUuid(`ecosystem-data-asset:${input.kind}:${input.selector}`),
    dataAssetVersionId: stableUuid(
      `ecosystem-data-version:${input.kind}:${input.selector}:${input.version}`,
    ),
    ...input,
  };
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function materializeExecutableCatalogEntry(
  db: DbExecutor,
  entry: typeof ecosystemReleaseAssets.$inferSelect,
  release: typeof ecosystemReleases.$inferSelect,
): Promise<ExecutableCatalogBinding> {
  if (entry.kind === "usecase") {
    const payload = parseExecutablePayload(entry);
    if (payload.kind !== "usecase") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Release usecase payload is invalid", 422);
    }
    const actualSpecDigest = usecaseSpecDigest(payload.spec);
    if (entry.usecaseSpecDigest && entry.usecaseSpecDigest !== actualSpecDigest) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Release usecase specDigest must match the canonical package spec before activation",
        422,
      );
    }
    if (entry.usecasePackageId && entry.usecasePackageRevisionId) {
      return {
        usecasePackageId: entry.usecasePackageId,
        usecasePackageRevisionId: entry.usecasePackageRevisionId,
        usecaseSpecDigest: actualSpecDigest,
      };
    }
    const [reusableBinding] = await db
      .select({
        usecasePackageId: ecosystemReleaseAssets.usecasePackageId,
        usecasePackageRevisionId: ecosystemReleaseAssets.usecasePackageRevisionId,
        usecaseSpecDigest: ecosystemReleaseAssets.usecaseSpecDigest,
      })
      .from(ecosystemReleaseAssets)
      .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id))
      .where(
        and(
          eq(ecosystemReleases.releaseKey, release.releaseKey),
          eq(ecosystemReleaseAssets.kind, "usecase"),
          eq(ecosystemReleaseAssets.ecosystemKey, entry.ecosystemKey),
          eq(ecosystemReleaseAssets.manifestEntryDigest, entry.manifestEntryDigest),
          isNotNull(ecosystemReleaseAssets.usecasePackageId),
          isNotNull(ecosystemReleaseAssets.usecasePackageRevisionId),
        ),
      )
      .orderBy(desc(ecosystemReleaseAssets.createdAt))
      .limit(1);
    if (reusableBinding?.usecasePackageId && reusableBinding.usecasePackageRevisionId) {
      return {
        usecasePackageId: reusableBinding.usecasePackageId,
        usecasePackageRevisionId: reusableBinding.usecasePackageRevisionId,
        usecaseSpecDigest: actualSpecDigest,
      };
    }
    const immutableProvenance = {
      ...entry.provenance,
      ecosystemRelease: {
        releaseKey: release.releaseKey,
        version: release.version,
        artifactDigest: release.artifactDigest,
        manifestEntryDigest: entry.manifestEntryDigest,
        signingKeyId: release.signingKeyId,
      },
    };
    const [row] = await db
      .insert(usecasePackages)
      .values({
        name: entry.name,
        version: entry.version,
        description: usecaseDescription(payload.spec),
        spec: payload.spec,
        specDigest: actualSpecDigest,
        namespace: "platform",
        ownerSubject: release.importedBy,
        provenance: immutableProvenance,
        immutableAt: sql`now()`,
        createdBy: null,
      })
      .returning();
    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Usecase catalog materialization failed", 500);
    }
    const [revision] = await db
      .insert(usecasePackageRevisions)
      .values({
        packageId: row.id,
        revision: 1,
        spec: payload.spec,
        specDigest: actualSpecDigest,
        provenance: immutableProvenance,
        createdBy: null,
      })
      .returning();
    if (!revision) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Usecase revision materialization failed", 500);
    }
    return {
      usecasePackageId: row.id,
      usecasePackageRevisionId: revision.id,
      usecaseSpecDigest: actualSpecDigest,
    };
  }
  if (entry.kind === "workflow-template") {
    if (entry.workflowTemplateId) return { workflowTemplateId: entry.workflowTemplateId };
    const [reusableBinding] = await db
      .select({ workflowTemplateId: ecosystemReleaseAssets.workflowTemplateId })
      .from(ecosystemReleaseAssets)
      .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id))
      .where(
        and(
          eq(ecosystemReleases.releaseKey, release.releaseKey),
          eq(ecosystemReleaseAssets.kind, "workflow-template"),
          eq(ecosystemReleaseAssets.ecosystemKey, entry.ecosystemKey),
          eq(ecosystemReleaseAssets.manifestEntryDigest, entry.manifestEntryDigest),
          isNotNull(ecosystemReleaseAssets.workflowTemplateId),
        ),
      )
      .orderBy(desc(ecosystemReleaseAssets.createdAt))
      .limit(1);
    if (reusableBinding?.workflowTemplateId) {
      return { workflowTemplateId: reusableBinding.workflowTemplateId };
    }
    const payload = parseExecutablePayload(entry);
    if (payload.kind !== "workflow-template" || !payload.yamlContent) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Release workflow payload is invalid", 422);
    }
    const [row] = await db
      .insert(workflowTemplates)
      .values({
        name: entry.name,
        version: entry.version,
        description: workflowDescription(payload.yamlContent),
        yamlContent: payload.yamlContent,
        tags: [],
        createdBy: null,
      })
      .returning();
    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Workflow catalog materialization failed", 500);
    }
    return { workflowTemplateId: row.id };
  }
  return {};
}

function parseExecutablePayload(
  entry: typeof ecosystemReleaseAssets.$inferSelect,
): SoftwareAssetPayload {
  const result = SoftwareAssetPayloadSchema.safeParse(entry.payload);
  if (!result.success) {
    throw schemaError(entry.ecosystemKey, "SoftwareAssetPayload", result.error.issues);
  }
  return result.data;
}

function attachExecutableCatalogBinding(
  payload: Record<string, unknown>,
  executable: ExecutableCatalogBinding,
): Record<string, unknown> {
  if (executable.usecasePackageId) {
    return {
      ...payload,
      usecasePackageId: executable.usecasePackageId,
      usecasePackageRevisionId: executable.usecasePackageRevisionId,
    };
  }
  if (executable.workflowTemplateId) {
    return { ...payload, workflowTemplateId: executable.workflowTemplateId };
  }
  return payload;
}

function usecaseDescription(spec: Record<string, unknown>): string | null {
  const description = spec.description;
  return typeof description === "string" && description.length > 0 ? description : null;
}

function workflowDescription(yamlContent: string): string | null {
  const document = parseWorkflowYaml("materialized workflow", yamlContent);
  if (!isRecord(document)) return null;
  const name = document.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

async function insertPlatformAsset(
  db: DbExecutor,
  entry: typeof ecosystemReleaseAssets.$inferSelect,
  payload: Record<string, unknown>,
  provenance: Record<string, unknown>,
) {
  const [row] = await db
    .insert(softwareAssets)
    .values({
      kind: entry.kind,
      name: entry.name,
      version: entry.version,
      source: "platform-fork",
      lifecycle: "published",
      visibility: "platform-public",
      payload,
      provenance,
      trustedForGlobalUse: true,
      createdBy: null,
    })
    .returning();
  if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR, "Asset materialization failed", 500);
  return row;
}

async function updatePlatformAsset(
  db: DbExecutor,
  id: string,
  entry: typeof ecosystemReleaseAssets.$inferSelect,
  payload: Record<string, unknown>,
  provenance: Record<string, unknown>,
) {
  const [row] = await db
    .update(softwareAssets)
    .set({
      name: entry.name,
      version: entry.version,
      lifecycle: "published",
      visibility: "platform-public",
      payload,
      provenance,
      trustedForGlobalUse: true,
      updatedAt: sql`now()`,
    })
    .where(eq(softwareAssets.id, id))
    .returning();
  if (!row)
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Asset disappeared while activating release", 500);
  return row;
}

async function deprecateRemovedAssets(db: DbExecutor, releaseId: string, oldReleaseIds: string[]) {
  if (oldReleaseIds.length === 0) return;
  const nextEntries = await db
    .select({
      ecosystemKey: ecosystemReleaseAssets.ecosystemKey,
      kind: ecosystemReleaseAssets.kind,
      payload: ecosystemReleaseAssets.payload,
    })
    .from(ecosystemReleaseAssets)
    .where(eq(ecosystemReleaseAssets.releaseId, releaseId));
  const previous = await db
    .select({
      assetId: ecosystemReleaseAssets.assetId,
      ecosystemKey: ecosystemReleaseAssets.ecosystemKey,
      kind: ecosystemReleaseAssets.kind,
      payload: ecosystemReleaseAssets.payload,
    })
    .from(ecosystemReleaseAssets)
    .where(inArray(ecosystemReleaseAssets.releaseId, oldReleaseIds));
  const nextSoftwareIdentities = new Set(
    nextEntries
      .filter((entry) => entry.kind !== "data-product")
      .map((entry) => `${entry.kind}:${entry.ecosystemKey}`),
  );
  const candidateRemovedAssetIds = previous
    .filter(
      (entry): entry is typeof entry & { assetId: string } =>
        entry.assetId !== null &&
        entry.kind !== "data-product" &&
        !nextSoftwareIdentities.has(`${entry.kind}:${entry.ecosystemKey}`),
    )
    .map((entry) => entry.assetId);
  const activeSoftwareAssetIds = await loadActiveSoftwareAssetIds(db, candidateRemovedAssetIds);
  const removedAssetIds = candidateRemovedAssetIds.filter(
    (assetId) => !activeSoftwareAssetIds.has(assetId),
  );
  if (removedAssetIds.length > 0) {
    await db
      .update(softwareAssets)
      .set({ lifecycle: "deprecated", updatedAt: sql`now()` })
      .where(inArray(softwareAssets.id, removedAssetIds));
    for (const assetId of removedAssetIds) {
      await enqueueSoftwareAssetAuthzProjection(db, {
        assetId,
        lifecycle: "deprecated",
        visibility: "platform-public",
        trustedForGlobalUse: true,
      });
    }
  }

  const nextDataProducts = nextEntries
    .filter((entry) => entry.kind === "data-product")
    .map((entry) => dataProductReferenceFromPayload(entry.ecosystemKey, entry.payload));
  const nextDataAssetIds = new Set(nextDataProducts.map((entry) => entry.dataAssetId));
  const nextDataVersionIds = new Set(nextDataProducts.map((entry) => entry.dataAssetVersionId));
  const previousDataProducts = previous
    .filter((entry) => entry.kind === "data-product")
    .map((entry) => dataProductReferenceFromPayload(entry.ecosystemKey, entry.payload));
  const candidateRemovedDataVersionIds = previousDataProducts
    .filter((entry) => !nextDataVersionIds.has(entry.dataAssetVersionId))
    .map((entry) => entry.dataAssetVersionId);
  const activeDataReferences = await loadActiveDataProductReferences(db);
  const activeDataAssetIds = new Set(activeDataReferences.map((entry) => entry.dataAssetId));
  const activeDataVersionIds = new Set(
    activeDataReferences.map((entry) => entry.dataAssetVersionId),
  );
  const removedDataVersionIds = candidateRemovedDataVersionIds.filter(
    (versionId) => !activeDataVersionIds.has(versionId),
  );
  if (removedDataVersionIds.length > 0) {
    await db
      .update(dataAssetVersions)
      .set({ status: "deprecated", updatedAt: sql`now()` })
      .where(inArray(dataAssetVersions.id, removedDataVersionIds));
  }
  const removedDataAssetIds = [
    ...new Set(
      previousDataProducts
        .filter(
          (entry) =>
            !nextDataAssetIds.has(entry.dataAssetId) && !activeDataAssetIds.has(entry.dataAssetId),
        )
        .map((entry) => entry.dataAssetId),
    ),
  ];
  if (removedDataAssetIds.length === 0) return;
  await db
    .update(dataAssets)
    .set({ lifecycle: "deprecated", updatedAt: sql`now()` })
    .where(inArray(dataAssets.id, removedDataAssetIds));
  for (const dataAssetId of removedDataAssetIds) {
    await enqueueDataProductAuthzProjection(db, dataAssetId, "deprecated");
  }
}

async function loadActiveSoftwareAssetIds(
  db: DbExecutor,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const rows = await db
    .select({ assetId: ecosystemReleaseAssets.assetId })
    .from(ecosystemReleaseAssets)
    .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id))
    .where(
      and(
        eq(ecosystemReleases.status, "active"),
        inArray(ecosystemReleaseAssets.assetId, candidateIds),
      ),
    );
  return new Set(rows.flatMap((row) => (row.assetId ? [row.assetId] : [])));
}

async function loadActiveDataProductReferences(db: DbExecutor): Promise<MaterializedDataProduct[]> {
  const rows = await db
    .select({
      ecosystemKey: ecosystemReleaseAssets.ecosystemKey,
      payload: ecosystemReleaseAssets.payload,
    })
    .from(ecosystemReleaseAssets)
    .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id))
    .where(
      and(eq(ecosystemReleases.status, "active"), eq(ecosystemReleaseAssets.kind, "data-product")),
    );
  return rows.map((row) => dataProductReferenceFromPayload(row.ecosystemKey, row.payload));
}

async function assertStableReleaseAssetIdentities(
  db: DbExecutor,
  releaseKey: string,
  assets: ReleaseAssetIdentity[],
): Promise<void> {
  const historicalEntries = await db
    .select({
      releaseKey: ecosystemReleases.releaseKey,
      ecosystemKey: ecosystemReleaseAssets.ecosystemKey,
      kind: ecosystemReleaseAssets.kind,
      payload: ecosystemReleaseAssets.payload,
    })
    .from(ecosystemReleaseAssets)
    .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id));
  const currentByKey = new Map(assets.map((asset) => [asset.ecosystemKey, asset]));
  for (const historical of historicalEntries.filter((entry) => entry.releaseKey === releaseKey)) {
    const current = currentByKey.get(historical.ecosystemKey);
    if (!current) continue;
    if (current.kind !== historical.kind) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Ecosystem asset ${current.ecosystemKey} cannot change kind within release ${releaseKey}`,
        422,
      );
    }
    if (current.kind !== "data-product") continue;
    const currentIdentity = dataProductStableIdentity(current.ecosystemKey, current.payload);
    const historicalIdentity = dataProductStableIdentity(
      historical.ecosystemKey,
      historical.payload,
    );
    if (currentIdentity !== historicalIdentity) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Data product ${current.ecosystemKey} cannot change kind or selector within release ${releaseKey}`,
        422,
      );
    }
  }
  const claimedDataProductIdentities = new Map<string, string>();
  for (const historical of historicalEntries) {
    if (historical.releaseKey === releaseKey || historical.kind !== "data-product") continue;
    claimedDataProductIdentities.set(
      dataProductStableIdentity(historical.ecosystemKey, historical.payload),
      historical.releaseKey,
    );
  }
  const currentDataProductIdentities = new Set<string>();
  for (const current of assets.filter((asset) => asset.kind === "data-product")) {
    const identity = dataProductStableIdentity(current.ecosystemKey, current.payload);
    if (currentDataProductIdentities.has(identity)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Data product identity ${identity} is duplicated within release ${releaseKey}`,
        422,
      );
    }
    currentDataProductIdentities.add(identity);
    const ownerReleaseKey = claimedDataProductIdentities.get(identity);
    if (ownerReleaseKey) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Data product identity ${identity} is already owned by release ${ownerReleaseKey}`,
        422,
      );
    }
  }
}

async function lockDataProductIdentities(
  db: DbExecutor,
  assets: ReleaseAssetIdentity[],
): Promise<void> {
  const identities = [
    ...new Set(
      assets
        .filter((asset) => asset.kind === "data-product")
        .map((asset) => dataProductStableIdentity(asset.ecosystemKey, asset.payload)),
    ),
  ].sort();
  for (const identity of identities) {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ecosystem-data-product:${identity}`}, 0))`,
    );
  }
}

function dataProductReferenceFromPayload(
  ecosystemKey: string,
  payload: Record<string, unknown>,
): MaterializedDataProduct {
  const parsed = DataProductPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw schemaError(ecosystemKey, "DataProductPayload", parsed.error.issues);
  }
  return stableDataProductCatalogReference(parsed.data.dataAsset);
}

function dataProductStableIdentity(ecosystemKey: string, payload: Record<string, unknown>): string {
  const reference = dataProductReferenceFromPayload(ecosystemKey, payload);
  return `${reference.kind}:${reference.selector}`;
}

function validateBundleAsset(asset: EcosystemBundleAsset): ValidatedBundleAsset {
  const policyResult = LicensePolicySchema.safeParse(asset.licensePolicy);
  if (!policyResult.success) {
    throw schemaError(asset.ecosystemKey, "LicensePolicy", policyResult.error.issues);
  }
  validateVaspLicensePolicy(asset, policyResult.data);
  if (asset.kind === "data-product") {
    const dataProductResult = DataProductPayloadSchema.safeParse(asset.payload);
    if (!dataProductResult.success) {
      throw schemaError(asset.ecosystemKey, "DataProductPayload", dataProductResult.error.issues);
    }
    validateDataProductMetadata(asset, dataProductResult.data);
    return { asset, licensePolicy: policyResult.data, payload: dataProductResult.data };
  }
  const payloadResult = SoftwareAssetPayloadSchema.safeParse(asset.payload);
  if (!payloadResult.success) {
    throw schemaError(asset.ecosystemKey, "SoftwareAssetPayload", payloadResult.error.issues);
  }
  const payload = payloadResult.data;
  if (payload.kind !== asset.kind) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Asset ${asset.ecosystemKey} kind does not match its payload`,
      422,
    );
  }
  if (payload.kind === "usecase") {
    const usecaseResult = usecase.GovernedUsecasePackageSchema.safeParse(payload.spec);
    if (!usecaseResult.success) {
      throw schemaError(asset.ecosystemKey, "GovernedUsecasePackage", usecaseResult.error.issues);
    }
    return {
      asset,
      licensePolicy: policyResult.data,
      payload,
      usecase: usecaseResult.data,
    };
  }
  if (payload.kind === "workflow-template") {
    if (!payload.yamlContent) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Workflow ${asset.ecosystemKey} must contain yamlContent`,
        422,
      );
    }
    const workflowDocument = parseWorkflowYaml(asset.ecosystemKey, payload.yamlContent);
    const workflowResult = workflowDsl.WorkflowSchema.safeParse(workflowDocument);
    if (!workflowResult.success) {
      throw schemaError(asset.ecosystemKey, "Workflow", workflowResult.error.issues);
    }
    if (workflowResult.data.advanced?.skipStaticValidation) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Workflow ${asset.ecosystemKey} cannot skip static validation`,
        422,
      );
    }
    const workflowErrors = workflowDsl.validateWorkflow(workflowResult.data);
    if (workflowErrors.length > 0) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Workflow ${asset.ecosystemKey} is invalid: ${workflowErrors.join("; ")}`,
        422,
      );
    }
    return {
      asset,
      licensePolicy: policyResult.data,
      payload,
      workflow: workflowResult.data,
    };
  }
  return { asset, licensePolicy: policyResult.data, payload };
}

function validateDataProductMetadata(
  asset: EcosystemBundleAsset,
  payload: DataProductPayload,
): void {
  assertMetadataOnly(payload, asset.ecosystemKey);
  const dataAsset = payload.dataAsset;
  if (dataAsset.kind !== "licensed-material") return;
  if (
    dataAsset.accessMode !== "entitlement" ||
    !dataAsset.entitlementRequired ||
    dataAsset.deliveryPolicy.download !== "deny" ||
    dataAsset.deliveryPolicy.redistribution !== "deny" ||
    dataAsset.redistribution !== "prohibited"
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Licensed data product ${asset.ecosystemKey} must deny download and redistribution with entitlement`,
      422,
    );
  }
}

function assertMetadataOnly(value: unknown, ecosystemKey: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertMetadataOnly(item, ecosystemKey);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:bytes|content|data|file|localPath|path|secret|token|credential)$/i.test(key)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Data product ${ecosystemKey} must be metadata-only and cannot contain ${key}`,
        422,
      );
    }
    assertMetadataOnly(child, ecosystemKey);
  }
}

function validateNamedReferences(assets: ValidatedBundleAsset[]): void {
  for (const item of assets) {
    if (item.usecase) {
      resolveNamedSelector(
        assets,
        "spack-package",
        item.usecase.softwareRef,
        item.asset.ecosystemKey,
      );
      for (const dataRequirement of item.usecase.dataRequirements) {
        resolveDataProductSelector(assets, dataRequirement.asset, item.asset.ecosystemKey);
      }
      for (const input of item.usecase.inputs) {
        for (const selector of input.dataRequirements?.dataAssets ?? []) {
          resolveDataProductSelector(assets, selector, item.asset.ecosystemKey);
        }
      }
    }
    if (item.workflow) {
      validateWorkflowNamedReferences(assets, item.workflow.spec, item.asset.ecosystemKey);
    }
  }
}

function validateDataProductRequirements(assets: ValidatedBundleAsset[]): void {
  for (const item of assets) {
    if (item.payload.kind !== "data-product") continue;
    const dataAsset = item.payload.dataAsset;
    const matches = assets.filter(
      (candidate) =>
        candidate.payload.kind === "data-product" &&
        candidate.payload.dataAsset.selector === dataAsset.selector &&
        candidate.payload.dataAsset.version === dataAsset.version,
    );
    if (matches.length !== 1) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Data product ${dataAsset.selector}@${dataAsset.version} must be unique`,
        422,
      );
    }
  }
}

function resolveDataProductSelector(
  assets: ValidatedBundleAsset[],
  selector: usecase.DataAssetSelector,
  ownerKey: string,
): ValidatedBundleAsset {
  const matches = assets.filter(
    (candidate) =>
      candidate.payload.kind === "data-product" &&
      candidate.payload.dataAsset.kind === selector.kind &&
      candidate.payload.dataAsset.selector === selector.selector &&
      candidate.payload.dataAsset.version === selector.version,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Data requirement ${ownerKey} selector ${selector.kind}/${selector.selector}@${selector.version ?? "<legacy>"} must resolve exactly once`,
      422,
    );
  }
  return matches[0];
}

function validateWorkflowNamedReferences(
  assets: ValidatedBundleAsset[],
  spec: workflowDsl.WorkflowSpec,
  ownerKey: string,
): void {
  for (const node of spec.nodeDrafts) {
    if (node.type === "SoftwareUsecaseComputing") {
      if (!node.usecaseRef || !node.softwareRef) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `Workflow ${ownerKey} must use named usecase and software selectors`,
          422,
        );
      }
      resolveNamedSelector(assets, "usecase", node.usecaseRef, ownerKey);
      resolveNamedSelector(assets, "spack-package", node.softwareRef, ownerKey);
    } else if (node.type === "Script") {
      if (!node.scriptRef || !node.runtimeContractRef) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `Workflow ${ownerKey} must use named script and runtime references`,
          422,
        );
      }
      resolveNamedSelector(assets, "sandbox-script", node.scriptRef, ownerKey);
      validateOfficialRuntimeReference(
        node.runtimeContractRef,
        node.runtimeProfileId,
        node.executionIdentity,
        `Workflow ${ownerKey} script ${node.id}`,
      );
    } else if (node.type === "Loop") {
      validateWorkflowNamedReferences(assets, node.body, ownerKey);
    } else if (node.type === "SubWorkflow" && node.ref.kind === "Inline") {
      validateWorkflowNamedReferences(assets, node.ref.body, ownerKey);
    }
  }
}

function resolveNamedSelector(
  assets: ValidatedBundleAsset[],
  kind: EcosystemAssetKind,
  selector: workflowDsl.AssetSelector,
  ownerKey: string,
): ValidatedBundleAsset {
  const matches = assets.filter(
    (candidate) =>
      candidate.asset.kind === kind &&
      selector.source === "platform-fork" &&
      candidate.asset.name === selector.name &&
      candidate.asset.version === selector.version &&
      selector.providerOrgId === undefined,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Asset ${ownerKey} selector ${selector.source}/${selector.name}@${selector.version} must resolve exactly once`,
      422,
    );
  }
  return matches[0];
}

function validatePinnedSoftware(assets: ValidatedBundleAsset[]): void {
  const seen = new Set<string>();
  for (const item of assets.filter((entry) => entry.asset.kind === "spack-package")) {
    if (item.payload.kind !== "spack-package") continue;
    const normalizedName = normalizeSoftwareName(item.asset.name);
    const expected = PINNED_SOFTWARE.get(normalizedName);
    if (!expected || seen.has(normalizedName)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Scientific ecosystem contains unexpected or duplicate software ${item.asset.name}`,
        422,
      );
    }
    seen.add(normalizedName);
    const defaultSpec = item.payload.spack.defaultSpec;
    if (
      item.asset.version !== expected.version ||
      item.payload.spack.packageName !== expected.packageName ||
      !defaultSpec ||
      !defaultSpec.includes(`@${expected.version}`) ||
      /(?:latest|master|develop)/i.test(defaultSpec)
    ) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Software ${item.asset.name} must pin ${expected.packageName}@${expected.version}`,
        422,
      );
    }
  }
  if (seen.size !== PINNED_SOFTWARE.size) {
    const missing = [...PINNED_SOFTWARE.keys()].filter((name) => !seen.has(name));
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Scientific ecosystem is missing pinned software: ${missing.join(", ")}`,
      422,
    );
  }
}

function validateOfficialScripts(assets: ValidatedBundleAsset[]): void {
  for (const item of assets.filter((entry) => entry.asset.kind === "sandbox-script")) {
    if (item.payload.kind !== "sandbox-script") continue;
    validateOfficialRuntimeReference(
      item.payload.runtimeContractRef,
      item.payload.runtimeProfileId,
      item.payload.executionIdentity,
      `Official script ${item.asset.ecosystemKey}`,
    );
  }
}

function validateOfficialRuntimeReference(
  runtimeContractRef: { name: string; version: string } | undefined,
  runtimeProfileId: string | undefined,
  executionIdentity: { type: string } | undefined,
  subject: string,
): void {
  if (
    runtimeContractRef?.name !== OFFICIAL_RUNTIME_CONTRACT.name ||
    runtimeContractRef.version !== OFFICIAL_RUNTIME_CONTRACT.version ||
    runtimeProfileId !== undefined ||
    executionIdentity?.type !== "MappedAuto"
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `${subject} must use python-3.12-stdlib-v1 with MappedAuto and no runtimeProfileId`,
      422,
    );
  }
}

function validateVaspLicensePolicy(asset: EcosystemBundleAsset, policy: LicensePolicy): void {
  if (normalizeSoftwareName(asset.name) !== "vasp") return;
  if (
    policy.classification !== "proprietary" ||
    !policy.acceptanceRequired ||
    !policy.providerEntitlements.includes("source-access") ||
    !policy.providerEntitlements.includes("install") ||
    !policy.consumerEntitlements.includes("use") ||
    policy.redistribution !== "prohibited" ||
    policy.autoInstall !== "denied"
  ) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "VASP license policy must be fail-closed", 422);
  }
}

function parseWorkflowYaml(ecosystemKey: string, yamlContent: string): unknown {
  try {
    return parseYaml(yamlContent);
  } catch {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Workflow ${ecosystemKey} yamlContent is invalid YAML`,
      422,
    );
  }
}

function schemaError(
  ecosystemKey: string,
  schemaName: string,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): AppError {
  const details = issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  return new AppError(
    ErrorCode.VALIDATION_ERROR,
    `Asset ${ecosystemKey} failed ${schemaName} validation: ${details}`,
    422,
  );
}

function assetSelectorIdentity(asset: EcosystemBundleAsset): string {
  return `${asset.kind}\0platform-fork\0${asset.name}\0${asset.version}`;
}

function normalizeSoftwareName(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function countByKind(assets: Array<{ kind: string }>): Record<EcosystemAssetKind, number> {
  return {
    "data-product": assets.filter((asset) => asset.kind === "data-product").length,
    "spack-package": assets.filter((asset) => asset.kind === "spack-package").length,
    usecase: assets.filter((asset) => asset.kind === "usecase").length,
    "workflow-template": assets.filter((asset) => asset.kind === "workflow-template").length,
    "sandbox-script": assets.filter((asset) => asset.kind === "sandbox-script").length,
  };
}

function isAssetKind(value: unknown): value is EcosystemAssetKind {
  return (
    value === "data-product" ||
    value === "spack-package" ||
    value === "usecase" ||
    value === "workflow-template" ||
    value === "sandbox-script"
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Expected a JSON object", 422);
  }
  return value;
}
