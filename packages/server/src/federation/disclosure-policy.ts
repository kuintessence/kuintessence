import { randomBytes } from "node:crypto";
import {
  auditLog,
  federationCommercialAgreements as contracts,
  federationSites,
  type PgDb,
  type PgTransaction,
  federationDisclosurePolicies as policies,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import {
  type CommercialDisclosurePolicy,
  CommercialDisclosurePolicyDraftSchema,
  CommercialDisclosurePolicySchema,
} from "@kuintessence/shared/federation/disclosure-authorization";
import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Independent field-read consent; no accounting, execution or ledger writes. */
export class FederationDisclosurePolicyService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(actor: FederationActor, revisionId: string, policyId: string) {
    return and(
      eq(policies.localSiteId, this.signing.siteId),
      eq(policies.localOrgId, actor.orgId),
      eq(policies.agreementRevisionId, revisionId),
      eq(policies.policyId, policyId),
    );
  }
  private async contract(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [row] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.localOrgId, actor.orgId),
          eq(contracts.revisionId, revisionId),
        ),
      )
      .for("share");
    if (!row?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }
  private async verify<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
  ) {
    const keyId = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, siteId, keyId, now);
    return verifyFederationMessage(
      schema,
      jws,
      await this.trust.resolveKey(siteId, keyId, now, tx),
      now,
    );
  }
  private async original(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const row = await this.contract(tx, actor, revisionId);
    const { sourceSiteId, targetSiteId } = row.terms.agreement;
    if (![sourceSiteId, targetSiteId].includes(this.signing.siteId))
      throw new FederationError("POLICY_DENIED");
    const other = sourceSiteId === this.signing.siteId ? targetSiteId : sourceSiteId;
    const originals = [
      [this.signing.siteId, row.approvalJws],
      [other, row.counterpartyJws],
    ];
    for (const [siteId, jws] of originals.sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
      if (!siteId || !jws) throw new FederationError("INVALID_MESSAGE");
      const verified = await this.verify(tx, CommercialAgreementSchema, jws, siteId);
      if (
        verified.digest !== row.digest ||
        federationCanonicalJson(verified.payload) !== federationCanonicalJson(row.terms)
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    return { row, other };
  }
  private async recipient(
    tx: PgTransaction,
    recipientSiteId: string,
    source: string,
    target: string,
  ) {
    if ([source, target].includes(recipientSiteId)) throw new FederationError("POLICY_DENIED");
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, recipientSiteId))
      .for("share");
    if (site?.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
  }
  private check(value: CommercialDisclosurePolicy, contract: typeof contracts.$inferSelect) {
    const { sourceSiteId, targetSiteId, agreementRevisionId } = contract.terms.agreement;
    const now = Date.now();
    if (Date.parse(value.issuedAt) > now || Date.parse(value.validUntil) <= now)
      throw new FederationError("AUTHORIZATION_EXPIRED");
    if (
      value.agreementRevisionId !== agreementRevisionId ||
      value.agreementDigest !== contract.digest ||
      value.domainId !== contract.terms.domainId ||
      value.sourceSiteId !== sourceSiteId ||
      value.targetSiteId !== targetSiteId ||
      Date.parse(value.issuedAt) < Date.parse(contract.terms.createdAt)
    )
      throw new FederationError("POLICY_DENIED");
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    raw: z.infer<typeof CommercialDisclosurePolicyDraftSchema>,
  ) {
    const input = CommercialDisclosurePolicyDraftSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const { row } = await this.original(tx, actor, revisionId);
      const { sourceSiteId, targetSiteId } = row.terms.agreement;
      await this.recipient(tx, input.recipientSiteId, sourceSiteId, targetSiteId);
      const now = new Date().toISOString();
      if (Date.parse(input.validUntil) <= Date.parse(now))
        throw new FederationError("AUTHORIZATION_EXPIRED");
      return CommercialDisclosurePolicySchema.parse({
        ...input,
        protocolVersion: 1,
        kind: "commercial-disclosure-policy",
        domainId: row.terms.domainId,
        agreementRevisionId: revisionId,
        agreementDigest: row.digest,
        sourceSiteId,
        targetSiteId,
        issuedAt: now,
        validFrom: now,
        salt: randomBytes(32).toString("hex"),
      });
    });
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialDisclosurePolicy) {
    const value = CommercialDisclosurePolicySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.approve");
      const { row: contract } = await this.original(tx, actor, revisionId);
      this.check(value, contract);
      await this.recipient(tx, value.recipientSiteId, value.sourceSiteId, value.targetSiteId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`disclosure-policy:${this.signing.siteId}:${value.policyId}`}, 0))`,
      );
      const [prior] = await tx
        .select()
        .from(policies)
        .where(
          and(eq(policies.localSiteId, this.signing.siteId), eq(policies.policyId, value.policyId)),
        )
        .for("share");
      if (prior) {
        if (
          prior.localOrgId !== actor.orgId ||
          prior.agreementRevisionId !== revisionId ||
          federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        if (prior.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
        const signed = await this.verify(
          tx,
          CommercialDisclosurePolicySchema,
          prior.approvalJws,
          this.signing.siteId,
        );
        if (signed.digest !== prior.digest) throw new FederationError("OPERATION_CONFLICT");
        return prior;
      }
      const jws = await signFederationMessage(
        CommercialDisclosurePolicySchema,
        value,
        this.signing,
      );
      const signed = await this.verify(
        tx,
        CommercialDisclosurePolicySchema,
        jws,
        this.signing.siteId,
      );
      this.check(value, contract);
      const [row] = await tx
        .insert(policies)
        .values({
          localSiteId: this.signing.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          policyId: value.policyId,
          recipientSiteId: value.recipientSiteId,
          payload: value,
          digest: signed.digest,
          approvalJws: jws,
          approvedBy: actor.userId,
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.disclosure_policy.approve",
        target: value.policyId,
        diff: { after: { digest: row.digest, recipientSiteId: value.recipientSiteId } },
      });
      return row;
    });
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    policyId: string,
    jws: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.approve");
      const { row: contract, other } = await this.original(tx, actor, revisionId);
      const [row] = await tx
        .select()
        .from(policies)
        .where(this.key(actor, revisionId, policyId))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
      this.check(row.payload, contract);
      await this.recipient(
        tx,
        row.recipientSiteId,
        row.payload.sourceSiteId,
        row.payload.targetSiteId,
      );
      const own = await this.verify(
        tx,
        CommercialDisclosurePolicySchema,
        row.approvalJws,
        this.signing.siteId,
      );
      const peer = await this.verify(tx, CommercialDisclosurePolicySchema, jws, other);
      if (
        own.digest !== row.digest ||
        peer.digest !== row.digest ||
        federationCanonicalJson(own.payload) !== federationCanonicalJson(row.payload)
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (row.counterpartyJws) {
        if (row.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        return row;
      }
      this.check(row.payload, contract);
      const [saved] = await tx
        .update(policies)
        .set({ counterpartyJws: jws, confirmedAt: new Date() })
        .where(this.key(actor, revisionId, policyId))
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.disclosure_policy.confirm",
        target: policyId,
        diff: { after: { digest: row.digest } },
      });
      return saved;
    });
  }
  async revoke(actor: FederationActor, revisionId: string, policyId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.approve");
      const [row] = await tx
        .select()
        .from(policies)
        .where(this.key(actor, revisionId, policyId))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.revokedAt) return row;
      const [saved] = await tx
        .update(policies)
        .set({ revokedAt: new Date(), revokedBy: actor.userId })
        .where(this.key(actor, revisionId, policyId))
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.disclosure_policy.revoke",
        target: policyId,
        diff: { after: { digest: row.digest } },
      });
      return saved;
    });
  }
  async list(
    actor: FederationActor,
    revisionId: string,
    limit = 50,
    offset = 0,
    policyId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor, revisionId);
      const rows = await tx
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.localSiteId, this.signing.siteId),
            eq(policies.localOrgId, actor.orgId),
            eq(policies.agreementRevisionId, revisionId),
            policyId ? eq(policies.policyId, policyId) : undefined,
          ),
        )
        .orderBy(desc(policies.createdAt), desc(policies.policyId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
