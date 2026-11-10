import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationDisputes as cases,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationReceivedArbitrationDecisions as received,
  federationReservations as reservations,
  federationArbitrationResolutions as resolutions,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  assertArbitrationResolution,
  verifyArbitrationResolution,
} from "@kuintessence/shared/federation/arbitration-resolution";
import {
  ArbitrationResolutionEnvelopeSchema,
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
  CommercialArbitrationResolutionSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, eq, sql } from "drizzle-orm";
import { verifyReceivedArbitrationDecision } from "./arbitration-decision-history";
import { lockFederationDisputeTask } from "./dispute-freeze";
import { FederationDisputeFreezeExchange } from "./dispute-freeze-exchange";
import { FederationDisputeService } from "./disputes";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Execute only an explicit no-money award. Financial awards use their own posting path. */
export class FederationArbitrationResolutionService {
  private readonly trust: FederationTrustRegistry;
  private readonly disputes: FederationDisputeService;
  private readonly freezes: FederationDisputeFreezeExchange;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.disputes = new FederationDisputeService(db, signing);
    this.freezes = new FederationDisputeFreezeExchange(db, signing);
  }
  private key(caseId: string) {
    return and(eq(resolutions.localSiteId, this.signing.siteId), eq(resolutions.caseId, caseId));
  }
  private async visible(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    caseId: string,
    execute = false,
  ) {
    await requireFederationCapability(tx, actor, "dispute.read");
    if (execute) await requireFederationCapability(tx, actor, "arbitration.execute");
    const [row] = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.localOrgId, actor.orgId),
          eq(cases.agreementRevisionId, revisionId),
          eq(cases.caseId, caseId),
        ),
      );
    if (!row) throw new FederationError("POLICY_DENIED");
    return row;
  }
  private view(row: typeof resolutions.$inferSelect) {
    return {
      payload: row.payload,
      appliedAt: row.appliedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
  private async current(tx: PgTransaction, caseId: string) {
    const [original] = await tx
      .select()
      .from(received)
      .where(and(eq(received.localSiteId, this.signing.siteId), eq(received.caseId, caseId)))
      .for("share");
    if (!original) throw new FederationError("DATA_WAITING");
    const value = original.payload,
      decision = value.decision,
      b = decision.intent.binding;
    await verifyReceivedArbitrationDecision(tx, value, this.signing.siteId);
    const context = await this.disputes.arbitrationSnapshot(tx, caseId);
    const { observedAt: _at, ...binding } = context.binding;
    const freeze = await this.freezes.arbitrationSnapshot(tx, caseId);
    if (!freeze) throw new FederationError("DATA_WAITING");
    if (
      federationCanonicalJson(binding) !== federationCanonicalJson(b) ||
      freeze.financial.headDigest !== decision.intent.financial.headDigest ||
      freeze.financial.freezeDigest !== decision.intent.financial.freezeDigest ||
      federationCanonicalJson(freeze.financial.records) !==
        federationCanonicalJson(decision.intent.financial.records)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const originalRequest =
      this.signing.siteId === b.sourceSiteId
        ? (
            await tx
              .select({ requestJws: outbound.requestJws, receiptJws: outbound.receiptJws })
              .from(outbound)
              .where(
                and(
                  eq(outbound.localSiteId, this.signing.siteId),
                  eq(outbound.operationId, b.operationId),
                ),
              )
          )[0]
        : (
            await tx
              .select({ requestJws: reservations.requestJws, receiptJws: reservations.receiptJws })
              .from(reservations)
              .where(eq(reservations.id, b.reservationId))
          )[0];
    if (!originalRequest?.receiptJws) throw new FederationError("DATA_WAITING");
    const envelope = ArbitrationResolutionEnvelopeSchema.parse({
      sourceSiteId: b.sourceSiteId,
      targetSiteId: b.targetSiteId,
      decisionJws: value.decisionJws,
      requestJws: originalRequest.requestJws,
      acceptanceJws: originalRequest.receiptJws,
    });
    const proof = await verifyArbitrationResolution(
      envelope,
      async (schema, jws, siteId) => {
        const keyId = federationMessageKeyId(jws),
          now = new Date();
        await this.trust.assertKey(tx, siteId, keyId, now);
        return verifyFederationMessage(
          schema,
          jws,
          await this.trust.resolveKey(siteId, keyId, now, tx),
          now,
        );
      },
      new Date(),
    );
    const payload = CommercialArbitrationResolutionSchema.parse({
      decisionId: original.decisionId,
      decisionDigest: value.decisionDigest,
      caseId,
      caseDigest: b.caseDigest,
      domainId: b.domainId,
      agreementRevisionId: b.agreementRevisionId,
      sourceSiteId: b.sourceSiteId,
      targetSiteId: b.targetSiteId,
      taskId: b.taskId,
      attempt: b.attempt,
      mode: b.mode,
      headDigest: decision.intent.financial.headDigest,
      freezeDigest: decision.intent.financial.freezeDigest,
      outcome: decision.intent.outcome,
    });
    assertArbitrationResolution(payload, proof);
    return { original, payload, envelope };
  }
  async execute(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      const record = await this.visible(tx, actor, revisionId, caseId, true);
      await lockFederationDisputeTask(tx, this.signing.siteId, record);
      const [prior] = await tx.select().from(resolutions).where(this.key(caseId));
      if (prior) return this.view(prior);
      const { original, payload, envelope } = await this.current(tx, caseId);
      const [row] = await tx
        .insert(resolutions)
        .values({
          localSiteId: this.signing.siteId,
          decisionId: original.decisionId,
          caseId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          payload,
          envelope,
          initiatedBy: actor.userId,
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      if (payload.mode !== "bilateral_direct")
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input: CommercialAdapterProposalInputSchema.parse({
            operation:
              payload.mode === "ledger_coordinated"
                ? "resolve-arbitrated-case"
                : "record-arbitration-resolution",
            domainId: payload.domainId,
            recordId: payload.decisionId,
            digest: payload.decisionDigest,
            envelope,
          }),
        });
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.arbitration_resolution.authorize",
        target: row.decisionId,
        diff: { after: { caseId, decisionDigest: payload.decisionDigest, mode: payload.mode } },
      });
      if (payload.mode !== "ledger_coordinated")
        await this.apply(tx, payload.decisionId, payload.decisionDigest);
      const [saved] = await tx.select().from(resolutions).where(this.key(caseId));
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      return this.view(saved);
    });
  }
  async beforeDisclosure(input: CommercialAdapterProposalInput, tx?: PgTransaction): Promise<void> {
    if (!tx) return this.db.transaction((tx) => this.beforeDisclosure(input, tx));
    if (
      input.operation !== "resolve-arbitrated-case" &&
      input.operation !== "record-arbitration-resolution"
    )
      throw new FederationError("POLICY_DENIED");
    const [row] = await tx
      .select()
      .from(resolutions)
      .where(
        and(
          eq(resolutions.localSiteId, this.signing.siteId),
          eq(resolutions.decisionId, input.recordId),
        ),
      );
    if (
      !row ||
      row.payload.decisionDigest !== input.digest ||
      row.payload.domainId !== input.domainId ||
      (input.operation === "resolve-arbitrated-case"
        ? row.payload.mode !== "ledger_coordinated"
        : row.payload.mode !== "bilateral_attested" || !row.appliedAt) ||
      federationCanonicalJson(row.envelope) !== federationCanonicalJson(input.envelope)
    )
      throw new FederationError("POLICY_DENIED");
    if (input.operation === "resolve-arbitrated-case") {
      await lockFederationDisputeTask(tx, this.signing.siteId, row.payload);
      const current = await this.current(tx, row.caseId);
      if (federationCanonicalJson(current.payload) !== federationCanonicalJson(row.payload))
        throw new FederationError("OPERATION_CONFLICT");
    }
  }
  /** Coordinated caller must have persisted the VALID transaction in this same transaction. */
  async apply(tx: PgTransaction, decisionId: string, digest: string) {
    const identity = and(
      eq(resolutions.localSiteId, this.signing.siteId),
      eq(resolutions.decisionId, decisionId),
    );
    const [scope] = await tx.select().from(resolutions).where(identity);
    if (!scope) throw new FederationError("OPERATION_CONFLICT");
    // Match execute's task-before-row lock order when the worker races a human retry.
    await lockFederationDisputeTask(tx, this.signing.siteId, scope.payload);
    const [row] = await tx.select().from(resolutions).where(identity).for("update");
    if (!row || row.payload.decisionDigest !== digest)
      throw new FederationError("OPERATION_CONFLICT");
    if (row.appliedAt) return;
    if (row.payload.mode === "ledger_coordinated") {
      const [committed] = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signing.siteId),
            eq(submissions.state, "committed"),
            sql`${submissions.input}->>'operation' = 'resolve-arbitrated-case'`,
            sql`${submissions.input}->>'recordId' = ${decisionId}`,
            sql`${submissions.input}->>'digest' = ${digest}`,
          ),
        );
      if (!committed) throw new FederationError("LEDGER_REQUIRED");
    }
    const [record] = await tx
      .update(cases)
      .set({ state: "RESOLVED" })
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.caseId, row.caseId),
          eq(cases.localOrgId, row.localOrgId),
          eq(cases.digest, row.payload.caseDigest),
          sql`${cases.state} IN ('DISPUTED','EVIDENCE_WAITING')`,
        ),
      )
      .returning();
    if (!record) throw new FederationError("OPERATION_CONFLICT");
    await tx
      .update(resolutions)
      .set({ appliedAt: sql`clock_timestamp()` })
      .where(this.key(row.caseId));
    await tx.insert(auditLog).values({
      actor: `arbitration-resolution:${this.signing.siteId}`,
      orgId: row.localOrgId,
      action: "federation.arbitration_resolution.apply",
      target: decisionId,
      diff: { after: { caseId: row.caseId, decisionDigest: digest } },
    });
  }
  async read(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      await this.visible(tx, actor, revisionId, caseId);
      const [row] = await tx.select().from(resolutions).where(this.key(caseId));
      return row ? this.view(row) : null;
    });
  }
}
