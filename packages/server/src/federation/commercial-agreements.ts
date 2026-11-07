import { randomUUID } from "node:crypto";
import {
  federationCommercialAgreements as agreements,
  auditLog,
  type PgDb,
  type PgTransaction,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  type CommercialAgreement,
  CommercialAgreementSchema,
  CommercialProposalInputSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, sql } from "drizzle-orm";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Signing commercial terms records business approval; it never grants execution or settles money. */
export class FederationCommercialAgreementService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async list(actor: FederationActor, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      return tx
        .select({
          revisionId: agreements.revisionId,
          digest: agreements.digest,
          approvedBy: agreements.approvedBy,
          createdAt: agreements.createdAt,
          hasCounterpartyApproval: sql<boolean>`${agreements.counterpartyJws} IS NOT NULL`,
        })
        .from(agreements)
        .where(
          and(
            eq(agreements.localSiteId, this.signingKey.siteId),
            eq(agreements.localOrgId, actor.orgId),
          ),
        )
        .orderBy(desc(agreements.createdAt), desc(agreements.revisionId))
        .limit(limit)
        .offset(offset);
    });
  }
  async get(actor: FederationActor, revisionId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      return this.local(tx, actor, revisionId);
    });
  }
  async approve(actor: FederationActor, raw: CommercialAgreement) {
    const terms = CommercialAgreementSchema.parse(raw);
    const { agreement } = terms;
    if (![agreement.sourceSiteId, agreement.targetSiteId].includes(this.signingKey.siteId))
      throw new FederationError("POLICY_DENIED");
    await this.db.transaction((tx) => requireFederationCapability(tx, actor, "agreement.approve"));
    this.validTime(terms);
    const key = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      this.clock(),
    );
    if (!key.allowedKinds.includes("commercial-agreement"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const approvalJws = await signFederationMessage(
      CommercialAgreementSchema,
      terms,
      this.signingKey,
    );
    const { digest } = await verifyFederationMessage(
      CommercialAgreementSchema,
      approvalJws,
      key,
      this.clock(),
    );
    return this.db.transaction(async (tx) => {
      await this.trust.assertKey(tx, key.siteId, key.keyId, this.clock());
      await requireFederationCapability(tx, actor, "agreement.approve");
      this.validTime(terms);
      await this.trust.assertKey(tx, key.siteId, key.keyId, this.clock());
      const [created] = await tx
        .insert(agreements)
        .values({
          localSiteId: key.siteId,
          revisionId: agreement.agreementRevisionId,
          localOrgId: actor.orgId,
          terms,
          digest,
          approvalJws,
          approvedBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const existing = await this.local(tx, actor, agreement.agreementRevisionId);
        if (existing.digest !== digest) throw new FederationError("OPERATION_CONFLICT");
        return existing;
      }
      await this.audit(tx, actor, "approve", created.revisionId, { digest });
      return created;
    });
  }
  async attachCounterparty(actor: FederationActor, revisionId: string, counterpartyJws: string) {
    const local = await this.get(actor, revisionId);
    const terms = CommercialAgreementSchema.parse(local.terms);
    this.validTime(terms);
    const otherSite =
      terms.agreement.sourceSiteId === this.signingKey.siteId
        ? terms.agreement.targetSiteId
        : terms.agreement.sourceSiteId;
    const ownKey = await this.trust.resolveKey(
      this.signingKey.siteId,
      federationMessageKeyId(local.approvalJws),
      this.clock(),
    );
    const otherKey = await this.trust.resolveKey(
      otherSite,
      federationMessageKeyId(counterpartyJws),
      this.clock(),
    );
    for (const [jws, key] of [
      [local.approvalJws, ownKey],
      [counterpartyJws, otherKey],
    ] as const) {
      const verified = await verifyFederationMessage(
        CommercialAgreementSchema,
        jws,
        key,
        this.clock(),
      );
      if (verified.digest !== local.digest) throw new FederationError("OPERATION_CONFLICT");
    }
    return this.db.transaction(async (tx) => {
      const keys = [ownKey, otherKey].sort((a, b) => a.siteId.localeCompare(b.siteId));
      for (const key of keys) await this.trust.assertKey(tx, key.siteId, key.keyId, this.clock());
      await requireFederationCapability(tx, actor, "agreement.approve");
      const current = await this.local(tx, actor, revisionId);
      for (const key of keys) await this.trust.assertKey(tx, key.siteId, key.keyId, this.clock());
      this.validTime(terms);
      if (current.counterpartyJws) {
        if (current.counterpartyJws !== counterpartyJws)
          throw new FederationError("OPERATION_CONFLICT");
        return current;
      }
      const [updated] = await tx
        .update(agreements)
        .set({ counterpartyJws })
        .where(this.key(revisionId))
        .returning();
      if (!updated) throw new FederationError("OPERATION_CONFLICT");
      // Direct cooperation has no ledger dependency or ledger work, including commercial approvals.
      if (terms.agreement.mode !== "bilateral_direct") {
        const localIsSource = terms.agreement.sourceSiteId === this.signingKey.siteId;
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signingKey.siteId,
          agreementRevisionId: revisionId,
          input: CommercialProposalInputSchema.parse({
            operation: "register-agreement",
            domainId: terms.domainId,
            recordId: revisionId,
            digest: local.digest,
            envelope: {
              sourceSiteId: terms.agreement.sourceSiteId,
              targetSiteId: terms.agreement.targetSiteId,
              sourceJws: localIsSource ? local.approvalJws : counterpartyJws,
              targetJws: localIsSource ? counterpartyJws : local.approvalJws,
            },
          }),
        });
      }
      await this.audit(tx, actor, "counterparty", revisionId, { digest: local.digest });
      return updated;
    });
  }
  private key(revisionId: string) {
    return and(
      eq(agreements.localSiteId, this.signingKey.siteId),
      eq(agreements.revisionId, revisionId),
    );
  }
  private async local(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [row] = await tx
      .select()
      .from(agreements)
      .where(and(this.key(revisionId), eq(agreements.localOrgId, actor.orgId)))
      .for("update");
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }
  private validTime(terms: CommercialAgreement) {
    if (Date.parse(terms.agreement.validUntil) <= this.clock().getTime())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    if (Date.parse(terms.createdAt) > this.clock().getTime() + 60000)
      throw new FederationError("INVALID_MESSAGE");
  }
  private async audit(
    tx: PgTransaction,
    actor: FederationActor,
    action: string,
    revisionId: string,
    after: unknown,
  ) {
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.commercial.${action}`,
      target: revisionId,
      diff: { after },
    });
  }
}
