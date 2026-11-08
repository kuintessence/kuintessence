import {
  auditLog,
  dataAccessPolicies,
  federationSites,
  type PgDb,
  type PgTransaction,
  federationDatasetUsePolicies as policies,
} from "@kuintessence/db";
import { AppError, ErrorCode, Role } from "@kuintessence/shared";
import {
  FederationAssetRefSchema,
  type FederationDatasetUseApproval,
  FederationDatasetUseApprovalSchema,
  type FederationDatasetUseQuery,
  FederationError,
  FederationMediaRevocationSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { evaluateActiveDataAccess } from "../services/data-access-decision";
import type { DataMarketActor } from "../services/data-market";
import { requiresActiveEntitlementUse } from "../services/data-prerequisite-repository-drizzle";
import { readDataVersionCustody } from "../services/data-version-custody";
import { requireMediaAgreement } from "./media-agreement";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { FederationTrustRegistry } from "./trust-registry";

type Policy = typeof policies.$inferSelect;
/** Source-owned use approval. Import, disclosure, local ownership and mapping never imply it. */
export class FederationDatasetUsePolicies {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    readonly siteId: string,
    private readonly authorizeManage: (actor: DataMarketActor, assetId: string) => Promise<void>,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async approve(actor: FederationActor, raw: unknown) {
    const input = FederationDatasetUseApprovalSchema.parse(raw);
    await this.authorize(actor, input.versionId);
    return this.db.transaction(async (tx) => {
      const data = await this.current(tx, actor, input);
      const now = this.clock();
      const [created] = await tx
        .insert(policies)
        .values({
          ...input,
          localSiteId: this.siteId,
          localOrgId: actor.orgId,
          asset: data.asset,
          approvedBy: actor.userId,
          approvedAt: now,
          expiresAt: new Date(input.expiresAt),
        })
        .onConflictDoNothing()
        .returning();
      const row = created ?? (await this.find(tx, input.policyId));
      if (
        !row ||
        row.revokedAt ||
        row.localOrgId !== actor.orgId ||
        row.approvedBy !== actor.userId ||
        federationCanonicalJson(this.request(row)) !== federationCanonicalJson(input) ||
        federationCanonicalJson(row.asset) !== federationCanonicalJson(data.asset)
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (created)
        await this.audit(tx, actor, "approve", input.policyId, { ...input, asset: data.asset });
      return row;
    });
  }
  async list(actor: FederationActor, limit: number, offset: number) {
    z.number().int().min(1).max(100).parse(limit);
    z.number().int().nonnegative().parse(offset);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      return tx
        .select()
        .from(policies)
        .where(and(eq(policies.localSiteId, this.siteId), eq(policies.localOrgId, actor.orgId)))
        .orderBy(desc(policies.approvedAt), desc(policies.policyId))
        .limit(limit)
        .offset(offset);
    });
  }
  async revoke(actor: FederationActor, policyId: string, raw: unknown) {
    z.uuid().parse(policyId);
    const { reason } = FederationMediaRevocationSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "dataset.use.approve");
      const row = await this.find(tx, policyId, true);
      if (!row || row.localOrgId !== actor.orgId) throw new FederationError("POLICY_DENIED");
      // Revocation remains possible after an asset is withdrawn or its former custodian leaves.
      if (row.revokedAt) return;
      await tx
        .update(policies)
        .set({ revokedAt: this.clock(), revocationReason: reason })
        .where(and(eq(policies.localSiteId, this.siteId), eq(policies.policyId, policyId)));
      await this.audit(tx, actor, "revoke", policyId, { reason });
    });
  }
  async preflight(query: FederationDatasetUseQuery) {
    const [row] = await this.db
      .select()
      .from(policies)
      .where(and(eq(policies.localSiteId, this.siteId), eq(policies.policyId, query.policyId)));
    if (
      !row ||
      row.recipientSiteId !== query.senderSiteId ||
      query.recipientSiteId !== this.siteId ||
      row.agreementRevisionId !== query.agreementRevisionId ||
      federationCanonicalJson(row.asset) !== federationCanonicalJson(query.asset) ||
      row.revokedAt ||
      row.expiresAt <= this.clock()
    )
      throw new FederationError("POLICY_DENIED");
    await this.authorize({ orgId: row.localOrgId, userId: row.approvedBy }, row.versionId);
  }
  async assertQuery(tx: PgTransaction, query: FederationDatasetUseQuery) {
    const row = await this.find(tx, query.policyId);
    if (
      !row ||
      row.revokedAt ||
      row.recipientSiteId !== query.senderSiteId ||
      query.recipientSiteId !== this.siteId ||
      row.agreementRevisionId !== query.agreementRevisionId ||
      federationCanonicalJson(row.asset) !== federationCanonicalJson(query.asset)
    )
      throw new FederationError("POLICY_DENIED");
    const current = await this.current(
      tx,
      { orgId: row.localOrgId, userId: row.approvedBy },
      this.request(row),
    );
    if (federationCanonicalJson(current.asset) !== federationCanonicalJson(row.asset))
      throw new FederationError("OPERATION_CONFLICT");
    return {
      policy: row,
      expiresAt: new Date(Math.min(row.expiresAt.getTime(), current.expiresAt)),
    };
  }
  private async authorize(actor: FederationActor, versionId: string) {
    const data = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "dataset.use.approve");
      return this.custody(tx, actor, versionId);
    });
    const manages =
      ["owner", "admin"].includes(data.member.membership.role) ||
      ["org_admin", "platform_admin", "super_admin"].includes(data.member.user.role);
    await this.authorizeManage(
      {
        ...actor,
        orgIds: [actor.orgId],
        role: z.enum(Role).parse(data.member.user.role),
        providerManagerOrgIds: manages ? [actor.orgId] : [],
      },
      data.asset.id,
    );
  }
  private async custody(tx: PgTransaction, actor: FederationActor, versionId: string) {
    try {
      return await readDataVersionCustody(tx, actor, versionId, false);
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.FORBIDDEN)
        throw new FederationError("POLICY_DENIED");
      throw error;
    }
  }
  private async current(
    tx: PgTransaction,
    actor: FederationActor,
    input: FederationDatasetUseApproval,
  ) {
    await requireFederationCapability(tx, actor, "dataset.use.approve");
    const now = this.clock();
    if (input.recipientSiteId === this.siteId || Date.parse(input.expiresAt) <= now.getTime())
      throw new FederationError("POLICY_DENIED");
    const sites = await tx
      .select()
      .from(federationSites)
      .where(or(eq(federationSites.id, this.siteId), eq(federationSites.id, input.recipientSiteId)))
      .orderBy(federationSites.id)
      .for("share");
    if (sites.length !== 2 || sites.some((s) => s.state !== "active"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const terms = await requireMediaAgreement(
      tx,
      this.trust,
      { siteId: this.siteId, orgId: actor.orgId, ...input },
      now,
    );
    if (Date.parse(terms.validUntil) < Date.parse(input.expiresAt))
      throw new FederationError("POLICY_DENIED");
    const data = await this.custody(tx, actor, input.versionId);
    if (
      data.asset.lifecycle !== "published" ||
      data.version.status !== "ready" ||
      !data.version.immutableAt ||
      !data.version.manifestDigest
    )
      throw new FederationError("POLICY_DENIED");
    let entitlementExpiresAt = Number.POSITIVE_INFINITY;
    if (requiresActiveEntitlementUse(data.asset.kind, data.asset.accessMode)) {
      const authorization = await evaluateActiveDataAccess(tx, {
        assetId: data.asset.id,
        versionId: input.versionId,
        actorUserId: actor.userId,
        orgIds: [actor.orgId],
        capability: "use",
        now,
      });
      if (!authorization.allowed) throw new FederationError("POLICY_DENIED");
      entitlementExpiresAt = authorization.expiresAtUnixMs;
    }
    const restrictions = await tx
      .select()
      .from(dataAccessPolicies)
      .where(
        and(
          eq(dataAccessPolicies.dataAssetId, data.asset.id),
          eq(dataAccessPolicies.status, "active"),
          eq(dataAccessPolicies.effect, "deny"),
          or(
            isNull(dataAccessPolicies.dataAssetVersionId),
            eq(dataAccessPolicies.dataAssetVersionId, input.versionId),
          ),
          or(
            and(
              eq(dataAccessPolicies.subjectKind, "user"),
              eq(dataAccessPolicies.subjectId, actor.userId),
            ),
            and(
              or(
                eq(dataAccessPolicies.subjectKind, "org"),
                eq(dataAccessPolicies.subjectKind, "provider-org"),
              ),
              eq(dataAccessPolicies.subjectId, actor.orgId),
            ),
            eq(dataAccessPolicies.subjectKind, "platform"),
          ),
        ),
      )
      .orderBy(dataAccessPolicies.id)
      .for("share");
    if (
      restrictions.some(
        (p) =>
          (!p.expiresAt || p.expiresAt > now) &&
          p.capabilities.some((c) => ["use", "download", "derive", "manage"].includes(c)),
      )
    )
      throw new FederationError("POLICY_DENIED");
    const digest = data.version.manifestDigest;
    return {
      asset: FederationAssetRefSchema.parse({
        originSiteId: this.siteId,
        kind: "dataset",
        id: data.asset.id,
        revision: data.version.version,
        digest: digest.startsWith("sha256:") ? digest : `sha256:${digest}`,
      }),
      expiresAt: Math.min(Date.parse(terms.validUntil), entitlementExpiresAt),
    };
  }
  private async find(tx: PgTransaction, policyId: string, write = false) {
    const [row] = await tx
      .select()
      .from(policies)
      .where(and(eq(policies.localSiteId, this.siteId), eq(policies.policyId, policyId)))
      .for(write ? "update" : "share");
    return row;
  }
  private request(row: Policy): FederationDatasetUseApproval {
    return {
      policyId: row.policyId,
      versionId: row.versionId,
      recipientSiteId: row.recipientSiteId,
      agreementRevisionId: row.agreementRevisionId,
      expiresAt: row.expiresAt.toISOString(),
      reason: row.reason,
    };
  }
  private async audit(
    tx: PgTransaction,
    actor: FederationActor,
    action: string,
    policyId: string,
    after: Record<string, unknown>,
  ) {
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.dataset_use.${action}`,
      target: policyId,
      diff: { after },
    });
  }
}
