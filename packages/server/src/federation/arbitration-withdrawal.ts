import {
  auditLog,
  type PgTransaction,
  federationReceivedArbitrationDecisions as received,
  federationArbitrationResolutions as resolutions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import type { ArbitrationDecisionDelivery } from "@kuintessence/shared/federation/arbitration-decision-delivery";
import {
  type ArbitrationExecutionWithdrawalReceipt,
  ArbitrationExecutionWithdrawalReceiptSchema,
} from "@kuintessence/shared/federation/arbitration-execution";
import {
  type CommercialArbitrationResolution,
  CommercialArbitrationResolutionSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, eq } from "drizzle-orm";
import { releaseFederationAdjustmentHold } from "./adjustment";
import { arbitrationFinancialTerms } from "./arbitrated-financial-original";
import {
  verifyArbitrationHistory,
  verifyReceivedArbitrationDecision,
} from "./arbitration-decision-history";
import { lockFederationDisputeTask } from "./dispute-freeze";
import {
  type FederationSigningKey,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import type { FederationTrustRegistry } from "./trust-registry";

export function receivedArbitrationResolution(value: ArbitrationDecisionDelivery) {
  const decision = value.decision,
    b = decision.intent.binding;
  return CommercialArbitrationResolutionSchema.parse({
    decisionId: value.decisionId,
    decisionDigest: value.decisionDigest,
    caseId: b.caseId,
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
}

/** B's permanent tombstone and release of the exact local hold are one audited transaction. */
export async function applyArbitrationWithdrawal(
  tx: PgTransaction,
  siteId: string,
  value: CommercialArbitrationResolution,
  receipt: ArbitrationExecutionWithdrawalReceipt,
  receiptJws: string,
) {
  await lockFederationDisputeTask(tx, siteId, value);
  const [execution] = await tx
    .select()
    .from(resolutions)
    .where(and(eq(resolutions.localSiteId, siteId), eq(resolutions.decisionId, value.decisionId)))
    .for("update");
  const [original] = await tx
    .select()
    .from(received)
    .where(and(eq(received.localSiteId, siteId), eq(received.decisionId, value.decisionId)))
    .for("update");
  if (!original) throw new FederationError("DATA_WAITING");
  const proof = await verifyArbitrationHistory(
    tx,
    ArbitrationExecutionWithdrawalReceiptSchema,
    receiptJws,
    value.targetSiteId,
    new Date(receipt.withdrawnAt),
  );
  if (
    federationCanonicalJson(proof.payload) !== federationCanonicalJson(receipt) ||
    federationCanonicalJson(receipt.resolution) !== federationCanonicalJson(value) ||
    federationCanonicalJson(receivedArbitrationResolution(original.payload)) !==
      federationCanonicalJson(value) ||
    Date.parse(receipt.withdrawnAt) < Date.parse(original.payload.decision.issuedAt) ||
    Date.parse(receipt.withdrawnAt) > Date.now() + 60000 ||
    execution?.appliedAt ||
    execution?.executionReceipt ||
    (execution && federationCanonicalJson(execution.payload) !== federationCanonicalJson(value))
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (original.executionWithdrawal) {
    if (
      original.executionWithdrawalJws !== receiptJws ||
      federationCanonicalJson(original.executionWithdrawal) !== federationCanonicalJson(receipt)
    )
      throw new FederationError("OPERATION_CONFLICT");
    return;
  }
  await verifyReceivedArbitrationDecision(tx, original.payload, siteId);
  if (execution && BigInt(execution.heldAmount) > 0n) {
    const terms = await arbitrationFinancialTerms(
      tx,
      siteId,
      execution.localOrgId,
      original.payload.decision,
    );
    if (terms.payload.kind !== "commercial-adjustment")
      throw new FederationError("OPERATION_CONFLICT");
    await releaseFederationAdjustmentHold(tx, { ...execution, payload: terms.payload });
  }
  await tx
    .update(received)
    .set({ executionWithdrawal: receipt, executionWithdrawalJws: receiptJws })
    .where(and(eq(received.localSiteId, siteId), eq(received.decisionId, value.decisionId)));
  if (execution)
    await tx
      .update(resolutions)
      .set({ leaseToken: null, leaseUntil: null, lastError: null })
      .where(
        and(eq(resolutions.localSiteId, siteId), eq(resolutions.decisionId, value.decisionId)),
      );
  await tx.insert(auditLog).values({
    actor: `arbitration-withdrawal:${siteId}`,
    orgId: original.localOrgId,
    action: "federation.arbitration_execution.withdraw",
    target: value.decisionId,
    diff: {
      after: { decisionDigest: value.decisionDigest, requestingSiteId: receipt.requestingSiteId },
    },
  });
}

export async function createArbitrationWithdrawal(
  tx: PgTransaction,
  signing: FederationSigningKey,
  value: CommercialArbitrationResolution,
  requestingSiteId: string,
  trust: FederationTrustRegistry,
) {
  if (signing.siteId !== value.targetSiteId) throw new FederationError("POLICY_DENIED");
  await lockFederationDisputeTask(tx, signing.siteId, value);
  const [original] = await tx
    .select()
    .from(received)
    .where(
      and(eq(received.localSiteId, signing.siteId), eq(received.decisionId, value.decisionId)),
    );
  if (original?.executionWithdrawal && original.executionWithdrawalJws) {
    await applyArbitrationWithdrawal(
      tx,
      signing.siteId,
      value,
      original.executionWithdrawal,
      original.executionWithdrawalJws,
    );
    return { receipt: original.executionWithdrawal, receiptJws: original.executionWithdrawalJws };
  }
  const receipt = ArbitrationExecutionWithdrawalReceiptSchema.parse({
    protocolVersion: 1,
    kind: "arbitration-execution-withdrawal-receipt",
    resolution: value,
    requestingSiteId,
    withdrawnAt: new Date().toISOString(),
  });
  await trust.assertKey(tx, signing.siteId, signing.keyId, new Date());
  const receiptJws = await signFederationMessage(
    ArbitrationExecutionWithdrawalReceiptSchema,
    receipt,
    signing,
  );
  await verifyFederationMessage(
    ArbitrationExecutionWithdrawalReceiptSchema,
    receiptJws,
    await trust.resolveKey(signing.siteId, signing.keyId, new Date(), tx),
    new Date(),
  );
  await applyArbitrationWithdrawal(tx, signing.siteId, value, receipt, receiptJws);
  return { receipt, receiptJws };
}
