import { randomBytes } from "node:crypto";
import {
  federationCaseArbitrationDecisions as approvals,
  federationCaseAttempts as attempts,
  auditLog,
  federationArbitrationDecisions as decisions,
  type PgDb,
  type PgTransaction,
  federationCaseSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import { ArbitrationDecisionSchema } from "@kuintessence/shared/federation/arbitration-decision";
import {
  type CaseArbitrationDecision,
  CaseArbitrationDecisionSchema,
  CaseProposalSchema,
  caseArbitrationDecision,
  caseVerificationKeys,
  type FabricCaseTrust,
  verifyCaseArbitrationDecision,
} from "@kuintessence/shared/federation/case-ledger";
import { and, desc, eq, sql } from "drizzle-orm";
import { verifyArbitrationHistory } from "./arbitration-decision-history";
import { federationMaterialDigest } from "./assets";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Current explicit storage approval never confers execution or commercial PDC access. */
export class FederationCaseArbitrationDecisionService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly ledger: FabricCaseTrust,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async visible(tx: PgTransaction, actor: FederationActor, caseId: string, publish = false) {
    await requireFederationCapability(tx, actor, "arbitration.read");
    if (publish) await requireFederationCapability(tx, actor, "case.publish");
    const [row] = await tx
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.localSiteId, this.signing.siteId),
          eq(decisions.caseId, caseId),
          eq(decisions.localOrgId, actor.orgId),
        ),
      )
      .for("share");
    if (!row) throw new FederationError("POLICY_DENIED");
    return row;
  }
  private view(row: typeof approvals.$inferSelect) {
    return { payload: row.payload, digest: row.digest, approvedAt: row.approvedAt.toISOString() };
  }
  private async original(tx: PgTransaction, row: typeof decisions.$inferSelect) {
    const signed = await verifyArbitrationHistory(
      tx,
      ArbitrationDecisionSchema,
      row.approvalJws,
      this.signing.siteId,
      new Date(row.payload.issuedAt),
    );
    if (
      signed.digest !== row.digest ||
      federationCanonicalJson(signed.payload) !== federationCanonicalJson(row.payload) ||
      federationMaterialDigest(row.basis) !== row.payload.basisDigest ||
      row.payload.intent.decisionId !== row.decisionId ||
      row.payload.intent.binding.caseId !== row.caseId ||
      row.payload.intent.binding.arbitratorSiteId !== this.signing.siteId
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private domain(value: CaseArbitrationDecision) {
    const domain = this.ledger.domains.find((d) => d.domainId === value.caseDomainId),
      b = value.binding;
    if (
      !domain ||
      domain.recipientSiteId !== this.signing.siteId ||
      b.arbitratorSiteId !== this.signing.siteId ||
      domain.commercialDomainId !== b.domainId ||
      domain.sourceSiteId !== b.sourceSiteId ||
      domain.targetSiteId !== b.targetSiteId
    )
      throw new FederationError("POLICY_DENIED");
    return domain;
  }
  private async verify(
    tx: PgTransaction,
    value: CaseArbitrationDecision,
    digest: string | undefined,
    jws: string,
  ) {
    const keyId = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, this.signing.siteId, keyId, now);
    const signed = await verifyFederationMessage(
      CaseArbitrationDecisionSchema,
      jws,
      await this.trust.resolveKey(this.signing.siteId, keyId, now, tx),
      now,
    );
    if (
      (digest !== undefined && signed.digest !== digest) ||
      federationCanonicalJson(signed.payload) !== federationCanonicalJson(value)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const proposal = CaseProposalSchema.options[2].parse({
      operation: "record-arbitration-decision",
      domainId: value.caseDomainId,
      recordId: value.decisionId,
      digest: signed.digest,
      envelope: { issuerSiteId: this.signing.siteId, jws },
    });
    const keys = await caseVerificationKeys(this.ledger, proposal, async () => false);
    await verifyCaseArbitrationDecision(proposal.envelope, this.domain(value), keys, now);
    return proposal;
  }
  async draft(actor: FederationActor, caseId: string, caseDomainId: string) {
    return this.db.transaction(async (tx) => {
      const row = await this.visible(tx, actor, caseId, true);
      await this.original(tx, row);
      const [prior] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, this.signing.siteId),
            eq(approvals.decisionId, row.decisionId),
          ),
        );
      if (prior) {
        if (prior.payload.caseDomainId !== caseDomainId)
          throw new FederationError("OPERATION_CONFLICT");
        return prior.payload;
      }
      const value = caseArbitrationDecision(
        row.payload,
        row.digest,
        caseDomainId,
        new Date().toISOString(),
        randomBytes(32).toString("hex"),
      );
      this.domain(value);
      return value;
    });
  }
  async approve(actor: FederationActor, caseId: string, raw: CaseArbitrationDecision) {
    const value = CaseArbitrationDecisionSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`case-decision:${this.signing.siteId}:${caseId}`}, 0))`,
      );
      const original = await this.visible(tx, actor, caseId, true);
      await this.original(tx, original);
      this.domain(value);
      const expected = caseArbitrationDecision(
        original.payload,
        original.digest,
        value.caseDomainId,
        value.issuedAt,
        value.salt,
      );
      if (federationCanonicalJson(value) !== federationCanonicalJson(expected))
        throw new FederationError("OPERATION_CONFLICT");
      const [prior] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, this.signing.siteId),
            eq(approvals.decisionId, original.decisionId),
          ),
        );
      if (prior && federationCanonicalJson(prior.payload) !== federationCanonicalJson(value))
        throw new FederationError("OPERATION_CONFLICT");
      if (prior && federationMessageKeyId(prior.submissionJws) === this.signing.keyId) {
        await this.verify(tx, value, prior.digest, prior.submissionJws);
        return this.view(prior);
      }
      const jws = await signFederationMessage(CaseArbitrationDecisionSchema, value, this.signing);
      const { digest } = await this.verify(tx, value, prior?.digest, jws);
      if (prior) {
        const [queue] = await tx
          .select()
          .from(submissions)
          .where(
            and(
              eq(submissions.localSiteId, this.signing.siteId),
              eq(submissions.arbitrationDecisionId, original.decisionId),
            ),
          )
          .for("update");
        if (queue) {
          const [available] = await tx
            .select({
              valid: sql<boolean>`(${submissions.leaseUntil} IS NULL OR ${submissions.leaseUntil} <= clock_timestamp())`,
            })
            .from(submissions)
            .where(eq(submissions.id, queue.id));
          const [attempt] = await tx
            .select()
            .from(attempts)
            .where(eq(attempts.submissionId, queue.id))
            .orderBy(desc(attempts.number))
            .limit(1);
          if (
            !available?.valid ||
            queue.state === "committed" ||
            (attempt?.dispatchAuthorizedAt && !["invalid", "abandoned"].includes(attempt.stage))
          )
            throw new FederationError("OPERATION_CONFLICT");
          if (attempt && ["proposal", "transaction"].includes(attempt.stage))
            await tx
              .update(attempts)
              .set({ stage: "abandoned", updatedAt: sql`clock_timestamp()` })
              .where(eq(attempts.id, attempt.id));
          await tx
            .update(submissions)
            .set({
              input: null,
              state: "pending",
              lastError: null,
              leaseToken: null,
              leaseUntil: null,
              nextAttemptAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(submissions.id, queue.id));
        }
        // Retain the original human approval and refresh only the transport signature for identical content.
        await tx
          .update(approvals)
          .set({ submissionJws: jws })
          .where(
            and(
              eq(approvals.localSiteId, this.signing.siteId),
              eq(approvals.decisionId, original.decisionId),
            ),
          );
      } else {
        await tx.insert(approvals).values({
          localSiteId: this.signing.siteId,
          decisionId: original.decisionId,
          caseId,
          localOrgId: actor.orgId,
          payload: value,
          digest,
          approvalJws: jws,
          submissionJws: jws,
          approvedBy: actor.userId,
        });
      }
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: prior ? "federation.case_decision.reattest" : "federation.case_decision.approve",
        target: original.decisionId,
        diff: {
          after: { caseId, digest, keyId: this.signing.keyId, caseDomainId: value.caseDomainId },
        },
      });
      const [saved] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, this.signing.siteId),
            eq(approvals.decisionId, original.decisionId),
          ),
        );
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      return this.view(saved);
    });
  }
  async ledgerProposal(tx: PgTransaction, decisionId: string) {
    const [row] = await tx
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.localSiteId, this.signing.siteId), eq(approvals.decisionId, decisionId)),
      )
      .for("share");
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    return this.verify(tx, row.payload, row.digest, row.submissionJws);
  }
  async read(actor: FederationActor, caseId: string) {
    return this.db.transaction(async (tx) => {
      const original = await this.visible(tx, actor, caseId);
      const [row] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, this.signing.siteId),
            eq(approvals.decisionId, original.decisionId),
          ),
        );
      return row ? this.view(row) : null;
    });
  }
}
