import {
  federationCommercialAdjustments as adjustments,
  federationCommercialBills as bills,
  federationCommercialAgreements as contracts,
  type PgTransaction,
  federationReceivedArbitrationDecisions as received,
  federationArbitrationResolutions as resolutions,
  federationCommercialSettlements as settlements,
  federationCommercialSubmissions as submissions,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import type { ArbitrationDecision } from "@kuintessence/shared/federation/arbitration-decision";
import {
  arbitrationAdjustmentTerms,
  arbitrationSettlementTerms,
  assertArbitratedSettlement,
} from "@kuintessence/shared/federation/billing";
import {
  CommercialAdjustmentSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, sql } from "drizzle-orm";
import { verifyReceivedArbitrationDecision } from "./arbitration-decision-history";
import { verifyBilateralArbitrationExecution } from "./arbitration-execution-proof";

/** Derive the same financial original as the chain, using the locked task's existing records. */
export async function arbitrationFinancialTerms(
  tx: PgTransaction,
  siteId: string,
  orgId: string,
  decision: ArbitrationDecision,
) {
  const { binding: b, outcome } = decision.intent;
  if (outcome.action === "resolve-without-financial-change")
    throw new FederationError("POLICY_DENIED");
  const [bill] = await tx
    .select()
    .from(bills)
    .where(
      and(
        eq(bills.localSiteId, siteId),
        eq(bills.billId, outcome.bill.recordId),
        eq(bills.localOrgId, orgId),
        eq(bills.agreementRevisionId, b.agreementRevisionId),
      ),
    );
  const [contract] = await tx
    .select()
    .from(contracts)
    .where(
      and(
        eq(contracts.localSiteId, siteId),
        eq(contracts.revisionId, b.agreementRevisionId),
        eq(contracts.localOrgId, orgId),
      ),
    );
  if (!bill?.counterpartyJws || !contract?.counterpartyJws)
    throw new FederationError("DATA_WAITING");
  if (
    bill.digest !== outcome.bill.recordDigest ||
    contract.digest !== b.agreementDigest ||
    (contract.terms.consideration === "charity" && outcome.chargedAmount !== "0")
  )
    throw new FederationError("POLICY_DENIED");
  if (outcome.action === "settle") {
    const [prior] = await tx
      .select()
      .from(settlements)
      .where(and(eq(settlements.localSiteId, siteId), eq(settlements.billId, bill.billId)));
    if (prior && prior.arbitrationDecisionId !== decision.intent.decisionId)
      throw new FederationError("OPERATION_CONFLICT");
    const [terminal] = await tx
      .select()
      .from(terminals)
      .where(and(eq(terminals.localSiteId, siteId), eq(terminals.reservationId, b.reservationId)));
    if (
      b.mode === "ledger_coordinated" &&
      (!terminal?.counterpartyJws ||
        terminal.payload.domainId !== b.domainId ||
        terminal.payload.sourceSiteId !== b.sourceSiteId ||
        terminal.payload.targetSiteId !== b.targetSiteId ||
        !bill.payload.reservationId)
    )
      throw new FederationError("DATA_WAITING");
    return {
      bill,
      payload: arbitrationSettlementTerms(
        decision,
        bill.payload,
        bill.digest,
        bill.payload.reservationId && terminal?.counterpartyJws
          ? {
              terminalId: terminal.terminalId,
              digest: terminal.digest,
            }
          : null,
      ),
      number: 0,
    };
  }
  const [settlement] = await tx
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.localSiteId, siteId),
        eq(settlements.settlementId, outcome.settlement.recordId),
        eq(settlements.localOrgId, orgId),
        eq(settlements.agreementRevisionId, b.agreementRevisionId),
      ),
    );
  if (!settlement?.appliedAt || (!settlement.counterpartyJws && !settlement.arbitrationDecisionId))
    throw new FederationError("DATA_WAITING");
  const [previous] = await tx
    .select()
    .from(adjustments)
    .where(
      and(
        eq(adjustments.localSiteId, siteId),
        eq(adjustments.settlementId, settlement.settlementId),
        sql`${adjustments.adjustmentId} <> ${decision.intent.decisionId}`,
      ),
    )
    .orderBy(desc(adjustments.number))
    .limit(1);
  if (
    previous &&
    (!previous.appliedAt || (!previous.counterpartyJws && !previous.arbitrationDecisionId))
  )
    throw new FederationError("DATA_WAITING");
  const authority = settlement.arbitrationDecisionId
    ? await verifyArbitratedFinancialOriginal(tx, siteId, settlement)
    : undefined;
  return {
    bill,
    payload: arbitrationAdjustmentTerms(decision, {
      agreement: contract.terms,
      bill: { terms: bill.payload, digest: bill.digest },
      settlement: { terms: settlement.payload, digest: settlement.digest, arbitration: authority },
      previous: previous ? { terms: previous.payload, digest: previous.digest } : undefined,
    }),
    number: (previous?.number ?? 0) + 1,
  };
}

/** Read authority for a persisted financial original; never authorizes a new execution. */
export async function verifyArbitratedFinancialOriginal(
  tx: PgTransaction,
  siteId: string,
  row: {
    arbitrationDecisionId?: string | null;
    payload: unknown;
    digest: string;
    approvalJws: string | null;
    counterpartyJws: string | null;
  },
): Promise<ArbitrationDecision> {
  if (!row.arbitrationDecisionId || row.approvalJws || row.counterpartyJws)
    throw new FederationError("POLICY_DENIED");
  const [execution] = await tx
    .select()
    .from(resolutions)
    .where(
      and(
        eq(resolutions.localSiteId, siteId),
        eq(resolutions.decisionId, row.arbitrationDecisionId),
      ),
    );
  const [original] = await tx
    .select()
    .from(received)
    .where(
      and(eq(received.localSiteId, siteId), eq(received.decisionId, row.arbitrationDecisionId)),
    );
  if (
    !execution ||
    !original ||
    execution.payload.decisionDigest !== row.digest ||
    original.payload.decisionDigest !== row.digest ||
    execution.envelope.decisionJws !== original.payload.decisionJws
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (execution.payload.mode === "ledger_coordinated") {
    const [committed] = await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, siteId),
          eq(submissions.state, "committed"),
          sql`${submissions.input}->>'operation' = 'resolve-arbitrated-case'`,
          sql`${submissions.input}->>'recordId' = ${row.arbitrationDecisionId}`,
          sql`${submissions.input}->>'digest' = ${row.digest}`,
        ),
      );
    if (!committed) throw new FederationError("LEDGER_REQUIRED");
  } else await verifyBilateralArbitrationExecution(tx, execution);
  await verifyReceivedArbitrationDecision(tx, original.payload, siteId);
  const decision = original.payload.decision,
    { binding: b, outcome } = decision.intent;
  const value =
    outcome.action === "settle"
      ? CommercialSettlementSchema.parse(row.payload)
      : CommercialAdjustmentSchema.parse(row.payload);
  if (
    outcome.action === "resolve-without-financial-change" ||
    value.domainId !== b.domainId ||
    value.agreementRevisionId !== b.agreementRevisionId ||
    value.sourceSiteId !== b.sourceSiteId ||
    value.targetSiteId !== b.targetSiteId ||
    value.unit !== b.unit ||
    value.billId !== outcome.bill.recordId ||
    value.billDigest !== outcome.bill.recordDigest ||
    value.chargedAmount !== outcome.chargedAmount ||
    value.issuedAt !== decision.issuedAt ||
    value.salt !== decision.intent.salt ||
    (value.kind === "commercial-settlement" ? value.settlementId : value.adjustmentId) !==
      decision.intent.decisionId
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (value.kind === "commercial-adjustment") {
    if (
      outcome.action !== "adjust" ||
      value.settlementId !== outcome.settlement.recordId ||
      value.settlementDigest !== outcome.settlement.recordDigest ||
      value.reason !== decision.intent.reason ||
      value.supportingEvidenceDigest !== decision.basisDigest ||
      federationCanonicalJson(
        value.previous
          ? { recordId: value.previous.adjustmentId, recordDigest: value.previous.digest }
          : null,
      ) !== federationCanonicalJson(outcome.previousAdjustment)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  const [bill] = await tx
    .select()
    .from(bills)
    .where(
      and(
        eq(bills.localSiteId, siteId),
        eq(bills.billId, value.billId),
        eq(bills.localOrgId, execution.localOrgId),
        eq(bills.agreementRevisionId, b.agreementRevisionId),
      ),
    );
  if (!bill?.counterpartyJws || bill.digest !== value.billDigest)
    throw new FederationError("OPERATION_CONFLICT");
  if (value.kind === "commercial-settlement") {
    assertArbitratedSettlement(value, bill.payload, bill.digest, decision);
    const [terminal] = await tx
      .select()
      .from(terminals)
      .where(and(eq(terminals.localSiteId, siteId), eq(terminals.reservationId, b.reservationId)));
    if (
      value.terminal
        ? !terminal?.counterpartyJws ||
          value.terminal.terminalId !== terminal.terminalId ||
          value.terminal.digest !== terminal.digest
        : b.mode === "ledger_coordinated"
    )
      throw new FederationError("OPERATION_CONFLICT");
  } else {
    const [settlement] = await tx
      .select()
      .from(settlements)
      .where(
        and(
          eq(settlements.localSiteId, siteId),
          eq(settlements.settlementId, value.settlementId),
          eq(settlements.billId, value.billId),
          eq(settlements.localOrgId, execution.localOrgId),
        ),
      );
    const [previous] = value.previous
      ? await tx
          .select()
          .from(adjustments)
          .where(
            and(
              eq(adjustments.localSiteId, siteId),
              eq(adjustments.adjustmentId, value.previous.adjustmentId),
              eq(adjustments.settlementId, value.settlementId),
              eq(adjustments.localOrgId, execution.localOrgId),
            ),
          )
      : [];
    if (
      !settlement?.appliedAt ||
      settlement.digest !== value.settlementDigest ||
      (value.previous && (!previous?.appliedAt || previous.digest !== value.previous.digest)) ||
      value.previousChargedAmount !==
        (previous?.payload.chargedAmount ?? settlement.payload.chargedAmount)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  return decision;
}
