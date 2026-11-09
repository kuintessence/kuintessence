import type { workflowDsl } from "@kuintessence/shared";
import type {
  FederationAcceptance,
  FederationAccountingObservation,
  FederationAgreement,
  FederationAssetRef,
  FederationCancellation,
  FederationCancellationReceipt,
  FederationDatasetUseLease,
  FederationDelegation,
  FederationEnvironmentLock,
  FederationExecutionTarget,
  FederationExecutionTerminalEvidence,
  FederationInputFiles,
  FederationInputManifest,
  FederationMediaImportGrant,
  FederationMediaManifest,
  FederationMediaReceipt,
  FederationMediaReceiptAck,
  FederationReceivedInputFiles,
  FederationResultReceipt,
  FederationResultReceiptAck,
  FederationResultReport,
  FederationStatusReport,
  FederationStorageReconciliationRecord,
  FederationTaskMediaExportApproval,
  FederationTaskMediaSource,
  FederationTerminalEvidence,
  FederationTerminalSourceReview,
  MediaHandoff,
  MediaShipmentPackage,
  MediaShipmentState,
} from "@kuintessence/shared/federation";
import type {
  CommercialAdapterProposalInput,
  CommercialAdjustment,
  CommercialAgreement,
  CommercialBill,
  CommercialDiscount,
  CommercialExecutionApproval,
  CommercialRefund,
  CommercialReservation,
  CommercialSettlement,
  CommercialTerminal,
  CommercialUsage,
  CommercialUsageCorrectionEvidence,
  CommercialUsageEvidenceSet,
  CommercialUsageGap,
} from "@kuintessence/shared/federation/commercial";
import type { FederationEvidenceBatch } from "@kuintessence/shared/federation/ledger";
import type {
  MarketAdapterProposalInput,
  MarketDemandState,
} from "@kuintessence/shared/federation/market";
import type { MarketRequest } from "@kuintessence/shared/federation/market-request";
import type { FederationTerminalProposal } from "@kuintessence/shared/federation/terminal-proposal";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  agents,
  clusterFileRoots,
  dataAssets,
  dataAssetVersions,
  dataLocations,
  jobs,
  orgs,
  softwareAssetRevisions,
  users,
  workflowRuns,
} from "./schema";

export const federationSites = pgTable(
  "federation_sites",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    endpoint: text("endpoint").notNull(),
    state: varchar("state", { length: 16 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("federation_site_state", sql`${t.state} IN ('active', 'suspended', 'revoked')`)],
);

/** Rotation adds a new record; key IDs and certificate fingerprints are never reassigned. */
export const federationSigningKeys = pgTable(
  "federation_signing_keys",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => federationSites.id),
    keyId: varchar("key_id", { length: 128 }).notNull(),
    publicKeyPem: text("public_key_pem").notNull(),
    allowedKinds: jsonb("allowed_kinds")
      .$type<
        (
          | "agreement"
          | "delegation"
          | "acceptance"
          | "evidence-batch"
          | "agreement-approval-query"
          | "agreement-approval-waiting"
          | "commercial-approval-query"
          | "commercial-approval-waiting"
          | "market-request"
          | "market-request-receipt"
          | "reservation-proposal-receipt"
          | "commercial-agreement"
          | "commercial-usage"
          | "commercial-reservation"
          | "commercial-release"
          | "commercial-terminal"
          | "commercial-discount"
          | "commercial-bill"
          | "commercial-settlement"
          | "commercial-adjustment"
          | "commercial-refund"
          | "terminal-query"
          | "terminal-chunk"
          | "terminal-delivery"
          | "terminal-ack"
          | "commercial-usage-query"
          | "commercial-usage-page"
          | "status-query"
          | "status-report"
          | "cancellation"
          | "cancellation-receipt"
          | "result-query"
          | "result-report"
          | "result-download-query"
          | "result-download-grant"
          | "result-receipt"
          | "result-receipt-ack"
          | "material-query"
          | "material-chunk"
          | "input-download-query"
          | "input-download-grant"
          | "media-manifest"
          | "media-key-query"
          | "media-key-grant"
          | "dataset-use-query"
          | "dataset-use-grant"
          | "media-import-receipt"
          | "media-import-receipt-ack"
        )[]
      >()
      .notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.keyId] }),
    check("federation_key_interval", sql`${t.validFrom} < ${t.validUntil}`),
  ],
);

export const federationCertificates = pgTable(
  "federation_certificates",
  {
    fingerprint: varchar("fingerprint", { length: 64 }).primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => federationSites.id),
    certificatePem: text("certificate_pem").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("federation_certificate_site").on(t.siteId),
    check("federation_certificate_interval", sql`${t.validFrom} < ${t.validUntil}`),
    check("federation_certificate_fingerprint", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Business authority is assigned explicitly per local organization, independent of platform roles. */
export const federationCapabilities = pgTable(
  "federation_capabilities",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    capability: varchar("capability", { length: 32 }).notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId, t.capability] }),
    check(
      "federation_capability_kind",
      sql`${t.capability} IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim')`,
    ),
  ],
);

export const federationAgreementApprovals = pgTable(
  "federation_agreement_approvals",
  {
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationSites.id),
    revisionId: uuid("revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    executionUserId: uuid("execution_user_id").references(() => users.id),
    terms: jsonb("terms").$type<FederationAgreement>().notNull(),
    termsDigest: varchar("terms_digest", { length: 71 }).notNull(),
    approvalJws: text("approval_jws").notNull(),
    counterpartyApprovalJws: text("counterparty_approval_jws"),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    state: varchar("state", { length: 16 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.revisionId] }),
    index("federation_approval_org").on(t.localOrgId, t.createdAt),
    check("federation_approval_state", sql`${t.state} IN ('active', 'suspended', 'revoked')`),
  ],
);

/** Source-owned delivery intent. Unknown delivery never releases its reserved budget. */
export const federationOutbound = pgTable(
  "federation_outbound",
  {
    localSiteId: uuid("local_site_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => users.id),
    taskId: uuid("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    budgetDomainId: uuid("budget_domain_id").notNull(),
    epoch: uuid("epoch").notNull(),
    amount: numeric("amount", { precision: 38, scale: 0 }).notNull(),
    settledAmount: numeric("settled_amount", { precision: 38, scale: 0 }),
    adjustmentHeldAmount: numeric("adjustment_held_amount", { precision: 38, scale: 0 })
      .notNull()
      .default("0"),
    endpoint: text("endpoint").notNull(),
    request: jsonb("request").$type<FederationDelegation>().notNull(),
    requestDigest: varchar("request_digest", { length: 71 }).notNull(),
    requestJws: text("request_jws").notNull(),
    receipt: jsonb("receipt").$type<FederationAcceptance>(),
    receiptJws: text("receipt_jws"),
    statusReport: jsonb("status_report").$type<FederationStatusReport>(),
    statusReportJws: text("status_report_jws"),
    statusVerifiedAt: timestamp("status_verified_at", { withTimezone: true }),
    statusLastError: varchar("status_last_error", { length: 64 }),
    statusClaim: uuid("status_claim"),
    statusNextAttemptAt: timestamp("status_next_attempt_at", { withTimezone: true }).defaultNow(),
    cancelRequest: jsonb("cancel_request").$type<FederationCancellation>(),
    cancelJws: text("cancel_jws"),
    cancelDigest: varchar("cancel_digest", { length: 71 }),
    cancelRequestedBy: uuid("cancel_requested_by").references(() => users.id),
    cancelState: varchar("cancel_state", { length: 24 }),
    cancelReceipt: jsonb("cancel_receipt").$type<FederationCancellationReceipt>(),
    cancelReceiptJws: text("cancel_receipt_jws"),
    cancelLastError: varchar("cancel_last_error", { length: 64 }),
    cancelLeaseOwner: uuid("cancel_lease_owner"),
    cancelLeaseUntil: timestamp("cancel_lease_until", { withTimezone: true }),
    cancelNextAttemptAt: timestamp("cancel_next_attempt_at", { withTimezone: true }),
    state: varchar("state", { length: 24 }).notNull().default("queued"),
    lastError: varchar("last_error", { length: 64 }),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.operationId] }),
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationAgreementApprovals.localSiteId,
        federationAgreementApprovals.revisionId,
      ],
    }),
    uniqueIndex("federation_outbound_task_attempt").on(
      t.localSiteId,
      t.agreementRevisionId,
      t.taskId,
      t.attempt,
    ),
    index("federation_outbound_delivery").on(t.localSiteId, t.state, t.nextAttemptAt),
    index("federation_outbound_status")
      .on(t.localSiteId, t.statusNextAttemptAt, t.operationId)
      .where(sql`${t.state} = 'accepted' AND ${t.statusNextAttemptAt} IS NOT NULL`),
    check(
      "federation_outbound_status_report",
      sql`(${t.statusReport} IS NULL AND ${t.statusReportJws} IS NULL AND ${t.statusVerifiedAt} IS NULL)
        OR (${t.statusReport} IS NOT NULL AND ${t.statusReportJws} IS NOT NULL AND ${t.statusVerifiedAt} IS NOT NULL AND ${t.state} = 'accepted')`,
    ),
    index("federation_outbound_cancel").on(t.localSiteId, t.cancelState, t.cancelNextAttemptAt),
    index("federation_outbound_budget").on(t.localSiteId, t.budgetDomainId, t.epoch),
    check(
      "federation_outbound_state",
      sql`${t.state} IN ('queued', 'sending', 'accepted', 'needs_review')`,
    ),
    check(
      "federation_outbound_cancel_intent",
      sql`
      (${t.cancelState} IS NULL AND ${t.cancelRequest} IS NULL AND ${t.cancelJws} IS NULL AND ${t.cancelDigest} IS NULL AND ${t.cancelRequestedBy} IS NULL)
      OR (${t.cancelState} IS NOT NULL AND ${t.cancelState} IN ('queued','sending','pending','stopped','needs_review') AND ${t.cancelRequest} IS NOT NULL AND ${t.cancelJws} IS NOT NULL AND ${t.cancelDigest} IS NOT NULL AND ${t.cancelRequestedBy} IS NOT NULL AND ${t.cancelNextAttemptAt} IS NOT NULL)`,
    ),
    check(
      "federation_outbound_cancel_stopped",
      sql`${t.cancelState} IS DISTINCT FROM 'stopped' OR (${t.cancelReceipt} IS NOT NULL AND ${t.cancelReceiptJws} IS NOT NULL AND coalesce(${t.cancelReceipt}->>'state' = 'stopped', false))`,
    ),
    check(
      "federation_outbound_amount",
      sql`${t.adjustmentHeldAmount} >= 0 AND ${t.adjustmentHeldAmount} <= ${t.amount} AND (${t.adjustmentHeldAmount} = 0 OR ${t.settledAmount} IS NOT NULL) AND (${t.settledAmount} IS NULL OR (${t.settledAmount} >= 0 AND ${t.settledAmount} + ${t.adjustmentHeldAmount} <= ${t.amount})) AND ${t.amount}::text ~ '^(0|[1-9][0-9]{0,37})$' AND ${t.attempt} > 0`,
    ),
    check(
      "federation_outbound_receipt",
      sql`(${t.state} = 'accepted' AND ${t.receipt} IS NOT NULL AND ${t.receiptJws} IS NOT NULL) OR (${t.state} <> 'accepted' AND ${t.receipt} IS NULL AND ${t.receiptJws} IS NULL)`,
    ),
  ],
);

export const federationBudgets = pgTable(
  "federation_budgets",
  {
    domainId: uuid("domain_id").notNull(),
    epoch: uuid("epoch").notNull(),
    unit: varchar("unit", { length: 64 }).notNull(),
    limit: numeric("limit", { precision: 38, scale: 0 }).notNull(),
    available: numeric("available", { precision: 38, scale: 0 }).notNull(),
    reserved: numeric("reserved", { precision: 38, scale: 0 }).notNull().default("0"),
    spent: numeric("spent", { precision: 38, scale: 0 }).notNull().default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.domainId, t.epoch] }),
    check(
      "federation_budget_conservation",
      sql`${t.limit}::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND ${t.available}::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND ${t.reserved}::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND ${t.spent}::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND ${t.limit} = ${t.available} + ${t.reserved} + ${t.spent}`,
    ),
  ],
);

export const federationAgreements = pgTable(
  "federation_agreements",
  {
    revisionId: uuid("revision_id").primaryKey(),
    sourceSiteId: uuid("source_site_id").notNull(),
    targetSiteId: uuid("target_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    executionUserId: uuid("execution_user_id")
      .notNull()
      .references(() => users.id),
    // Only bilateral execution installs a local spendable budget.
    budgetDomainId: uuid("budget_domain_id"),
    epoch: uuid("epoch"),
    terms: jsonb("terms").$type<FederationAgreement>().notNull(),
    termsDigest: varchar("terms_digest", { length: 71 }).notNull(),
    sourceApprovalJws: text("source_approval_jws").notNull(),
    targetApprovalJws: text("target_approval_jws").notNull(),
    state: varchar("state", { length: 16 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.budgetDomainId, t.epoch],
      foreignColumns: [federationBudgets.domainId, federationBudgets.epoch],
    }),
    uniqueIndex("federation_agreement_budget_epoch").on(t.budgetDomainId, t.epoch),
    check(
      "federation_agreement_budget_backing",
      sql`(((${t.terms}->>'mode' IN ('bilateral_direct', 'bilateral_attested'))
        AND ${t.budgetDomainId} IS NOT NULL AND ${t.epoch} IS NOT NULL
        AND ${t.budgetDomainId} = (${t.terms}->>'budgetDomainId')::uuid
        AND ${t.epoch} = (${t.terms}->>'epoch')::uuid)
        OR (${t.terms}->>'mode' = 'ledger_coordinated'
        AND ${t.budgetDomainId} IS NULL AND ${t.epoch} IS NULL)) IS TRUE`,
    ),
    check("federation_agreement_state", sql`${t.state} IN ('active', 'suspended', 'revoked')`),
    check("federation_agreement_sites", sql`${t.sourceSiteId} <> ${t.targetSiteId}`),
  ],
);

/** The signed request is also the durable inbox entry; an unsigned receipt never permits dispatch. */
export const federationReservations = pgTable(
  "federation_reservations",
  {
    id: uuid("id").primaryKey(),
    agreementRevisionId: uuid("agreement_revision_id")
      .notNull()
      .references(() => federationAgreements.revisionId),
    senderSiteId: uuid("sender_site_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    taskId: uuid("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    requestDigest: varchar("request_digest", { length: 71 }).notNull(),
    requestJws: text("request_jws").notNull(),
    amount: numeric("amount", { precision: 38, scale: 0 }).notNull(),
    settledAmount: numeric("settled_amount", { precision: 38, scale: 0 }),
    receipt: jsonb("receipt").$type<FederationAcceptance>().notNull(),
    receiptJws: text("receipt_jws"),
    state: varchar("state", { length: 24 }).notNull().default("pending_signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_request_operation").on(t.senderSiteId, t.operationId),
    uniqueIndex("federation_task_attempt").on(t.agreementRevisionId, t.taskId, t.attempt),
    index("federation_reservation_recovery").on(t.state, t.createdAt),
    check(
      "federation_reservation_amount",
      sql`(${t.settledAmount} IS NULL OR (${t.settledAmount} >= 0 AND ${t.settledAmount} <= ${t.amount})) AND ${t.amount}::text ~ '^(0|[1-9][0-9]{0,37})$' AND ${t.attempt} > 0`,
    ),
    check(
      "federation_reservation_signature",
      sql`
      (${t.state} = 'pending_signature' AND ${t.receiptJws} IS NULL)
      OR (${t.state} = 'reserved' AND ${t.receiptJws} IS NOT NULL)`,
    ),
  ],
);

/** Irreversible receiver fence, including cancellation arriving before admission. */
export const federationCancellations = pgTable(
  "federation_cancellations",
  {
    localSiteId: uuid("local_site_id").notNull(),
    senderSiteId: uuid("sender_site_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id")
      .notNull()
      .references(() => federationAgreements.revisionId),
    requestDigest: varchar("request_digest", { length: 71 }).notNull(),
    cancellationDigest: varchar("cancellation_digest", { length: 71 }).notNull(),
    request: jsonb("request").$type<FederationCancellation>().notNull(),
    requestJws: text("request_jws").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.localSiteId, t.senderSiteId, t.operationId] })],
);

/** Independent of raw metering retention. There is deliberately no cascade deletion. */
export const federationEvidence = pgTable(
  "federation_evidence",
  {
    id: uuid("id").primaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => federationReservations.id),
    kind: varchar("kind", { length: 24 }).notNull(),
    jws: text("jws").notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_evidence_reservation_kind").on(t.reservationId, t.kind),
    check("federation_evidence_kind", sql`${t.kind} IN ('delegation', 'acceptance')`),
  ],
);

export const federationEvidenceStreams = pgTable(
  "federation_evidence_streams",
  {
    domainId: uuid("domain_id").notNull(),
    issuerSiteId: uuid("issuer_site_id").notNull(),
    nextSequence: numeric("next_sequence", { precision: 20, scale: 0 }).notNull().default("1"),
  },
  (t) => [
    primaryKey({ columns: [t.domainId, t.issuerSiteId] }),
    check("federation_evidence_sequence_positive", sql`${t.nextSequence} > 0`),
  ],
);

export const federationEvidenceBatches = pgTable(
  "federation_evidence_batches",
  {
    id: uuid("id").primaryKey(),
    domainId: uuid("domain_id").notNull(),
    issuerSiteId: uuid("issuer_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    agreementRevisionId: uuid("agreement_revision_id")
      .notNull()
      .references(() => federationAgreements.revisionId),
    firstSequence: numeric("first_sequence", { precision: 20, scale: 0 }).notNull(),
    manifest: jsonb("manifest").$type<FederationEvidenceBatch>().notNull(),
    issuerJws: text("issuer_jws"),
    digest: varchar("digest", { length: 71 }),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.domainId, t.issuerSiteId],
      foreignColumns: [federationEvidenceStreams.domainId, federationEvidenceStreams.issuerSiteId],
    }),
    uniqueIndex("federation_batch_sequence").on(t.domainId, t.issuerSiteId, t.firstSequence),
    uniqueIndex("federation_batch_unresolved_stream")
      .on(t.domainId, t.issuerSiteId)
      .where(sql`${t.state} <> 'anchored'`),
    index("federation_batch_pending").on(t.issuerSiteId, t.state, t.nextAttemptAt),
    index("federation_batch_agreement").on(t.agreementRevisionId, t.createdAt),
    check("federation_batch_state", sql`${t.state} IN ('pending','anchored','needs_review')`),
    check(
      "federation_batch_signature",
      sql`((${t.issuerJws} IS NULL AND ${t.digest} IS NULL) OR (${t.issuerJws} IS NOT NULL AND ${t.digest} ~ '^sha256:[a-f0-9]{64}$')) IS TRUE`,
    ),
    check("federation_batch_lease", sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`),
    check(
      "federation_batch_manifest",
      sql`(${t.firstSequence} > 0 AND ${t.manifest}->>'batchId' = ${t.id}::text AND ${t.manifest}->>'domainId' = ${t.domainId}::text AND ${t.manifest}->>'issuerSiteId' = ${t.issuerSiteId}::text AND ${t.manifest}->>'agreementRevisionId' = ${t.agreementRevisionId}::text AND ${t.manifest}->'records'->0->>'sequence' = ${t.firstSequence}::text AND jsonb_array_length(${t.manifest}->'records') BETWEEN 1 AND 100) IS TRUE`,
    ),
  ],
);

/** Every submitted transaction is retained, including confirmed INVALID attempts. */
export const federationAttestationAttempts = pgTable(
  "federation_attestation_attempts",
  {
    id: uuid("id").primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => federationEvidenceBatches.id),
    number: integer("number").notNull(),
    transactionId: varchar("transaction_id", { length: 64 }).notNull(),
    recovery: text("recovery").notNull(),
    stage: varchar("stage", { length: 24 }).notNull().default("proposal"),
    validationCode: integer("validation_code"),
    blockNumber: numeric("block_number", { precision: 20, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_attestation_tx").on(t.transactionId),
    uniqueIndex("federation_attestation_attempt_number").on(t.batchId, t.number),
    check(
      "federation_attestation_attempt",
      sql`${t.number} > 0 AND ${t.transactionId} ~ '^[a-f0-9]{64}$' AND octet_length(${t.recovery}) BETWEEN 1 AND 4194304`,
    ),
    check(
      "federation_attestation_result",
      sql`((${t.stage} IN ('proposal','transaction','abandoned') AND ${t.validationCode} IS NULL AND ${t.blockNumber} IS NULL) OR (${t.stage} = 'anchored' AND ${t.validationCode} = 0 AND ${t.blockNumber} >= 0) OR (${t.stage} = 'invalid' AND ${t.validationCode} BETWEEN 1 AND 255 AND ${t.blockNumber} >= 0)) IS TRUE`,
    ),
  ],
);

export const federationAttestationOutbox = pgTable(
  "federation_attestation_outbox",
  {
    evidenceId: uuid("evidence_id")
      .primaryKey()
      .references(() => federationEvidence.id),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    batchId: uuid("batch_id").references(() => federationEvidenceBatches.id),
    sequence: numeric("sequence", { precision: 20, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_outbox_batch_sequence").on(t.batchId, t.sequence),
    index("federation_outbox_pending").on(t.state, t.createdAt),
    check(
      "federation_attestation_state",
      sql`((${t.state} = 'pending' AND ${t.batchId} IS NULL AND ${t.sequence} IS NULL) OR (${t.state} IN ('batched','anchored') AND ${t.batchId} IS NOT NULL AND ${t.sequence} > 0)) IS TRUE`,
    ),
  ],
);

/** A mapping never grants permission and never silently follows a newer local revision. */
export const federationAssetMappings = pgTable(
  "federation_asset_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    originSiteId: uuid("origin_site_id")
      .notNull()
      .references(() => federationSites.id),
    kind: varchar("kind", { length: 16 }).notNull(),
    originId: uuid("origin_id").notNull(),
    originRevision: varchar("origin_revision", { length: 128 }).notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    softwareRevisionId: uuid("software_revision_id").references(() => softwareAssetRevisions.id),
    dataVersionId: uuid("data_version_id").references(() => dataAssetVersions.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("federation_asset_origin").on(
      t.localOrgId,
      t.originSiteId,
      t.kind,
      t.originId,
      t.originRevision,
    ),
    check("federation_asset_digest", sql`${t.digest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "federation_asset_target",
      sql`(${t.kind} = 'dataset' AND ${t.dataVersionId} IS NOT NULL AND ${t.softwareRevisionId} IS NULL)
    OR (${t.kind} IN ('workflow', 'script', 'software', 'usecase') AND ${t.softwareRevisionId} IS NOT NULL AND ${t.dataVersionId} IS NULL)`,
    ),
  ],
);

/** Exact canonical bytes are retained separately from JSONB to keep content addressing stable. */
export const federationMaterials = pgTable(
  "federation_materials",
  {
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    originSiteId: uuid("origin_site_id")
      .notNull()
      .references(() => federationSites.id),
    digest: varchar("digest", { length: 71 }).notNull(),
    kind: varchar("kind", { length: 24 }).notNull(),
    content: text("content").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localOrgId, t.originSiteId, t.digest] }),
    check("federation_material_kind", sql`${t.kind} IN ('inputs', 'environment-lock')`),
    check("federation_material_digest", sql`${t.digest} ~ '^sha256:[a-f0-9]{64}$'`),
    check("federation_material_size", sql`octet_length(${t.content}) <= 1048576`),
  ],
);

/** Local-only version pins; this preparation record is not a cross-site download or use permit. */
export const federationWorkflowInputExports = pgTable(
  "federation_workflow_input_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    pathHash: varchar("path_hash", { length: 64 }).notNull(),
    path: text("path").notNull(),
    nodeId: varchar("node_id", { length: 1024 }).notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    intentDigest: varchar("intent_digest", { length: 71 }).notNull(),
    manifest: jsonb("manifest").$type<FederationInputFiles>().notNull(),
    manifestDigest: varchar("manifest_digest", { length: 71 }).notNull(),
    bindings: jsonb("bindings")
      .$type<
        Array<{
          descriptor: string;
          path: string;
          fileId: string;
          storageKey: string;
          versionId: string;
          sha256: string;
          sizeBytes: number;
        }>
      >()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_input_export_invocation").on(t.runId, t.pathHash),
    check(
      "federation_input_export_path",
      sql`${t.pathHash} ~ '^[a-f0-9]{64}$' AND octet_length(${t.path}) BETWEEN 1 AND 16384`,
    ),
    check(
      "federation_input_export_digest",
      sql`${t.intentDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.manifestDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "federation_input_export_bindings",
      sql`jsonb_typeof(${t.bindings}) = 'array' AND jsonb_array_length(${t.bindings}) <= 256`,
    ),
  ],
);

export const federationPreparations = pgTable(
  "federation_preparations",
  {
    reservationId: uuid("reservation_id")
      .primaryKey()
      .references(() => federationReservations.id),
    state: varchar("state", { length: 16 }).notNull(),
    blocker: varchar("blocker", { length: 64 }),
    mappings: jsonb("mappings")
      .$type<
        Array<{
          reference: import("@kuintessence/shared/federation").FederationAssetRef;
          mappingId: string;
          localRevisionId: string;
        }>
      >()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "federation_preparation_state",
      sql`(${t.state} = 'resolved' AND ${t.blocker} IS NULL) OR (${t.state} IN ('waiting', 'blocked') AND ${t.blocker} IS NOT NULL)`,
    ),
  ],
);

/** Receiver-private input inventory; quota remains held until cancelled storage is positively cleaned. */
export const federationInputImports = pgTable(
  "federation_input_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => federationReservations.id),
    localSiteId: uuid("local_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    manifestDigest: varchar("manifest_digest", { length: 71 }).notNull(),
    manifest: jsonb("manifest").$type<FederationInputFiles>().notNull(),
    delivery: varchar("delivery", { length: 16 }).notNull().default("network"),
    state: varchar("state", { length: 16 }).notNull().default("pending"),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    nextPublishAt: timestamp("next_publish_at", { withTimezone: true }).notNull().defaultNow(),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: varchar("last_error", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_input_import_reservation").on(t.reservationId),
    check("federation_input_import_delivery", sql`${t.delivery} IN ('network', 'media')`),
    index("federation_input_import_pending")
      .on(t.localSiteId, t.nextCheckAt)
      .where(sql`${t.state} IN ('pending', 'transferring', 'available')`),
    index("federation_input_import_publication")
      .on(t.localSiteId, t.nextPublishAt)
      .where(sql`${t.state} IN ('pending', 'transferring')`),
    check(
      "federation_input_import_published",
      sql`${t.state} != 'available' OR (${t.publishedAt} IS NOT NULL AND ${t.reservedBytes} = 0)`,
    ),
    check("federation_input_import_digest", sql`${t.manifestDigest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "federation_input_import_state",
      sql`${t.state} IN ('pending', 'transferring', 'available', 'cancelling', 'cancelled')`,
    ),
    check(
      "federation_input_import_quota",
      sql`${t.reservedBytes} BETWEEN 0 AND 9007199254740991 AND (${t.state} != 'cancelled' OR ${t.reservedBytes} = 0)`,
    ),
  ],
);

export const federationInputTransfers = pgTable(
  "federation_input_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id")
      .notNull()
      .references(() => federationInputImports.id),
    descriptor: varchar("descriptor", { length: 128 }).notNull(),
    path: varchar("path", { length: 255 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    partSize: bigint("part_size", { mode: "number" }).notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_input_transfer_member").on(t.importId, t.descriptor, t.path),
    check(
      "federation_input_transfer_state",
      sql`${t.state} IN ('pending', 'copying', 'assembling', 'verifying', 'verified', 'available', 'cleanup_pending', 'cancelled')`,
    ),
    check(
      "federation_input_transfer_size",
      sql`${t.sizeBytes} BETWEEN 0 AND 5497558138880 AND ${t.partSize} BETWEEN 5242880 AND 5368709120 AND ceil(${t.sizeBytes}::numeric / ${t.partSize}) <= 10000`,
    ),
    check("federation_input_transfer_hash", sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** A generation owns one storage key forever, including after failed or lost allocations. */
export const federationInputAttempts = pgTable(
  "federation_input_attempts",
  {
    generation: uuid("generation").primaryKey(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => federationInputTransfers.id),
    agentId: varchar("agent_id", { length: 255 })
      .notNull()
      .references(() => agents.agentId),
    state: varchar("state", { length: 24 }).notNull().default("preparing"),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    allocationStartedAt: timestamp("allocation_started_at", { withTimezone: true }),
    reconciliation: jsonb("reconciliation").$type<FederationStorageReconciliationRecord>(),
    cleanupToken: uuid("cleanup_token"),
    uploadId: text("upload_id"),
    parts: jsonb("parts").$type<Array<{ partNumber: number; etag: string }>>(),
    completionStartedAt: timestamp("completion_started_at", { withTimezone: true }),
    completionSettledAt: timestamp("completion_settled_at", { withTimezone: true }),
    destinationVersionId: text("destination_version_id"),
    destinationEtag: varchar("destination_etag", { length: 255 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    lastError: varchar("last_error", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_input_attempt_storage").on(t.storageKey),
    uniqueIndex("federation_input_attempt_active_member")
      .on(t.transferId)
      .where(sql`${t.state} != 'cleaned'`),
    uniqueIndex("federation_input_attempt_active_agent")
      .on(t.agentId)
      .where(sql`${t.state} IN ('preparing', 'copying', 'assembling', 'verifying')`),
    index("federation_input_attempt_lease").on(t.state, t.leaseUntil),
    check(
      "federation_input_attempt_state",
      sql`${t.state} IN ('preparing', 'copying', 'assembling', 'verifying', 'verified', 'available', 'cleanup_pending', 'cleaned')`,
    ),
    check(
      "federation_input_attempt_upload",
      sql`${t.state} NOT IN ('copying', 'assembling', 'verifying', 'verified', 'available') OR (${t.uploadId} IS NOT NULL AND ${t.allocationStartedAt} IS NOT NULL)`,
    ),
    check(
      "federation_input_attempt_parts",
      sql`${t.state} NOT IN ('assembling', 'verifying', 'verified', 'available') OR ${t.parts} IS NOT NULL`,
    ),
    check(
      "federation_input_completion_started",
      sql`${t.completionStartedAt} IS NULL OR (${t.uploadId} IS NOT NULL AND ${t.parts} IS NOT NULL)`,
    ),
    check(
      "federation_input_completion_settled",
      sql`${t.completionSettledAt} IS NULL OR (${t.completionStartedAt} IS NOT NULL AND ${t.destinationEtag} IS NOT NULL)`,
    ),
    check(
      "federation_input_attempt_destination",
      sql`${t.state} NOT IN ('verifying', 'verified', 'available') OR (${t.completionSettledAt} IS NOT NULL AND ${t.destinationVersionId} IS NOT NULL AND ${t.destinationVersionId} != 'null')`,
    ),
    check(
      "federation_input_attempt_verified",
      sql`${t.state} NOT IN ('verified', 'available') OR ${t.verifiedAt} IS NOT NULL`,
    ),
    check(
      "federation_input_attempt_allocated",
      sql`${t.uploadId} IS NULL OR ${t.allocationStartedAt} IS NOT NULL`,
    ),
  ],
);

/** Receiver-local execution intent. Creation alone never authorizes dispatch. */
export const federationWorkflowBindings = pgTable(
  "federation_workflow_bindings",
  {
    reservationId: uuid("reservation_id")
      .primaryKey()
      .references(() => federationReservations.id),
    workflowRunId: uuid("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    snapshotDigest: varchar("snapshot_digest", { length: 71 }).notNull(),
    snapshot: jsonb("snapshot")
      .$type<{
        request: FederationDelegation;
        requestDigest: string;
        identity: { orgId: string; userId: string };
        workflow: workflowDsl.Workflow;
        workflowVersions: Record<string, workflowDsl.Workflow>;
        inputs: FederationInputManifest;
        receivedInputs?: FederationReceivedInputFiles;
        environment: FederationEnvironmentLock;
        executionTargets?: FederationExecutionTarget[];
        mappings: typeof federationPreparations.$inferSelect.mappings;
      }>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_workflow_run").on(t.workflowRunId),
    check(
      "federation_workflow_snapshot_digest",
      sql`${t.snapshotDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** Source-side result import. No credential URL is persisted in any transfer row. */
export const federationResultImports = pgTable(
  "federation_result_imports",
  {
    id: uuid("id").primaryKey(),
    localSiteId: uuid("local_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    operationId: uuid("operation_id").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    report: jsonb("report").$type<FederationResultReport>().notNull(),
    delivery: varchar("delivery", { length: 16 }).notNull().default("network"),
    reportJws: text("report_jws").notNull(),
    manifestDigest: varchar("manifest_digest", { length: 71 }).notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    receipt: jsonb("receipt").$type<FederationResultReceipt>(),
    receiptJws: text("receipt_jws"),
    receiptAck: jsonb("receipt_ack").$type<FederationResultReceiptAck>(),
    receiptAckJws: text("receipt_ack_jws"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: varchar("last_error", { length: 64 }),
    receiptNextAttemptAt: timestamp("receipt_next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    receiptLastError: varchar("receipt_last_error", { length: 64 }),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.localSiteId, t.operationId],
      foreignColumns: [federationOutbound.localSiteId, federationOutbound.operationId],
    }),
    uniqueIndex("federation_result_import_manifest")
      .on(t.localSiteId, t.operationId, t.requestedBy, t.manifestDigest)
      .where(sql`${t.state} <> 'cancelled'`),
    check("federation_result_import_delivery", sql`${t.delivery} IN ('network', 'media')`),
    index("federation_result_import_owner").on(
      t.localSiteId,
      t.localOrgId,
      t.requestedBy,
      t.createdAt,
    ),
    check(
      "federation_result_import_receipt",
      sql`(${t.receipt} IS NULL OR ${t.state} = 'available') AND (${t.receiptJws} IS NULL OR ${t.receipt} IS NOT NULL) AND ((${t.receiptAck} IS NULL AND ${t.receiptAckJws} IS NULL) OR (${t.receiptAck} IS NOT NULL AND ${t.receiptAckJws} IS NOT NULL AND ${t.receiptJws} IS NOT NULL))`,
    ),
    check("federation_result_import_reservation", sql`${t.reservedBytes} >= 0`),
    check(
      "federation_result_import_state",
      sql`${t.state} IN ('pending','transferring','verifying','available','cancelled','needs_review')`,
    ),
  ],
);

export const federationResultTransfers = pgTable(
  "federation_result_transfers",
  {
    id: uuid("id").primaryKey(),
    importId: uuid("import_id")
      .notNull()
      .references(() => federationResultImports.id),
    outputId: varchar("output_id", { length: 71 }).notNull(),
    path: varchar("path", { length: 255 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    partSize: bigint("part_size", { mode: "number" }).notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_result_transfer_member").on(t.importId, t.outputId, t.path),
    check(
      "federation_result_transfer_state",
      sql`${t.state} IN ('pending','copying','assembling','verifying','verified','available','cleanup_pending','cancelled')`,
    ),
    check(
      "federation_result_transfer_size",
      sql`${t.sizeBytes} >= 0 AND ${t.sizeBytes} <= 5497558138880 AND ${t.partSize} >= 5242880 AND ${t.partSize} <= 5368709120`,
    ),
    check("federation_result_transfer_hash", sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Attempts are never overwritten: a lost create/complete response retains its cleanup identity. */
export const federationResultAttempts = pgTable(
  "federation_result_attempts",
  {
    generation: uuid("generation").primaryKey(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => federationResultTransfers.id),
    agentId: varchar("agent_id", { length: 255 })
      .notNull()
      .references(() => agents.agentId),
    state: varchar("state", { length: 24 }).notNull().default("preparing"),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    uploadId: text("upload_id"),
    parts: jsonb("parts").$type<Array<{ partNumber: number; etag: string }>>(),
    destinationVersionId: text("destination_version_id"),
    destinationEtag: varchar("destination_etag", { length: 255 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    lastError: varchar("last_error", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_result_attempt_storage").on(t.storageKey),
    uniqueIndex("federation_result_attempt_active_member")
      .on(t.transferId)
      .where(sql`${t.state} NOT IN ('cleaned','cleanup_pending')`),
    uniqueIndex("federation_result_attempt_active_agent")
      .on(t.agentId)
      .where(sql`${t.state} IN ('preparing','copying','assembling','verifying')`),
    index("federation_result_attempt_lease").on(t.state, t.leaseUntil),
    check(
      "federation_result_attempt_state",
      sql`${t.state} IN ('preparing','copying','assembling','verifying','verified','available','cleanup_pending','cleaned')`,
    ),
    check(
      "federation_result_attempt_upload",
      sql`${t.state} NOT IN ('copying','assembling','verifying','verified','available') OR ${t.uploadId} IS NOT NULL`,
    ),
    check(
      "federation_result_attempt_destination",
      sql`${t.state} NOT IN ('verifying','verified','available') OR ${t.destinationEtag} IS NOT NULL`,
    ),
    check(
      "federation_result_attempt_verified",
      sql`${t.state} NOT IN ('verified','available') OR ${t.verifiedAt} IS NOT NULL`,
    ),
  ],
);

/** Receiver-owned signed claims and acknowledgement; independent of live object retention. */
export const federationResultReceipts = pgTable(
  "federation_result_receipts",
  {
    localSiteId: uuid("local_site_id").notNull(),
    senderSiteId: uuid("sender_site_id").notNull(),
    receiptId: uuid("receipt_id").notNull(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => federationReservations.id),
    receipt: jsonb("receipt").$type<FederationResultReceipt>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    receiptJws: text("receipt_jws").notNull(),
    acknowledgement: jsonb("acknowledgement").$type<FederationResultReceiptAck>().notNull(),
    acknowledgementJws: text("acknowledgement_jws").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.senderSiteId, t.receiptId] }),
    index("federation_result_receipt_reservation").on(t.reservationId),
  ],
);

/** Commercial approval records never activate execution agreements or transfer a balance. */
export const federationCommercialAgreements = pgTable(
  "federation_commercial_agreements",
  {
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationSites.id),
    revisionId: uuid("revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    terms: jsonb("terms").$type<CommercialAgreement>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    approvalJws: text("approval_jws").notNull(),
    counterpartyJws: text("counterparty_jws"),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.revisionId] }),
    index("federation_commercial_org").on(t.localSiteId, t.localOrgId, t.createdAt),
    check(
      "federation_commercial_terms",
      sql`(${t.digest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.terms}->'agreement'->>'agreementRevisionId' = ${t.revisionId}::text AND (${t.terms}->'agreement'->>'sourceSiteId' = ${t.localSiteId}::text OR ${t.terms}->'agreement'->>'targetSiteId' = ${t.localSiteId}::text)) IS TRUE`,
    ),
  ],
);

/** Independent, revocable authority for financial approval; not a spendable balance. */
export const federationClosingPolicies = pgTable(
  "federation_closing_policies",
  {
    id: uuid("id").primaryKey(),
    localSiteId: uuid("local_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    agreementDigest: varchar("agreement_digest", { length: 71 }).notNull(),
    kind: varchar("kind", { length: 16 }).$type<"bill" | "settlement" | "refund">().notNull(),
    outcomes: jsonb("outcomes").$type<Array<"completed" | "failed" | "cancelled">>().notNull(),
    maxAmount: numeric("max_amount", { precision: 38, scale: 0 }).notNull(),
    maxTotalAmount: numeric("max_total_amount", { precision: 38, scale: 0 }).notNull(),
    maxRecords: integer("max_records").notNull(),
    approvedAmount: numeric("approved_amount", { precision: 38, scale: 0 }).notNull().default("0"),
    approvedRecords: integer("approved_records").notNull().default(0),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
  },
  (t) => [
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    uniqueIndex("federation_closing_policy_active")
      .on(t.localSiteId, t.agreementRevisionId, t.kind)
      .where(sql`${t.revokedAt} IS NULL`),
    check("federation_closing_policy_kind", sql`${t.kind} IN ('bill','settlement','refund')`),
    check(
      "federation_closing_policy_limits",
      sql`${t.maxAmount} >= 0 AND ${t.maxTotalAmount} >= ${t.maxAmount} AND ${t.maxRecords} BETWEEN 1 AND 100000 AND ${t.approvedAmount} BETWEEN 0 AND ${t.maxTotalAmount} AND ${t.approvedRecords} BETWEEN 0 AND ${t.maxRecords}`,
    ),
    check(
      "federation_closing_policy_time",
      sql`${t.validUntil} > ${t.validFrom} AND (${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`,
    ),
    check(
      "federation_closing_policy_outcomes",
      sql`jsonb_typeof(${t.outcomes}) = 'array' AND jsonb_array_length(${t.outcomes}) BETWEEN 1 AND 3 AND ${t.outcomes} <@ '["completed","failed","cancelled"]'::jsonb AND (${t.kind} <> 'refund' OR ${t.outcomes} = '["cancelled"]'::jsonb)`,
    ),
  ],
);

/** Initiator-owned closing progress; signatures and ledger checkpoints remain in their original tables. */
export const federationClosingTasks = pgTable(
  "federation_closing_tasks",
  {
    localSiteId: uuid("local_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    kind: varchar("kind", { length: 16 }).$type<"bill" | "settlement" | "refund">().notNull(),
    referenceId: uuid("reference_id").notNull(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => federationClosingPolicies.id),
    recordId: uuid("record_id"),
    state: varchar("state", { length: 16 })
      .$type<"pending" | "complete" | "needs_review">()
      .notNull()
      .default("pending"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: varchar("last_error", { length: 80 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.kind, t.referenceId] }),
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    index("federation_closing_task_due").on(t.localSiteId, t.state, t.nextAttemptAt),
    check("federation_closing_task_kind", sql`${t.kind} IN ('bill','settlement','refund')`),
    check(
      "federation_closing_task_state",
      sql`${t.state} IN ('pending','complete','needs_review') AND (${t.state} <> 'complete' OR (${t.recordId} IS NOT NULL AND ${t.completedAt} IS NOT NULL))`,
    ),
    check(
      "federation_closing_task_lease",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
  ],
);

/** Local business signatures are immutable; no payment or balance fields belong here. */
export const federationCommercialBills = pgTable(
  "federation_commercial_bills",
  {
    localSiteId: uuid("local_site_id").notNull(),
    billId: uuid("bill_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    taskId: uuid("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    payload: jsonb("payload").$type<CommercialBill>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    approvalJws: text("approval_jws").notNull(),
    counterpartyJws: text("counterparty_jws"),
    authorizationPolicyId: uuid("authorization_policy_id").references(
      () => federationClosingPolicies.id,
    ),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.billId] }),
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    uniqueIndex("federation_bill_task_attempt").on(
      t.localSiteId,
      t.agreementRevisionId,
      t.taskId,
      t.attempt,
    ),
    index("federation_bill_org").on(t.localSiteId, t.localOrgId, t.createdAt),
    check(
      "federation_bill_identity",
      sql`(${t.digest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.attempt} > 0
    AND ${t.payload}->>'kind' = 'commercial-bill' AND ${t.payload}->>'billId' = ${t.billId}::text
    AND ${t.payload}->'request'->>'agreementRevisionId' = ${t.agreementRevisionId}::text
    AND ${t.payload}->'request'->>'taskId' = ${t.taskId}::text AND ${t.payload}->'request'->>'attempt' = ${t.attempt}::text
    AND (${t.payload}->'request'->>'senderSiteId' = ${t.localSiteId}::text OR ${t.payload}->'request'->>'recipientSiteId' = ${t.localSiteId}::text)) IS TRUE`,
    ),
  ],
);

/** Separate business consent; appliedAt is local accounting, not bank payment. */
export const federationCommercialSettlements = pgTable(
  "federation_commercial_settlements",
  {
    localSiteId: uuid("local_site_id").notNull(),
    settlementId: uuid("settlement_id").notNull(),
    billId: uuid("bill_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    payload: jsonb("payload").$type<CommercialSettlement>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    approvalJws: text("approval_jws").notNull(),
    counterpartyJws: text("counterparty_jws"),
    authorizationPolicyId: uuid("authorization_policy_id").references(
      () => federationClosingPolicies.id,
    ),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.settlementId] }),
    foreignKey({
      columns: [t.localSiteId, t.billId],
      foreignColumns: [federationCommercialBills.localSiteId, federationCommercialBills.billId],
    }),
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    uniqueIndex("federation_settlement_bill").on(t.localSiteId, t.billId),
    index("federation_settlement_org").on(t.localSiteId, t.localOrgId, t.createdAt),
    check(
      "federation_settlement_identity",
      sql`(
      ${t.digest} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.payload}->>'kind' = 'commercial-settlement'
      AND ${t.payload}->>'settlementId' = ${t.settlementId}::text
      AND ${t.payload}->>'billId' = ${t.billId}::text
      AND ${t.payload}->>'agreementRevisionId' = ${t.agreementRevisionId}::text
      AND (${t.payload}->>'sourceSiteId' = ${t.localSiteId}::text OR ${t.payload}->>'targetSiteId' = ${t.localSiteId}::text)
      AND (${t.appliedAt} IS NULL OR ${t.counterpartyJws} IS NOT NULL)) IS TRUE`,
    ),
  ],
);

/** Append-only approvals; a positive local hold protects a pending debit from new admissions. */
export const federationCommercialAdjustments = pgTable(
  "federation_commercial_adjustments",
  {
    localSiteId: uuid("local_site_id").notNull(),
    adjustmentId: uuid("adjustment_id").notNull(),
    settlementId: uuid("settlement_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    number: integer("number").notNull(),
    payload: jsonb("payload").$type<CommercialAdjustment>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    approvalJws: text("approval_jws").notNull(),
    counterpartyJws: text("counterparty_jws"),
    heldAmount: numeric("held_amount", { precision: 38, scale: 0 }).notNull().default("0"),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.adjustmentId] }),
    foreignKey({
      columns: [t.localSiteId, t.settlementId],
      foreignColumns: [
        federationCommercialSettlements.localSiteId,
        federationCommercialSettlements.settlementId,
      ],
    }),
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    uniqueIndex("federation_adjustment_sequence").on(t.localSiteId, t.settlementId, t.number),
    uniqueIndex("federation_adjustment_predecessor").on(
      t.localSiteId,
      t.settlementId,
      sql`coalesce(${t.payload}->'previous'->>'adjustmentId', 'initial')`,
    ),
    index("federation_adjustment_org").on(t.localSiteId, t.localOrgId, t.createdAt),
    check(
      "federation_adjustment_identity",
      sql`(
      ${t.number} > 0 AND ${t.heldAmount} >= 0 AND ${t.digest} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.payload}->>'kind' = 'commercial-adjustment'
      AND ${t.payload}->>'adjustmentId' = ${t.adjustmentId}::text
      AND ${t.payload}->>'settlementId' = ${t.settlementId}::text
      AND ${t.payload}->>'agreementRevisionId' = ${t.agreementRevisionId}::text
      AND (${t.payload}->>'sourceSiteId' = ${t.localSiteId}::text OR ${t.payload}->>'targetSiteId' = ${t.localSiteId}::text)
      AND (${t.appliedAt} IS NULL OR ${t.counterpartyJws} IS NOT NULL)
      AND ((${t.number} = 1) = (${t.payload}->'previous' = 'null'::jsonb))
    ) IS TRUE`,
    ),
  ],
);

export const federationCommercialDiscounts = pgTable(
  "federation_commercial_discounts",
  {
    localSiteId: uuid("local_site_id").notNull(),
    discountId: uuid("discount_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    payload: jsonb("payload").$type<CommercialDiscount>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    providerJws: text("provider_jws").notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.discountId] }),
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    index("federation_discount_org").on(t.localSiteId, t.localOrgId, t.createdAt),
    check(
      "federation_discount_identity",
      sql`(${t.digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.payload}->>'kind' = 'commercial-discount' AND ${t.payload}->>'discountId' = ${t.discountId}::text
    AND ${t.payload}->>'agreementRevisionId' = ${t.agreementRevisionId}::text
    AND (${t.payload}->>'sourceSiteId' = ${t.localSiteId}::text OR ${t.payload}->>'targetSiteId' = ${t.localSiteId}::text)) IS TRUE`,
    ),
  ],
);

export const federationCommercialSubmissions = pgTable(
  "federation_commercial_submissions",
  {
    id: uuid("id").primaryKey(),
    localSiteId: uuid("local_site_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    input: jsonb("input").$type<CommercialAdapterProposalInput>().notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    uniqueIndex("federation_commercial_record").on(
      t.localSiteId,
      sql`(${t.input}->>'operation')`,
      sql`(${t.input}->>'recordId')`,
    ),
    index("federation_commercial_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    check(
      "federation_commercial_submission_state",
      sql`${t.state} IN ('pending','committed','needs_review','closed')`,
    ),
    check(
      "federation_commercial_submission_input",
      sql`(${t.input}->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution','record-execution-terminal','record-discount','confirm-bill','settle-bill','adjust-settlement','record-refund') AND ${t.input}->>'recordId' IS NOT NULL AND ${t.input}->>'domainId' IS NOT NULL AND ${t.input}->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE`,
    ),
    check(
      "federation_commercial_submission_lease",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
  ],
);

/** Cumulative signing authority, not a balance or a source of ledger funds. */
export const federationReservationPolicies = pgTable(
  "federation_reservation_policies",
  {
    id: uuid("id").primaryKey(),
    localSiteId: uuid("local_site_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    agreementDigest: varchar("agreement_digest", { length: 71 }).notNull(),
    allowMarketPublish: boolean("allow_market_publish").notNull().default(false),
    allowMarketClaim: boolean("allow_market_claim").notNull().default(false),
    allowActivation: boolean("allow_activation").notNull().default(false),
    allowExecutionConfirmation: boolean("allow_execution_confirmation").notNull().default(false),
    maxTaskAmount: numeric("max_task_amount", { precision: 38, scale: 0 }).notNull(),
    maxTotalAmount: numeric("max_total_amount", { precision: 38, scale: 0 }).notNull(),
    maxTasks: integer("max_tasks").notNull(),
    authorizedAmount: numeric("authorized_amount", { precision: 38, scale: 0 })
      .notNull()
      .default("0"),
    authorizedTasks: integer("authorized_tasks").notNull().default(0),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
  },
  (t) => [
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    uniqueIndex("federation_reservation_policy_active")
      .on(t.localSiteId, t.agreementRevisionId)
      .where(sql`${t.revokedAt} IS NULL`),
    check(
      "federation_reservation_policy_valid",
      sql`(
      ${t.validUntil} > ${t.validFrom} AND ${t.agreementDigest} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.maxTaskAmount} >= 0 AND ${t.maxTotalAmount} >= ${t.maxTaskAmount}
      AND ${t.maxTasks} BETWEEN 1 AND 100000
      AND ${t.authorizedAmount} BETWEEN 0 AND ${t.maxTotalAmount}
      AND ${t.authorizedTasks} BETWEEN 0 AND ${t.maxTasks}
      AND ((${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL))) IS TRUE`,
    ),
  ],
);

/** Signed task proposals survive both sender restart and provider approval delay. */
export const federationReservationProposals = pgTable(
  "federation_reservation_proposals",
  {
    localSiteId: uuid("local_site_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => federationReservationPolicies.id),
    direction: varchar("direction", { length: 16 }).notNull(),
    payload: jsonb("payload").$type<CommercialReservation>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    sourceJws: text("source_jws"),
    sourceFingerprint: varchar("source_fingerprint", { length: 64 }),
    requestedBy: uuid("requested_by").references(() => users.id),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    receiptJws: text("receipt_jws"),
    executionState: varchar("execution_state", { length: 24 }).notNull().default("idle"),
    executionError: varchar("execution_error", { length: 64 }),
    executionNextAt: timestamp("execution_next_at", { withTimezone: true }).notNull().defaultNow(),
    executionLeaseToken: uuid("execution_lease_token"),
    executionLeaseUntil: timestamp("execution_lease_until", { withTimezone: true }),
    activationId: uuid("activation_id").references(() => federationMarketSubmissions.id),
    confirmationId: uuid("confirmation_id").references(() => federationMarketSubmissions.id),

    approvedAt: timestamp("approved_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.reservationId] }),
    index("federation_execution_automation_pending").on(
      t.localSiteId,
      t.executionState,
      t.executionNextAt,
    ),
    check(
      "federation_execution_automation_state",
      sql`(${t.executionState} IN ('idle','pending','complete','needs_review','closed')
      AND ((${t.executionLeaseToken} IS NULL) = (${t.executionLeaseUntil} IS NULL))) IS TRUE`,
    ),

    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    index("federation_reservation_proposal_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    index("federation_reservation_proposal_org").on(
      t.localSiteId,
      t.localOrgId,
      t.agreementRevisionId,
    ),
    check(
      "federation_reservation_proposal_identity",
      sql`(
      ${t.payload}->>'kind' = 'commercial-reservation' AND ${t.payload}->>'reservationId' = ${t.reservationId}::text
      AND ${t.payload}->'request'->>'agreementRevisionId' = ${t.agreementRevisionId}::text
      AND ${t.digest} ~ '^sha256:[a-f0-9]{64}$'
      AND ((${t.direction} = 'outbound' AND ${t.requestedBy} IS NOT NULL AND ${t.sourceFingerprint} IS NULL)
        OR (${t.direction} = 'inbound' AND ${t.requestedBy} IS NULL AND ${t.sourceFingerprint} ~ '^[a-f0-9]{64}$' AND ${t.sourceJws} IS NOT NULL))) IS TRUE`,
    ),
    check(
      "federation_reservation_proposal_state",
      sql`(
      ${t.state} IN ('pending','sending','delivered','approved','needs_review','closed')
      AND ((${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL))
      AND (${t.state} <> 'pending' OR ${t.approvedAt} IS NULL)
      AND (${t.state} NOT IN ('sending','delivered') OR (${t.direction} = 'outbound' AND ${t.approvedAt} IS NOT NULL AND ${t.sourceJws} IS NOT NULL))
      AND (${t.state} <> 'approved' OR (${t.direction} = 'inbound' AND ${t.approvedAt} IS NOT NULL))
      AND ((${t.deliveredAt} IS NULL) = (${t.receiptJws} IS NULL))
      AND (${t.state} <> 'delivered' OR ${t.deliveredAt} IS NOT NULL)) IS TRUE`,
    ),
  ],
);

/** Each signed approval is immutable; attaching the other signature creates durable ledger work. */
export const federationCommercialExecutionApprovals = pgTable(
  "federation_commercial_execution_approvals",
  {
    localSiteId: uuid("local_site_id").notNull(),
    recordId: uuid("record_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    payload: jsonb("payload").$type<CommercialExecutionApproval>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    approvalJws: text("approval_jws").notNull(),
    counterpartyJws: text("counterparty_jws"),
    authorizationPolicyId: uuid("authorization_policy_id").references(
      () => federationReservationPolicies.id,
    ),
    terminalAutoState: varchar("terminal_auto_state", { length: 24 }).notNull().default("pending"),
    terminalAutoNextAt: timestamp("terminal_auto_next_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    terminalAutoError: varchar("terminal_auto_error", { length: 64 }),
    stopId: uuid("stop_id"),
    stopRequestedBy: uuid("stop_requested_by").references(() => users.id),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    stopNextAttemptAt: timestamp("stop_next_attempt_at", { withTimezone: true }),
    stopLastError: varchar("stop_last_error", { length: 64 }),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.recordId] }),
    index("federation_terminal_auto_pending").on(
      t.localSiteId,
      t.terminalAutoState,
      t.terminalAutoNextAt,
    ),
    check(
      "federation_terminal_auto_state",
      sql`${t.terminalAutoState} IN ('pending','needs_review')`,
    ),
    uniqueIndex("federation_execution_stop_id").on(t.stopId),
    index("federation_execution_stop_pending")
      .on(t.localSiteId, t.stopNextAttemptAt)
      .where(sql`${t.stopNextAttemptAt} IS NOT NULL`),
    check(
      "federation_execution_stop_intent",
      sql`((${t.stopId} IS NULL AND ${t.stopRequestedBy} IS NULL AND ${t.stopRequestedAt} IS NULL AND ${t.stopNextAttemptAt} IS NULL AND ${t.stopLastError} IS NULL)
        OR (${t.stopId} IS NOT NULL AND ${t.stopRequestedBy} IS NOT NULL AND ${t.stopRequestedAt} IS NOT NULL AND ${t.payload}->>'kind' = 'commercial-reservation' AND ${t.payload}->'request'->>'mode' = 'ledger_coordinated')) IS TRUE`,
    ),
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    index("federation_execution_approval_org").on(
      t.localSiteId,
      t.localOrgId,
      t.agreementRevisionId,
      t.createdAt,
    ),
    index("federation_execution_approval_operation")
      .on(t.localSiteId, t.localOrgId, sql`(${t.payload}->'request'->>'operationId')`)
      .where(sql`${t.payload}->>'kind' = 'commercial-reservation'`),
    check(
      "federation_execution_approval_payload",
      sql`(
      ${t.digest} ~ '^sha256:[a-f0-9]{64}$'
      AND ((${t.payload}->>'kind' = 'commercial-reservation'
        AND ${t.payload}->>'reservationId' = ${t.recordId}::text
        AND ${t.payload}->'request'->>'agreementRevisionId' = ${t.agreementRevisionId}::text)
      OR (${t.payload}->>'kind' = 'commercial-release'
        AND ${t.payload}->>'releaseId' = ${t.recordId}::text))
    ) IS TRUE`,
    ),
  ],
);

/** Immutable institutional consent; replacement requires explicit revocation. */
export const federationTerminalPolicies = pgTable(
  "federation_terminal_policies",
  {
    id: uuid("id").primaryKey(),
    localSiteId: uuid("local_site_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    agreementDigest: varchar("agreement_digest", { length: 71 }).notNull(),
    outcomes: jsonb("outcomes").$type<("completed" | "failed" | "cancelled")[]>().notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
  },
  (t) => [
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    uniqueIndex("federation_terminal_policy_active")
      .on(t.localSiteId, t.agreementRevisionId)
      .where(sql`${t.revokedAt} IS NULL`),
    check(
      "federation_terminal_policy_valid",
      sql`(${t.validUntil} > ${t.validFrom} AND ${t.agreementDigest} ~ '^sha256:[a-f0-9]{64}$' AND jsonb_typeof(${t.outcomes}) = 'array' AND jsonb_array_length(${t.outcomes}) BETWEEN 1 AND 3 AND ${t.outcomes} <@ '["completed","failed","cancelled"]'::jsonb AND ((${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL))) IS TRUE`,
    ),
  ],
);

/** Presence is a permanent execution fence, committed atomically with the local signature. */
export const federationExecutionTerminals = pgTable(
  "federation_execution_terminals",
  {
    localSiteId: uuid("local_site_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    terminalId: uuid("terminal_id").notNull(),
    payload: jsonb("payload").$type<CommercialTerminal>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    evidence: jsonb("evidence").$type<FederationExecutionTerminalEvidence>().notNull(),
    approvalJws: text("approval_jws").notNull(),
    counterpartyJws: text("counterparty_jws"),
    sourceReview: jsonb("source_review").$type<FederationTerminalSourceReview>(),
    authorizationPolicyId: uuid("authorization_policy_id").references(
      () => federationTerminalPolicies.id,
    ),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.reservationId] }),
    uniqueIndex("federation_execution_terminal_id").on(t.localSiteId, t.terminalId),
    foreignKey({
      columns: [t.localSiteId, t.reservationId],
      foreignColumns: [
        federationCommercialExecutionApprovals.localSiteId,
        federationCommercialExecutionApprovals.recordId,
      ],
    }),
    check(
      "federation_execution_terminal_identity",
      sql`(
      ${t.digest} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.payload}->>'kind' = 'commercial-terminal'
      AND ${t.payload}->>'terminalId' = ${t.terminalId}::text
      AND ${t.payload}->>'reservationId' = ${t.reservationId}::text
      AND ((${t.payload}->>'targetSiteId' = ${t.localSiteId}::text AND ${t.sourceReview} IS NULL)
        OR (${t.payload}->>'sourceSiteId' = ${t.localSiteId}::text AND ${t.sourceReview} IS NOT NULL AND ${t.counterpartyJws} IS NOT NULL))
      AND ${t.evidence}->>'reservationId' = ${t.reservationId}::text
      AND ${t.evidence}->>'activationId' = ${t.payload}->>'activationId'
      AND ${t.evidence}->'workflow'->>'status' = ${t.payload}->>'outcome'
    ) IS TRUE`,
    ),
  ],
);

export const federationCommercialAttempts = pgTable(
  "federation_commercial_attempts",
  {
    id: uuid("id").primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => federationCommercialSubmissions.id),
    number: integer("number").notNull(),
    transactionId: varchar("transaction_id", { length: 64 }).notNull(),
    recovery: text("recovery").notNull(),
    stage: varchar("stage", { length: 24 }).notNull().default("proposal"),
    validationCode: integer("validation_code"),
    blockNumber: numeric("block_number", { precision: 20, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_commercial_tx").on(t.transactionId),
    uniqueIndex("federation_commercial_attempt_number").on(t.submissionId, t.number),
    check(
      "federation_commercial_attempt",
      sql`${t.number} > 0 AND ${t.transactionId} ~ '^[a-f0-9]{64}$' AND octet_length(${t.recovery}) BETWEEN 1 AND 4194304`,
    ),
    check(
      "federation_commercial_result",
      sql`((${t.stage} IN ('proposal','transaction','abandoned') AND ${t.validationCode} IS NULL AND ${t.blockNumber} IS NULL) OR (${t.stage} = 'committed' AND ${t.validationCode} = 0 AND ${t.blockNumber} >= 0) OR (${t.stage} = 'invalid' AND ${t.validationCode} BETWEEN 1 AND 255 AND ${t.blockNumber} >= 0)) IS TRUE`,
    ),
  ],
);

export const federationMarketSubmissions = pgTable(
  "federation_market_submissions",
  {
    id: uuid("id").primaryKey(),
    localSiteId: uuid("local_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    authorizationPolicyId: uuid("authorization_policy_id").references(
      () => federationReservationPolicies.id,
    ),
    demandId: uuid("demand_id").notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    input: jsonb("input").$type<MarketAdapterProposalInput>().notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    closureCheckAt: timestamp("closure_check_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("federation_market_org").on(t.localSiteId, t.localOrgId, t.createdAt),
    index("federation_market_demand").on(t.localSiteId, t.demandId),
    index("federation_market_closure_check")
      .on(t.localSiteId, t.closureCheckAt)
      .where(
        sql`${t.state} = 'committed' AND ${t.input}->>'operation' IN ('publish-demand','claim-demand')`,
      ),
    index("federation_market_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    uniqueIndex("federation_market_activation")
      .on(t.localSiteId, sql`(${t.input}->'activation'->'gate'->>'reservationId')`)
      .where(sql`${t.input}->>'operation' = 'activate-demand'`),
    index("federation_market_execution_confirmation")
      .on(
        t.localSiteId,
        t.localOrgId,
        sql`(${t.input}->'authorization'->'gate'->>'reservationId')`,
        t.createdAt,
      )
      .where(sql`${t.input}->>'operation' = 'authorize-execution'`),
    uniqueIndex("federation_market_execution_stop")
      .on(t.localSiteId, sql`(${t.input}->'stop'->>'activationId')`, t.demandId)
      .where(sql`${t.input}->>'operation' = 'request-execution-stop'`),
    uniqueIndex("federation_market_execution_closure")
      .on(t.localSiteId, sql`(${t.input}->'closure'->'gate'->'terminal'->>'activationId')`)
      .where(sql`${t.input}->>'operation' = 'close-demand'`),
    check(
      "federation_market_submission_state",
      sql`${t.state} IN ('pending','committed','needs_review','closed')`,
    ),
    check(
      "federation_market_submission_input",
      sql`(${t.digest} ~ '^sha256:[a-f0-9]{64}$' AND (
        (${t.input}->>'operation' = 'publish-demand' AND ${t.input}->'demand'->>'demandId' = ${t.id}::text AND ${t.input}->'demand'->>'demandId' = ${t.demandId}::text AND ${t.input}->'demand'->>'sourceSiteId' = ${t.localSiteId}::text)
        OR (${t.input}->>'operation' = 'claim-demand' AND ${t.input}->'claim'->>'claimId' = ${t.id}::text AND ${t.input}->'claim'->>'demandId' = ${t.demandId}::text AND ${t.input}->'claim'->>'providerSiteId' = ${t.localSiteId}::text)
        OR (${t.input}->>'operation' = 'cancel-open-demand' AND ${t.input}->'cancellation'->>'cancellationId' = ${t.id}::text AND ${t.input}->'cancellation'->>'demandId' = ${t.demandId}::text)
        OR (${t.input}->>'operation' = 'close-unreserved-demand' AND ${t.input}->'closure'->>'closureId' = ${t.id}::text AND ${t.input}->'closure'->>'demandId' = ${t.demandId}::text AND ${t.input}->'closure'->>'issuerSiteId' = ${t.localSiteId}::text)
        OR (${t.input}->>'operation' = 'activate-demand' AND ${t.input}->'activation'->>'activationId' = ${t.id}::text AND ${t.input}->'activation'->>'demandId' = ${t.demandId}::text)
        OR (${t.input}->>'operation' = 'authorize-execution' AND ${t.input}->'authorization'->>'authorizationId' = ${t.id}::text AND ${t.input}->'authorization'->>'demandId' = ${t.demandId}::text AND ${t.input}->'authorization'->'gate'->>'demandId' = ${t.demandId}::text AND ${t.input}->'authorization'->>'issuerSiteId' = ${t.localSiteId}::text)
        OR (${t.input}->>'operation' = 'request-execution-stop' AND ${t.input}->'stop'->>'stopId' = ${t.id}::text AND ${t.input}->'stop'->>'demandId' = ${t.demandId}::text AND ${t.input}->'stop'->>'issuerSiteId' = ${t.localSiteId}::text)
        OR (${t.input}->>'operation' = 'close-demand' AND ${t.input}->'closure'->>'closureId' = ${t.id}::text AND ${t.input}->'closure'->>'demandId' = ${t.demandId}::text AND ${t.input}->'closure'->'gate'->>'demandId' = ${t.demandId}::text AND ((${t.input}->'closure'->'gate'->>'state' = 'TERMINAL' AND ${t.input}->'closure'->'gate'->'terminal'->>'terminalId' = ${t.id}::text) OR (${t.input}->'closure'->'gate'->>'state' = 'REVOKED' AND ${t.input}->'closure'->'gate'->>'version' = '2' AND ${t.input}->'closure'->>'expectedVersion' = ${t.input}->'closure'->'gate'->>'claimVersion')))
      )) IS TRUE`,
    ),
    check(
      "federation_market_submission_lease",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
  ],
);

export const federationMarketAttempts = pgTable(
  "federation_market_attempts",
  {
    id: uuid("id").primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => federationMarketSubmissions.id),
    number: integer("number").notNull(),
    transactionId: varchar("transaction_id", { length: 64 }).notNull(),
    recovery: text("recovery").notNull(),
    stage: varchar("stage", { length: 24 }).notNull().default("proposal"),
    validationCode: integer("validation_code"),
    blockNumber: numeric("block_number", { precision: 20, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_market_tx").on(t.transactionId),
    uniqueIndex("federation_market_attempt_number").on(t.submissionId, t.number),
    check(
      "federation_market_attempt",
      sql`${t.number} > 0 AND ${t.transactionId} ~ '^[a-f0-9]{64}$' AND octet_length(${t.recovery}) BETWEEN 1 AND 4194304`,
    ),
    check(
      "federation_market_result",
      sql`((${t.stage} IN ('proposal','transaction','abandoned') AND ${t.validationCode} IS NULL AND ${t.blockNumber} IS NULL) OR (${t.stage} = 'committed' AND ${t.validationCode} = 0 AND ${t.blockNumber} >= 0) OR (${t.stage} = 'invalid' AND ${t.validationCode} BETWEEN 1 AND 255 AND ${t.blockNumber} >= 0)) IS TRUE`,
    ),
  ],
);

/** Immutable local evidence; raw-metering retention and Job deletion must not erase it. */
export const federationTerminalEvidence = pgTable(
  "federation_terminal_evidence",
  {
    jobId: uuid("job_id")
      .primaryKey()
      .references(() => jobs.id),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => federationReservations.id),
    workflowRunId: uuid("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    evidence: jsonb("evidence").$type<FederationTerminalEvidence>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("federation_terminal_reservation").on(t.reservationId, t.jobId),
    check("federation_terminal_digest", sql`${t.digest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "federation_terminal_identity",
      sql`coalesce(
      ${t.evidence}->>'version' = '1'
      AND ${t.evidence}->>'jobId' = ${t.jobId}::text
      AND ${t.evidence}->>'reservationId' = ${t.reservationId}::text
      AND ${t.evidence}->>'runId' = ${t.workflowRunId}::text
      AND ${t.evidence}->>'status' IN ('completed','failed','cancelled'), false)`,
    ),
  ],
);

/** A later scheduler observation supplements, and never overwrites, the terminal record. */
export const federationAccountingCollections = pgTable(
  "federation_accounting_collections",
  {
    jobId: uuid("job_id")
      .primaryKey()
      .references(() => federationTerminalEvidence.jobId),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    requestId: uuid("request_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: varchar("last_error", { length: 64 }),
    observation: jsonb("observation").$type<FederationAccountingObservation>(),
    digest: varchar("digest", { length: 71 }),
  },
  (t) => [
    index("federation_accounting_due").on(t.state, t.nextAttemptAt),
    check("federation_accounting_state", sql`${t.state} IN ('pending','collected','needs_review')`),
    check(
      "federation_accounting_observation",
      sql`(${t.state} = 'collected') = (${t.observation} IS NOT NULL AND ${t.digest} IS NOT NULL)`,
    ),
    check(
      "federation_accounting_digest",
      sql`${t.digest} IS NULL OR ${t.digest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** Reporting is independent of execution success and the optional ledger outbox. */
export const federationUsageTasks = pgTable(
  "federation_usage_tasks",
  {
    reservationId: uuid("reservation_id")
      .primaryKey()
      .references(() => federationReservations.id),
    localSiteId: uuid("local_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    gaps: jsonb("gaps").$type<CommercialUsageGap[]>().notNull().default([]),
    lastError: varchar("last_error", { length: 64 }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    index("federation_usage_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    check(
      "federation_usage_task_state",
      sql`${t.state} IN ('pending','missing_data','needs_review','reported')`,
    ),
  ],
);

/** Original and correction reports remain immutable; no financial balance is stored here. */
export const federationUsageReports = pgTable(
  "federation_usage_reports",
  {
    id: uuid("id").primaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => federationUsageTasks.reservationId),
    number: integer("number").notNull(),
    report: jsonb("report").$type<CommercialUsage>().notNull(),
    correctionEvidence: jsonb("correction_evidence").$type<CommercialUsageCorrectionEvidence>(),
    reportJws: text("report_jws").notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    evidenceSet: jsonb("evidence_set").$type<CommercialUsageEvidenceSet>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_usage_report_sequence").on(t.reservationId, t.number),
    check(
      "federation_usage_report_identity",
      sql`coalesce(${t.number} > 0 AND ${t.report}->>'reportId' = ${t.id}::text
    AND ${t.evidenceSet}->>'reservationId' = ${t.reservationId}::text AND ${t.digest} ~ '^sha256:[a-f0-9]{64}$',false)`,
    ),
  ],
);

/** Source-side polling survives restarts; receipt of a report never approves a bill. */
export const federationUsageSyncs = pgTable(
  "federation_usage_syncs",
  {
    localSiteId: uuid("local_site_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    number: integer("number").notNull().default(0),
    lastReportId: uuid("last_report_id"),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    providerState: varchar("provider_state", { length: 24 }),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.operationId] }),
    foreignKey({
      name: "federation_usage_sync_outbound_fk",
      columns: [t.localSiteId, t.operationId],
      foreignColumns: [federationOutbound.localSiteId, federationOutbound.operationId],
    }),
    index("federation_usage_sync_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    check(
      "federation_usage_sync_state",
      sql`${t.state} IN ('pending','needs_review') AND ${t.number} >= 0 AND ((${t.number} = 0) = (${t.lastReportId} IS NULL)) AND ((${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL))`,
    ),
  ],
);

export const federationReceivedUsage = pgTable(
  "federation_received_usage",
  {
    localSiteId: uuid("local_site_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    reportId: uuid("report_id").notNull(),
    number: integer("number").notNull(),
    report: jsonb("report").$type<CommercialUsage>().notNull(),
    reportJws: text("report_jws").notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    correctionEvidence: jsonb("correction_evidence").$type<CommercialUsageCorrectionEvidence>(),
    pageJws: text("page_jws").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.reportId] }),
    foreignKey({
      name: "federation_received_usage_sync_fk",
      columns: [t.localSiteId, t.operationId],
      foreignColumns: [federationUsageSyncs.localSiteId, federationUsageSyncs.operationId],
    }),
    uniqueIndex("federation_received_usage_sequence").on(t.localSiteId, t.operationId, t.number),
    check(
      "federation_received_usage_identity",
      sql`(${t.number} > 0 AND ${t.report}->>'reportId' = ${t.reportId}::text AND ${t.digest} ~ '^sha256:[a-f0-9]{64}$') IS TRUE`,
    ),
  ],
);

export const federationTerminalSyncs = pgTable(
  "federation_terminal_syncs",
  {
    localSiteId: uuid("local_site_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    terminalId: uuid("terminal_id"),
    proposalDigest: varchar("proposal_digest", { length: 71 }),
    totalBytes: integer("total_bytes"),
    nextOffset: integer("next_offset").notNull().default(0),
    proposal: jsonb("proposal").$type<FederationTerminalProposal>(),
    acknowledgementJws: text("acknowledgement_jws"),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.reservationId] }),
    foreignKey({
      name: "federation_terminal_sync_approval_fk",
      columns: [t.localSiteId, t.reservationId],
      foreignColumns: [
        federationCommercialExecutionApprovals.localSiteId,
        federationCommercialExecutionApprovals.recordId,
      ],
    }),
    index("federation_terminal_sync_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    check(
      "federation_terminal_sync_state",
      sql`${t.state} IN ('pending','ready','complete','needs_review')`,
    ),
    check(
      "federation_terminal_sync_lease",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
    check(
      "federation_terminal_sync_content",
      sql`((
    (${t.terminalId} IS NULL AND ${t.proposalDigest} IS NULL AND ${t.totalBytes} IS NULL AND ${t.nextOffset} = 0 AND ${t.proposal} IS NULL)
    OR (${t.terminalId} IS NOT NULL AND ${t.proposalDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.totalBytes} BETWEEN 1 AND 16777216
      AND ${t.nextOffset} BETWEEN 1 AND ${t.totalBytes}
      AND ((${t.proposal} IS NULL AND ${t.nextOffset} % 65536 = 0) OR
        (${t.proposal}->'payload'->>'terminalId' = ${t.terminalId}::text AND ${t.nextOffset} = ${t.totalBytes})))
    ) AND (${t.state} <> 'ready' OR ${t.proposal} IS NOT NULL)
      AND ((${t.state} = 'complete') = (${t.acknowledgementJws} IS NOT NULL))) IS TRUE`,
    ),
  ],
);
export const federationTerminalChunks = pgTable(
  "federation_terminal_chunks",
  {
    localSiteId: uuid("local_site_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    offset: integer("offset").notNull(),
    bytes: text("bytes").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.reservationId, t.offset] }),
    foreignKey({
      name: "federation_terminal_chunk_sync_fk",
      columns: [t.localSiteId, t.reservationId],
      foreignColumns: [federationTerminalSyncs.localSiteId, federationTerminalSyncs.reservationId],
    }),
    check(
      "federation_terminal_chunk_size",
      sql`${t.offset} BETWEEN 0 AND 16777215 AND ${t.offset} % 65536 = 0 AND octet_length(${t.bytes}) BETWEEN 4 AND 87384`,
    ),
  ],
);

/** Exchange of existing business signatures grants no new signing or execution authority. */
export const federationCommercialApprovalSyncs = pgTable(
  "federation_commercial_approval_syncs",
  {
    localSiteId: uuid("local_site_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    recordKind: varchar("record_kind", { length: 16 })
      .$type<
        "agreement" | "reservation" | "release" | "bill" | "settlement" | "adjustment" | "refund"
      >()
      .notNull(),
    recordId: uuid("record_id").notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.recordKind, t.recordId] }),
    foreignKey({
      name: "federation_approval_sync_contract_fk",
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    index("federation_approval_sync_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    check(
      "federation_approval_sync_identity",
      sql`(${t.recordKind} IN ('agreement','reservation','release','bill','settlement','adjustment','refund') AND (${t.recordKind} <> 'agreement' OR ${t.recordId} = ${t.agreementRevisionId})) IS TRUE`,
    ),
    check(
      "federation_approval_sync_state",
      sql`${t.state} IN ('pending','complete','needs_review','closed')`,
    ),
    check(
      "federation_approval_sync_lease",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
    check(
      "federation_approval_sync_receipt",
      sql`(${t.state} = 'complete') = (${t.verifiedAt} IS NOT NULL)`,
    ),
  ],
);

/** Original execution-consent signatures exchange independently of commercial contracts. */
export const federationAgreementSyncs = pgTable(
  "federation_agreement_syncs",
  {
    localSiteId: uuid("local_site_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.revisionId] }),
    foreignKey({
      name: "federation_agreement_sync_approval_fk",
      columns: [t.localSiteId, t.revisionId],
      foreignColumns: [
        federationAgreementApprovals.localSiteId,
        federationAgreementApprovals.revisionId,
      ],
    }),
    index("federation_agreement_sync_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    check(
      "federation_agreement_sync_state",
      sql`${t.state} IN ('pending','complete','needs_review')`,
    ),
    check(
      "federation_agreement_sync_lease",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
    check(
      "federation_agreement_sync_receipt",
      sql`(${t.state} = 'complete') = (${t.verifiedAt} IS NOT NULL)`,
    ),
  ],
);

/** Private task intent before public publish/claim; never a substitute for reservation approval. */
export const federationMarketRequests = pgTable(
  "federation_market_requests",
  {
    localSiteId: uuid("local_site_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    demandId: uuid("demand_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => federationReservationPolicies.id),
    direction: varchar("direction", { length: 16 }).notNull(),
    payload: jsonb("payload").$type<MarketRequest>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    sourceJws: text("source_jws"),
    sourceFingerprint: varchar("source_fingerprint", { length: 64 }),
    receiptJws: text("receipt_jws"),
    requestedBy: uuid("requested_by").references(() => users.id),
    marketSubmissionId: uuid("market_submission_id").references(
      () => federationMarketSubmissions.id,
    ),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    lastError: varchar("last_error", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.reservationId] }),
    uniqueIndex("federation_market_request_demand").on(t.localSiteId, t.demandId),
    index("federation_market_request_pending").on(t.localSiteId, t.state, t.nextAttemptAt),
    index("federation_market_request_policy").on(t.policyId),
    foreignKey({
      name: "federation_market_request_contract_fk",
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    check(
      "federation_market_request_state",
      sql`${t.state} IN ('pending','complete','needs_review','closed') AND ((${t.state} = 'complete') = (${t.completedAt} IS NOT NULL))`,
    ),
    check(
      "federation_market_request_direction",
      sql`${t.direction} IN ('outbound','inbound') AND (${t.direction} <> 'inbound' OR (${t.sourceJws} IS NOT NULL AND ${t.sourceFingerprint} IS NOT NULL))`,
    ),
    check(
      "federation_market_request_lease",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
  ],
);

/** Site-wide completion allocations survive Server restarts and agreement revision changes. */
export const federationCompletionPools = pgTable(
  "federation_completion_pools",
  {
    localSiteId: uuid("local_site_id").primaryKey(),
    reserveId: uuid("reserve_id").notNull(),
    capacityBytes: numeric("capacity_bytes", { precision: 30, scale: 0 }).notNull(),
    taskBytes: numeric("task_bytes", { precision: 30, scale: 0 }).notNull(),
    marketBytes: numeric("market_bytes", { precision: 30, scale: 0 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "federation_completion_pool_bytes",
      sql`${t.capacityBytes} > 0 AND ${t.capacityBytes} < 1e30 AND ${t.taskBytes} > 0 AND ${t.taskBytes} <= ${t.capacityBytes} AND ${t.marketBytes} > 0 AND ${t.marketBytes} <= ${t.capacityBytes}`,
    ),
  ],
);

export const federationCompletionClaims = pgTable(
  "federation_completion_claims",
  {
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationCompletionPools.localSiteId),
    kind: varchar("kind", { length: 16 }).$type<"task" | "market">().notNull(),
    intentId: varchar("intent_id", { length: 96 }).notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    allocatedBytes: numeric("allocated_bytes", { precision: 30, scale: 0 }).notNull(),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    releaseBlocker: varchar("release_blocker", { length: 64 }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.kind, t.intentId] }),
    index("federation_completion_active")
      .on(t.localSiteId, t.nextCheckAt)
      .where(sql`${t.releasedAt} IS NULL`),
    check("federation_completion_claim_kind", sql`${t.kind} IN ('task', 'market')`),
    check(
      "federation_completion_claim_bytes",
      sql`${t.allocatedBytes} > 0 AND ${t.allocatedBytes} < 1e30`,
    ),
  ],
);

/** Final public closure observed through this site's trusted ledger adapter; never inferred from expiry. */
export const federationUnreservedClosures = pgTable(
  "federation_unreserved_closures",
  {
    localSiteId: uuid("local_site_id").notNull(),
    demandId: uuid("demand_id").notNull(),
    originId: uuid("origin_id")
      .notNull()
      .references(() => federationMarketSubmissions.id),
    payload: jsonb("payload").$type<MarketDemandState>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.demandId] }),
    check(
      "federation_unreserved_closure_identity",
      sql`(
      ${t.digest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.payload}->>'status' = 'CLOSED'
      AND ${t.payload}->'demand'->>'demandId' = ${t.demandId}::text
      AND ${t.payload}->'unreservedClosure'->>'demandId' = ${t.demandId}::text
      AND ${t.payload}->'unreservedClosure'->>'claimId' = ${t.payload}->'claim'->>'claimId'
      AND (${t.payload}->'demand'->>'sourceSiteId' = ${t.localSiteId}::text
        OR ${t.payload}->'claim'->>'providerSiteId' = ${t.localSiteId}::text)
    ) IS TRUE`,
    ),
  ],
);

/** Immutable bilateral refund consent; original task and cancellation records remain intact. */
export const federationCommercialRefunds = pgTable(
  "federation_commercial_refunds",
  {
    localSiteId: uuid("local_site_id").notNull(),
    refundId: uuid("refund_id").notNull(),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    operationId: uuid("operation_id").notNull(),
    payload: jsonb("payload").$type<CommercialRefund>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    approvalJws: text("approval_jws").notNull(),
    counterpartyJws: text("counterparty_jws"),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    authorizationPolicyId: uuid("authorization_policy_id").references(
      () => federationClosingPolicies.id,
    ),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.refundId] }),
    foreignKey({
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationCommercialAgreements.localSiteId,
        federationCommercialAgreements.revisionId,
      ],
    }),
    uniqueIndex("federation_refund_operation").on(t.localSiteId, t.operationId),
    index("federation_refund_org").on(t.localSiteId, t.localOrgId, t.createdAt),
    check(
      "federation_refund_identity",
      sql`(
    ${t.digest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.payload}->>'kind' = 'commercial-refund'
    AND ${t.payload}->>'refundId' = ${t.refundId}::text
    AND ${t.payload}->'request'->>'agreementRevisionId' = ${t.agreementRevisionId}::text
    AND ${t.payload}->'request'->>'operationId' = ${t.operationId}::text
    AND ${t.payload}->'request'->>'mode' IN ('bilateral_direct','bilateral_attested')
    AND ${t.payload}->>'releasedAmount' = ${t.payload}->'request'->>'maxAmount'
    AND (${t.payload}->'request'->>'senderSiteId' = ${t.localSiteId}::text OR ${t.payload}->'request'->>'recipientSiteId' = ${t.localSiteId}::text)
    AND (${t.appliedAt} IS NULL OR ${t.counterpartyJws} IS NOT NULL)) IS TRUE`,
    ),
  ],
);

/** Signed inventory only: registration never publishes a replica or grants data use. */
export const federationMediaPackages = pgTable(
  "federation_media_packages",
  {
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationSites.id),
    packageId: uuid("package_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    senderSiteId: uuid("sender_site_id")
      .notNull()
      .references(() => federationSites.id),
    // Results return to the source approval table; task guards validate the directional agreement.
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    taskInputImportId: uuid("task_input_import_id").references(() => federationInputImports.id),
    taskResultImportId: uuid("task_result_import_id").references(() => federationResultImports.id),
    manifest: jsonb("manifest").$type<FederationMediaManifest>().notNull(),
    manifestDigest: varchar("manifest_digest", { length: 71 }).notNull(),
    manifestJws: text("manifest_jws").notNull(),
    registeredBy: uuid("registered_by")
      .notNull()
      .references(() => users.id),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.packageId] }),
    index("federation_media_package_org").on(t.localSiteId, t.localOrgId, t.registeredAt),
    // Legacy task inventories may be unbound, but cannot receive a new import/key grant.
    check(
      "federation_media_package_target",
      sql`((${t.taskInputImportId} IS NULL OR (${t.manifest}->'subject'->>'kind' = 'task-input' AND ${t.taskResultImportId} IS NULL))
        AND (${t.taskResultImportId} IS NULL OR (${t.manifest}->'subject'->>'kind' = 'task-result' AND ${t.taskInputImportId} IS NULL))) IS TRUE`,
    ),
    check(
      "federation_media_package_identity",
      sql`(
      ${t.manifest}->>'kind' = 'media-manifest'
      AND ${t.manifest}->>'packageId' = ${t.packageId}::text
      AND ${t.manifest}->>'senderSiteId' = ${t.senderSiteId}::text
      AND ${t.manifest}->>'recipientSiteId' = ${t.localSiteId}::text
      AND ${t.manifest}->>'agreementRevisionId' = ${t.agreementRevisionId}::text
      AND ${t.senderSiteId} <> ${t.localSiteId}
      AND ${t.manifestDigest} ~ '^sha256:[a-f0-9]{64}$'
      AND octet_length(${t.manifestJws}) BETWEEN 1 AND 524288
      AND ((${t.revokedAt} IS NULL) = (${t.revocationReason} IS NULL))) IS TRUE`,
    ),
  ],
);

/** Receiver-local consent only. A separate live source grant is still required to obtain a key. */
export const federationMediaImportAuthorizations = pgTable(
  "federation_media_import_authorizations",
  {
    authorizationId: uuid("authorization_id").primaryKey(),
    localSiteId: uuid("local_site_id").notNull(),
    packageId: uuid("package_id").notNull(),
    agentId: varchar("agent_id", { length: 255 })
      .notNull()
      .references(() => agents.agentId),
    managedRootId: uuid("managed_root_id")
      .notNull()
      .references(() => clusterFileRoots.id),
    maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
  },
  (t) => [
    foreignKey({
      columns: [t.localSiteId, t.packageId],
      foreignColumns: [federationMediaPackages.localSiteId, federationMediaPackages.packageId],
    }),
    index("federation_media_import_package").on(t.localSiteId, t.packageId, t.approvedAt),
    check(
      "federation_media_import_limits",
      sql`(
      ${t.maxBytes} BETWEEN 0 AND 5497558138880
      AND ${t.expiresAt} > ${t.approvedAt}
      AND ${t.expiresAt} <= ${t.approvedAt} + interval '7 days'
      AND ((${t.revokedAt} IS NULL) = (${t.revocationReason} IS NULL))) IS TRUE`,
    ),
  ],
);

/** Source-side consent and encrypted package identity; no plaintext key is a public API field. */
export const federationMediaExports = pgTable(
  "federation_media_exports",
  {
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationSites.id),
    packageId: uuid("package_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    recipientSiteId: uuid("recipient_site_id")
      .notNull()
      .references(() => federationSites.id),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    versionId: uuid("version_id").references(() => dataAssetVersions.id),
    locationId: uuid("location_id").references(() => dataLocations.id),
    taskSelection:
      jsonb("task_selection").$type<
        Pick<FederationTaskMediaExportApproval, "kind" | "operationId" | "agentId">
      >(),
    source: jsonb("source")
      .$type<
        { agentId: string; managedRootId: string; relativePath: string } | FederationTaskMediaSource
      >()
      .notNull(),
    manifest: jsonb("manifest").$type<FederationMediaManifest>().notNull(),
    manifestDigest: varchar("manifest_digest", { length: 71 }).notNull(),
    manifestJws: text("manifest_jws").notNull(),
    recipient: varchar("recipient", { length: 62 }).notNull(),
    identityEncrypted: text("identity_encrypted").notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.packageId] }),
    foreignKey({
      name: "federation_media_export_approval",
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationAgreementApprovals.localSiteId,
        federationAgreementApprovals.revisionId,
      ],
    }),
    index("federation_media_export_org").on(t.localSiteId, t.localOrgId, t.approvedAt),
    check(
      "federation_media_export_selector",
      sql`((
        ${t.manifest}->'subject'->>'kind' = 'dataset'
        AND ${t.versionId} IS NOT NULL AND ${t.locationId} IS NOT NULL
        AND ${t.taskSelection} IS NULL
        AND NOT (${t.source} ? 'objects')
      ) OR (
        ${t.versionId} IS NULL AND ${t.locationId} IS NULL
        AND ${t.taskSelection}->>'kind' IN ('task-input', 'task-result')
        AND ${t.taskSelection}->>'kind' = ${t.manifest}->'subject'->>'kind'
        AND ${t.taskSelection}->>'operationId' = ${t.manifest}->'subject'->>'operationId'
        AND ${t.taskSelection}->>'agentId' = ${t.source}->>'agentId'
        AND jsonb_typeof(${t.source}->'objects') = 'array'
        AND NOT (${t.source} ?| array['managedRootId', 'relativePath'])
      )) IS TRUE`,
    ),
    check(
      "federation_media_export_identity",
      sql`(
      ${t.manifest}->>'kind' = 'media-manifest'
      AND ${t.manifest}->>'packageId' = ${t.packageId}::text
      AND ${t.manifest}->>'senderSiteId' = ${t.localSiteId}::text
      AND ${t.manifest}->>'recipientSiteId' = ${t.recipientSiteId}::text
      AND ${t.manifest}->>'agreementRevisionId' = ${t.agreementRevisionId}::text
      AND ${t.localSiteId} <> ${t.recipientSiteId}
      AND ${t.manifestDigest} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.recipient} ~ '^age1[0-9a-z]{58}$'
      AND octet_length(${t.identityEncrypted}) BETWEEN 1 AND 1024
      AND ${t.expiresAt} > ${t.approvedAt}
      AND ${t.expiresAt} <= ${t.approvedAt} + interval '7 days'
      AND ((${t.revokedAt} IS NULL) = (${t.revocationReason} IS NULL))) IS TRUE`,
    ),
  ],
);

/** Encrypted, request-bound key responses; no plaintext package identity is retained here. */
export const federationMediaKeyGrants = pgTable(
  "federation_media_key_grants",
  {
    localSiteId: uuid("local_site_id").notNull(),
    queryId: uuid("query_id").notNull(),
    packageId: uuid("package_id").notNull(),
    queryDigest: varchar("query_digest", { length: 71 }).notNull(),
    responseJws: text("response_jws").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.queryId] }),
    foreignKey({
      columns: [t.localSiteId, t.packageId],
      foreignColumns: [federationMediaExports.localSiteId, federationMediaExports.packageId],
    }),
    check(
      "federation_media_key_grant_window",
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '60 seconds'`,
    ),
    check("federation_media_key_grant_digest", sql`${t.queryDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

/** One current source export attempt per approved package; ciphertext stays on its Agent. */
export const federationMediaExportOperations = pgTable(
  "federation_media_export_operations",
  {
    localSiteId: uuid("local_site_id").notNull(),
    packageId: uuid("package_id").notNull(),
    generation: uuid("generation").notNull().unique(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    state: varchar("state", { length: 16 }).$type<"queued" | "exported" | "failed">().notNull(),
    sha256: varchar("sha256", { length: 64 }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.packageId] }),
    foreignKey({
      columns: [t.localSiteId, t.packageId],
      foreignColumns: [federationMediaExports.localSiteId, federationMediaExports.packageId],
    }),
    index("federation_media_export_pending").on(t.localSiteId, t.state, t.updatedAt),
    check(
      "federation_media_export_operation_result",
      sql`(
      ${t.state} IN ('queued', 'exported', 'failed') AND
      (CASE WHEN ${t.state} = 'exported' THEN ${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.sizeBytes} BETWEEN 1 AND 6597069766656
       ELSE ${t.sha256} IS NULL AND ${t.sizeBytes} IS NULL END)
    ) IS TRUE`,
    ),
  ],
);

/** Private verified imports; these rows do not publish locations or grant data use. */
export const federationMediaImportOperations = pgTable(
  "federation_media_import_operations",
  {
    authorizationId: uuid("authorization_id")
      .primaryKey()
      .references(() => federationMediaImportAuthorizations.authorizationId),
    generation: uuid("generation").notNull().unique(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    state: varchar("state", { length: 16 }).$type<"queued" | "verified" | "failed">().notNull(),
    latestGrant: jsonb("latest_grant").$type<FederationMediaImportGrant>(),
    verifiedBytes: bigint("verified_bytes", { mode: "number" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    receipt: jsonb("receipt").$type<FederationMediaReceipt>(),
    receiptJws: text("receipt_jws"),
    receiptAck: jsonb("receipt_ack").$type<FederationMediaReceiptAck>(),
    receiptAckJws: text("receipt_ack_jws"),
    receiptToken: uuid("receipt_token"),
    receiptNextAttemptAt: timestamp("receipt_next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    receiptLastError: varchar("receipt_last_error", { length: 32 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("federation_media_import_pending").on(t.state, t.updatedAt),
    index("federation_media_import_receipt_pending").on(t.receiptNextAttemptAt),
    check(
      "federation_media_import_operation_state",
      sql`(${t.state} IN ('queued','verified','failed') AND
    (CASE WHEN ${t.state} = 'verified' THEN ${t.verifiedAt} IS NOT NULL AND ${t.latestGrant} IS NOT NULL AND ${t.verifiedBytes} BETWEEN 0 AND 5497558138880
     ELSE ${t.verifiedAt} IS NULL AND ${t.verifiedBytes} IS NULL END)) IS TRUE`,
    ),
    check(
      "federation_media_import_operation_binding",
      sql`${t.latestGrant} IS NULL OR (
    ${t.latestGrant}->'binding'->>'generation' = ${t.generation}::text AND
    ${t.latestGrant}->'binding'->>'authorizationId' = ${t.authorizationId}::text) IS TRUE`,
    ),
  ],
);

/** One current media generation owns an original task inventory; released claims remain historical. */
export const federationTaskMediaClaims = pgTable(
  "federation_task_media_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskInputImportId: uuid("task_input_import_id").references(() => federationInputImports.id),
    taskResultImportId: uuid("task_result_import_id").references(() => federationResultImports.id),
    authorizationId: uuid("authorization_id")
      .notNull()
      .references(() => federationMediaImportOperations.authorizationId),
    generation: uuid("generation").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    uploadGrantToken: uuid("upload_grant_token"),
    uploadGrant: jsonb("upload_grant").$type<FederationMediaImportGrant>(),
  },
  (t) => [
    check(
      "federation_task_media_claim_direction",
      sql`num_nonnulls(${t.taskInputImportId}, ${t.taskResultImportId}) = 1`,
    ),
    uniqueIndex("federation_task_media_claim_generation").on(t.authorizationId, t.generation),
    uniqueIndex("federation_task_media_claim_input")
      .on(t.taskInputImportId)
      .where(sql`${t.releasedAt} IS NULL`),
    uniqueIndex("federation_task_media_claim_result")
      .on(t.taskResultImportId)
      .where(sql`${t.releasedAt} IS NULL`),
    check(
      "federation_task_media_claim_time",
      sql`${t.releasedAt} IS NULL OR ${t.releasedAt} >= ${t.claimedAt}`,
    ),
    check(
      "federation_task_media_upload_grant",
      sql`${t.uploadGrant} IS NULL OR (${t.uploadGrantToken} IS NOT NULL AND
        ${t.uploadGrant}->'binding'->>'authorizationId' = ${t.authorizationId}::text AND
        ${t.uploadGrant}->'binding'->>'generation' = ${t.generation}::text) IS TRUE`,
    ),
  ],
);

/** Source authorization is independent of a particular transport package or import approval. */
export const federationDatasetUsePolicies = pgTable(
  "federation_dataset_use_policies",
  {
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationSites.id),
    policyId: uuid("policy_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    recipientSiteId: uuid("recipient_site_id")
      .notNull()
      .references(() => federationSites.id),
    agreementRevisionId: uuid("agreement_revision_id").notNull(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => dataAssetVersions.id),
    asset: jsonb("asset").$type<FederationAssetRef>().notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.policyId] }),
    foreignKey({
      name: "federation_dataset_use_approval",
      columns: [t.localSiteId, t.agreementRevisionId],
      foreignColumns: [
        federationAgreementApprovals.localSiteId,
        federationAgreementApprovals.revisionId,
      ],
    }),
    index("federation_dataset_use_org").on(t.localSiteId, t.localOrgId, t.approvedAt),
    check(
      "federation_dataset_use_scope",
      sql`(${t.localSiteId} <> ${t.recipientSiteId} AND ${t.asset}->>'kind' = 'dataset' AND ${t.asset}->>'originSiteId' = ${t.localSiteId}::text AND ${t.expiresAt} > ${t.approvedAt}) IS TRUE`,
    ),
  ],
);
export const federationDatasetUseGrants = pgTable(
  "federation_dataset_use_grants",
  {
    localSiteId: uuid("local_site_id").notNull(),
    queryId: uuid("query_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    queryDigest: varchar("query_digest", { length: 71 }).notNull(),
    responseJws: text("response_jws").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.queryId] }),
    foreignKey({
      columns: [t.localSiteId, t.policyId],
      foreignColumns: [
        federationDatasetUsePolicies.localSiteId,
        federationDatasetUsePolicies.policyId,
      ],
    }),
    check(
      "federation_dataset_use_grant_window",
      sql`${t.expiresAt} > ${t.issuedAt} AND ${t.expiresAt} <= ${t.issuedAt} + interval '60 seconds'`,
    ),
    check("federation_dataset_use_grant_digest", sql`${t.queryDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

/** Structural provenance: editable asset metadata cannot remove the source's authority. */
export const federationDatasetAssets = pgTable(
  "federation_dataset_assets",
  {
    assetId: uuid("asset_id")
      .primaryKey()
      .references(() => dataAssets.id),
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationSites.id),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    sourceSiteId: uuid("source_site_id")
      .notNull()
      .references(() => federationSites.id),
    sourceAssetId: uuid("source_asset_id").notNull(),
  },
  (t) => [
    uniqueIndex("federation_dataset_asset_origin").on(
      t.localSiteId,
      t.localOrgId,
      t.sourceSiteId,
      t.sourceAssetId,
    ),
    check("federation_dataset_asset_sites", sql`${t.localSiteId} <> ${t.sourceSiteId}`),
  ],
);
export const federationDatasetReplicas = pgTable(
  "federation_dataset_replicas",
  {
    replicaId: uuid("replica_id").primaryKey(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => federationDatasetAssets.assetId),
    versionId: uuid("version_id")
      .notNull()
      .references(() => dataAssetVersions.id),
    locationId: uuid("location_id")
      .notNull()
      .unique()
      .references(() => dataLocations.id),
    authorizationId: uuid("authorization_id")
      .notNull()
      .unique()
      .references(() => federationMediaImportAuthorizations.authorizationId),
    importGeneration: uuid("import_generation").notNull(),
    sourcePolicyId: uuid("source_policy_id").notNull(),
    publicationName: varchar("publication_name", { length: 255 }).notNull(),
    agreementRevisionId: uuid("agreement_revision_id")
      .notNull()
      .references(() => federationAgreements.revisionId),
    reference: jsonb("reference").$type<FederationAssetRef>().notNull(),
    lease: jsonb("lease").$type<FederationDatasetUseLease>(),
    renewAfter: timestamp("renew_after", { withTimezone: true }).notNull(),
    renewToken: uuid("renew_token"),
    lastError: varchar("last_error", { length: 32 }),
    publishedBy: uuid("published_by")
      .notNull()
      .references(() => users.id),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
  },
  (t) => [
    index("federation_dataset_replica_renewal").on(t.renewAfter),
    check(
      "federation_dataset_replica_reference",
      sql`(${t.reference}->>'kind' = 'dataset') IS TRUE`,
    ),
  ],
);

/** Source custody evidence, independent of current export or dataset-use permissions. */
export const federationMediaReceipts = pgTable(
  "federation_media_receipts",
  {
    localSiteId: uuid("local_site_id").notNull(),
    senderSiteId: uuid("sender_site_id")
      .notNull()
      .references(() => federationSites.id),
    receiptId: uuid("receipt_id").notNull(),
    packageId: uuid("package_id").notNull(),
    receipt: jsonb("receipt").$type<FederationMediaReceipt>().notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    receiptJws: text("receipt_jws").notNull(),
    acknowledgement: jsonb("acknowledgement").$type<FederationMediaReceiptAck>().notNull(),
    acknowledgementJws: text("acknowledgement_jws").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.senderSiteId, t.receiptId] }),
    foreignKey({
      columns: [t.localSiteId, t.packageId],
      foreignColumns: [federationMediaExports.localSiteId, federationMediaExports.packageId],
    }),
    index("federation_media_receipt_package").on(t.localSiteId, t.packageId),
    check(
      "federation_media_receipt_scope",
      sql`(${t.localSiteId} <> ${t.senderSiteId} AND ${t.digest} ~ '^sha256:[a-f0-9]{64}$' AND
    ${t.receipt}->>'receiptId' = ${t.receiptId}::text AND ${t.receipt}->>'packageId' = ${t.packageId}::text AND
    ${t.receipt}->>'senderSiteId' = ${t.senderSiteId}::text AND ${t.receipt}->>'recipientSiteId' = ${t.localSiteId}::text AND
    ${t.acknowledgement}->>'receiptDigest' = ${t.digest}) IS TRUE`,
    ),
  ],
);

/** Institution-local physical inventory; never a data authorization or deletion command. */
export const federationMediaDevices = pgTable(
  "federation_media_devices",
  {
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationSites.id),
    deviceId: uuid("device_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    name: varchar("name", { length: 128 }).notNull(),
    assetTag: varchar("asset_tag", { length: 128 }).notNull(),
    capacityBytes: bigint("capacity_bytes", { mode: "number" }).notNull(),
    registrationDigest: varchar("registration_digest", { length: 71 }).notNull(),
    state: varchar("state", { length: 16 })
      .$type<"active" | "retired" | "destroyed">()
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.deviceId] }),
    uniqueIndex("federation_media_device_tag").on(t.localSiteId, t.localOrgId, t.assetTag),
    check(
      "federation_media_device_state",
      sql`${t.state} IN ('active','retired','destroyed') AND ${t.version} > 0 AND ${t.capacityBytes} BETWEEN 1 AND 9007199254740991 AND ${t.registrationDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

export const federationMediaShipments = pgTable(
  "federation_media_shipments",
  {
    localSiteId: uuid("local_site_id")
      .notNull()
      .references(() => federationSites.id),
    shipmentId: uuid("shipment_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    name: varchar("name", { length: 128 }).notNull(),
    senderSiteId: uuid("sender_site_id")
      .notNull()
      .references(() => federationSites.id),
    recipientSiteId: uuid("recipient_site_id")
      .notNull()
      .references(() => federationSites.id),
    packages: jsonb("packages").$type<MediaShipmentPackage[]>().notNull(),
    registrationDigest: varchar("registration_digest", { length: 71 }).notNull(),
    state: varchar("state", { length: 16 })
      .$type<MediaShipmentState>()
      .notNull()
      .default("prepared"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.shipmentId] }),
    index("federation_media_shipment_org").on(t.localSiteId, t.localOrgId, t.createdAt),
    check(
      "federation_media_shipment_identity",
      sql`(${t.senderSiteId} <> ${t.recipientSiteId} AND ${t.localSiteId} IN (${t.senderSiteId},${t.recipientSiteId}) AND ${t.version} > 0 AND ${t.registrationDigest} ~ '^sha256:[a-f0-9]{64}$' AND jsonb_typeof(${t.packages}) = 'array' AND jsonb_array_length(${t.packages}) BETWEEN 1 AND 100 AND ${t.state} IN ('prepared','dispatched','received','returning','returned','closed','cancelled','lost','damaged')) IS TRUE`,
    ),
  ],
);

export const federationMediaShipmentDevices = pgTable(
  "federation_media_shipment_devices",
  {
    localSiteId: uuid("local_site_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.shipmentId, t.deviceId] }),
    foreignKey({
      columns: [t.localSiteId, t.shipmentId],
      foreignColumns: [federationMediaShipments.localSiteId, federationMediaShipments.shipmentId],
    }),
    foreignKey({
      columns: [t.localSiteId, t.deviceId],
      foreignColumns: [federationMediaDevices.localSiteId, federationMediaDevices.deviceId],
    }),
    uniqueIndex("federation_media_device_active_shipment")
      .on(t.localSiteId, t.deviceId)
      .where(sql`${t.active}`),
  ],
);

export const federationMediaHandoffs = pgTable(
  "federation_media_handoffs",
  {
    localSiteId: uuid("local_site_id").notNull(),
    eventId: uuid("event_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    payload: jsonb("payload").$type<MediaHandoff>().notNull(),
    version: integer("version").notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.localSiteId, t.eventId] }),
    foreignKey({
      columns: [t.localSiteId, t.shipmentId],
      foreignColumns: [federationMediaShipments.localSiteId, federationMediaShipments.shipmentId],
    }),
    uniqueIndex("federation_media_handoff_version").on(t.localSiteId, t.shipmentId, t.version),
    check(
      "federation_media_handoff_identity",
      sql`(${t.version} > 1 AND ${t.payload}->>'eventId' = ${t.eventId}::text AND (${t.payload}->>'expectedVersion')::int = ${t.version} - 1 AND ${t.payload}->>'state' IN ('dispatched','received','returning','returned','closed','cancelled','lost','damaged')) IS TRUE`,
    ),
  ],
);
