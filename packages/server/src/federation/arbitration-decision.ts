import { randomBytes } from "node:crypto";
import {
  auditLog,
  federationEvidenceCases as cases,
  federationArbitrationDecisions as decisions,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  ArbitrationDecisionBasisSchema,
  ArbitrationDecisionInputSchema,
  type ArbitrationDecisionIntent,
  ArbitrationDecisionIntentSchema,
  ArbitrationDecisionSchema,
  arbitrationDecisionIntent,
} from "@kuintessence/shared/federation/arbitration-decision";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { FederationArbitrationReviewService } from "./arbitration-review";
import { federationMaterialDigest } from "./assets";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** R's durable signed original; no delivery, ledger transaction or financial mutation. */
export class FederationArbitrationDecisionService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly review: FederationArbitrationReviewService,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private async visible(
    tx: PgTransaction,
    actor: FederationActor,
    caseId: string,
    deciding = false,
  ) {
    await requireFederationCapability(tx, actor, "arbitration.read");
    if (deciding) await requireFederationCapability(tx, actor, "arbitration.decide");
    const [record] = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.caseId, caseId),
          eq(cases.localOrgId, actor.orgId),
        ),
      )
      .for("share");
    if (!record) throw new FederationError("POLICY_DENIED");
    return record;
  }
  private async prior(
    tx: PgTransaction,
    actor: FederationActor,
    caseId: string,
    intent?: ArbitrationDecisionIntent,
  ) {
    const [row] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.localSiteId, this.signing.siteId), eq(decisions.caseId, caseId)))
      .for("share");
    if (
      row &&
      (row.localOrgId !== actor.orgId ||
        (intent && federationCanonicalJson(row.payload.intent) !== federationCanonicalJson(intent)))
    )
      throw new FederationError("OPERATION_CONFLICT");
    return row;
  }
  private view(row: typeof decisions.$inferSelect) {
    return { payload: row.payload, digest: row.digest, approvedAt: row.approvedAt.toISOString() };
  }
  async read(actor: FederationActor, caseId: string) {
    return this.db.transaction(async (tx) => {
      await this.visible(tx, actor, caseId);
      const row = await this.prior(tx, actor, caseId);
      return row ? this.view(row) : null;
    });
  }
  async draft(
    actor: FederationActor,
    caseId: string,
    raw: z.infer<typeof ArbitrationDecisionInputSchema>,
  ) {
    const input = ArbitrationDecisionInputSchema.parse(raw);
    await this.db.transaction((tx) => this.visible(tx, actor, caseId, true));
    const proof = await this.review.prepare(actor, caseId, { grantIds: input.grantIds });
    return this.db.transaction(async (tx) => {
      await this.visible(tx, actor, caseId, true);
      if (await this.prior(tx, actor, caseId)) throw new FederationError("OPERATION_CONFLICT");
      await requireFederationCapability(tx, actor, "disclosure.receive");
      const review = await this.review.verify(tx, actor, caseId, proof);
      return arbitrationDecisionIntent(review, input, randomBytes(32).toString("hex"));
    });
  }
  async approve(actor: FederationActor, caseId: string, raw: ArbitrationDecisionIntent) {
    const intent = ArbitrationDecisionIntentSchema.parse(raw);
    if (intent.binding.caseId !== caseId || intent.binding.arbitratorSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    const saved = await this.db.transaction(async (tx) => {
      await this.visible(tx, actor, caseId, true);
      return this.prior(tx, actor, caseId, intent);
    });
    // Historical recovery never re-signs, re-reads remote data or restores execution authority.
    if (saved) return this.view(saved);
    const proof = await this.review.prepare(actor, caseId, {
      grantIds: intent.evidence.map((e) => e.grantId),
    });
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`arbitration-decision:${this.signing.siteId}:${caseId}`}, 0))`,
      );
      await this.visible(tx, actor, caseId, true);
      const prior = await this.prior(tx, actor, caseId, intent);
      if (prior) return this.view(prior);
      await requireFederationCapability(tx, actor, "disclosure.receive");
      const review = await this.review.verify(tx, actor, caseId, proof);
      const current = arbitrationDecisionIntent(
        review,
        {
          decisionId: intent.decisionId,
          outcome: intent.outcome,
          reason: intent.reason,
          grantIds: intent.evidence.map((e) => e.grantId),
        },
        intent.salt,
      );
      if (federationCanonicalJson(current) !== federationCanonicalJson(intent))
        throw new FederationError("OPERATION_CONFLICT");
      const basis = ArbitrationDecisionBasisSchema.parse({
        review,
        contexts: proof.contextProof.responses.map((r) => ({
          queryJws: r.jws,
          responseJws: r.responseJws,
        })),
        evidence: proof.proofs.map((p) => ({
          scope: p.record.scope,
          evidence: p.record.evidence,
          readId: p.current.readId,
          authorizations: p.pair,
        })),
      });
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const key = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      const expiresAt = Math.min(Date.parse(review.expiresAt), key.validUntil.getTime());
      const payload = ArbitrationDecisionSchema.parse({
        protocolVersion: 1,
        kind: "arbitration-decision",
        intent,
        issuedAt: new Date().toISOString(),
        basisDigest: federationMaterialDigest(basis),
        basisExpiresAt: new Date(expiresAt).toISOString(),
      });
      const jws = await signFederationMessage(ArbitrationDecisionSchema, payload, this.signing);
      const signed = await verifyFederationMessage(ArbitrationDecisionSchema, jws, key, new Date());
      if (expiresAt <= Date.now()) throw new FederationError("AUTHORIZATION_EXPIRED");
      const [row] = await tx
        .insert(decisions)
        .values({
          localSiteId: this.signing.siteId,
          decisionId: intent.decisionId,
          caseId,
          localOrgId: actor.orgId,
          payload,
          digest: signed.digest,
          approvalJws: jws,
          basis,
          approvedBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.arbitration_decision.approve",
        target: intent.decisionId,
        diff: { after: { caseId, digest: row.digest, basisDigest: payload.basisDigest } },
      });
      if (expiresAt <= Date.now()) throw new FederationError("AUTHORIZATION_EXPIRED");
      return this.view(row);
    });
  }
}
