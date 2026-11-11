import { createHash } from "node:crypto";
import { compactVerify } from "jose";
import type { z } from "zod";
import { ArbitrationDecisionSchema } from "./arbitration-decision";
import { CommercialArbitrationPolicySchema } from "./arbitration-policy";
import {
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialPaymentSchema,
  CommercialRefundSchema,
  CommercialSettlementSchema,
  CommercialUsageSchema,
} from "./commercial";
import { CommercialDisputeResolutionSchema } from "./dispute-resolution";
import { CommercialDisputeFreezeSchema, CommercialDisputeSchema } from "./disputes";
import {
  type CommercialHistoryEnvelopeSchema,
  type CommercialHistoryRecovery,
  CommercialHistoryRecoverySchema,
} from "./history-recovery";
import {
  FederationAcceptanceSchema,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "./index";
import { federationMessageKeyId } from "./signatures";

type Verify = <T extends { kind: string }>(
  schema: z.ZodType<T>,
  jws: string,
  siteId: string,
) => Promise<{ payload: T; digest: string }>;
export function commercialHistoryDigest(value: unknown) {
  return `sha256:${createHash("sha256").update(federationCanonicalJson(value)).digest("hex")}`;
}

/** Integrity of preserved bytes only. Current bilateral recovery signatures supply all authority. */
export async function verifyArchivedCommercialDocument<T extends { kind: string }>(
  schema: z.ZodType<T>,
  jws: string,
  siteId: string,
  resolve: (siteId: string, keyId: string) => Promise<CryptoKey>,
) {
  const keyId = federationMessageKeyId(jws);
  try {
    const result = await compactVerify(jws, await resolve(siteId, keyId), {
      algorithms: ["RS256"],
    });
    if (result.payload.length > 262144) throw new FederationError("INVALID_MESSAGE");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.payload);
    const value: unknown = JSON.parse(text);
    if (JSON.stringify(value) !== text) throw new FederationError("INVALID_MESSAGE");
    return {
      payload: schema.parse(value),
      digest: `sha256:${createHash("sha256").update(result.payload).digest("hex")}`,
    };
  } catch (error) {
    if (error instanceof FederationError) throw error;
    throw new FederationError("INVALID_MESSAGE");
  }
}

export function originalCommercialHistoryInput(value: CommercialHistoryRecovery, text: string) {
  let original: CommercialAdapterProposalInput;
  try {
    original = CommercialAdapterProposalInputSchema.parse(JSON.parse(text));
  } catch {
    throw new FederationError("INVALID_MESSAGE");
  }
  if (
    original.operation !== value.originalOperation ||
    original.domainId !== value.domainId ||
    original.recordId !== value.originalRecordId ||
    original.digest !== value.originalDigest ||
    commercialHistoryDigest(original) !== value.originalInputDigest ||
    federationCanonicalJson(original) !== text
  )
    throw new FederationError("OPERATION_CONFLICT");
  return original;
}

export async function verifyCommercialHistoryEnvelope(
  envelope: z.infer<typeof CommercialHistoryEnvelopeSchema>,
  domainId: string,
  recoveryId: string,
  current: Verify,
  archived: Verify,
  now: Date,
) {
  const source = await current(
    CommercialHistoryRecoverySchema,
    envelope.sourceJws,
    envelope.sourceSiteId,
  );
  const target = await current(
    CommercialHistoryRecoverySchema,
    envelope.targetJws,
    envelope.targetSiteId,
  );
  const value = source.payload;
  if (
    source.digest !== target.digest ||
    value.domainId !== domainId ||
    value.recoveryId !== recoveryId ||
    value.sourceSiteId !== envelope.sourceSiteId ||
    value.targetSiteId !== envelope.targetSiteId ||
    Date.parse(value.issuedAt) > now.getTime() + 60000
  )
    throw new FederationError("POLICY_DENIED");
  const original = originalCommercialHistoryInput(value, envelope.originalInput);
  await verifyOriginalCommercialHistory(value, original, archived);
  return { payload: value, digest: source.digest, original };
}

export async function verifyOriginalCommercialHistory(
  value: CommercialHistoryRecovery,
  original: CommercialAdapterProposalInput,
  verify: Verify,
) {
  const pair = async <T extends { kind: string }>(schema: z.ZodType<T>) => {
    if (!("sourceJws" in original.envelope)) throw new FederationError("INVALID_MESSAGE");
    const first = await verify(schema, original.envelope.sourceJws, value.sourceSiteId);
    const second = await verify(schema, original.envelope.targetJws, value.targetSiteId);
    if (first.digest !== value.originalDigest || first.digest !== second.digest)
      throw new FederationError("OPERATION_CONFLICT");
    return first.payload;
  };
  const identity = (
    id: string,
    domainId: string,
    revisionId: string,
    source: string,
    target: string,
  ) => {
    if (
      id !== value.originalRecordId ||
      domainId !== value.domainId ||
      revisionId !== value.agreementRevisionId ||
      source !== value.sourceSiteId ||
      target !== value.targetSiteId
    )
      throw new FederationError("OPERATION_CONFLICT");
  };
  if (
    "sourceSiteId" in original.envelope &&
    (original.envelope.sourceSiteId !== value.sourceSiteId ||
      original.envelope.targetSiteId !== value.targetSiteId)
  )
    throw new FederationError("POLICY_DENIED");
  switch (original.operation) {
    case "register-agreement": {
      const p = await pair(CommercialAgreementSchema),
        a = p.agreement;
      if (a.mode !== "bilateral_attested") throw new FederationError("POLICY_DENIED");
      identity(
        a.agreementRevisionId,
        p.domainId,
        a.agreementRevisionId,
        a.sourceSiteId,
        a.targetSiteId,
      );
      break;
    }
    case "record-usage":
    case "record-discount": {
      const p =
        original.operation === "record-usage"
          ? await verify(CommercialUsageSchema, original.envelope.providerJws, value.targetSiteId)
          : await verify(
              CommercialDiscountSchema,
              original.envelope.providerJws,
              value.targetSiteId,
            );
      if (p.digest !== value.originalDigest) throw new FederationError("OPERATION_CONFLICT");
      identity(
        p.payload.kind === "commercial-usage" ? p.payload.reportId : p.payload.discountId,
        p.payload.domainId,
        p.payload.agreementRevisionId,
        p.payload.sourceSiteId,
        p.payload.targetSiteId,
      );
      break;
    }
    case "confirm-bill":
    case "record-refund": {
      const p =
        original.operation === "confirm-bill"
          ? await pair(CommercialBillSchema)
          : await pair(CommercialRefundSchema);
      if (p.request.mode !== "bilateral_attested") throw new FederationError("POLICY_DENIED");
      identity(
        "billId" in p ? p.billId : p.refundId,
        p.domainId,
        p.request.agreementRevisionId,
        p.request.senderSiteId,
        p.request.recipientSiteId,
      );
      break;
    }
    case "settle-bill":
    case "adjust-settlement":
    case "record-payment": {
      const p =
        original.operation === "settle-bill"
          ? await pair(CommercialSettlementSchema)
          : original.operation === "adjust-settlement"
            ? await pair(CommercialAdjustmentSchema)
            : await pair(CommercialPaymentSchema);
      identity(
        "adjustmentId" in p ? p.adjustmentId : "settlementId" in p ? p.settlementId : p.receiptId,
        p.domainId,
        p.agreementRevisionId,
        p.sourceSiteId,
        p.targetSiteId,
      );
      break;
    }
    case "record-dispute-freeze": {
      const p = await pair(CommercialDisputeFreezeSchema);
      const opening = await verify(
        CommercialDisputeSchema,
        original.envelope.openingJws,
        original.envelope.openingSiteId,
      );
      if (
        p.mode !== "bilateral_attested" ||
        p.caseDigest !== opening.digest ||
        p.caseId !== opening.payload.caseId
      )
        throw new FederationError("OPERATION_CONFLICT");
      identity(
        p.caseId,
        opening.payload.domainId,
        p.agreementRevisionId,
        p.sourceSiteId,
        p.targetSiteId,
      );
      break;
    }
    case "record-dispute-resolution": {
      const p = await pair(CommercialDisputeResolutionSchema);
      if (p.mode !== "bilateral_attested") throw new FederationError("POLICY_DENIED");
      identity(p.resolutionId, p.domainId, p.agreementRevisionId, p.sourceSiteId, p.targetSiteId);
      break;
    }
    case "record-arbitration-resolution": {
      let arbitratorSiteId: string;
      try {
        const unsigned: unknown = JSON.parse(
          Buffer.from(original.envelope.decisionJws.split(".")[1] ?? "", "base64url").toString(),
        );
        arbitratorSiteId =
          ArbitrationDecisionSchema.parse(unsigned).intent.binding.arbitratorSiteId;
      } catch {
        throw new FederationError("INVALID_MESSAGE");
      }
      const p = await verify(
        ArbitrationDecisionSchema,
        original.envelope.decisionJws,
        arbitratorSiteId,
      );
      const b = p.payload.intent.binding;
      if (p.digest !== value.originalDigest || b.mode !== "bilateral_attested")
        throw new FederationError("POLICY_DENIED");
      const request = await verify(
        FederationDelegationSchema,
        original.envelope.requestJws,
        value.sourceSiteId,
      );
      const accepted = await verify(
        FederationAcceptanceSchema,
        original.envelope.acceptanceJws,
        value.targetSiteId,
      );
      const authority = request.payload.arbitration;
      if (!authority) throw new FederationError("OPERATION_CONFLICT");
      const policy = await verify(
        CommercialArbitrationPolicySchema,
        authority.sourceJws,
        value.sourceSiteId,
      );
      const otherPolicy = await verify(
        CommercialArbitrationPolicySchema,
        authority.targetJws,
        value.targetSiteId,
      );
      if (
        request.digest !== b.requestDigest ||
        accepted.digest !== b.acceptanceDigest ||
        accepted.payload.requestDigest !== request.digest ||
        policy.digest !== b.policyDigest ||
        policy.digest !== otherPolicy.digest ||
        policy.payload.policyId !== b.policyId ||
        policy.payload.arbitratorSiteId !== b.arbitratorSiteId ||
        policy.payload.domainId !== b.domainId ||
        request.payload.senderSiteId !== value.sourceSiteId ||
        request.payload.recipientSiteId !== value.targetSiteId ||
        accepted.payload.senderSiteId !== value.targetSiteId ||
        accepted.payload.recipientSiteId !== value.sourceSiteId ||
        accepted.payload.reservationId !== b.reservationId ||
        (["agreementRevisionId", "taskId", "attempt", "operationId", "mode", "unit"] as const).some(
          (key) => request.payload[key] !== b[key] || accepted.payload[key] !== b[key],
        )
      )
        throw new FederationError("OPERATION_CONFLICT");
      identity(
        p.payload.intent.decisionId,
        b.domainId,
        b.agreementRevisionId,
        b.sourceSiteId,
        b.targetSiteId,
      );
      break;
    }
    default:
      throw new FederationError("POLICY_DENIED");
  }
}
