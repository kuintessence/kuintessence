import {
  agents,
  auditLog,
  clusterFileRoots,
  federationAgreements,
  federationMediaImportAuthorizations,
  federationMediaPackages,
  federationSites,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationAgreementSchema,
  FederationError,
  FederationMediaImportApprovalSchema,
  type FederationMediaManifest,
  FederationMediaManifestSchema,
  FederationMediaRegistrationSchema,
  FederationMediaRevocationSchema,
} from "@kuintessence/shared/federation";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Package = typeof federationMediaPackages.$inferSelect;
type Authorization = typeof federationMediaImportAuthorizations.$inferSelect;

/** Inventory and receiver consent. Neither is a source disclosure grant or a published replica. */
export class FederationMediaPackageService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly localSiteId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    z.uuid().parse(localSiteId);
    this.trust = new FederationTrustRegistry(db);
  }

  async register(actor: FederationActor, raw: unknown) {
    const input = FederationMediaRegistrationSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.map");
      const now = this.clock(),
        keyId = federationMessageKeyId(input.signedManifest);
      await this.trust.assertKey(tx, input.senderSiteId, keyId, now);
      const key = await this.trust.resolveKey(input.senderSiteId, keyId, now, tx);
      const { payload: manifest, digest } = await verifyFederationMessage(
        FederationMediaManifestSchema,
        input.signedManifest,
        key,
        now,
      );
      if (
        manifest.senderSiteId !== key.siteId ||
        manifest.recipientSiteId !== this.localSiteId ||
        Date.parse(manifest.createdAt) > now.getTime()
      )
        throw new FederationError("INVALID_MESSAGE");
      await this.agreement(tx, manifest, actor.orgId, false);
      const [created] = await tx
        .insert(federationMediaPackages)
        .values({
          localSiteId: this.localSiteId,
          packageId: manifest.packageId,
          localOrgId: actor.orgId,
          senderSiteId: manifest.senderSiteId,
          agreementRevisionId: manifest.agreementRevisionId,
          manifest,
          manifestDigest: digest,
          manifestJws: input.signedManifest,
          registeredBy: actor.userId,
          registeredAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const existing = await this.package(tx, actor.orgId, manifest.packageId);
        if (existing.manifestDigest !== digest || existing.revokedAt)
          throw new FederationError("OPERATION_CONFLICT");
        return summary(existing);
      }
      await this.audit(tx, actor, "register", manifest.packageId, { manifestDigest: digest });
      return summary(created);
    });
  }

  async list(actor: FederationActor, limit = 50, offset = 0) {
    z.number().int().min(1).max(100).parse(limit);
    z.number().int().nonnegative().parse(offset);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      const t = federationMediaPackages;
      return tx
        .select({
          packageId: t.packageId,
          senderSiteId: t.senderSiteId,
          recipientSiteId: t.localSiteId,
          agreementRevisionId: t.agreementRevisionId,
          manifestDigest: t.manifestDigest,
          subject: sql<FederationMediaManifest["subject"]>`${t.manifest}->'subject'`,
          fileCount: sql`jsonb_array_length(${t.manifest}->'files')`.mapWith(Number),
          sizeBytes:
            sql`(select coalesce(sum((entry->>'sizeBytes')::bigint), 0) from jsonb_array_elements(${t.manifest}->'files') entry)`.mapWith(
              Number,
            ),
          registeredAt: t.registeredAt,
          registeredBy: t.registeredBy,
          revokedAt: t.revokedAt,
          revocationReason: t.revocationReason,
        })
        .from(federationMediaPackages)
        .where(
          and(
            eq(federationMediaPackages.localSiteId, this.localSiteId),
            eq(federationMediaPackages.localOrgId, actor.orgId),
          ),
        )
        .orderBy(
          desc(federationMediaPackages.registeredAt),
          desc(federationMediaPackages.packageId),
        )
        .limit(limit)
        .offset(offset);
    });
  }

  async details(actor: FederationActor, packageId: string, authorizationOffset = 0) {
    z.number().int().nonnegative().parse(authorizationOffset);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      const row = await this.package(tx, actor.orgId, packageId);
      const authorizations = await tx
        .select()
        .from(federationMediaImportAuthorizations)
        .where(
          and(
            eq(federationMediaImportAuthorizations.localSiteId, this.localSiteId),
            eq(federationMediaImportAuthorizations.packageId, packageId),
          ),
        )
        .orderBy(
          desc(federationMediaImportAuthorizations.approvedAt),
          desc(federationMediaImportAuthorizations.authorizationId),
        )
        .limit(101)
        .offset(authorizationOffset);
      return {
        ...summary(row),
        manifest: row.manifest,
        signedManifest: row.manifestJws,
        authorizations: authorizations.slice(0, 100),
        hasMoreAuthorizations: authorizations.length > 100,
      };
    });
  }

  async approveImport(actor: FederationActor, packageId: string, raw: unknown) {
    const input = FederationMediaImportApprovalSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.import");
      const row = await this.package(tx, actor.orgId, packageId);
      const now = this.clock();
      const expiresAt = new Date(input.expiresAt);
      if (
        expiresAt <= now ||
        expiresAt.getTime() > now.getTime() + 7 * 86400_000 ||
        input.maxBytes < totalBytes(row.manifest)
      )
        throw new FederationError("POLICY_DENIED");
      const authorization = {
        ...input,
        localSiteId: this.localSiteId,
        packageId,
        approvedBy: actor.userId,
        approvedAt: now,
        expiresAt,
        revokedAt: null,
        revocationReason: null,
      };
      await this.checkImport(tx, row, authorization);
      const [created] = await tx
        .insert(federationMediaImportAuthorizations)
        .values(authorization)
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const [existing] = await tx
          .select()
          .from(federationMediaImportAuthorizations)
          .where(eq(federationMediaImportAuthorizations.authorizationId, input.authorizationId))
          .for("share");
        if (
          !existing ||
          existing.localSiteId !== this.localSiteId ||
          existing.packageId !== packageId ||
          existing.approvedBy !== actor.userId ||
          existing.agentId !== input.agentId ||
          existing.managedRootId !== input.managedRootId ||
          existing.expiresAt.getTime() !== expiresAt.getTime() ||
          existing.maxBytes !== input.maxBytes ||
          existing.revokedAt
        )
          throw new FederationError("OPERATION_CONFLICT");
        return existing;
      }
      await this.audit(tx, actor, "import_approve", packageId, {
        authorizationId: input.authorizationId,
        agentId: input.agentId,
        managedRootId: input.managedRootId,
        maxBytes: input.maxBytes,
        expiresAt: input.expiresAt,
      });
      return created;
    });
  }

  /** Internal guard for the future key/import worker; callers still need the source's current grant. */
  async assertImportAuthorized(
    tx: PgTransaction,
    orgId: string,
    packageId: string,
    authorizationId: string,
  ) {
    const row = await this.package(tx, orgId, packageId);
    const [authorization] = await tx
      .select()
      .from(federationMediaImportAuthorizations)
      .where(
        and(
          eq(federationMediaImportAuthorizations.authorizationId, authorizationId),
          eq(federationMediaImportAuthorizations.localSiteId, this.localSiteId),
          eq(federationMediaImportAuthorizations.packageId, packageId),
        ),
      )
      .for("share");
    if (!authorization) throw new FederationError("POLICY_DENIED");
    await this.checkImport(tx, row, authorization);
    return { package: row, authorization };
  }

  async revoke(actor: FederationActor, packageId: string, raw: unknown, authorizationId?: string) {
    const { reason } = FederationMediaRevocationSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, authorizationId ? "media.import" : "asset.map");
      const row = await this.package(tx, actor.orgId, packageId);
      const now = this.clock();
      if (authorizationId) {
        const [authorization] = await tx
          .select()
          .from(federationMediaImportAuthorizations)
          .where(
            and(
              eq(federationMediaImportAuthorizations.authorizationId, authorizationId),
              eq(federationMediaImportAuthorizations.localSiteId, this.localSiteId),
              eq(federationMediaImportAuthorizations.packageId, packageId),
            ),
          )
          .for("update");
        if (!authorization) throw new FederationError("POLICY_DENIED");
        if (authorization.revokedAt) return;
        await tx
          .update(federationMediaImportAuthorizations)
          .set({ revokedAt: now, revocationReason: reason })
          .where(eq(federationMediaImportAuthorizations.authorizationId, authorizationId));
      } else {
        if (row.revokedAt) return;
        await tx
          .update(federationMediaPackages)
          .set({ revokedAt: now, revocationReason: reason })
          .where(
            and(
              eq(federationMediaPackages.localSiteId, this.localSiteId),
              eq(federationMediaPackages.packageId, packageId),
            ),
          );
      }
      await this.audit(tx, actor, authorizationId ? "import_revoke" : "revoke", packageId, {
        authorizationId: authorizationId ?? null,
        reason,
      });
    });
  }

  private async package(tx: PgTransaction, orgId: string, packageId: string): Promise<Package> {
    z.uuid().parse(packageId);
    const [row] = await tx
      .select()
      .from(federationMediaPackages)
      .where(
        and(
          eq(federationMediaPackages.localSiteId, this.localSiteId),
          eq(federationMediaPackages.localOrgId, orgId),
          eq(federationMediaPackages.packageId, packageId),
        ),
      )
      .for("update");
    if (!row) throw new FederationError("POLICY_DENIED");
    return row;
  }

  private async checkImport(tx: PgTransaction, row: Package, authorization: Authorization) {
    const now = this.clock();
    if (
      row.revokedAt ||
      authorization.revokedAt ||
      now >= authorization.expiresAt ||
      authorization.maxBytes < totalBytes(row.manifest)
    )
      throw new FederationError("POLICY_DENIED");
    await requireFederationCapability(
      tx,
      { orgId: row.localOrgId, userId: authorization.approvedBy },
      "media.import",
    );
    await this.trust.assertKey(tx, row.senderSiteId, federationMessageKeyId(row.manifestJws), now);
    const key = await this.trust.resolveKey(
      row.senderSiteId,
      federationMessageKeyId(row.manifestJws),
      now,
      tx,
    );
    if (!key.allowedKinds.includes("media-manifest"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    await this.agreement(tx, row.manifest, row.localOrgId, true);
    const [root] = await tx
      .select({ root: clusterFileRoots, agent: agents })
      .from(clusterFileRoots)
      .innerJoin(agents, eq(agents.agentId, clusterFileRoots.agentId))
      .where(
        and(
          eq(clusterFileRoots.id, authorization.managedRootId),
          eq(agents.agentId, authorization.agentId),
        ),
      )
      .for("share", { of: [clusterFileRoots, agents] });
    if (
      !root?.root.enabled ||
      root.root.providerOrgId !== row.localOrgId ||
      root.agent.providerOrgId !== row.localOrgId
    )
      throw new FederationError("POLICY_DENIED");
  }

  private async agreement(
    tx: PgTransaction,
    manifest: FederationMediaManifest,
    orgId: string,
    active: boolean,
  ) {
    const [local] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, this.localSiteId))
      .for("share");
    if (!local || local.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    const [agreement] = await tx
      .select()
      .from(federationAgreements)
      .where(
        and(
          eq(federationAgreements.revisionId, manifest.agreementRevisionId),
          eq(federationAgreements.localOrgId, orgId),
        ),
      )
      .for("share");
    if (
      !agreement ||
      ![agreement.sourceSiteId, agreement.targetSiteId].includes(this.localSiteId) ||
      ![agreement.sourceSiteId, agreement.targetSiteId].includes(manifest.senderSiteId)
    )
      throw new FederationError("POLICY_DENIED");
    const terms = FederationAgreementSchema.parse(agreement.terms);
    if (
      active &&
      (agreement.state !== "active" ||
        this.clock().getTime() < Date.parse(terms.validFrom) ||
        this.clock().getTime() >= Date.parse(terms.validUntil))
    )
      throw new FederationError("POLICY_DENIED");
  }

  private async audit(
    tx: PgTransaction,
    actor: FederationActor,
    action: string,
    packageId: string,
    after: Record<string, unknown>,
  ) {
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.media.${action}`,
      target: packageId,
      diff: { after },
    });
  }
}

function totalBytes(manifest: FederationMediaManifest) {
  return manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}
function summary(row: Package) {
  return {
    packageId: row.packageId,
    senderSiteId: row.senderSiteId,
    recipientSiteId: row.localSiteId,
    agreementRevisionId: row.agreementRevisionId,
    manifestDigest: row.manifestDigest,
    subject: row.manifest.subject,
    fileCount: row.manifest.files.length,
    sizeBytes: totalBytes(row.manifest),
    registeredAt: row.registeredAt,
    registeredBy: row.registeredBy,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
  };
}
