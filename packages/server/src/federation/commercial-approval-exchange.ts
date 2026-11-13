import { randomUUID } from "node:crypto";
import {
  federationCommercialAdjustments as adjustments,
  federationCommercialExecutionApprovals as approvals,
  federationArbitrationPolicies as arbitrationPolicies,
  auditLog,
  federationCommercialBills as bills,
  federationCommercialAgreements as contracts,
  federationDisclosures as disclosures,
  federationDisputeResolutions as disputeResolutions,
  type PgDb,
  type PgTransaction,
  federationCommercialPayments as payments,
  federationDisclosurePolicies as policies,
  federationCasePublications as publications,
  federationCommercialRefunds as refunds,
  federationCommercialSettlements as settlements,
  federationSites as sites,
  federationCommercialApprovalSyncs as syncs,
} from "@kuintessence/db";
import { assertFederationStatusQueryFresh, FederationError } from "@kuintessence/shared/federation";
import { CommercialArbitrationPolicySchema } from "@kuintessence/shared/federation/arbitration-policy";
import { CasePublicationSchema } from "@kuintessence/shared/federation/case-ledger";
import {
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialExecutionApprovalSchema,
  CommercialPaymentSchema,
  CommercialRefundSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialApprovalQuerySchema,
  CommercialApprovalWaitingSchema,
} from "@kuintessence/shared/federation/commercial-approval-exchange";
import { CommercialDisclosureSchema } from "@kuintessence/shared/federation/disclosure";
import { CommercialDisclosurePolicySchema } from "@kuintessence/shared/federation/disclosure-authorization";
import { CommercialDisputeResolutionSchema } from "@kuintessence/shared/federation/dispute-resolution";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { FederationAdjustmentService } from "./adjustment";
import { FederationArbitrationPolicyService } from "./arbitration-policy";
import { federationMaterialDigest } from "./assets";
import { FederationBillingService } from "./billing";
import type { FederationCasePublicationService } from "./case-publications";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialExecutionService } from "./commercial-execution";
import { FederationDisclosureService } from "./disclosure";
import { FederationDisclosurePolicyService } from "./disclosure-policy";
import { FederationDisputeResolutionService } from "./dispute-resolution";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { FederationPaymentService } from "./payment";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { FederationRefundService } from "./refund";
import { FederationSettlementService } from "./settlement";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

import { unreservedExecutionClosed } from "./unreserved-closure";

type Sync = typeof syncs.$inferSelect;
type Identity = Pick<Sync, "agreementRevisionId" | "recordKind" | "recordId">;
const businessSchema = z.union([
  CommercialDisputeResolutionSchema,
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialExecutionApprovalSchema,
  CommercialBillSchema,
  CommercialSettlementSchema,
  CommercialPaymentSchema,
  CommercialRefundSchema,
  CommercialDisclosurePolicySchema,
  CommercialArbitrationPolicySchema,
  CommercialDisclosureSchema,
  CasePublicationSchema,
]);
const responseSchema = z.union([businessSchema, CommercialApprovalWaitingSchema]);
class ApprovalLeaseLost extends Error {}

/** Exchanges only existing signatures for the identical record; never creates business approval. */
export class FederationCommercialApprovalExchange {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
    private readonly cases?: FederationCasePublicationService,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(identity: Pick<Sync, "recordKind" | "recordId">) {
    return and(
      eq(syncs.localSiteId, this.signing.siteId),
      eq(syncs.recordKind, identity.recordKind),
      eq(syncs.recordId, identity.recordId),
    );
  }

  private async record(tx: PgTransaction, identity: Identity) {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.revisionId, identity.agreementRevisionId),
        ),
      )
      .for("share");
    if (!contract) return null;
    const terms = CommercialAgreementSchema.parse(contract.terms);
    const other =
      terms.agreement.sourceSiteId === this.signing.siteId
        ? terms.agreement.targetSiteId
        : terms.agreement.sourceSiteId;
    if (![terms.agreement.sourceSiteId, terms.agreement.targetSiteId].includes(this.signing.siteId))
      throw new FederationError("POLICY_DENIED");
    if (
      ["agreement", "reservation"].includes(identity.recordKind) &&
      Date.parse(terms.agreement.validUntil) <= Date.now()
    )
      throw new FederationError("AUTHORIZATION_EXPIRED");
    if (identity.recordKind === "agreement") {
      if (identity.recordId !== identity.agreementRevisionId)
        throw new FederationError("INVALID_MESSAGE");
      return {
        contract,
        other,
        payload: terms,
        digest: contract.digest,
        approvalJws: contract.approvalJws,
        counterpartyJws: contract.counterpartyJws,
      };
    }
    if (identity.recordKind === "dispute-resolution") {
      const record = await new FederationDisputeResolutionService(
        this.db,
        this.signing,
      ).exchangeRecord(tx, contract.localOrgId, identity.agreementRevisionId, identity.recordId);
      if (!record) return null;
      return {
        contract,
        other: record.other,
        payload: record.row.payload,
        digest: record.row.digest,
        approvalJws: record.row.approvalJws,
        counterpartyJws: record.row.counterpartyJws,
      };
    }
    if (identity.recordKind === "case-publication") {
      if (!this.cases) throw new FederationError("ASSET_UNAVAILABLE");
      const record = await this.cases.exchangeRecord(
        tx,
        contract.localOrgId,
        identity.agreementRevisionId,
        identity.recordId,
      );
      if (!record) return null;
      return {
        contract,
        other: record.other,
        payload: record.row.payload,
        digest: record.row.digest,
        approvalJws: record.row.approvalJws,
        counterpartyJws: record.row.counterpartyJws,
      };
    }
    if (
      identity.recordKind === "arbitration-policy" ||
      identity.recordKind === "disclosure-policy" ||
      identity.recordKind === "disclosure"
    ) {
      const service =
        identity.recordKind === "arbitration-policy"
          ? new FederationArbitrationPolicyService(this.db, this.signing)
          : identity.recordKind === "disclosure-policy"
            ? new FederationDisclosurePolicyService(this.db, this.signing)
            : new FederationDisclosureService(this.db, this.signing);
      const record = await service.exchangeRecord(
        tx,
        contract.localOrgId,
        identity.agreementRevisionId,
        identity.recordId,
      );
      if (!record) return null;
      return {
        contract,
        other: record.other,
        payload: record.row.payload,
        digest: record.row.digest,
        approvalJws: record.row.approvalJws,
        counterpartyJws: record.row.counterpartyJws,
      };
    }
    if (identity.recordKind === "adjustment") {
      const [record] = await tx
        .select()
        .from(adjustments)
        .where(
          and(
            eq(adjustments.localSiteId, this.signing.siteId),
            eq(adjustments.adjustmentId, identity.recordId),
            eq(adjustments.agreementRevisionId, identity.agreementRevisionId),
            eq(adjustments.localOrgId, contract.localOrgId),
          ),
        );
      if (!record) return null;
      if (!record.approvalJws || record.arbitrationDecisionId)
        throw new FederationError("POLICY_DENIED");
      const payload = CommercialAdjustmentSchema.parse(record.payload);
      if (
        !contract.counterpartyJws ||
        payload.adjustmentId !== identity.recordId ||
        payload.domainId !== terms.domainId ||
        payload.agreementRevisionId !== identity.agreementRevisionId ||
        payload.sourceSiteId !== terms.agreement.sourceSiteId ||
        payload.targetSiteId !== terms.agreement.targetSiteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        contract,
        other,
        payload,
        digest: record.digest,
        approvalJws: record.approvalJws,
        counterpartyJws: record.counterpartyJws,
      };
    }
    if (identity.recordKind === "refund") {
      const [record] = await tx
        .select()
        .from(refunds)
        .where(
          and(
            eq(refunds.localSiteId, this.signing.siteId),
            eq(refunds.refundId, identity.recordId),
            eq(refunds.agreementRevisionId, identity.agreementRevisionId),
            eq(refunds.localOrgId, contract.localOrgId),
          ),
        );
      if (!record) return null;
      const payload = CommercialRefundSchema.parse(record.payload);
      if (
        !contract.counterpartyJws ||
        payload.refundId !== identity.recordId ||
        payload.domainId !== terms.domainId ||
        payload.agreementDigest !== contract.digest ||
        payload.request.agreementRevisionId !== identity.agreementRevisionId ||
        payload.request.senderSiteId !== terms.agreement.sourceSiteId ||
        payload.request.recipientSiteId !== terms.agreement.targetSiteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        contract,
        other,
        payload,
        digest: record.digest,
        approvalJws: record.approvalJws,
        counterpartyJws: record.counterpartyJws,
      };
    }
    if (identity.recordKind === "payment") {
      const [record] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.localSiteId, this.signing.siteId),
            eq(payments.receiptId, identity.recordId),
            eq(payments.agreementRevisionId, identity.agreementRevisionId),
            eq(payments.localOrgId, contract.localOrgId),
          ),
        );
      if (!record) return null;
      const payload = CommercialPaymentSchema.parse(record.payload);
      if (
        !contract.counterpartyJws ||
        payload.receiptId !== identity.recordId ||
        payload.domainId !== terms.domainId ||
        payload.agreementRevisionId !== identity.agreementRevisionId ||
        payload.sourceSiteId !== terms.agreement.sourceSiteId ||
        payload.targetSiteId !== terms.agreement.targetSiteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        contract,
        other,
        payload,
        digest: record.digest,
        approvalJws: record.approvalJws,
        counterpartyJws: record.counterpartyJws,
      };
    }
    if (identity.recordKind === "settlement") {
      const [record] = await tx
        .select()
        .from(settlements)
        .where(
          and(
            eq(settlements.localSiteId, this.signing.siteId),
            eq(settlements.settlementId, identity.recordId),
            eq(settlements.agreementRevisionId, identity.agreementRevisionId),
            eq(settlements.localOrgId, contract.localOrgId),
          ),
        );
      if (!record) return null;
      if (!record.approvalJws || record.arbitrationDecisionId)
        throw new FederationError("POLICY_DENIED");
      const payload = CommercialSettlementSchema.parse(record.payload);
      if (
        !contract.counterpartyJws ||
        payload.settlementId !== identity.recordId ||
        payload.domainId !== terms.domainId ||
        payload.agreementRevisionId !== identity.agreementRevisionId ||
        payload.sourceSiteId !== terms.agreement.sourceSiteId ||
        payload.targetSiteId !== terms.agreement.targetSiteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        contract,
        other,
        payload,
        digest: record.digest,
        approvalJws: record.approvalJws,
        counterpartyJws: record.counterpartyJws,
      };
    }
    if (identity.recordKind === "bill") {
      // The signed payload is immutable. Avoid taking a bill lock before its usage-head lock.
      const [record] = await tx
        .select()
        .from(bills)
        .where(
          and(
            eq(bills.localSiteId, this.signing.siteId),
            eq(bills.billId, identity.recordId),
            eq(bills.agreementRevisionId, identity.agreementRevisionId),
            eq(bills.localOrgId, contract.localOrgId),
          ),
        );
      if (!record) return null;
      const payload = CommercialBillSchema.parse(record.payload);
      if (
        !contract.counterpartyJws ||
        payload.billId !== identity.recordId ||
        payload.domainId !== terms.domainId ||
        payload.agreementDigest !== contract.digest ||
        payload.priceVersionId !== terms.priceVersionId ||
        payload.request.agreementRevisionId !== identity.agreementRevisionId ||
        payload.request.senderSiteId !== terms.agreement.sourceSiteId ||
        payload.request.recipientSiteId !== terms.agreement.targetSiteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        contract,
        other,
        payload,
        digest: record.digest,
        approvalJws: record.approvalJws,
        counterpartyJws: record.counterpartyJws,
      };
    }
    const [record] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          eq(approvals.recordId, identity.recordId),
          eq(approvals.agreementRevisionId, identity.agreementRevisionId),
          eq(approvals.localOrgId, contract.localOrgId),
        ),
      )
      .for("share");
    if (!record) return null;
    const payload = CommercialExecutionApprovalSchema.parse(record.payload);
    if (await unreservedExecutionClosed(tx, this.signing.siteId, payload))
      throw new FederationError("CANCELLATION_REQUESTED");
    if (
      payload.kind !== `commercial-${identity.recordKind}` ||
      payload.domainId !== terms.domainId ||
      !contract.counterpartyJws ||
      terms.agreement.mode !== "ledger_coordinated"
    )
      throw new FederationError("OPERATION_CONFLICT");
    const source =
      payload.kind === "commercial-reservation"
        ? payload.request.senderSiteId
        : payload.sourceSiteId;
    const target =
      payload.kind === "commercial-reservation"
        ? payload.request.recipientSiteId
        : payload.targetSiteId;
    if (source !== terms.agreement.sourceSiteId || target !== terms.agreement.targetSiteId)
      throw new FederationError("OPERATION_CONFLICT");
    if (
      payload.kind === "commercial-reservation" &&
      (payload.reservationId !== identity.recordId ||
        payload.request.agreementRevisionId !== identity.agreementRevisionId ||
        payload.agreementDigest !== contract.digest)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (payload.kind === "commercial-release" && payload.releaseId !== identity.recordId)
      throw new FederationError("OPERATION_CONFLICT");
    return {
      contract,
      other,
      payload,
      digest: record.digest,
      approvalJws: record.approvalJws,
      counterpartyJws: record.counterpartyJws,
    };
  }

  async receive(jws: string, fingerprint: string) {
    const sender = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      new Date(),
    );
    const { payload: query, digest } = await verifyFederationMessage(
      CommercialApprovalQuerySchema,
      jws,
      sender,
      new Date(),
    );
    if (query.senderSiteId !== sender.siteId || query.recipientSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    return this.db.transaction(async (tx) => {
      for (const site of [sender.siteId, this.signing.siteId].sort()) {
        if (site === sender.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, sender.keyId, new Date());
        else await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
      }
      const peer = await this.trust.resolveKey(sender.siteId, sender.keyId, new Date(), tx);
      await verifyFederationMessage(CommercialApprovalQuerySchema, jws, peer, new Date());
      assertFederationStatusQueryFresh(query, new Date());
      const record = await this.record(tx, query);
      if (!record) {
        const own = await this.trust.resolveKey(
          this.signing.siteId,
          this.signing.keyId,
          new Date(),
          tx,
        );
        const { kind: _kind, issuedAt: _issued, expiresAt: _expires, ...identity } = query;
        const response = CommercialApprovalWaitingSchema.parse({
          ...identity,
          kind: "commercial-approval-waiting",
          senderSiteId: this.signing.siteId,
          recipientSiteId: sender.siteId,
          queryDigest: digest,
          observedAt: new Date().toISOString(),
        });
        const signed = await signFederationMessage(
          CommercialApprovalWaitingSchema,
          response,
          this.signing,
        );
        await verifyFederationMessage(CommercialApprovalWaitingSchema, signed, own, new Date());
        assertFederationStatusQueryFresh(query, new Date());
        return signed;
      }
      if (record.other !== sender.siteId) throw new FederationError("POLICY_DENIED");
      if (record.digest !== query.recordDigest || record.contract.terms.domainId !== query.domainId)
        throw new FederationError("OPERATION_CONFLICT");
      const keyId = federationMessageKeyId(record.approvalJws);
      await this.trust.assertKey(tx, this.signing.siteId, keyId, new Date());
      const own = await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx);
      const verified = await verifyFederationMessage(
        businessSchema,
        record.approvalJws,
        own,
        new Date(),
      );
      if (
        verified.digest !== record.digest ||
        federationMaterialDigest(verified.payload) !== federationMaterialDigest(record.payload)
      )
        throw new FederationError("OPERATION_CONFLICT");
      assertFederationStatusQueryFresh(query, new Date());
      return record.approvalJws;
    });
  }

  async discover() {
    if (!this.send) return;
    // Serialize discovery with countersignature attachment so no stale queue appears after closure.
    await this.db.transaction(async (tx) => {
      const agreements = await tx
        .select({
          localSiteId: contracts.localSiteId,
          agreementRevisionId: contracts.revisionId,
          recordId: contracts.revisionId,
        })
        .from(contracts)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, contracts.localSiteId),
            eq(syncs.recordKind, "agreement"),
            eq(syncs.recordId, contracts.revisionId),
          ),
        )
        .where(
          and(
            eq(contracts.localSiteId, this.signing.siteId),
            isNull(contracts.counterpartyJws),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(contracts.revisionId))
        .limit(8)
        .for("update", { of: contracts, skipLocked: true });
      if (agreements.length)
        await tx
          .insert(syncs)
          .values(agreements.map((v) => ({ ...v, recordKind: "agreement" as const })))
          .onConflictDoNothing();
      const billing = await tx
        .select({
          localSiteId: bills.localSiteId,
          agreementRevisionId: bills.agreementRevisionId,
          recordId: bills.billId,
        })
        .from(bills)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, bills.localSiteId),
            eq(syncs.recordKind, "bill"),
            eq(syncs.recordId, bills.billId),
          ),
        )
        .where(
          and(
            eq(bills.localSiteId, this.signing.siteId),
            isNull(bills.counterpartyJws),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(bills.billId))
        .limit(8)
        .for("update", { of: bills, skipLocked: true });
      if (billing.length)
        await tx
          .insert(syncs)
          .values(billing.map((v) => ({ ...v, recordKind: "bill" as const })))
          .onConflictDoNothing();
      const pendingRefunds = await tx
        .select({
          localSiteId: refunds.localSiteId,
          agreementRevisionId: refunds.agreementRevisionId,
          recordId: refunds.refundId,
        })
        .from(refunds)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, refunds.localSiteId),
            eq(syncs.recordKind, "refund"),
            eq(syncs.recordId, refunds.refundId),
          ),
        )
        .where(
          and(
            eq(refunds.localSiteId, this.signing.siteId),
            isNull(refunds.counterpartyJws),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(refunds.refundId))
        .limit(8)
        .for("update", { of: refunds, skipLocked: true });
      if (pendingRefunds.length)
        await tx
          .insert(syncs)
          .values(pendingRefunds.map((v) => ({ ...v, recordKind: "refund" as const })))
          .onConflictDoNothing();
      const pendingResolutions = await tx
        .select({
          localSiteId: disputeResolutions.localSiteId,
          agreementRevisionId: disputeResolutions.agreementRevisionId,
          recordId: disputeResolutions.resolutionId,
        })
        .from(disputeResolutions)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, disputeResolutions.localSiteId),
            eq(syncs.recordKind, "dispute-resolution"),
            eq(syncs.recordId, disputeResolutions.resolutionId),
          ),
        )
        .where(
          and(
            eq(disputeResolutions.localSiteId, this.signing.siteId),
            isNull(disputeResolutions.counterpartyJws),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(disputeResolutions.resolutionId))
        .limit(8)
        .for("update", { of: disputeResolutions, skipLocked: true });
      if (pendingResolutions.length)
        await tx
          .insert(syncs)
          .values(
            pendingResolutions.map((v) => ({ ...v, recordKind: "dispute-resolution" as const })),
          )
          .onConflictDoNothing();
      const pendingPayments = await tx
        .select({
          localSiteId: payments.localSiteId,
          agreementRevisionId: payments.agreementRevisionId,
          recordId: payments.receiptId,
        })
        .from(payments)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, payments.localSiteId),
            eq(syncs.recordKind, "payment"),
            eq(syncs.recordId, payments.receiptId),
          ),
        )
        .where(
          and(
            eq(payments.localSiteId, this.signing.siteId),
            isNull(payments.counterpartyJws),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(payments.receiptId))
        .limit(8)
        .for("update", { of: payments, skipLocked: true });
      if (pendingPayments.length)
        await tx
          .insert(syncs)
          .values(pendingPayments.map((v) => ({ ...v, recordKind: "payment" as const })))
          .onConflictDoNothing();
      const pendingSettlements = await tx
        .select({
          localSiteId: settlements.localSiteId,
          agreementRevisionId: settlements.agreementRevisionId,
          recordId: settlements.settlementId,
        })
        .from(settlements)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, settlements.localSiteId),
            eq(syncs.recordKind, "settlement"),
            eq(syncs.recordId, settlements.settlementId),
          ),
        )
        .where(
          and(
            eq(settlements.localSiteId, this.signing.siteId),
            isNull(settlements.counterpartyJws),
            isNull(settlements.arbitrationDecisionId),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(settlements.settlementId))
        .limit(8)
        .for("update", { of: settlements, skipLocked: true });
      if (pendingSettlements.length)
        await tx
          .insert(syncs)
          .values(pendingSettlements.map((v) => ({ ...v, recordKind: "settlement" as const })))
          .onConflictDoNothing();
      const pendingAdjustments = await tx
        .select({
          localSiteId: adjustments.localSiteId,
          agreementRevisionId: adjustments.agreementRevisionId,
          recordId: adjustments.adjustmentId,
        })
        .from(adjustments)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, adjustments.localSiteId),
            eq(syncs.recordKind, "adjustment"),
            eq(syncs.recordId, adjustments.adjustmentId),
          ),
        )
        .where(
          and(
            eq(adjustments.localSiteId, this.signing.siteId),
            isNull(adjustments.counterpartyJws),
            isNull(adjustments.arbitrationDecisionId),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(adjustments.adjustmentId))
        .limit(8)
        .for("update", { of: adjustments, skipLocked: true });
      if (pendingAdjustments.length)
        await tx
          .insert(syncs)
          .values(pendingAdjustments.map((v) => ({ ...v, recordKind: "adjustment" as const })))
          .onConflictDoNothing();
      const pendingArbitrationPolicies = await tx
        .select({
          localSiteId: arbitrationPolicies.localSiteId,
          agreementRevisionId: arbitrationPolicies.agreementRevisionId,
          recordId: arbitrationPolicies.policyId,
        })
        .from(arbitrationPolicies)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, arbitrationPolicies.localSiteId),
            eq(syncs.recordKind, "arbitration-policy"),
            eq(syncs.recordId, arbitrationPolicies.policyId),
          ),
        )
        .where(
          and(
            eq(arbitrationPolicies.localSiteId, this.signing.siteId),
            isNull(arbitrationPolicies.counterpartyJws),
            isNull(arbitrationPolicies.revokedAt),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(arbitrationPolicies.policyId))
        .limit(8)
        .for("update", { of: arbitrationPolicies, skipLocked: true });
      if (pendingArbitrationPolicies.length)
        await tx
          .insert(syncs)
          .values(
            pendingArbitrationPolicies.map((v) => ({
              ...v,
              recordKind: "arbitration-policy" as const,
            })),
          )
          .onConflictDoNothing();
      const pendingPolicies = await tx
        .select({
          localSiteId: policies.localSiteId,
          agreementRevisionId: policies.agreementRevisionId,
          recordId: policies.policyId,
        })
        .from(policies)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, policies.localSiteId),
            eq(syncs.recordKind, "disclosure-policy"),
            eq(syncs.recordId, policies.policyId),
          ),
        )
        .where(
          and(
            eq(policies.localSiteId, this.signing.siteId),
            isNull(policies.counterpartyJws),
            isNull(policies.revokedAt),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(policies.policyId))
        .limit(8)
        .for("update", { of: policies, skipLocked: true });
      if (pendingPolicies.length)
        await tx
          .insert(syncs)
          .values(pendingPolicies.map((v) => ({ ...v, recordKind: "disclosure-policy" as const })))
          .onConflictDoNothing();
      const pendingDisclosures = await tx
        .select({
          localSiteId: disclosures.localSiteId,
          agreementRevisionId: disclosures.agreementRevisionId,
          recordId: disclosures.grantId,
        })
        .from(disclosures)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, disclosures.localSiteId),
            eq(syncs.recordKind, "disclosure"),
            eq(syncs.recordId, disclosures.grantId),
          ),
        )
        .where(
          and(
            eq(disclosures.localSiteId, this.signing.siteId),
            isNull(disclosures.counterpartyJws),
            isNull(disclosures.revokedAt),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(disclosures.grantId))
        .limit(8)
        .for("update", { of: disclosures, skipLocked: true });
      if (pendingDisclosures.length)
        await tx
          .insert(syncs)
          .values(pendingDisclosures.map((v) => ({ ...v, recordKind: "disclosure" as const })))
          .onConflictDoNothing();
      if (this.cases) {
        const pending = await tx
          .select({
            localSiteId: publications.localSiteId,
            agreementRevisionId: publications.agreementRevisionId,
            recordId: publications.publicationId,
          })
          .from(publications)
          .leftJoin(
            syncs,
            and(
              eq(syncs.localSiteId, publications.localSiteId),
              eq(syncs.recordKind, "case-publication"),
              eq(syncs.recordId, publications.publicationId),
            ),
          )
          .where(
            and(
              eq(publications.localSiteId, this.signing.siteId),
              isNull(publications.counterpartyJws),
              isNull(publications.revokedAt),
              isNull(syncs.recordId),
            ),
          )
          .orderBy(asc(publications.publicationId))
          .limit(8)
          .for("update", { of: publications, skipLocked: true });
        if (pending.length)
          await tx
            .insert(syncs)
            .values(pending.map((value) => ({ ...value, recordKind: "case-publication" as const })))
            .onConflictDoNothing();
      }
      const executions = await tx
        .select({
          localSiteId: approvals.localSiteId,
          agreementRevisionId: approvals.agreementRevisionId,
          recordId: approvals.recordId,
          payload: approvals.payload,
        })
        .from(approvals)
        .leftJoin(
          syncs,
          and(
            eq(syncs.localSiteId, approvals.localSiteId),
            eq(syncs.recordId, approvals.recordId),
            sql`'commercial-' || ${syncs.recordKind} = ${approvals.payload}->>'kind'`,
          ),
        )
        .where(
          and(
            eq(approvals.localSiteId, this.signing.siteId),
            sql`NOT EXISTS (SELECT 1 FROM federation_unreserved_closures c WHERE c.local_site_id = ${approvals.localSiteId} AND c.demand_id::text = coalesce(${approvals.payload}->>'demandId', (SELECT original.payload->>'demandId' FROM federation_commercial_execution_approvals original WHERE original.local_site_id = ${approvals.localSiteId} AND original.record_id::text = ${approvals.payload}->>'reservationId')))`,
            isNull(approvals.counterpartyJws),
            isNull(syncs.recordId),
          ),
        )
        .orderBy(asc(approvals.recordId))
        .limit(8)
        .for("update", { of: approvals, skipLocked: true });
      for (const { payload, ...record } of executions) {
        if (await unreservedExecutionClosed(tx, this.signing.siteId, payload)) continue;
        await tx
          .insert(syncs)
          .values({
            ...record,
            recordKind: payload.kind === "commercial-reservation" ? "reservation" : "release",
          })
          .onConflictDoNothing();
      }
    });
  }

  private async lock(tx: PgTransaction, claim: Sync) {
    if (!claim.leaseToken) throw new ApprovalLeaseLost();
    const [row] = await tx
      .select()
      .from(syncs)
      .where(
        and(
          this.key(claim),
          eq(syncs.leaseToken, claim.leaseToken),
          sql`${syncs.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new ApprovalLeaseLost();
    return row;
  }

  private async source(tx: PgTransaction, claim: Sync, endpoint?: string) {
    const record = await this.record(tx, claim);
    if (!record) throw new FederationError("ASSET_UNAVAILABLE");
    const keyId = federationMessageKeyId(record.approvalJws);
    for (const site of [this.signing.siteId, record.other].sort()) {
      if (site === this.signing.siteId) {
        await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
        await this.trust.assertKey(tx, site, keyId, new Date());
      } else {
        const [peer] = await tx.select().from(sites).where(eq(sites.id, site)).for("share");
        if (peer?.state !== "active" || (endpoint && endpoint !== peer.endpoint))
          throw new FederationError("UNTRUSTED_IDENTITY");
      }
    }
    const own = await this.trust.resolveKey(
      this.signing.siteId,
      this.signing.keyId,
      new Date(),
      tx,
    );
    if (!own.allowedKinds.includes("commercial-approval-query"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const business = await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx);
    const verified = await verifyFederationMessage(
      businessSchema,
      record.approvalJws,
      business,
      new Date(),
    );
    if (
      verified.digest !== record.digest ||
      federationMaterialDigest(verified.payload) !== federationMaterialDigest(record.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [peer] = await tx.select().from(sites).where(eq(sites.id, record.other));
    if (!peer) throw new FederationError("UNTRUSTED_IDENTITY");
    return { ...record, endpoint: peer.endpoint };
  }

  private async advance(claim: Sync) {
    if (!this.send) return;
    const scope = await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      return this.source(tx, claim);
    });
    const issuedAt = new Date();
    const query = CommercialApprovalQuerySchema.parse({
      protocolVersion: 1,
      kind: "commercial-approval-query",
      queryId: randomUUID(),
      senderSiteId: this.signing.siteId,
      recipientSiteId: scope.other,
      agreementRevisionId: claim.agreementRevisionId,
      domainId: scope.contract.terms.domainId,
      recordKind: claim.recordKind,
      recordId: claim.recordId,
      recordDigest: scope.digest,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 60000).toISOString(),
    });
    const own = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date());
    const request = await signFederationMessage(CommercialApprovalQuerySchema, query, this.signing);
    const { digest } = await verifyFederationMessage(
      CommercialApprovalQuerySchema,
      request,
      own,
      new Date(),
    );
    await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      await this.source(tx, claim, scope.endpoint);
    });
    const response =
      scope.counterpartyJws ??
      (await this.send(scope.endpoint, request, "/federation/v1/commercial-approvals"));
    const peerId = federationMessageKeyId(response);
    const peer = await this.trust.resolveKey(scope.other, peerId, new Date());
    const verified = await verifyFederationMessage(responseSchema, response, peer, new Date());
    const authorize = async (tx: PgTransaction, complete: boolean) => {
      await this.lock(tx, claim);
      const current = await this.source(tx, claim, scope.endpoint);
      if (current.digest !== scope.digest || current.approvalJws !== scope.approvalJws)
        throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertKey(tx, scope.other, peerId, new Date());
      const currentPeer = await this.trust.resolveKey(scope.other, peerId, new Date(), tx);
      await verifyFederationMessage(responseSchema, response, currentPeer, new Date());
      assertFederationStatusQueryFresh(query, new Date());
      await tx
        .update(syncs)
        .set({
          state: complete ? "complete" : "pending",
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
          verifiedAt: complete ? new Date() : null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(claim));
    };
    if (verified.payload.kind === "commercial-approval-waiting") {
      const waiting = verified.payload;
      if (
        waiting.senderSiteId !== scope.other ||
        waiting.recipientSiteId !== this.signing.siteId ||
        waiting.queryDigest !== digest ||
        waiting.queryId !== query.queryId ||
        waiting.recordId !== query.recordId ||
        waiting.recordKind !== query.recordKind ||
        waiting.agreementRevisionId !== query.agreementRevisionId ||
        waiting.domainId !== query.domainId ||
        waiting.recordDigest !== query.recordDigest ||
        Date.parse(waiting.observedAt) < Date.parse(query.issuedAt) - 60000 ||
        Date.parse(waiting.observedAt) > Date.now() + 60000
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.db.transaction((tx) => authorize(tx, false));
      return;
    }
    if (
      verified.digest !== scope.digest ||
      federationMaterialDigest(verified.payload) !== federationMaterialDigest(scope.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (claim.recordKind === "agreement")
      await new FederationCommercialAgreementService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        response,
        (tx) => authorize(tx, true),
      );
    else if (claim.recordKind === "dispute-resolution")
      await new FederationDisputeResolutionService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        claim.recordId,
        response,
        (tx) => authorize(tx, true),
      );
    else if (claim.recordKind === "case-publication") {
      if (!this.cases) throw new FederationError("ASSET_UNAVAILABLE");
      await this.cases.attachExchanged(claim.agreementRevisionId, claim.recordId, response, (tx) =>
        authorize(tx, true),
      );
    } else if (
      claim.recordKind === "arbitration-policy" ||
      claim.recordKind === "disclosure-policy" ||
      claim.recordKind === "disclosure"
    ) {
      const service =
        claim.recordKind === "arbitration-policy"
          ? new FederationArbitrationPolicyService(this.db, this.signing)
          : claim.recordKind === "disclosure-policy"
            ? new FederationDisclosurePolicyService(this.db, this.signing)
            : new FederationDisclosureService(this.db, this.signing);
      await service.attachExchanged(claim.agreementRevisionId, claim.recordId, response, (tx) =>
        authorize(tx, true),
      );
    } else if (claim.recordKind === "adjustment")
      await new FederationAdjustmentService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        claim.recordId,
        response,
        (tx) => authorize(tx, true),
      );
    else if (claim.recordKind === "refund")
      await new FederationRefundService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        claim.recordId,
        response,
        (tx) => authorize(tx, true),
      );
    else if (claim.recordKind === "payment")
      await new FederationPaymentService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        claim.recordId,
        response,
        (tx) => authorize(tx, true),
      );
    else if (claim.recordKind === "settlement")
      await new FederationSettlementService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        claim.recordId,
        response,
        (tx) => authorize(tx, true),
      );
    else if (claim.recordKind === "bill")
      await new FederationBillingService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        claim.recordId,
        response,
        (tx) => authorize(tx, true),
      );
    else
      await new FederationCommercialExecutionService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        claim.recordId,
        response,
        (tx) => authorize(tx, true),
      );
  }

  async advanceNext() {
    if (!this.send) return false;
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(syncs)
        .where(
          and(
            eq(syncs.localSiteId, this.signing.siteId),
            eq(syncs.state, "pending"),
            sql`${syncs.nextAttemptAt} <= clock_timestamp()`,
            sql`(${syncs.leaseUntil} IS NULL OR ${syncs.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(syncs.nextAttemptAt), asc(syncs.recordKind), asc(syncs.recordId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(syncs)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(row))
        .returning();
      return saved;
    });
    if (!claim) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof ApprovalLeaseLost || !claim.leaseToken) return true;
      const review =
        error instanceof FederationError ||
        error instanceof z.ZodError ||
        (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      await this.db
        .update(syncs)
        .set({
          state: review ? "needs_review" : "pending",
          lastError:
            error instanceof FederationError || error instanceof FederationDeliveryError
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "EXCHANGE_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim),
            eq(syncs.leaseToken, claim.leaseToken),
            sql`${syncs.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }

  async list(
    actor: FederationActor,
    revisionId: string,
    limit: number,
    offset: number,
    kind?: "case-publication",
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, kind ? "case.publish" : "agreement.read");
      const [contract] = await tx
        .select()
        .from(contracts)
        .where(
          and(
            eq(contracts.localSiteId, this.signing.siteId),
            eq(contracts.revisionId, revisionId),
            eq(contracts.localOrgId, actor.orgId),
          ),
        );
      if (!contract) throw new FederationError("AGREEMENT_UNAVAILABLE");
      const rows = await tx
        .select({
          recordKind: syncs.recordKind,
          recordId: syncs.recordId,
          state: syncs.state,
          lastError: syncs.lastError,
          nextAttemptAt: syncs.nextAttemptAt,
          verifiedAt: syncs.verifiedAt,
        })
        .from(syncs)
        .where(
          and(
            eq(syncs.localSiteId, this.signing.siteId),
            eq(syncs.agreementRevisionId, revisionId),
            kind ? eq(syncs.recordKind, kind) : undefined,
          ),
        )
        .orderBy(asc(syncs.recordKind), asc(syncs.recordId))
        .limit(limit)
        .offset(offset);
      return { enabled: !!this.send, records: rows };
    });
  }
  async retry(actor: FederationActor, identity: Identity) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(
        tx,
        actor,
        identity.recordKind === "dispute-resolution"
          ? "dispute.resolve"
          : identity.recordKind === "arbitration-policy"
            ? "arbitration.approve"
            : identity.recordKind === "case-publication"
              ? "case.publish"
              : identity.recordKind === "disclosure-policy" || identity.recordKind === "disclosure"
                ? "disclosure.approve"
                : identity.recordKind === "payment"
                  ? "payment.approve"
                  : identity.recordKind === "adjustment"
                    ? "adjustment.approve"
                    : identity.recordKind === "settlement" || identity.recordKind === "refund"
                      ? "settlement.approve"
                      : identity.recordKind === "bill"
                        ? "billing.approve"
                        : "agreement.approve",
      );
      const [existing] = await tx
        .select()
        .from(syncs)
        .where(and(this.key(identity), eq(syncs.agreementRevisionId, identity.agreementRevisionId)))
        .for("update");
      if (!existing) throw new FederationError("ASSET_UNAVAILABLE");
      const record = await this.record(tx, identity);
      if (!record || record.contract.localOrgId !== actor.orgId)
        throw new FederationError("POLICY_DENIED");
      const [row] = await tx
        .update(syncs)
        .set({
          state: "pending",
          lastError: null,
          nextAttemptAt: sql`clock_timestamp()`,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(
          and(
            this.key(identity),
            eq(syncs.agreementRevisionId, identity.agreementRevisionId),
            sql`${syncs.state} <> 'complete'`,
            sql`(${syncs.leaseUntil} IS NULL OR ${syncs.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.commercial.exchange_retry",
        target: identity.recordId,
        diff: { after: { recordKind: identity.recordKind } },
      });
    });
  }
}
