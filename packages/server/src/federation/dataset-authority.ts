import { createHash } from "node:crypto";
import {
  agents,
  clusterFileRoots,
  dataAssets,
  dataAssetVersions,
  dataLocations,
  federationAgreements,
  federationDatasetAssets,
  federationDatasetReplicas,
  federationMediaImportAuthorizations,
  federationMediaImportOperations,
  federationMediaPackages,
  federationSigningKeys,
  federationSites,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  assertDatasetUseGrant,
  FederationAgreementSchema,
  FederationDatasetUseGrantSchema,
  type FederationDatasetUseLease,
  FederationDatasetUseLeaseSchema,
  type FederationDatasetUseQuery,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "./signatures";

type Db = PgDb | PgTransaction;
export async function isFederationDataset(db: Db, assetId: string) {
  const [row] = await db
    .select({ id: federationDatasetAssets.assetId })
    .from(federationDatasetAssets)
    .where(eq(federationDatasetAssets.assetId, assetId));
  return !!row;
}
export async function verifyDatasetUseLease(
  tx: PgTransaction,
  expected: Omit<
    FederationDatasetUseQuery,
    "protocolVersion" | "kind" | "queryId" | "issuedAt" | "expiresAt"
  >,
  raw: FederationDatasetUseLease,
  now: Date,
) {
  const lease = FederationDatasetUseLeaseSchema.parse(raw),
    query = lease.query;
  if (
    (
      [
        "senderSiteId",
        "recipientSiteId",
        "policyId",
        "replicaId",
        "agreementRevisionId",
        "agentId",
        "managedRootId",
      ] as const
    ).some((k) => query[k] !== expected[k]) ||
    federationCanonicalJson(query.asset) !== federationCanonicalJson(expected.asset)
  )
    throw new FederationError("OPERATION_CONFLICT");
  const queryDigest = `sha256:${createHash("sha256").update(JSON.stringify(query)).digest("hex")}`;
  if (queryDigest !== lease.queryDigest) throw new FederationError("INVALID_MESSAGE");
  const sites = await tx
    .select()
    .from(federationSites)
    .where(inArray(federationSites.id, [query.senderSiteId, query.recipientSiteId]))
    .orderBy(federationSites.id)
    .for("share", { noWait: true });
  if (sites.length !== 2 || sites.some((s) => s.state !== "active"))
    throw new FederationError("UNTRUSTED_IDENTITY");
  const grantKeyId = federationMessageKeyId(lease.signedGrant);
  const keys = await tx
    .select()
    .from(federationSigningKeys)
    .where(
      or(
        and(
          eq(federationSigningKeys.siteId, query.senderSiteId),
          eq(federationSigningKeys.keyId, lease.queryKeyId),
        ),
        and(
          eq(federationSigningKeys.siteId, query.recipientSiteId),
          eq(federationSigningKeys.keyId, grantKeyId),
        ),
      ),
    )
    .orderBy(federationSigningKeys.siteId, federationSigningKeys.keyId)
    .for("share", { noWait: true });
  const source = keys.find((k) => k.siteId === query.recipientSiteId),
    recipient = keys.find((k) => k.siteId === query.senderSiteId);
  if (
    !source ||
    !recipient ||
    recipient.revokedAt ||
    recipient.validFrom > now ||
    recipient.validUntil <= now ||
    recipient.validFrom > new Date(query.issuedAt) ||
    !recipient.allowedKinds.includes("dataset-use-query")
  )
    throw new FederationError("UNTRUSTED_IDENTITY");
  const verified = await verifyFederationMessage(
    FederationDatasetUseGrantSchema,
    lease.signedGrant,
    {
      ...source,
      publicKey: await parseFederationPublicKey(source.publicKeyPem),
      revoked: !!source.revokedAt,
    },
    now,
  );
  assertDatasetUseGrant(query, queryDigest, verified.payload, now);
  return Math.min(
    Date.parse(verified.payload.expiresAt),
    source.validUntil.getTime(),
    recipient.validUntil.getTime(),
  );
}

/** null is local data; a managed dataset always requires a valid source lease, even for owners.
 * NOWAIT avoids lock inversion with publication/revocation when the caller already holds a Job lock.
 */
export async function datasetSourceAuthority(
  db: Db,
  input: { assetId: string; versionId?: string; locationId?: string; orgIds?: string[] },
  now: Date,
) {
  const check = async (tx: PgTransaction) => {
    const [origin] = await tx
      .select()
      .from(federationDatasetAssets)
      .where(eq(federationDatasetAssets.assetId, input.assetId))
      .for("share", { noWait: true });
    if (!origin) return null;
    const denied = { allowed: false, expiresAtUnixMs: 0, locationIds: [] as string[] };
    if (input.orgIds && !input.orgIds.includes(origin.localOrgId)) return denied;
    const rows = await tx
      .select({
        replica: federationDatasetReplicas,
        asset: dataAssets,
        version: dataAssetVersions,
        location: dataLocations,
        root: clusterFileRoots,
        agent: agents,
        agreement: federationAgreements,
        imported: federationMediaImportOperations,
        approval: federationMediaImportAuthorizations,
        inventory: federationMediaPackages,
      })
      .from(federationDatasetReplicas)
      .innerJoin(
        federationMediaImportAuthorizations,
        eq(
          federationMediaImportAuthorizations.authorizationId,
          federationDatasetReplicas.authorizationId,
        ),
      )
      .innerJoin(
        federationMediaImportOperations,
        eq(
          federationMediaImportOperations.authorizationId,
          federationDatasetReplicas.authorizationId,
        ),
      )
      .innerJoin(
        federationMediaPackages,
        and(
          eq(federationMediaPackages.localSiteId, federationMediaImportAuthorizations.localSiteId),
          eq(federationMediaPackages.packageId, federationMediaImportAuthorizations.packageId),
        ),
      )
      .innerJoin(dataAssets, eq(dataAssets.id, federationDatasetReplicas.assetId))
      .innerJoin(
        dataAssetVersions,
        and(
          eq(dataAssetVersions.id, federationDatasetReplicas.versionId),
          eq(dataAssetVersions.dataAssetId, dataAssets.id),
        ),
      )
      .innerJoin(
        dataLocations,
        and(
          eq(dataLocations.id, federationDatasetReplicas.locationId),
          eq(dataLocations.dataAssetVersionId, dataAssetVersions.id),
        ),
      )
      .innerJoin(clusterFileRoots, eq(clusterFileRoots.id, dataLocations.managedRootId))
      .innerJoin(agents, eq(agents.agentId, dataLocations.agentId))
      .innerJoin(
        federationAgreements,
        eq(federationAgreements.revisionId, federationDatasetReplicas.agreementRevisionId),
      )
      .where(
        and(
          eq(federationDatasetReplicas.assetId, input.assetId),
          input.versionId ? eq(federationDatasetReplicas.versionId, input.versionId) : undefined,
          input.locationId ? eq(federationDatasetReplicas.locationId, input.locationId) : undefined,
        ),
      )
      .for("share", { noWait: true });
    const permitted: { id: string; expires: number }[] = [];
    for (const r of rows) {
      if (
        r.replica.revokedAt ||
        !r.replica.lease ||
        r.asset.lifecycle !== "published" ||
        r.asset.providerOrgId !== origin.localOrgId ||
        r.asset.ownerKind !== "provider" ||
        !["restricted", "regulated"].includes(r.asset.sensitivity) ||
        r.version.status !== "ready" ||
        !r.version.immutableAt ||
        !r.version.manifestDigest ||
        !r.root.enabled ||
        r.root.providerOrgId !== origin.localOrgId ||
        r.agent.providerOrgId !== origin.localOrgId ||
        r.root.agentId !== r.agent.agentId ||
        r.location.siteId !== r.agent.siteId ||
        r.location.kind !== "cp-local" ||
        r.location.status !== "available" ||
        r.location.providerOrgId !== origin.localOrgId ||
        r.agreement.state !== "active" ||
        r.agreement.localOrgId !== origin.localOrgId ||
        ![r.agreement.sourceSiteId, r.agreement.targetSiteId].includes(origin.localSiteId) ||
        ![r.agreement.sourceSiteId, r.agreement.targetSiteId].includes(origin.sourceSiteId)
      )
        continue;
      if (
        r.inventory.revokedAt ||
        r.inventory.localOrgId !== origin.localOrgId ||
        r.inventory.localSiteId !== origin.localSiteId ||
        r.inventory.senderSiteId !== origin.sourceSiteId ||
        r.approval.revokedAt ||
        r.imported.state !== "verified" ||
        r.imported.generation !== r.replica.importGeneration ||
        r.inventory.agreementRevisionId !== r.replica.agreementRevisionId ||
        r.inventory.manifest.subject.kind !== "dataset" ||
        federationCanonicalJson(r.inventory.manifest.subject.asset) !==
          federationCanonicalJson(r.replica.reference) ||
        r.imported.verifiedBytes !==
          r.inventory.manifest.files.reduce((n, f) => n + f.sizeBytes, 0) ||
        r.location.agentId !== r.approval.agentId ||
        r.location.managedRootId !== r.approval.managedRootId ||
        r.location.relativePath !== `.federation-media/${r.inventory.packageId}/files`
      )
        continue;
      const reference = r.replica.reference;
      if (
        reference.originSiteId !== origin.sourceSiteId ||
        reference.id !== origin.sourceAssetId ||
        reference.revision !== r.version.version ||
        reference.digest !==
          (r.version.manifestDigest.startsWith("sha256:")
            ? r.version.manifestDigest
            : `sha256:${r.version.manifestDigest}`)
      )
        continue;
      try {
        const terms = FederationAgreementSchema.parse(r.agreement.terms);
        if (
          Date.parse(terms.validFrom) > now.getTime() ||
          Date.parse(terms.validUntil) <= now.getTime()
        )
          continue;
        const expires = await verifyDatasetUseLease(
          tx,
          {
            senderSiteId: origin.localSiteId,
            recipientSiteId: origin.sourceSiteId,
            policyId: r.replica.sourcePolicyId,
            replicaId: r.replica.replicaId,
            agreementRevisionId: r.replica.agreementRevisionId,
            agentId: r.agent.agentId,
            managedRootId: r.root.id,
            asset: reference,
          },
          r.replica.lease,
          now,
        );
        permitted.push({
          id: r.location.id,
          expires: Math.min(expires, Date.parse(terms.validUntil)),
        });
      } catch (error) {
        if (
          !(error instanceof FederationError) &&
          !(error instanceof Error && error.name === "ZodError")
        )
          throw error;
      }
    }
    // Conservative for version-wide checks; dispatch separately narrows to its actual location.
    return permitted.length
      ? {
          allowed: true,
          expiresAtUnixMs: Math.min(...permitted.map((p) => p.expires)),
          locationIds: permitted.map((p) => p.id),
        }
      : denied;
  };
  return "rollback" in db ? check(db) : db.transaction(check);
}
