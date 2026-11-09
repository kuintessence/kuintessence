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
import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import type {
  FederationTaskMediaTargets,
  TaskMediaTarget,
  TaskMediaTargetReader,
} from "./task-media-target";
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
    private readonly targets?: FederationTaskMediaTargets,
  ) {
    z.uuid().parse(localSiteId);
    this.trust = new FederationTrustRegistry(db);
  }

  async register(actor: FederationActor, raw: unknown) {
    const input = FederationMediaRegistrationSchema.parse(raw);
    const { manifest, digest } = await this.db.transaction(async (tx) => {
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
      return { manifest, digest };
    });
    const read =
      manifest.subject.kind === "dataset" ? undefined : await this.taskReader(actor, manifest);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.map");
      await this.manifestKey(tx, manifest.senderSiteId, input.signedManifest);
      const target = read ? await read(tx) : undefined;
      if (!target) await this.agreement(tx, manifest, actor.orgId, false);
      else if (target.authorizedUntil <= this.clock().getTime())
        throw new FederationError("AUTHORIZATION_EXPIRED");
      const now = this.clock();
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
          taskInputImportId: target?.taskInputImportId ?? null,
          taskResultImportId: target?.taskResultImportId ?? null,
          registeredBy: actor.userId,
          registeredAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const existing = await this.package(tx, actor.orgId, manifest.packageId);
        this.human(existing, actor);
        if (
          existing.manifestDigest !== digest ||
          existing.revokedAt ||
          existing.taskInputImportId !== (target?.taskInputImportId ?? null) ||
          existing.taskResultImportId !== (target?.taskResultImportId ?? null)
        )
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
            or(
              sql`${t.manifest}->'subject'->>'kind' = 'dataset'`,
              eq(t.registeredBy, actor.userId),
            ),
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
      this.human(row, actor);
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
    const reader = await this.reader(packageId, { actor });
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.import");
      const target = reader ? await reader(tx) : undefined;
      const row = await this.package(tx, actor.orgId, packageId);
      this.human(row, actor);
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
      await this.checkImport(tx, row, authorization, target);
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
    reader?: TaskMediaTargetReader,
  ) {
    const target = reader ? await reader(tx) : undefined;
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
    const authorizedUntil = await this.checkImport(tx, row, authorization, target);
    return { package: row, authorization, authorizedUntil };
  }

  async revoke(actor: FederationActor, packageId: string, raw: unknown, authorizationId?: string) {
    const { reason } = FederationMediaRevocationSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, authorizationId ? "media.import" : "asset.map");
      const row = await this.package(tx, actor.orgId, packageId);
      this.human(row, actor);
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

  async reader(
    packageId: string,
    selector:
      | { actor: FederationActor }
      | { orgId: string; agentId: string; authorizationId: string },
  ): Promise<TaskMediaTargetReader | undefined> {
    const selected = await this.db.transaction(async (tx) => {
      const orgId = "actor" in selector ? selector.actor.orgId : selector.orgId;
      const row = await this.package(tx, orgId, packageId);
      let actor: FederationActor;
      if ("actor" in selector) actor = selector.actor;
      else {
        const [authorization] = await tx
          .select()
          .from(federationMediaImportAuthorizations)
          .where(
            and(
              eq(federationMediaImportAuthorizations.authorizationId, selector.authorizationId),
              eq(federationMediaImportAuthorizations.localSiteId, this.localSiteId),
              eq(federationMediaImportAuthorizations.packageId, packageId),
              eq(federationMediaImportAuthorizations.agentId, selector.agentId),
            ),
          );
        if (!authorization) throw new FederationError("POLICY_DENIED");
        actor = { orgId, userId: authorization.approvedBy };
      }
      await requireFederationCapability(tx, actor, "media.import");
      this.human(row, actor);
      return { row, actor };
    });
    if (selected.row.manifest.subject.kind === "dataset") return undefined;
    const read = await this.taskReader(selected.actor, selected.row.manifest);
    return async (tx) => {
      const target = await read(tx);
      if (
        target.taskInputImportId !== selected.row.taskInputImportId ||
        target.taskResultImportId !== selected.row.taskResultImportId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return target;
    };
  }

  private taskReader(actor: FederationActor, manifest: FederationMediaManifest) {
    if (!this.targets) throw new FederationError("POLICY_DENIED");
    return this.targets.authorize(actor, manifest);
  }
  private human(row: Package, actor: FederationActor) {
    if (row.manifest.subject.kind !== "dataset" && row.registeredBy !== actor.userId)
      throw new FederationError("POLICY_DENIED");
  }
  private async manifestKey(tx: PgTransaction, senderSiteId: string, jws: string) {
    const keyId = federationMessageKeyId(jws);
    await this.trust.assertKey(tx, senderSiteId, keyId, this.clock());
    const key = await this.trust.resolveKey(senderSiteId, keyId, this.clock(), tx);
    if (!key.allowedKinds.includes("media-manifest"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    return key;
  }

  private async checkImport(
    tx: PgTransaction,
    row: Package,
    authorization: Authorization,
    target?: TaskMediaTarget,
  ) {
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
    this.human(row, { orgId: row.localOrgId, userId: authorization.approvedBy });
    const key = await this.manifestKey(tx, row.senderSiteId, row.manifestJws);
    const signed = await verifyFederationMessage(
      FederationMediaManifestSchema,
      row.manifestJws,
      key,
      now,
    );
    if (
      signed.digest !== row.manifestDigest ||
      federationMaterialDigest(row.manifest) !== federationMaterialDigest(signed.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    let authorizedUntil = Math.min(authorization.expiresAt.getTime(), key.validUntil.getTime());
    if (row.manifest.subject.kind === "dataset")
      await this.agreement(tx, row.manifest, row.localOrgId, true);
    else {
      if (!target) throw new FederationError("POLICY_DENIED");
      if (
        target.manifestContentDigest !== federationMaterialDigest(row.manifest) ||
        target.taskInputImportId !== row.taskInputImportId ||
        target.taskResultImportId !== row.taskResultImportId
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (authorization.expiresAt.getTime() > target.validUntil)
        throw new FederationError("POLICY_DENIED");
      authorizedUntil = Math.min(authorizedUntil, target.authorizedUntil);
    }
    if (authorizedUntil <= this.clock().getTime())
      throw new FederationError("AUTHORIZATION_EXPIRED");
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
    if (authorizedUntil <= this.clock().getTime())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    return authorizedUntil;
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
