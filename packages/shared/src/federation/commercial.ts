import { z } from "zod";
import {
  FederationAgreementSchema,
  FederationAmountSchema,
  FederationDelegationSchema,
} from "./index";
import {
  FabricEvidenceAdvanceResultSchema,
  FabricEvidenceTrustSchema,
  FabricProposalCheckpointSchema,
  fabricEvidenceCollections,
} from "./ledger";
import { FederationDigestSchema } from "./references";

const Id = z.uuid();
const Salt = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveQuantity = z.string().regex(/^[1-9][0-9]{0,37}$/);
const Metric = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/);
/** These names are an explicit contract choice; generic legacy metrics are never reinterpreted. */
export const commercialAutomaticMeters = [
  { metric: "cpu.time", quantityUnit: "cpu-millisecond" },
  { metric: "cpu.allocated", quantityUnit: "core-millisecond" },
  { metric: "job.elapsed", quantityUnit: "job-millisecond" },
] as const;
export const CommercialSigningKindSchema = z.enum([
  "commercial-agreement",
  "commercial-usage",
  "commercial-reservation",
  "commercial-release",
  "commercial-terminal",
  "commercial-discount",
  "commercial-bill",
  "commercial-settlement",
  "commercial-adjustment",
  "commercial-refund",
  "cancellation-receipt",
]);

/** Private rates use integer amount per integer quantity; the execution agreement fixes the money unit. */
export const CommercialAgreementSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-agreement"),
    domainId: Id,
    salt: Salt,
    createdAt: z.iso.datetime(),
    agreement: FederationAgreementSchema,
    consideration: z.enum(["charity", "exchange", "paid"]),
    priceVersionId: Id,
    prices: z
      .array(
        z.strictObject({
          metric: Metric,
          quantityUnit: Metric,
          perQuantity: PositiveQuantity,
          amount: FederationAmountSchema,
        }),
      )
      .min(1)
      .max(64),
    termsText: z.string().min(1).max(65536),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.prices.map((price) => price.metric)).size !== value.prices.length)
      ctx.addIssue({ code: "custom", message: "Duplicate price metric" });
    if (value.consideration === "charity" && value.prices.some((price) => price.amount !== "0"))
      ctx.addIssue({ code: "custom", message: "Charity cannot charge a unit price" });
  });
export type CommercialAgreement = z.infer<typeof CommercialAgreementSchema>;
export const CommercialAgreementEnvelopeSchema = z.strictObject({
  sourceSiteId: Id,
  targetSiteId: Id,
  sourceJws: z.string().min(1).max(524288),
  targetJws: z.string().min(1).max(524288),
});

/** Both institutions approve the exact delegation, including its private cap and immutable material locks. */
export const CommercialReservationSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("commercial-reservation"),
  domainId: Id,
  reservationId: Id,
  demandId: Id,
  claimVersion: z.number().int().min(1).max(2147483647),
  agreementDigest: FederationDigestSchema,
  salt: Salt,
  request: FederationDelegationSchema,
});
export type CommercialReservation = z.infer<typeof CommercialReservationSchema>;
export const CommercialReleaseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("commercial-release"),
  releaseId: Id,
  domainId: Id,
  reservationId: Id,
  reservationDigest: FederationDigestSchema,
  sourceSiteId: Id,
  targetSiteId: Id,
  expectedGateVersion: z.number().int().min(1).max(2147483647),
  issuedAt: z.iso.datetime(),
  salt: Salt,
  reason: z.string().trim().min(1).max(4096),
});
export type CommercialRelease = z.infer<typeof CommercialReleaseSchema>;

/** Both parties acknowledge immutable terminal evidence; this is neither a bill nor payment. */
export const CommercialTerminalSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-terminal"),
    terminalId: Id,
    domainId: Id,
    reservationId: Id,
    reservationDigest: FederationDigestSchema,
    activationId: Id,
    sourceSiteId: Id,
    targetSiteId: Id,
    expectedGateVersion: z.number().int().min(1).max(2147483646),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    executionEvidenceDigest: FederationDigestSchema,
    resultManifestDigest: FederationDigestSchema.nullable(),
    observedAt: z.iso.datetime(),
    issuedAt: z.iso.datetime(),
    salt: Salt,
  })
  .refine(
    (value) =>
      value.sourceSiteId !== value.targetSiteId &&
      Date.parse(value.observedAt) <= Date.parse(value.issuedAt),
    "Invalid terminal identity or observation",
  );
export type CommercialTerminal = z.infer<typeof CommercialTerminalSchema>;

/** Provider assertions and technical corrections remain immutable; neither confirms a bill or payment. */
export const CommercialUsageSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-usage"),
    reportId: Id,
    domainId: Id,
    agreementRevisionId: Id,
    agreementDigest: FederationDigestSchema,
    sourceSiteId: Id,
    targetSiteId: Id,
    taskId: Id,
    attempt: z.number().int().min(1).max(2147483647),
    salt: Salt,
    reportedAt: z.iso.datetime(),
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
    measurements: z
      .array(
        z.strictObject({
          metric: Metric,
          quantityUnit: Metric,
          quantity: FederationAmountSchema,
          evidenceDigest: FederationDigestSchema,
        }),
      )
      .min(1)
      .max(64),
    correctionOf: Id.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.sourceSiteId === value.targetSiteId ||
      Date.parse(value.periodStart) >= Date.parse(value.periodEnd) ||
      Date.parse(value.periodEnd) > Date.parse(value.reportedAt)
    )
      ctx.addIssue({ code: "custom", message: "Invalid usage identity or reporting interval" });
    if (
      new Set(value.measurements.map((item) => item.metric)).size !== value.measurements.length ||
      value.correctionOf === value.reportId
    )
      ctx.addIssue({ code: "custom", message: "Duplicate measurement or self correction" });
  });
export type CommercialUsage = z.infer<typeof CommercialUsageSchema>;
/** A provider concession is a separate signed fact, bound to one bill and usage revision. */
export const CommercialDiscountSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("commercial-discount"),
  discountId: Id,
  billId: Id,
  domainId: Id,
  agreementRevisionId: Id,
  agreementDigest: FederationDigestSchema,
  reportId: Id,
  reportDigest: FederationDigestSchema,
  taskId: Id,
  attempt: z.number().int().min(1).max(2147483647),
  sourceSiteId: Id,
  targetSiteId: Id,
  unit: FederationDelegationSchema.shape.unit,
  amount: PositiveQuantity,
  reason: z.string().trim().min(1).max(4096),
  issuedAt: z.iso.datetime(),
  salt: Salt,
});
export type CommercialDiscount = z.infer<typeof CommercialDiscountSchema>;

export const CommercialBillCalculationSchema = z.strictObject({
  // No legacy agreement implicitly authorizes rounding; both bill signatures approve it.
  rounding: z.literal("ceil-per-line"),
  lines: z
    .array(
      z.strictObject({
        metric: Metric,
        quantityUnit: Metric,
        quantity: FederationAmountSchema,
        perQuantity: PositiveQuantity,
        rateAmount: FederationAmountSchema,
        amount: FederationAmountSchema,
      }),
    )
    .min(1)
    .max(64),
  grossAmount: FederationAmountSchema,
  capReduction: FederationAmountSchema,
  discountAmount: FederationAmountSchema,
  dueAmount: FederationAmountSchema,
});
/** Confirmation records an amount owed, never acceptance of results, a debit or a payment. */
export const CommercialBillSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-bill"),
    billId: Id,
    domainId: Id,
    agreementDigest: FederationDigestSchema,
    priceVersionId: Id,
    reportId: Id,
    reportDigest: FederationDigestSchema,
    request: FederationDelegationSchema,
    // A chain reservation is required only for coordinated cooperation.
    reservationId: Id.nullable(),
    discount: z.strictObject({ discountId: Id, digest: FederationDigestSchema }).nullable(),
    calculation: CommercialBillCalculationSchema,
    issuedAt: z.iso.datetime(),
    salt: Salt,
  })
  .refine(
    (value) => (value.request.mode === "ledger_coordinated") === (value.reservationId !== null),
    "Coordinated bills require the original chain reservation",
  );
export type CommercialBill = z.infer<typeof CommercialBillSchema>;

/** A separate financial approval for a permanently cancelled task that never created a workflow. */
export const CommercialRefundSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-refund"),
    refundId: Id,
    domainId: Id,
    agreementDigest: FederationDigestSchema,
    request: FederationDelegationSchema,
    requestDigest: FederationDigestSchema,
    cancellationReceiptJws: z.string().min(1).max(524288),
    releasedAmount: FederationAmountSchema,
    issuedAt: z.iso.datetime(),
    salt: Salt,
    reason: z.string().trim().min(1).max(4096),
  })
  .refine(
    (v) => v.request.mode !== "ledger_coordinated" && v.releasedAmount === v.request.maxAmount,
    "Only full bilateral pre-execution refunds are allowed",
  );
export type CommercialRefund = z.infer<typeof CommercialRefundSchema>;
export const CommercialRefundDraftInputSchema = z.strictObject({
  operationId: Id,
  refundId: Id,
  reason: z.string().trim().min(1).max(4096),
});

/** A separately approved allocation settlement, never proof of bank payment or a new credit issue. */
export const CommercialSettlementSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-settlement"),
    settlementId: Id,
    domainId: Id,
    agreementRevisionId: Id,
    billId: Id,
    billDigest: FederationDigestSchema,
    sourceSiteId: Id,
    targetSiteId: Id,
    reservationId: Id.nullable(),
    terminal: z.strictObject({ terminalId: Id, digest: FederationDigestSchema }).nullable(),
    unit: FederationDelegationSchema.shape.unit,
    reservedAmount: FederationAmountSchema,
    chargedAmount: FederationAmountSchema,
    releasedAmount: FederationAmountSchema,
    issuedAt: z.iso.datetime(),
    salt: Salt,
  })
  .refine(
    (value) =>
      value.sourceSiteId !== value.targetSiteId &&
      (value.reservationId !== null) === (value.terminal !== null) &&
      [value.reservedAmount, value.chargedAmount, value.releasedAmount].every(
        (amount) => FederationAmountSchema.safeParse(amount).success,
      ) &&
      BigInt(value.reservedAmount) === BigInt(value.chargedAmount) + BigInt(value.releasedAmount),
    "Settlement must preserve the original reservation and institutional identities",
  );
export type CommercialSettlement = z.infer<typeof CommercialSettlementSchema>;

/** An append-only bilateral change to a settled charge, never a bank payment or a new execution permit. */
export const CommercialAdjustmentSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-adjustment"),
    adjustmentId: Id,
    domainId: Id,
    agreementRevisionId: Id,
    billId: Id,
    billDigest: FederationDigestSchema,
    settlementId: Id,
    settlementDigest: FederationDigestSchema,
    sourceSiteId: Id,
    targetSiteId: Id,
    unit: FederationDelegationSchema.shape.unit,
    previous: z.strictObject({ adjustmentId: Id, digest: FederationDigestSchema }).nullable(),
    previousChargedAmount: FederationAmountSchema,
    chargedAmount: FederationAmountSchema,
    reason: z.string().trim().min(1).max(4096),
    supportingEvidenceDigest: FederationDigestSchema.nullable(),
    issuedAt: z.iso.datetime(),
    salt: Salt,
  })
  .refine(
    (v) =>
      v.sourceSiteId !== v.targetSiteId &&
      v.previous?.adjustmentId !== v.adjustmentId &&
      v.previousChargedAmount !== v.chargedAmount,
    "An adjustment must change the charge and reference a different original",
  );
export type CommercialAdjustment = z.infer<typeof CommercialAdjustmentSchema>;
export const CommercialAdjustmentDraftInputSchema = z.strictObject({
  settlementId: Id,
  adjustmentId: Id,
  chargedAmount: FederationAmountSchema,
  reason: CommercialAdjustmentSchema.shape.reason,
  supportingEvidenceDigest: FederationDigestSchema.nullable(),
});
export type CommercialAdjustmentDraftInput = z.infer<typeof CommercialAdjustmentDraftInputSchema>;

export const ClosingPolicyInputSchema = z
  .strictObject({
    kind: z.enum(["bill", "settlement", "refund"]),
    outcomes: z
      .array(z.enum(["completed", "failed", "cancelled"]))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length),
    maxAmount: FederationAmountSchema,
    maxTotalAmount: FederationAmountSchema,
    maxRecords: z.number().int().min(1).max(100000),
    validUntil: z.iso.datetime({ offset: true }),
  })
  .refine(
    (v) =>
      [v.maxAmount, v.maxTotalAmount].every((a) => FederationAmountSchema.safeParse(a).success) &&
      BigInt(v.maxAmount) <= BigInt(v.maxTotalAmount),
    "Invalid approval limits",
  )
  .refine(
    (v) => v.kind !== "refund" || (v.outcomes.length === 1 && v.outcomes[0] === "cancelled"),
    "Refund policies only authorize pre-execution cancellation",
  );
export const ClosingPolicySchema = ClosingPolicyInputSchema.safeExtend({
  id: Id,
  localSiteId: Id,
  localOrgId: Id,
  agreementRevisionId: Id,
  agreementDigest: FederationDigestSchema,
  approvedAmount: FederationAmountSchema,
  approvedRecords: z.number().int().nonnegative(),
  validFrom: z.iso.datetime(),
  grantedBy: Id,
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: Id.nullable(),
}).refine(
  (v) =>
    [v.approvedAmount, v.maxTotalAmount].every(
      (a) => FederationAmountSchema.safeParse(a).success,
    ) &&
    BigInt(v.approvedAmount) <= BigInt(v.maxTotalAmount) &&
    v.approvedRecords <= v.maxRecords &&
    Date.parse(v.validUntil) > Date.parse(v.validFrom) &&
    (v.revokedAt === null) === (v.revokedBy === null),
  "Invalid closing policy state",
);
export type ClosingPolicy = z.infer<typeof ClosingPolicySchema>;
export type ClosingPolicyInput = z.infer<typeof ClosingPolicyInputSchema>;
export const ClosingTaskSchema = z
  .object({
    localSiteId: Id,
    localOrgId: Id,
    agreementRevisionId: Id,
    kind: z.enum(["bill", "settlement", "refund"]),
    referenceId: Id,
    policyId: Id,
    recordId: Id.nullable(),
    state: z.enum(["pending", "complete", "needs_review"]),
    nextAttemptAt: z.iso.datetime(),
    lastError: z.string().max(80).nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (v) => v.state !== "complete" || (v.recordId !== null && v.completedAt !== null),
    "Incomplete closing task",
  );
export const ClosingTasksViewSchema = z.object({
  enabled: z.boolean(),
  records: z.array(ClosingTaskSchema).max(100),
});

export const CommercialBillApprovalSchema = z.object({
  localSiteId: Id,
  localOrgId: Id,
  agreementRevisionId: Id,
  billId: Id,
  payload: CommercialBillSchema,
  digest: FederationDigestSchema,
  approvalJws: z.string().min(1).max(524288),
  counterpartyJws: z.string().min(1).max(524288).nullable(),
  approvedBy: Id,
  createdAt: z.iso.datetime(),
});
export const CommercialBillListSchema = z.object({
  data: z.array(
    z.object({
      bill: CommercialBillApprovalSchema,
      ledger: z
        .object({
          id: Id,
          state: z.enum(["pending", "committed", "needs_review"]),
          lastError: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  hasMore: z.boolean(),
});

export const CommercialRefundApprovalSchema = z.object({
  localSiteId: Id,
  localOrgId: Id,
  agreementRevisionId: Id,
  operationId: Id,
  refundId: Id,
  payload: CommercialRefundSchema,
  digest: FederationDigestSchema,
  approvalJws: z.string().min(1).max(524288),
  counterpartyJws: z.string().min(1).max(524288).nullable(),
  approvedBy: Id,
  authorizationPolicyId: Id.nullable(),
  appliedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export const CommercialRefundListSchema = z.object({
  data: z.array(
    CommercialRefundApprovalSchema.extend({
      ledger: CommercialBillListSchema.shape.data.element.shape.ledger,
    }),
  ),
  hasMore: z.boolean(),
});

export const CommercialSettlementApprovalSchema = z.object({
  localSiteId: Id,
  localOrgId: Id,
  agreementRevisionId: Id,
  billId: Id,
  settlementId: Id,
  payload: CommercialSettlementSchema,
  digest: FederationDigestSchema,
  approvalJws: z.string().min(1).max(524288),
  counterpartyJws: z.string().min(1).max(524288).nullable(),
  approvedBy: Id,
  appliedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export const CommercialSettlementListSchema = z.object({
  data: z.array(
    z.object({
      settlement: CommercialSettlementApprovalSchema,
      ledger: CommercialBillListSchema.shape.data.element.shape.ledger,
    }),
  ),
  hasMore: z.boolean(),
});

export const CommercialAdjustmentApprovalSchema = z.object({
  localSiteId: Id,
  localOrgId: Id,
  agreementRevisionId: Id,
  adjustmentId: Id,
  settlementId: Id,
  number: z.number().int().positive(),
  payload: CommercialAdjustmentSchema,
  digest: FederationDigestSchema,
  approvalJws: z.string().min(1).max(524288),
  counterpartyJws: z.string().min(1).max(524288).nullable(),
  heldAmount: FederationAmountSchema,
  approvedBy: Id,
  appliedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export const CommercialAdjustmentListSchema = z.object({
  data: z.array(
    z.object({
      adjustment: CommercialAdjustmentApprovalSchema,
      ledger: CommercialBillListSchema.shape.data.element.shape.ledger,
    }),
  ),
  hasMore: z.boolean(),
  summary: z
    .object({
      settlementId: Id,
      originalChargedAmount: FederationAmountSchema,
      currentChargedAmount: FederationAmountSchema.nullable(),
      pendingAdjustmentId: Id.nullable(),
    })
    .nullable()
    .optional(),
});

export const CommercialUsageEnvelopeSchema = z.strictObject({
  providerJws: z.string().min(1).max(524288),
});
export const CommercialReceiptSchema = z.strictObject({
  recordId: Id,
  digest: FederationDigestSchema,
});
export const CommercialRecordTypeSchema = z.enum([
  "agreement",
  "usage",
  "reservation",
  "release",
  "terminal",
  "discount",
  "bill",
  "settlement",
  "adjustment",
  "refund",
]);
export const CommercialReceiptQuerySchema = z.strictObject({
  operation: z.literal("get-commercial-receipt"),
  domainId: Id,
  recordType: CommercialRecordTypeSchema,
  recordId: Id,
});
export const CommercialReceiptQueryResultSchema = z.strictObject({
  receipt: CommercialReceiptSchema.nullable(),
});

/** Public lifecycle-governed purposes; registering a key never implies authority to sign every record. */
export const FabricCommercialTrustSchema = FabricEvidenceTrustSchema.safeExtend({
  keyPurposes: z
    .array(
      z.strictObject({
        siteId: Id,
        keyId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
        kinds: z
          .array(CommercialSigningKindSchema)
          .min(1)
          .max(CommercialSigningKindSchema.options.length),
      }),
    )
    .min(2)
    .max(1000),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const item of value.keyPurposes) {
    const id = `${item.siteId}:${item.keyId}`;
    if (
      ids.has(id) ||
      new Set(item.kinds).size !== item.kinds.length ||
      !value.organizations
        .find((org) => org.siteId === item.siteId)
        ?.keys.some((key) => key.keyId === item.keyId)
    )
      ctx.addIssue({ code: "custom", message: "Invalid commercial signing purposes" });
    ids.add(id);
  }
  for (const org of value.organizations)
    for (const key of org.keys)
      if (!ids.has(`${org.siteId}:${key.keyId}`))
        ctx.addIssue({
          code: "custom",
          message: "Every commercial key requires explicit purposes",
        });
});
export type FabricCommercialTrust = z.infer<typeof FabricCommercialTrustSchema>;
export function fabricCommercialCollections(input: FabricCommercialTrust) {
  const trust = FabricCommercialTrustSchema.parse(input);
  return fabricEvidenceCollections({
    version: trust.version,
    generationId: trust.generationId,
    organizations: trust.organizations,
    domains: trust.domains,
  });
}

const ProposalIdentity = { domainId: Id, recordId: Id, digest: FederationDigestSchema };
export const CommercialProposalInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("register-agreement"),
    envelope: CommercialAgreementEnvelopeSchema,
  }),
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("record-usage"),
    envelope: CommercialUsageEnvelopeSchema,
  }),
]);
export type CommercialProposalInput = z.infer<typeof CommercialProposalInputSchema>;
export const CommercialExecutionApprovalSchema = z.discriminatedUnion("kind", [
  CommercialReservationSchema,
  CommercialReleaseSchema,
]);
export type CommercialExecutionApproval = z.infer<typeof CommercialExecutionApprovalSchema>;
/** Signed transport inputs are assembled only after both institutions approve the same payload. */
export const CommercialExecutionProposalInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("reserve-execution"),
    envelope: CommercialAgreementEnvelopeSchema,
  }),
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("release-execution"),
    envelope: CommercialAgreementEnvelopeSchema,
  }),
]);
export type CommercialExecutionProposalInput = z.infer<
  typeof CommercialExecutionProposalInputSchema
>;
export const CommercialAdjustmentProposalInputSchema = z.strictObject({
  ...ProposalIdentity,
  operation: z.literal("adjust-settlement"),
  envelope: CommercialAgreementEnvelopeSchema,
});
export const CommercialAdapterProposalInputSchema = z.discriminatedUnion("operation", [
  ...CommercialProposalInputSchema.options,
  ...CommercialExecutionProposalInputSchema.options,
  CommercialAdjustmentProposalInputSchema,
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("record-refund"),
    envelope: CommercialAgreementEnvelopeSchema,
  }),
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("record-discount"),
    envelope: CommercialUsageEnvelopeSchema,
  }),
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("settle-bill"),
    envelope: CommercialAgreementEnvelopeSchema,
  }),
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("confirm-bill"),
    envelope: CommercialAgreementEnvelopeSchema,
  }),
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("record-execution-terminal"),
    envelope: CommercialAgreementEnvelopeSchema,
  }),
]);
export type CommercialAdapterProposalInput = z.infer<typeof CommercialAdapterProposalInputSchema>;
export const CommercialGateQuerySchema = z.strictObject({
  operation: z.literal("get-execution-gate-hash"),
  domainId: Id,
  reservationId: Id,
});
export const CommercialGateHashSchema = z.strictObject({
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});

export const FabricCommercialAdvanceResultSchema = z.discriminatedUnion("state", [
  FabricProposalCheckpointSchema.extend({ state: z.literal("prepared") }),
  FabricProposalCheckpointSchema.extend({ state: z.literal("pending") }),
  z.strictObject({
    state: z.literal("committed"),
    transactionId: z.string().regex(/^[a-f0-9]{64}$/),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  }),
  FabricEvidenceAdvanceResultSchema.options[3],
]);
export type CommercialAdvanceResult = z.infer<typeof FabricCommercialAdvanceResultSchema>;

export const CommercialAgreementApprovalSchema = z.object({
  localSiteId: Id,
  localOrgId: Id,
  revisionId: Id,
  terms: CommercialAgreementSchema,
  digest: FederationDigestSchema,
  approvalJws: z.string().min(1).max(524288),
  counterpartyJws: z.string().min(1).max(524288).nullable(),
  approvedBy: Id,
  createdAt: z.iso.datetime(),
});
export type CommercialAgreementApproval = z.infer<typeof CommercialAgreementApprovalSchema>;
export const CommercialAgreementSummarySchema = CommercialAgreementApprovalSchema.pick({
  revisionId: true,
  digest: true,
  approvedBy: true,
  createdAt: true,
}).extend({
  sourceSiteId: Id,
  targetSiteId: Id,
  sourceName: z.string().nullable(),
  targetName: z.string().nullable(),
  mode: CommercialAgreementSchema.shape.agreement.shape.mode,
  consideration: CommercialAgreementSchema.shape.consideration,
  hasCounterpartyApproval: z.boolean(),
});
export const CommercialSubmissionsViewSchema = z.object({
  enabled: z.boolean(),
  submissions: z.array(
    z.object({
      id: Id,
      state: z.enum(["pending", "committed", "needs_review"]),
      lastError: z.string().nullable(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      transaction: z
        .object({
          transactionId: z.string().regex(/^[a-f0-9]{64}$/),
          stage: z.enum(["proposal", "transaction", "abandoned", "committed", "invalid"]),
          validationCode: z.number().int().nullable(),
          blockNumber: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});
export type CommercialSubmissionsView = z.infer<typeof CommercialSubmissionsViewSchema>;

export const CommercialUsageEvidenceSetSchema = z.strictObject({
  version: z.literal(1),
  reservationId: Id,
  agreementRevisionId: Id,
  priceVersionId: Id,
  records: z
    .array(
      z.strictObject({
        jobId: Id,
        digest: FederationDigestSchema,
        accountingDigest: FederationDigestSchema.optional(),
      }),
    )
    .min(1)
    .max(4096),
});
export type CommercialUsageEvidenceSet = z.infer<typeof CommercialUsageEvidenceSetSchema>;
export const CommercialUsageGapSchema = z.strictObject({
  metric: Metric,
  jobId: Id.optional(),
  missingJobs: z.number().int().nonnegative().optional(),
  reason: z.enum(["UNSUPPORTED_METER", "MISSING_ACCOUNTING", "NO_JOB_EVIDENCE"]),
});
export type CommercialUsageGap = z.infer<typeof CommercialUsageGapSchema>;

/** An authorized provider assertion; never presented as a new Agent observation or a discount. */
export const CommercialUsageCorrectionInputSchema = z
  .strictObject({
    reportId: Id,
    correctionOf: Id,
    reason: z.string().trim().min(1).max(4096),
    measurements: z
      .array(
        z.strictObject({
          metric: Metric,
          quantityUnit: Metric,
          quantity: FederationAmountSchema,
          supportingEvidenceDigest: FederationDigestSchema,
        }),
      )
      .min(1)
      .max(64),
  })
  .superRefine((value, ctx) => {
    if (
      value.reportId === value.correctionOf ||
      new Set(value.measurements.map((item) => item.metric)).size !== value.measurements.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate metric or self correction" });
  });
export type CommercialUsageCorrectionInput = z.infer<typeof CommercialUsageCorrectionInputSchema>;
export const CommercialUsageCorrectionEvidenceSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("provider-technical-correction"),
  reservationId: Id,
  previousDigest: FederationDigestSchema,
  recordedAt: z.iso.datetime(),
  salt: Salt,
  declaration: CommercialUsageCorrectionInputSchema,
});
export type CommercialUsageCorrectionEvidence = z.infer<
  typeof CommercialUsageCorrectionEvidenceSchema
>;

/** Organization-scoped HTTP views; dates are serialized by the Server. */
export const CommercialUsageTaskViewSchema = z.object({
  reservationId: Id,
  localSiteId: Id,
  localOrgId: Id,
  agreementRevisionId: Id,
  state: z.enum(["pending", "missing_data", "needs_review", "reported"]),
  gaps: z.array(CommercialUsageGapSchema),
  lastError: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export const CommercialUsageSyncViewSchema = z.object({
  operationId: Id,
  number: z.number().int().nonnegative(),
  lastReportId: Id.nullable(),
  state: z.enum(["pending", "needs_review"]),
  providerState: z
    .enum(["waiting", "pending", "missing_data", "needs_review", "reported"])
    .nullable(),
  lastError: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  nextAttemptAt: z.iso.datetime(),
});
export const CommercialUsageRecordViewSchema = z.object({
  number: z.number().int().positive(),
  report: CommercialUsageSchema,
  reportJws: z.string().min(1),
  digest: FederationDigestSchema,
  correctionEvidence: CommercialUsageCorrectionEvidenceSchema.nullable(),
  evidenceSet: CommercialUsageEvidenceSetSchema.optional(),
  submissionId: Id.nullable().optional(),
  ledgerState: z.enum(["pending", "committed", "needs_review"]).nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export type CommercialUsageRecordView = z.infer<typeof CommercialUsageRecordViewSchema>;
export const CommercialUsageProviderViewSchema = z.object({
  task: CommercialUsageTaskViewSchema,
  reports: z.array(CommercialUsageRecordViewSchema),
  hasMore: z.boolean(),
});
export const CommercialUsageReceivedViewSchema = z.object({
  syncEnabled: z.boolean(),
  sync: CommercialUsageSyncViewSchema.nullable(),
  reports: z.array(CommercialUsageRecordViewSchema),
  hasMore: z.boolean(),
});
