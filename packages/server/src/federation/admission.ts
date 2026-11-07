import {
  federationAgreements,
  federationAttestationOutbox,
  federationBudgets,
  federationEvidence,
  federationReservations,
  type PgDb,
} from "@kuintessence/db";
import {
  assertDelegationPolicy,
  type FederationAcceptance,
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  FederationDelegationSchema,
  FederationError,
} from "@kuintessence/shared/federation";
import { and, count, eq, sql } from "drizzle-orm";
import { assertFederationNotCancelled } from "./cancellation-fence";
import { requireCoordinatedCommercialAgreement } from "./commercial-execution-policy";
import type { FederationExecutionConfirmationService } from "./execution-confirmation";
import { type ExecutionIdentity, requireExecutionIdentity } from "./execution-identity";
import {
  type FederationSigningKey,
  type FederationVerificationKey,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
type Reservation = typeof federationReservations.$inferSelect;

/** Internal admission only. A reservation is not a Job or permission to dispatch one. */
export class FederationAdmission {
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly receiptVerificationKey: FederationVerificationKey,
    private readonly clock: () => Date = () => new Date(),
    private readonly confirmations?: FederationExecutionConfirmationService,
  ) {
    if (
      signingKey.siteId !== receiptVerificationKey.siteId ||
      signingKey.keyId !== receiptVerificationKey.keyId
    )
      throw new FederationError("UNTRUSTED_IDENTITY");
  }

  /** Both approval keys must have agreement authority in the local trust registry. */
  async installApprovedAgreement(input: {
    sourceApprovalJws: string;
    targetApprovalJws: string;
    sourceKey: FederationVerificationKey;
    targetKey: FederationVerificationKey;
    identity: ExecutionIdentity;
    authorize?: (tx: Transaction, now: Date) => Promise<void>;
  }): Promise<void> {
    const now = this.clock();
    const source = await verifyFederationMessage(
      FederationAgreementSchema,
      input.sourceApprovalJws,
      input.sourceKey,
      now,
    );
    const target = await verifyFederationMessage(
      FederationAgreementSchema,
      input.targetApprovalJws,
      input.targetKey,
      now,
    );
    const terms = source.payload;
    if (
      source.digest !== target.digest ||
      input.sourceKey.siteId !== terms.sourceSiteId ||
      input.targetKey.siteId !== terms.targetSiteId ||
      terms.targetSiteId !== this.signingKey.siteId
    )
      throw new FederationError("UNTRUSTED_IDENTITY");
    if (Date.parse(terms.validUntil) <= now.getTime())
      throw new FederationError("AUTHORIZATION_EXPIRED");

    await this.db.transaction(async (tx) => {
      await input.authorize?.(tx, this.clock());
      // Serializes initial creation and retries without holding a network/crypto call in a transaction.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${terms.agreementRevisionId}, 0))`,
      );
      await requireExecutionIdentity(tx, input.identity);
      await requireCoordinatedCommercialAgreement(
        tx,
        new FederationTrustRegistry(this.db),
        this.signingKey.siteId,
        input.identity.orgId,
        terms,
        this.clock,
      );
      const [existing] = await tx
        .select()
        .from(federationAgreements)
        .where(eq(federationAgreements.revisionId, terms.agreementRevisionId));
      if (existing) {
        if (
          existing.termsDigest !== source.digest ||
          existing.localOrgId !== input.identity.orgId ||
          existing.executionUserId !== input.identity.userId
        )
          throw new FederationError("OPERATION_CONFLICT");
        return;
      }
      if (Date.parse(terms.validUntil) <= this.clock().getTime())
        throw new FederationError("AUTHORIZATION_EXPIRED");
      if (terms.mode !== "ledger_coordinated") {
        const [budget] = await tx
          .insert(federationBudgets)
          .values({
            domainId: terms.budgetDomainId,
            epoch: terms.epoch,
            unit: terms.unit,
            limit: terms.budgetLimit,
            available: terms.budgetLimit,
          })
          .onConflictDoNothing()
          .returning();
        // Revisions never silently reopen or copy an existing spendable epoch.
        if (!budget) throw new FederationError("OPERATION_CONFLICT");
      }
      await tx.insert(federationAgreements).values({
        revisionId: terms.agreementRevisionId,
        sourceSiteId: terms.sourceSiteId,
        targetSiteId: terms.targetSiteId,
        localOrgId: input.identity.orgId,
        executionUserId: input.identity.userId,
        budgetDomainId: terms.mode === "ledger_coordinated" ? null : terms.budgetDomainId,
        epoch: terms.mode === "ledger_coordinated" ? null : terms.epoch,
        terms,
        termsDigest: source.digest,
        sourceApprovalJws: source.jws,
        targetApprovalJws: target.jws,
      });
    });
  }

  async receive(input: {
    requestJws: string;
    // Must come from the authenticated transport, not a sender-controlled header/body.
    authenticatedPeerSiteId: string;
    senderKey: FederationVerificationKey;
    authorize?: (tx: Transaction, now: Date) => Promise<void>;
  }): Promise<{ reservationId: string; receiptJws: string }> {
    const now = this.clock();
    const verified = await verifyFederationMessage(
      FederationDelegationSchema,
      input.requestJws,
      input.senderKey,
      now,
    );
    const request = verified.payload;
    if (
      request.senderSiteId !== input.authenticatedPeerSiteId ||
      request.senderSiteId !== input.senderKey.siteId ||
      request.recipientSiteId !== this.signingKey.siteId
    )
      throw new FederationError("UNTRUSTED_IDENTITY");

    let coordinatedOrgId: string | undefined;
    if (request.mode === "ledger_coordinated") {
      if (!this.confirmations) throw new FederationError("LEDGER_REQUIRED");
      const scope = await this.db.transaction(async (tx) => {
        await input.authorize?.(tx, this.clock());
        const [prior] = await tx
          .select()
          .from(federationReservations)
          .where(
            and(
              eq(federationReservations.senderSiteId, request.senderSiteId),
              eq(federationReservations.operationId, request.operationId),
            ),
          );
        if (prior) return { prior: this.requireSameRequest(prior, verified.digest) };
        const [agreement] = await tx
          .select()
          .from(federationAgreements)
          .where(eq(federationAgreements.revisionId, request.agreementRevisionId));
        if (!agreement || agreement.targetSiteId !== this.signingKey.siteId)
          throw new FederationError("AGREEMENT_UNAVAILABLE");
        return { orgId: agreement.localOrgId };
      });
      if (scope.prior) return this.completeReceipt(scope.prior.id);
      coordinatedOrgId = scope.orgId;
      if (!coordinatedOrgId) throw new FederationError("AGREEMENT_UNAVAILABLE");
      await this.confirmations.refreshForExecution(coordinatedOrgId, request, "admission");
    }

    const reservation = await this.db.transaction(async (tx) => {
      await input.authorize?.(tx, this.clock());
      const [prior] = await tx
        .select()
        .from(federationReservations)
        .where(
          and(
            eq(federationReservations.senderSiteId, request.senderSiteId),
            eq(federationReservations.operationId, request.operationId),
          ),
        );
      if (prior) {
        await input.authorize?.(tx, this.clock());
        return this.requireSameRequest(prior, verified.digest);
      }

      // Serialize admissions before confirmation's consent/installed-agreement locks.
      if (coordinatedOrgId) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${request.agreementRevisionId}, 0))`,
        );
        await this.confirmations?.authorize(tx, coordinatedOrgId, request, "admission");
      }

      const [agreement] = await tx
        .select()
        .from(federationAgreements)
        .where(eq(federationAgreements.revisionId, request.agreementRevisionId))
        .for("update");
      if (!agreement) throw new FederationError("AGREEMENT_UNAVAILABLE");
      // A duplicate can have committed while this transaction was waiting for the agreement lock.
      const [retried] = await tx
        .select()
        .from(federationReservations)
        .where(
          and(
            eq(federationReservations.senderSiteId, request.senderSiteId),
            eq(federationReservations.operationId, request.operationId),
          ),
        );
      if (retried) {
        await input.authorize?.(tx, this.clock());
        return this.requireSameRequest(retried, verified.digest);
      }
      if (agreement.state !== "active") throw new FederationError("AGREEMENT_UNAVAILABLE");
      await assertFederationNotCancelled(tx, request);
      const terms = FederationAgreementSchema.parse(agreement.terms);
      if (terms.mode === "ledger_coordinated" && !coordinatedOrgId)
        throw new FederationError("LEDGER_REQUIRED");
      await requireExecutionIdentity(tx, {
        orgId: agreement.localOrgId,
        userId: agreement.executionUserId,
      });
      const [open] = await tx
        .select({ total: count() })
        .from(federationReservations)
        .where(eq(federationReservations.agreementRevisionId, agreement.revisionId));
      if (!open || open.total >= terms.maxReservations)
        throw new FederationError("BUDGET_EXHAUSTED");
      const [budget] = coordinatedOrgId
        ? []
        : await tx
            .select()
            .from(federationBudgets)
            .where(
              and(
                eq(federationBudgets.domainId, terms.budgetDomainId),
                eq(federationBudgets.epoch, terms.epoch),
              ),
            )
            .for("update");
      if (!coordinatedOrgId && (!budget || budget.unit !== request.unit))
        throw new FederationError("AGREEMENT_UNAVAILABLE");
      if (budget && BigInt(budget.available) < BigInt(request.maxAmount))
        throw new FederationError("BUDGET_EXHAUSTED");
      // Recheck after all potentially blocking locks, not just before signature verification.
      await input.authorize?.(tx, this.clock());
      const confirmation = coordinatedOrgId
        ? await this.confirmations?.authorize(tx, coordinatedOrgId, request, "admission")
        : undefined;
      const admittedAt = this.clock();
      if (!confirmation) assertDelegationPolicy(terms, request, admittedAt);
      const id = confirmation?.reservationId ?? crypto.randomUUID();
      const receipt: FederationAcceptance = {
        protocolVersion: 1,
        kind: "acceptance",
        operationId: request.operationId,
        senderSiteId: request.recipientSiteId,
        recipientSiteId: request.senderSiteId,
        agreementRevisionId: request.agreementRevisionId,
        mode: request.mode,
        budgetDomainId: request.budgetDomainId,
        epoch: request.epoch,
        taskId: request.taskId,
        attempt: request.attempt,
        requestDigest: verified.digest,
        reservationId: id,
        reservedAmount: request.maxAmount,
        unit: request.unit,
        acceptedAt: admittedAt.toISOString(),
        status: "RESERVED",
      };
      const [created] = await tx
        .insert(federationReservations)
        .values({
          id,
          agreementRevisionId: terms.agreementRevisionId,
          senderSiteId: request.senderSiteId,
          operationId: request.operationId,
          taskId: request.taskId,
          attempt: request.attempt,
          requestDigest: verified.digest,
          requestJws: verified.jws,
          amount: request.maxAmount,
          receipt,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) throw new FederationError("OPERATION_CONFLICT");
      if (budget)
        await tx
          .update(federationBudgets)
          .set({
            available: (BigInt(budget.available) - BigInt(request.maxAmount)).toString(),
            reserved: (BigInt(budget.reserved) + BigInt(request.maxAmount)).toString(),
          })
          .where(
            and(
              eq(federationBudgets.domainId, terms.budgetDomainId),
              eq(federationBudgets.epoch, terms.epoch),
            ),
          );
      await this.saveEvidence(tx, created, "delegation", verified.jws, verified.digest);
      return created;
    });
    return this.completeReceipt(reservation.id);
  }

  /** Recovery uses the existing reservation and original receipt bytes, never a new operation ID. */
  async completeReceipt(reservationId: string) {
    const now = this.clock();
    const [row] = await this.db
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.id, reservationId));
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
    if (row.receipt.senderSiteId !== this.signingKey.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    if (row.receiptJws) return { reservationId, receiptJws: row.receiptJws };
    const receiptJws = await signFederationMessage(
      FederationAcceptanceSchema,
      row.receipt,
      this.signingKey,
    );
    const verified = await verifyFederationMessage(
      FederationAcceptanceSchema,
      receiptJws,
      this.receiptVerificationKey,
      now,
    );
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, reservationId))
        .for("update");
      if (!current) throw new FederationError("AGREEMENT_UNAVAILABLE");
      if (current.receiptJws) return { reservationId, receiptJws: current.receiptJws };
      await this.saveEvidence(tx, current, "acceptance", receiptJws, verified.digest);
      await tx
        .update(federationReservations)
        .set({ receiptJws, state: "reserved" })
        .where(eq(federationReservations.id, reservationId));
      return { reservationId, receiptJws };
    });
  }

  private requireSameRequest(prior: Reservation, digest: string) {
    if (prior.requestDigest !== digest) throw new FederationError("OPERATION_CONFLICT");
    return prior;
  }

  private async saveEvidence(
    tx: Transaction,
    reservation: Reservation,
    kind: "delegation" | "acceptance",
    jws: string,
    digest: string,
  ) {
    const id = crypto.randomUUID();
    await tx.insert(federationEvidence).values({
      id,
      reservationId: reservation.id,
      kind,
      jws,
      digest,
    });
    if (reservation.receipt.mode === "bilateral_attested")
      await tx.insert(federationAttestationOutbox).values({ evidenceId: id });
  }
}
