import { createHash } from "node:crypto";
import {
  auditLog,
  authzOutbox,
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  LicensePolicySchema,
  type SoftwareAssetPayload,
  SoftwareAssetPayloadSchema,
  type SoftwareAssetSummary,
  softwareAssetAuthzProjectionTuples,
  type UpstreamVersionSnapshotLicensePolicySource,
  type UpstreamVersionSnapshotProvenance,
  UpstreamVersionSnapshotProvenanceSchema,
  UpstreamVersionSupersededReviewStateSchema,
  type UpstreamVersionSupersessionSchema,
} from "@kuintessence/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { RbacPrincipal } from "./namespace";
import { rowToSummary } from "./software-asset-service";

type AssetRow = typeof softwareAssets.$inferSelect;
type RevisionRow = typeof softwareAssetRevisions.$inferSelect;
type PgTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

const LegacySnapshotProvenanceSchema = z.strictObject({
  source: z.literal("official-upstream"),
  snapshot: z.literal("versioned-upstream"),
  sourceAssetId: z.string().uuid(),
  sourceRevisionId: z.string().uuid(),
  sourceRevision: z.number().int().positive(),
  upstreamName: z.string().min(1),
  upstreamVersion: z.string().min(1),
});

const LegacyUpstreamProvenanceSchema = z.strictObject({
  source: z.literal("official-upstream"),
  upstreamName: z.string().min(1),
  upstreamRef: z.string().min(1),
});

export interface UpstreamVersionSnapshotResult {
  created: boolean;
  asset: SoftwareAssetSummary;
  revision: {
    id: string;
    assetId: string;
    revision: number;
    payload: SoftwareAssetPayload;
    provenance: Record<string, unknown>;
    recipeSha256: string | null;
    createdAt: string;
  };
}

export interface UpstreamVersionSupersessionResult {
  created: boolean;
  legacy: {
    asset: SoftwareAssetSummary;
    revisionId: string;
  };
  snapshot: UpstreamVersionSnapshotResult;
}

export class UpstreamVersionSnapshotService {
  constructor(private readonly db: PgDb) {}

  async snapshot(input: {
    name: string;
    version: string;
    principal: RbacPrincipal;
  }): Promise<UpstreamVersionSnapshotResult> {
    assertSnapshotRole(input.principal);
    return this.db.transaction(async (tx) => {
      await lockSnapshotIdentity(tx, input);
      const sourceAsset = await loadSourceAsset(tx, input.name);
      assertSourceAssetActive(sourceAsset, input.name);
      validateSourceRevision(
        await loadLatestRevision(tx, sourceAsset.id),
        input.name,
        input.version,
      );
      const licensePolicySource = await loadLicensePolicySource(tx, input);
      const targetAssets = await loadIdentityAssets(tx, targetIdentity(input));
      if (targetAssets.length > 0) {
        return validateSnapshotIdentityState(
          tx,
          targetAssets,
          sourceAsset,
          licensePolicySource,
          input,
        );
      }
      return createSnapshot(tx, sourceAsset, licensePolicySource, input);
    });
  }

  async supersedeLegacy(input: {
    name: string;
    version: string;
    legacyAssetId: string;
    legacyRevisionId: string;
    reason: string;
    principal: RbacPrincipal;
  }): Promise<UpstreamVersionSupersessionResult> {
    assertSnapshotRole(input.principal);
    return this.db.transaction(async (tx) => {
      await lockSnapshotIdentity(tx, input);
      const sourceAsset = await loadSourceAsset(tx, input.name);
      assertSourceAssetActive(sourceAsset, input.name);
      validateSourceRevision(
        await loadLatestRevision(tx, sourceAsset.id),
        input.name,
        input.version,
      );
      const licensePolicySource = await loadLicensePolicySource(tx, input);
      const targetAssets = await loadIdentityAssets(tx, targetIdentity(input));
      const published = targetAssets.filter((asset) => asset.lifecycle === "published");

      if (published.length === 1 && targetAssets.length === 2) {
        const snapshot = await validateSnapshotIdentityState(
          tx,
          targetAssets,
          sourceAsset,
          licensePolicySource,
          input,
        );
        const legacy = await validateSupersededLegacyReplay(tx, targetAssets, snapshot, input);
        return {
          created: false,
          legacy: { asset: rowToSummary(legacy.asset), revisionId: legacy.revision.id },
          snapshot,
        };
      }

      if (targetAssets.length !== 1 || published.length !== 1) {
        throw supersessionConflict(input, "canonical identity is not a single active legacy asset");
      }
      const legacyAsset = targetAssets[0];
      if (!legacyAsset || legacyAsset.id !== input.legacyAssetId) {
        throw supersessionConflict(input, "legacy asset id does not match");
      }
      const legacyRevision = await validateLegacyAsset(tx, legacyAsset, input);
      const snapshot = await createSnapshot(tx, sourceAsset, licensePolicySource, input);
      const supersededAt = new Date().toISOString();
      const supersession = {
        kind: "versioned-upstream" as const,
        canonicalIdentity: canonicalIdentity(input),
        legacyRevisionId: legacyRevision.id,
        replacementAssetId: snapshot.asset.id,
        replacementRevisionId: snapshot.revision.id,
        reason: input.reason,
        supersededAt,
        supersededBy: input.principal.sub,
      };
      const [archived] = await tx
        .update(softwareAssets)
        .set({
          lifecycle: "archived",
          visibility: "hidden",
          reviewState: {
            ...legacyAsset.reviewState,
            upstreamVersionSupersession: supersession,
          },
          updatedAt: sql`now()`,
        })
        .where(eq(softwareAssets.id, legacyAsset.id))
        .returning();
      if (!archived) throw new Error("legacy upstream asset disappeared during supersession");

      await enqueueAssetProjection(tx, archived);
      await tx.insert(auditLog).values({
        actor: input.principal.sub,
        action: "software.asset.supersede_legacy_upstream_version",
        target: archived.id,
        diff: {
          before: {
            lifecycle: legacyAsset.lifecycle,
            visibility: legacyAsset.visibility,
          },
          after: {
            lifecycle: archived.lifecycle,
            visibility: archived.visibility,
            replacementAssetId: snapshot.asset.id,
            replacementRevisionId: snapshot.revision.id,
            reason: input.reason,
          },
        },
      });

      return {
        created: true,
        legacy: { asset: rowToSummary(archived), revisionId: legacyRevision.id },
        snapshot,
      };
    });
  }
}

async function createSnapshot(
  tx: PgTransaction,
  sourceAsset: AssetRow,
  licensePolicySource: UpstreamVersionSnapshotLicensePolicySource,
  input: { name: string; version: string; principal: RbacPrincipal },
): Promise<UpstreamVersionSnapshotResult> {
  assertSourceAssetActive(sourceAsset, input.name);
  const sourceRevision = await loadLatestRevision(tx, sourceAsset.id);
  const sourcePayload = validateSourceRevision(sourceRevision, input.name, input.version);
  const payload = snapshotPayload(sourcePayload, input.name, input.version);
  const provenance = snapshotProvenance(sourceAsset, sourceRevision, licensePolicySource, input);
  const actorId = uuidOrNull(input.principal.sub);

  const [asset] = await tx
    .insert(softwareAssets)
    .values({
      kind: "spack-package",
      name: input.name,
      version: input.version,
      source: "official-upstream",
      lifecycle: "published",
      visibility: "platform-public",
      payload,
      provenance,
      trustedForGlobalUse: true,
      createdBy: actorId,
    })
    .returning();
  if (!asset) throw new Error("versioned upstream snapshot asset insert returned no row");

  const [revision] = await tx
    .insert(softwareAssetRevisions)
    .values({
      assetId: asset.id,
      revision: 1,
      payload,
      provenance,
      recipeSha256: hashJson(payload),
      createdBy: actorId,
    })
    .returning();
  if (!revision) {
    throw new Error("versioned upstream snapshot revision insert returned no row");
  }

  await tx.insert(softwareAssetGrants).values({
    assetId: asset.id,
    subjectKind: "platform",
    subjectId: "platform",
    capabilities: ["install", "use", "view"],
    reason: "platform-public versioned upstream snapshot",
    createdBy: actorId,
  });
  await enqueueAssetProjection(tx, asset);
  await tx.insert(auditLog).values({
    actor: input.principal.sub,
    action: "software.asset.snapshot_upstream_version",
    target: asset.id,
    diff: {
      after: {
        identity: canonicalIdentity(input),
        revisionId: revision.id,
        sourceAssetId: sourceAsset.id,
        sourceRevisionId: sourceRevision.id,
        licensePolicyReleaseId: licensePolicySource.releaseId,
        licensePolicyReleaseAssetId: licensePolicySource.releaseAssetId,
        defaultSpec: `${input.name}@${input.version}`,
      },
    },
  });

  return snapshotResult(true, asset, revision, payload, provenance);
}

async function validateSnapshotIdentityState(
  tx: PgTransaction,
  assets: AssetRow[],
  sourceAsset: AssetRow,
  licensePolicySource: UpstreamVersionSnapshotLicensePolicySource,
  input: { name: string; version: string },
): Promise<UpstreamVersionSnapshotResult> {
  const published = assets.filter((asset) => asset.lifecycle === "published");
  if (published.length !== 1 || !published[0]) throw snapshotConflict(input);
  const superseded = assets.filter((asset) => asset.id !== published[0]?.id);
  if (superseded.length > 1) throw snapshotConflict(input);
  const snapshot = await validateExistingSnapshot(
    tx,
    published[0],
    sourceAsset,
    licensePolicySource,
    superseded.length === 1,
    input,
  );
  for (const asset of superseded) {
    const supersession = assertExplicitSupersession(asset, snapshot, input);
    await validateLegacyFixtureContents(tx, asset, {
      ...input,
      legacyRevisionId: supersession.legacyRevisionId,
    });
  }
  return snapshot;
}

async function validateLegacyAsset(
  tx: PgTransaction,
  asset: AssetRow,
  input: {
    name: string;
    version: string;
    legacyRevisionId: string;
  },
): Promise<RevisionRow> {
  if (asset.lifecycle !== "published" || asset.visibility !== "platform-public") {
    throw supersessionConflict(input, "legacy asset is not an active platform-public asset");
  }
  return validateLegacyFixtureContents(tx, asset, input);
}

async function validateLegacyFixtureContents(
  tx: PgTransaction,
  asset: AssetRow,
  input: {
    name: string;
    version: string;
    legacyRevisionId: string;
  },
): Promise<RevisionRow> {
  if (
    asset.kind !== "spack-package" ||
    asset.source !== "official-upstream" ||
    asset.name !== input.name ||
    asset.version !== input.version ||
    !asset.trustedForGlobalUse ||
    asset.ownerUserId !== null ||
    asset.ownerOrgId !== null ||
    asset.providerOrgId !== null ||
    asset.officialForkOfAssetId !== null
  ) {
    throw supersessionConflict(input, "legacy asset ownership or identity no longer matches");
  }
  const provenance = LegacyUpstreamProvenanceSchema.safeParse(asset.provenance);
  if (
    !provenance.success ||
    provenance.data.upstreamName !== input.name ||
    provenance.data.upstreamRef !== `v${input.version}`
  ) {
    throw supersessionConflict(input, "legacy provenance does not match the known fixture shape");
  }
  const payload = SoftwareAssetPayloadSchema.safeParse(asset.payload);
  if (
    !payload.success ||
    payload.data.kind !== "spack-package" ||
    payload.data.spack.packageName !== input.name ||
    payload.data.spack.defaultSpec !== `${input.name}@${input.version}`
  ) {
    throw supersessionConflict(input, "legacy payload does not match the exact Spack identity");
  }
  const revisions = await tx
    .select()
    .from(softwareAssetRevisions)
    .where(eq(softwareAssetRevisions.assetId, asset.id))
    .orderBy(asc(softwareAssetRevisions.revision))
    .limit(2);
  const revision = revisions[0];
  if (
    revisions.length !== 1 ||
    !revision ||
    revision.id !== input.legacyRevisionId ||
    revision.revision !== 1 ||
    JSON.stringify(revision.payload) !== JSON.stringify(asset.payload) ||
    JSON.stringify(revision.provenance) !== JSON.stringify(asset.provenance)
  ) {
    throw supersessionConflict(input, "legacy immutable revision does not match");
  }
  const grants = await tx
    .select({ id: softwareAssetGrants.id })
    .from(softwareAssetGrants)
    .where(eq(softwareAssetGrants.assetId, asset.id))
    .limit(1);
  if (grants.length > 0) {
    throw supersessionConflict(input, "legacy asset has grants that require separate revocation");
  }
  return revision;
}

async function validateSupersededLegacyReplay(
  tx: PgTransaction,
  assets: AssetRow[],
  snapshot: UpstreamVersionSnapshotResult,
  input: {
    name: string;
    version: string;
    legacyAssetId: string;
    legacyRevisionId: string;
    reason: string;
  },
): Promise<{ asset: AssetRow; revision: RevisionRow }> {
  const legacy = assets.find((asset) => asset.id === input.legacyAssetId);
  if (!legacy) throw supersessionConflict(input, "legacy asset id does not match");
  const state = parseExplicitSupersession(legacy, input);
  if (
    state.legacyRevisionId !== input.legacyRevisionId ||
    state.replacementAssetId !== snapshot.asset.id ||
    state.replacementRevisionId !== snapshot.revision.id ||
    state.reason !== input.reason
  ) {
    throw supersessionConflict(input, "supersession request does not match the recorded migration");
  }
  const revision = await validateLegacyFixtureContents(tx, legacy, input);
  return { asset: legacy, revision };
}

function assertExplicitSupersession(
  asset: AssetRow,
  snapshot: UpstreamVersionSnapshotResult,
  input: { name: string; version: string },
): z.infer<typeof UpstreamVersionSupersessionSchema> {
  const state = parseExplicitSupersession(asset, input);
  if (
    state.replacementAssetId !== snapshot.asset.id ||
    state.replacementRevisionId !== snapshot.revision.id
  ) {
    throw snapshotConflict(input);
  }
  return state;
}

function parseExplicitSupersession(
  asset: AssetRow,
  input: { name: string; version: string },
): z.infer<typeof UpstreamVersionSupersessionSchema> {
  const parsed = UpstreamVersionSupersededReviewStateSchema.safeParse(asset.reviewState);
  if (
    asset.lifecycle !== "archived" ||
    asset.visibility !== "hidden" ||
    !parsed.success ||
    parsed.data.upstreamVersionSupersession.canonicalIdentity !== canonicalIdentity(input)
  ) {
    throw snapshotConflict(input);
  }
  return parsed.data.upstreamVersionSupersession;
}

async function enqueueAssetProjection(tx: PgTransaction, asset: AssetRow): Promise<void> {
  await tx.insert(authzOutbox).values(
    softwareAssetAuthzProjectionTuples({
      assetId: asset.id,
      lifecycle: asset.lifecycle,
      visibility: asset.visibility,
      trustedForGlobalUse: asset.trustedForGlobalUse,
    }).map((tuple) => ({
      operation: tuple.operation,
      resourceType: tuple.resource.type,
      resourceId: tuple.resource.id,
      relation: tuple.relation,
      subjectType: tuple.subject.type,
      subjectId: tuple.subject.id,
      subjectRelation: tuple.subject.relation ?? null,
      payload: tuple.payload ?? {},
    })),
  );
}

async function validateExistingSnapshot(
  tx: PgTransaction,
  asset: AssetRow,
  sourceAsset: AssetRow,
  licensePolicySource: UpstreamVersionSnapshotLicensePolicySource,
  allowLegacyPolicyFallback: boolean,
  input: { name: string; version: string },
): Promise<UpstreamVersionSnapshotResult> {
  if (
    asset.lifecycle !== "published" ||
    asset.visibility !== "platform-public" ||
    !asset.trustedForGlobalUse ||
    asset.ownerUserId !== null ||
    asset.ownerOrgId !== null ||
    asset.providerOrgId !== null ||
    asset.officialForkOfAssetId !== null
  ) {
    throw snapshotConflict(input);
  }

  const currentProvenance = UpstreamVersionSnapshotProvenanceSchema.safeParse(asset.provenance);
  const legacyProvenance = LegacySnapshotProvenanceSchema.safeParse(asset.provenance);
  const provenance = currentProvenance.success
    ? currentProvenance
    : allowLegacyPolicyFallback
      ? legacyProvenance
      : currentProvenance;
  if (
    !provenance.success ||
    provenance.data.sourceAssetId !== sourceAsset.id ||
    provenance.data.upstreamName !== input.name ||
    provenance.data.upstreamVersion !== input.version ||
    (currentProvenance.success &&
      (currentProvenance.data.licensePolicySource.releaseId !== licensePolicySource.releaseId ||
        currentProvenance.data.licensePolicySource.releaseAssetId !==
          licensePolicySource.releaseAssetId))
  ) {
    throw snapshotConflict(input);
  }

  const sourceRevision = await loadRevisionById(
    tx,
    sourceAsset.id,
    provenance.data.sourceRevisionId,
  );
  if (!sourceRevision || sourceRevision.revision !== provenance.data.sourceRevision) {
    throw snapshotConflict(input);
  }
  const sourcePayload = validateSourceRevision(sourceRevision, input.name, input.version);
  const expectedPayload = snapshotPayload(sourcePayload, input.name, input.version);
  const targetPayload = SoftwareAssetPayloadSchema.safeParse(asset.payload);
  const revisions = await tx
    .select()
    .from(softwareAssetRevisions)
    .where(eq(softwareAssetRevisions.assetId, asset.id))
    .orderBy(asc(softwareAssetRevisions.revision))
    .limit(2);
  const revision = revisions[0];
  const revisionPayload = SoftwareAssetPayloadSchema.safeParse(revision?.payload);
  if (
    revisions.length !== 1 ||
    !revision ||
    revision.revision !== 1 ||
    !targetPayload.success ||
    !revisionPayload.success ||
    JSON.stringify(targetPayload.data) !== JSON.stringify(expectedPayload) ||
    JSON.stringify(revisionPayload.data) !== JSON.stringify(expectedPayload) ||
    JSON.stringify(revision.provenance) !== JSON.stringify(asset.provenance)
  ) {
    throw snapshotConflict(input);
  }

  const [platformGrant] = await tx
    .select()
    .from(softwareAssetGrants)
    .where(
      and(
        eq(softwareAssetGrants.assetId, asset.id),
        eq(softwareAssetGrants.subjectKind, "platform"),
        eq(softwareAssetGrants.subjectId, "platform"),
      ),
    )
    .limit(1);
  if (
    !platformGrant ||
    !["view", "use", "install"].every((capability) =>
      platformGrant.capabilities.includes(capability),
    )
  ) {
    throw snapshotConflict(input);
  }

  return snapshotResult(false, asset, revision, expectedPayload, provenance.data);
}

async function loadSourceAsset(tx: PgTransaction, name: string): Promise<AssetRow> {
  const sourceAsset = await loadUniqueAsset(tx, {
    kind: "spack-package",
    name,
    version: "upstream",
    source: "official-upstream",
  });
  if (!sourceAsset) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      `Official upstream Spack package ${name} not found`,
      404,
    );
  }
  return sourceAsset;
}

async function loadLicensePolicySource(
  tx: PgTransaction,
  input: { name: string; version: string },
): Promise<UpstreamVersionSnapshotLicensePolicySource> {
  const rows = await tx
    .select({
      releaseId: ecosystemReleaseAssets.releaseId,
      releaseAssetId: ecosystemReleaseAssets.id,
      payload: ecosystemReleaseAssets.payload,
      licensePolicy: ecosystemReleaseAssets.licensePolicy,
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
        eq(ecosystemReleaseAssets.kind, "spack-package"),
        eq(ecosystemReleaseAssets.version, input.version),
        sql`${ecosystemReleaseAssets.payload}->'spack'->>'packageName' = ${input.name}`,
        sql`${ecosystemReleaseAssets.payload}->'spack'->>'defaultSpec' = ${`${input.name}@${input.version}`}`,
      ),
    )
    .limit(2);
  const row = rows[0];
  const payload = SoftwareAssetPayloadSchema.safeParse(row?.payload);
  const policy = LicensePolicySchema.safeParse(row?.licensePolicy);
  if (
    rows.length !== 1 ||
    !row ||
    !payload.success ||
    payload.data.kind !== "spack-package" ||
    payload.data.spack.packageName !== input.name ||
    payload.data.spack.defaultSpec !== `${input.name}@${input.version}` ||
    !policy.success
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Versioned upstream snapshot ${canonicalIdentity(input)} requires one exact active reviewed LicensePolicy source`,
      422,
    );
  }
  return { releaseId: row.releaseId, releaseAssetId: row.releaseAssetId };
}

async function loadIdentityAssets(
  tx: PgTransaction,
  identity: { kind: string; name: string; version: string; source: string },
): Promise<AssetRow[]> {
  return tx
    .select()
    .from(softwareAssets)
    .where(
      and(
        eq(softwareAssets.kind, identity.kind),
        eq(softwareAssets.name, identity.name),
        eq(softwareAssets.version, identity.version),
        eq(softwareAssets.source, identity.source),
      ),
    )
    .orderBy(asc(softwareAssets.createdAt))
    .limit(3);
}

async function loadUniqueAsset(
  tx: PgTransaction,
  identity: { kind: string; name: string; version: string; source: string },
): Promise<AssetRow | null> {
  const rows = await tx
    .select()
    .from(softwareAssets)
    .where(
      and(
        eq(softwareAssets.kind, identity.kind),
        eq(softwareAssets.name, identity.name),
        eq(softwareAssets.version, identity.version),
        eq(softwareAssets.source, identity.source),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Software asset identity ${identity.source}/${identity.name}/${identity.version} is not unique`,
      409,
    );
  }
  return rows[0] ?? null;
}

async function loadLatestRevision(tx: PgTransaction, assetId: string): Promise<RevisionRow> {
  const [revision] = await tx
    .select()
    .from(softwareAssetRevisions)
    .where(eq(softwareAssetRevisions.assetId, assetId))
    .orderBy(desc(softwareAssetRevisions.revision))
    .limit(1);
  if (!revision) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Upstream asset has no revision", 422);
  }
  return revision;
}

async function loadRevisionById(
  tx: PgTransaction,
  assetId: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  const [revision] = await tx
    .select()
    .from(softwareAssetRevisions)
    .where(
      and(eq(softwareAssetRevisions.id, revisionId), eq(softwareAssetRevisions.assetId, assetId)),
    )
    .limit(1);
  return revision ?? null;
}

function validateSourceRevision(
  revision: RevisionRow,
  name: string,
  version: string,
): Extract<SoftwareAssetPayload, { kind: "spack-package" }> {
  const parsed = SoftwareAssetPayloadSchema.safeParse(revision.payload);
  if (
    !parsed.success ||
    parsed.data.kind !== "spack-package" ||
    parsed.data.spack.packageName !== name
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Official upstream Spack package ${name} has a malformed source revision`,
      422,
    );
  }
  const versions = parsed.data.spack.metadata.versions;
  if (!Array.isArray(versions) || !versions.some((candidate) => candidate === version)) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Version ${version} is not declared by official upstream Spack package ${name}`,
      422,
    );
  }
  return parsed.data;
}

function snapshotPayload(
  source: Extract<SoftwareAssetPayload, { kind: "spack-package" }>,
  name: string,
  version: string,
): Extract<SoftwareAssetPayload, { kind: "spack-package" }> {
  return {
    kind: "spack-package",
    spack: {
      packageName: name,
      metadata: source.spack.metadata,
      defaultSpec: `${name}@${version}`,
      dependencies: source.spack.dependencies,
      providers: source.spack.providers,
      variants: source.spack.variants,
      ...(source.spack.packageFile ? { packageFile: source.spack.packageFile } : {}),
    },
  };
}

function snapshotProvenance(
  sourceAsset: AssetRow,
  sourceRevision: RevisionRow,
  licensePolicySource: UpstreamVersionSnapshotLicensePolicySource,
  input: { name: string; version: string },
): UpstreamVersionSnapshotProvenance {
  return {
    source: "official-upstream",
    snapshot: "versioned-upstream",
    sourceAssetId: sourceAsset.id,
    sourceRevisionId: sourceRevision.id,
    sourceRevision: sourceRevision.revision,
    upstreamName: input.name,
    upstreamVersion: input.version,
    licensePolicySource,
  };
}

function snapshotResult(
  created: boolean,
  asset: AssetRow,
  revision: RevisionRow,
  payload: SoftwareAssetPayload,
  provenance: Record<string, unknown>,
): UpstreamVersionSnapshotResult {
  return {
    created,
    asset: rowToSummary(asset),
    revision: {
      id: revision.id,
      assetId: revision.assetId,
      revision: revision.revision,
      payload,
      provenance,
      recipeSha256: revision.recipeSha256,
      createdAt: revision.createdAt.toISOString(),
    },
  };
}

function snapshotConflict(input: { name: string; version: string }): AppError {
  return new AppError(
    ErrorCode.VALIDATION_ERROR,
    `Existing software asset official-upstream/${input.name}/${input.version} conflicts with the immutable snapshot contract`,
    409,
  );
}

function supersessionConflict(input: { name: string; version: string }, reason: string): AppError {
  return new AppError(
    ErrorCode.VALIDATION_ERROR,
    `Cannot supersede legacy software asset ${canonicalIdentity(input)}: ${reason}`,
    409,
  );
}

function assertSnapshotRole(principal: RbacPrincipal): void {
  if (principal.role !== "platform_admin" && principal.role !== "super_admin") {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Versioned upstream snapshots require platform_admin+",
      403,
    );
  }
}

function assertSourceAssetActive(asset: AssetRow, name: string): void {
  if (
    asset.lifecycle !== "published" ||
    asset.visibility !== "platform-public" ||
    !asset.trustedForGlobalUse
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Official upstream Spack package ${name} is not an active public source`,
      422,
    );
  }
}

function snapshotLockKey(input: { name: string; version: string }): string {
  return `software-asset:official-upstream:${input.name}:${input.version}`;
}

async function lockSnapshotIdentity(
  tx: PgTransaction,
  input: { name: string; version: string },
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${snapshotLockKey(input)}, 0))`,
  );
}

function targetIdentity(input: { name: string; version: string }) {
  return {
    kind: "spack-package",
    name: input.name,
    version: input.version,
    source: "official-upstream",
  };
}

function canonicalIdentity(input: { name: string; version: string }): string {
  return `official-upstream/${input.name}/${input.version}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uuidOrNull(value: string): string | null {
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}
