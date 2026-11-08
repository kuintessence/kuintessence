import {
  agents,
  auditLog,
  dataAssetManifestEntries,
  dataAssets,
  dataAssetVersions,
  dataLocations,
  federationMediaImportOperations as imports,
  federationDatasetAssets as origins,
  type PgDb,
  type PgTransaction,
  federationDatasetReplicas as replicas,
} from "@kuintessence/db";
import {
  FederationDatasetPublicationSchema,
  FederationError,
  FederationMediaRevocationSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueDataAssetCreation } from "../services/data-market-repository-drizzle";
import { datasetSourceAuthority, verifyDatasetUseLease } from "./dataset-authority";
import type { DatasetUseScope, FederationDatasetUseClient } from "./dataset-use-client";
import type { FederationMediaPackageService } from "./media-packages";
import { type FederationActor, requireFederationCapability } from "./permissions";

type Publication = z.infer<typeof FederationDatasetPublicationSchema>;

export class FederationDatasetPublicationService {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly inventory: FederationMediaPackageService,
    private readonly client: Pick<FederationDatasetUseClient, "request">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async prepared(
    tx: PgTransaction,
    actor: FederationActor,
    packageId: string,
    input: Publication,
  ) {
    await requireFederationCapability(tx, actor, "asset.map");
    const s = await this.inventory.assertImportAuthorized(
      tx,
      actor.orgId,
      packageId,
      input.authorizationId,
    );
    const [operation] = await tx
      .select()
      .from(imports)
      .where(eq(imports.authorizationId, input.authorizationId))
      .for("share");
    if (
      s.package.manifest.subject.kind !== "dataset" ||
      !operation ||
      operation.state !== "verified" ||
      operation.verifiedBytes !== s.package.manifest.files.reduce((n, f) => n + f.sizeBytes, 0)
    )
      throw new FederationError("POLICY_DENIED");
    const scope: DatasetUseScope = {
      senderSiteId: this.siteId,
      recipientSiteId: s.package.senderSiteId,
      policyId: input.sourcePolicyId,
      replicaId: input.replicaId,
      agreementRevisionId: s.package.agreementRevisionId,
      agentId: s.authorization.agentId,
      managedRootId: s.authorization.managedRootId,
      asset: s.package.manifest.subject.asset,
    };
    return { ...s, operation, scope, subject: s.package.manifest.subject };
  }

  async publish(actor: FederationActor, packageId: string, raw: unknown) {
    z.uuid().parse(packageId);
    const input = FederationDatasetPublicationSchema.parse(raw);
    const before = await this.db.transaction((tx) => this.prepared(tx, actor, packageId, input));
    const lease = await this.client.request(before.scope);
    return this.db.transaction(async (tx) => {
      const s = await this.prepared(tx, actor, packageId, input);
      if (s.operation.generation !== before.operation.generation)
        throw new FederationError("OPERATION_CONFLICT");
      const now = this.clock();
      const expires = await verifyDatasetUseLease(tx, s.scope, lease, now);
      // Serialize first publication of an origin, including concurrent versions and retries.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${this.siteId}:${actor.orgId}:${s.scope.asset.originSiteId}:${s.scope.asset.id}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(replicas)
        .where(eq(replicas.replicaId, input.replicaId))
        .for("update");
      if (existing) {
        if (
          existing.authorizationId !== input.authorizationId ||
          existing.sourcePolicyId !== input.sourcePolicyId ||
          existing.publicationName !== input.name ||
          existing.revokedAt ||
          existing.importGeneration !== s.operation.generation
        )
          throw new FederationError("OPERATION_CONFLICT");
        return summary(existing);
      }
      const [bound] = await tx
        .select()
        .from(replicas)
        .where(eq(replicas.authorizationId, input.authorizationId));
      if (bound) throw new FederationError("OPERATION_CONFLICT");
      let [origin] = await tx
        .select()
        .from(origins)
        .where(
          and(
            eq(origins.localSiteId, this.siteId),
            eq(origins.localOrgId, actor.orgId),
            eq(origins.sourceSiteId, s.scope.asset.originSiteId),
            eq(origins.sourceAssetId, s.scope.asset.id),
          ),
        )
        .for("update");
      if (!origin) {
        const assetId = crypto.randomUUID();
        const [createdAsset] = await tx
          .insert(dataAssets)
          .values({
            id: assetId,
            name: input.name,
            ownerKind: "provider",
            providerOrgId: actor.orgId,
            kind: "scientific-dataset",
            lifecycle: "published",
            visibility: "organization",
            accessMode: "request",
            sensitivity: "restricted",
            createdBy: actor.userId,
          })
          .returning();
        if (!createdAsset) throw new FederationError("OPERATION_CONFLICT");
        await enqueueDataAssetCreation(tx, createdAsset);
        [origin] = await tx
          .insert(origins)
          .values({
            assetId,
            localSiteId: this.siteId,
            localOrgId: actor.orgId,
            sourceSiteId: s.scope.asset.originSiteId,
            sourceAssetId: s.scope.asset.id,
          })
          .returning();
      }
      if (!origin) throw new FederationError("OPERATION_CONFLICT");
      const manifest = {
        files: s.package.manifest.files,
        license: s.subject.license ?? null,
        provenance: s.subject.provenance ?? null,
      };
      let [version] = await tx
        .select()
        .from(dataAssetVersions)
        .where(
          and(
            eq(dataAssetVersions.dataAssetId, origin.assetId),
            eq(dataAssetVersions.version, s.scope.asset.revision),
          ),
        )
        .for("update");
      if (version) {
        if (
          version.status !== "ready" ||
          version.manifestDigest !== s.scope.asset.digest ||
          federationCanonicalJson(version.manifest) !== federationCanonicalJson(manifest)
        )
          throw new FederationError("OPERATION_CONFLICT");
      } else {
        [version] = await tx
          .insert(dataAssetVersions)
          .values({
            dataAssetId: origin.assetId,
            version: s.scope.asset.revision,
            status: "ready",
            manifestDigest: s.scope.asset.digest,
            manifest,
            provenance: s.subject.provenance ?? {},
            sizeBytes: s.operation.verifiedBytes,
            immutableAt: now,
            createdBy: actor.userId,
          })
          .returning();
        if (!version) throw new FederationError("OPERATION_CONFLICT");
        const versionId = version.id;
        await tx.insert(dataAssetManifestEntries).values(
          s.package.manifest.files.map((f) => ({
            dataAssetVersionId: versionId,
            entryPath: f.path,
            digest: f.sha256,
            sizeBytes: f.sizeBytes,
            metadata: { license: f.license, provenance: f.provenance },
          })),
        );
      }
      const [agent] = await tx
        .select()
        .from(agents)
        .where(eq(agents.agentId, s.authorization.agentId))
        .for("share");
      if (!agent?.siteId) throw new FederationError("POLICY_DENIED");
      const [location] = await tx
        .insert(dataLocations)
        .values({
          dataAssetVersionId: version.id,
          providerOrgId: actor.orgId,
          siteId: agent.siteId,
          agentId: agent.agentId,
          managedRootId: s.authorization.managedRootId,
          relativePath: `.federation-media/${packageId}/files`,
          kind: "cp-local",
          status: "available",
        })
        .returning();
      if (!location) throw new FederationError("OPERATION_CONFLICT");
      const [replica] = await tx
        .insert(replicas)
        .values({
          replicaId: input.replicaId,
          assetId: origin.assetId,
          versionId: version.id,
          locationId: location.id,
          authorizationId: input.authorizationId,
          importGeneration: s.operation.generation,
          sourcePolicyId: input.sourcePolicyId,
          publicationName: input.name,
          agreementRevisionId: s.scope.agreementRevisionId,
          reference: s.scope.asset,
          lease,
          renewAfter: renewalAt(now, expires),
          publishedBy: actor.userId,
          publishedAt: now,
        })
        .returning();
      if (!replica) throw new FederationError("OPERATION_CONFLICT");
      await this.assertUsable(tx, replica);
      await this.audit(tx, actor, "publish", replica.replicaId, summary(replica));
      return summary(replica);
    });
  }

  async list(actor: FederationActor, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      return (
        await tx
          .select({ replica: replicas })
          .from(replicas)
          .innerJoin(origins, eq(origins.assetId, replicas.assetId))
          .where(and(eq(origins.localSiteId, this.siteId), eq(origins.localOrgId, actor.orgId)))
          .orderBy(asc(replicas.publishedAt), asc(replicas.replicaId))
          .limit(limit)
          .offset(offset)
      ).map((r) => summary(r.replica));
    });
  }

  async revoke(actor: FederationActor, replicaId: string, raw: unknown) {
    z.uuid().parse(replicaId);
    const { reason } = FederationMediaRevocationSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.map");
      const [r] = await tx
        .select({ replica: replicas })
        .from(replicas)
        .innerJoin(origins, eq(origins.assetId, replicas.assetId))
        .where(
          and(
            eq(replicas.replicaId, replicaId),
            eq(origins.localSiteId, this.siteId),
            eq(origins.localOrgId, actor.orgId),
          ),
        )
        .for("update", { of: replicas });
      if (!r) throw new FederationError("POLICY_DENIED");
      if (r.replica.revokedAt) return;
      await tx
        .update(replicas)
        .set({ revokedAt: this.clock(), revocationReason: reason, lease: null, renewToken: null })
        .where(eq(replicas.replicaId, replicaId));
      await this.audit(tx, actor, "revoke", replicaId, { reason });
    });
  }

  async renewNext(): Promise<boolean> {
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ replica: replicas, origin: origins, location: dataLocations })
        .from(replicas)
        .innerJoin(origins, eq(origins.assetId, replicas.assetId))
        .innerJoin(dataLocations, eq(dataLocations.id, replicas.locationId))
        .where(
          and(
            eq(origins.localSiteId, this.siteId),
            isNull(replicas.revokedAt),
            lte(replicas.renewAfter, this.clock()),
          ),
        )
        .orderBy(asc(replicas.renewAfter))
        .limit(1)
        .for("update", { of: replicas, skipLocked: true });
      if (!row) return null;
      const token = crypto.randomUUID();
      await tx
        .update(replicas)
        .set({ renewToken: token, renewAfter: new Date(this.clock().getTime() + 30_000) })
        .where(eq(replicas.replicaId, row.replica.replicaId));
      return { ...row, token };
    });
    if (!claimed) return false;
    const { replica: r, origin, location, token } = claimed;
    try {
      if (!location.agentId || !location.managedRootId) throw new FederationError("POLICY_DENIED");
      const scope: DatasetUseScope = {
        senderSiteId: this.siteId,
        recipientSiteId: origin.sourceSiteId,
        policyId: r.sourcePolicyId,
        replicaId: r.replicaId,
        agreementRevisionId: r.agreementRevisionId,
        asset: r.reference,
        agentId: location.agentId,
        managedRootId: location.managedRootId,
      };
      const lease = await this.client.request(scope);
      await this.db.transaction(async (tx) => {
        const now = this.clock();
        const expires = await verifyDatasetUseLease(tx, scope, lease, now);
        const [updated] = await tx
          .update(replicas)
          .set({ lease, lastError: null, renewToken: null, renewAfter: renewalAt(now, expires) })
          .where(
            and(
              eq(replicas.replicaId, r.replicaId),
              eq(replicas.renewToken, token),
              isNull(replicas.revokedAt),
            ),
          )
          .returning();
        if (updated) await this.assertUsable(tx, updated);
      });
    } catch (error) {
      // Keep the signed lease for its original lifetime on network failure; never extend it locally.
      await this.db
        .update(replicas)
        .set({
          lastError: error instanceof FederationError ? error.code : "RENEWAL_FAILED",
          renewToken: null,
          renewAfter: new Date(this.clock().getTime() + 10_000),
          ...(error instanceof FederationError ? { lease: null } : {}),
        })
        .where(
          and(
            eq(replicas.replicaId, r.replicaId),
            eq(replicas.renewToken, token),
            isNull(replicas.revokedAt),
          ),
        );
    }
    return true;
  }

  private async assertUsable(tx: PgTransaction, r: typeof replicas.$inferSelect) {
    const authority = await datasetSourceAuthority(
      tx,
      { assetId: r.assetId, versionId: r.versionId, locationId: r.locationId },
      this.clock(),
    );
    if (!authority?.allowed) throw new FederationError("POLICY_DENIED");
  }
  private async audit(
    tx: PgTransaction,
    actor: FederationActor,
    action: string,
    id: string,
    after: Record<string, unknown>,
  ) {
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.dataset.${action}`,
      target: id,
      diff: { after },
    });
  }
}
function renewalAt(now: Date, expires: number) {
  return new Date(now.getTime() + Math.max(1, Math.min(20_000, (expires - now.getTime()) / 2)));
}
function summary(row: typeof replicas.$inferSelect) {
  return {
    replicaId: row.replicaId,
    assetId: row.assetId,
    versionId: row.versionId,
    locationId: row.locationId,
    authorizationId: row.authorizationId,
    sourcePolicyId: row.sourcePolicyId,
    publishedAt: row.publishedAt,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
    renewAfter: row.renewAfter,
    lastError: row.lastError,
  };
}
