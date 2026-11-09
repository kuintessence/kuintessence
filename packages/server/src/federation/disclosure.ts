import { randomBytes } from "node:crypto";
import {
  auditLog,
  federationDisclosures as disclosures,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type CommercialDisclosure,
  CommercialDisclosureDraftSchema,
  CommercialDisclosureGrantSchema,
  CommercialDisclosureSchema,
  projectCommercialEvidence,
} from "@kuintessence/shared/federation/disclosure";
import { assertCommercialDisclosurePolicy } from "@kuintessence/shared/federation/disclosure-authorization";
import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { FederationDisclosurePolicyService } from "./disclosure-policy";
import { FederationDisputeService } from "./disputes";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Institutional consent to exact evidence bytes; delivery and current remote revocation are separate. */
export class FederationDisclosureService {
  private readonly policies: FederationDisclosurePolicyService;
  private readonly disputes: FederationDisputeService;
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.policies = new FederationDisclosurePolicyService(db, signing);
    this.disputes = new FederationDisputeService(db, signing);
    this.trust = new FederationTrustRegistry(db);
  }
  private key(actor: FederationActor, revisionId: string, grantId: string) {
    return and(
      eq(disclosures.localSiteId, this.signing.siteId),
      eq(disclosures.localOrgId, actor.orgId),
      eq(disclosures.agreementRevisionId, revisionId),
      eq(disclosures.grantId, grantId),
    );
  }
  private async verify(tx: PgTransaction, jws: string, siteId: string) {
    const keyId = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, siteId, keyId, now);
    return verifyFederationMessage(
      CommercialDisclosureSchema,
      jws,
      await this.trust.resolveKey(siteId, keyId, now, tx),
      now,
    );
  }
  private async validate(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    value: CommercialDisclosure,
  ) {
    const policy = await this.policies.verified(tx, actor, revisionId, value.grant.policyId);
    assertCommercialDisclosurePolicy(
      value.grant,
      policy.row.payload,
      policy.row.digest,
      new Date(),
    );
    const original = await this.disputes.disclosureOriginal(tx, actor, revisionId, value.grant);
    const expected = projectCommercialEvidence(
      value.grant,
      original,
      policy.row.recipientSiteId,
      new Date(),
    );
    if (federationCanonicalJson(expected) !== federationCanonicalJson(value))
      throw new FederationError("OPERATION_CONFLICT");
    return policy;
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    raw: z.infer<typeof CommercialDisclosureDraftSchema>,
  ) {
    const input = CommercialDisclosureDraftSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.approve");
      const { row: policy } = await this.policies.verified(tx, actor, revisionId, input.policyId);
      const grant = CommercialDisclosureGrantSchema.parse({
        ...input,
        protocolVersion: 1,
        kind: "commercial-disclosure-grant",
        domainId: policy.payload.domainId,
        agreementRevisionId: revisionId,
        sourceSiteId: policy.payload.sourceSiteId,
        targetSiteId: policy.payload.targetSiteId,
        recipientSiteId: policy.recipientSiteId,
        policyDigest: policy.digest,
        validFrom: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      assertCommercialDisclosurePolicy(grant, policy.payload, policy.digest, new Date());
      const original = await this.disputes.disclosureOriginal(tx, actor, revisionId, grant);
      return projectCommercialEvidence(grant, original, policy.recipientSiteId, new Date());
    });
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialDisclosure) {
    const value = CommercialDisclosureSchema.parse(raw),
      g = value.grant;
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.approve");
      const { other } = await this.validate(tx, actor, revisionId, value);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`disclosure:${this.signing.siteId}:${g.grantId}`}, 0))`,
      );
      const [prior] = await tx
        .select()
        .from(disclosures)
        .where(
          and(eq(disclosures.localSiteId, this.signing.siteId), eq(disclosures.grantId, g.grantId)),
        )
        .for("update");
      if (prior) {
        if (
          prior.localOrgId !== actor.orgId ||
          prior.agreementRevisionId !== revisionId ||
          federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        if (prior.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
        await this.saved(tx, prior, other);
        await this.validate(tx, actor, revisionId, value);
        return prior;
      }
      const jws = await signFederationMessage(CommercialDisclosureSchema, value, this.signing);
      const signed = await this.verify(tx, jws, this.signing.siteId);
      await this.validate(tx, actor, revisionId, value);
      const [row] = await tx
        .insert(disclosures)
        .values({
          localSiteId: this.signing.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          grantId: g.grantId,
          caseId: g.caseId,
          policyId: g.policyId,
          recipientSiteId: g.recipientSiteId,
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
        action: "federation.disclosure.approve",
        target: g.grantId,
        diff: {
          after: {
            digest: row.digest,
            caseId: g.caseId,
            policyId: g.policyId,
            recipientSiteId: g.recipientSiteId,
            recordType: g.recordType,
            fields: g.fields,
          },
        },
      });
      return row;
    });
  }
  private async saved(tx: PgTransaction, row: typeof disclosures.$inferSelect, other: string) {
    const own = await this.verify(tx, row.approvalJws, this.signing.siteId);
    if (
      own.digest !== row.digest ||
      federationCanonicalJson(own.payload) !== federationCanonicalJson(row.payload) ||
      (row.counterpartyJws &&
        (await this.verify(tx, row.counterpartyJws, other)).digest !== row.digest)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    grantId: string,
    jws: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.approve");
      const [scope] = await tx
        .select()
        .from(disclosures)
        .where(this.key(actor, revisionId, grantId));
      if (!scope) throw new FederationError("POLICY_DENIED");
      const { other } = await this.validate(tx, actor, revisionId, scope.payload);
      const [row] = await tx
        .select()
        .from(disclosures)
        .where(this.key(actor, revisionId, grantId))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
      if (row.digest !== scope.digest) throw new FederationError("OPERATION_CONFLICT");
      await this.saved(tx, row, other);
      const peer = await this.verify(tx, jws, other);
      if (peer.digest !== row.digest) throw new FederationError("OPERATION_CONFLICT");
      await this.validate(tx, actor, revisionId, row.payload);
      if (row.counterpartyJws) {
        if (row.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        return row;
      }
      const [saved] = await tx
        .update(disclosures)
        .set({ counterpartyJws: jws, confirmedAt: new Date() })
        .where(this.key(actor, revisionId, grantId))
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.disclosure.confirm",
        target: grantId,
        diff: { after: { digest: row.digest } },
      });
      return saved;
    });
  }
  async revoke(actor: FederationActor, revisionId: string, grantId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.approve");
      const [row] = await tx
        .select()
        .from(disclosures)
        .where(this.key(actor, revisionId, grantId))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.revokedAt) return row;
      const [saved] = await tx
        .update(disclosures)
        .set({ revokedAt: new Date(), revokedBy: actor.userId })
        .where(this.key(actor, revisionId, grantId))
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.disclosure.revoke",
        target: grantId,
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
    filter: { caseId?: string; grantId?: string } = {},
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.approve");
      const rows = await tx
        .select()
        .from(disclosures)
        .where(
          and(
            eq(disclosures.localSiteId, this.signing.siteId),
            eq(disclosures.localOrgId, actor.orgId),
            eq(disclosures.agreementRevisionId, revisionId),
            filter.caseId ? eq(disclosures.caseId, filter.caseId) : undefined,
            filter.grantId ? eq(disclosures.grantId, filter.grantId) : undefined,
          ),
        )
        .orderBy(desc(disclosures.createdAt), desc(disclosures.grantId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
