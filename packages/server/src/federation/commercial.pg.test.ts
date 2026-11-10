import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  agents,
  federationCommercialAttempts as attempts,
  auditLog,
  federationCommercialAgreements as contracts,
  createPgDb,
  dataDeliveryRevocations,
  federationCommercialExecutionApprovals as executionApprovals,
  federationAgreementApprovals,
  federationAgreements,
  federationArbitrationDecisionDeliveries,
  federationArbitrationDecisions,
  federationArbitrationPolicies,
  federationArbitrationResolutions,
  federationArbitrationRevocationDeliveries,
  federationArbitrationRevocationNotices,
  federationAssetMappings,
  federationAttestationOutbox,
  federationBudgets,
  federationCancellations,
  federationCapabilities,
  federationCaseArbitrationDecisions,
  federationCaseAttempts,
  federationCaseSubmissions,
  federationCertificates,
  federationClosingPolicies,
  federationClosingTasks,
  federationCommercialAdjustments,
  federationCommercialApprovalSyncs,
  federationCommercialBills,
  federationCommercialRefunds,
  federationCommercialSettlements,
  federationCompletionClaims,
  federationDisclosureDownloads,
  federationDisclosurePolicies,
  federationDisclosureReadAuthorizations,
  federationDisclosures,
  federationDisputeDeliveries,
  federationDisputeFreezes,
  federationDisputes,
  federationEvidence,
  federationEvidenceCases,
  federationExecutionTerminals,
  federationMarketRequests,
  federationMaterials,
  federationOutbound,
  federationReceivedArbitrationDecisions,
  federationReceivedDisclosures,
  federationReservationPolicies,
  federationReservationProposals,
  federationReservations,
  federationResultImports,
  federationResultReceipts,
  federationSigningKeys,
  federationSites,
  federationTerminalChunks,
  federationTerminalEvidence,
  federationTerminalPolicies,
  federationTerminalSyncs,
  federationUnreservedClosures,
  federationWorkflowBindings,
  jobCancellations,
  jobs,
  federationMarketAttempts as marketAttempts,
  federationMarketSubmissions as marketSubmissions,
  orgs,
  softwareAssetRevisions,
  softwareAssets,
  softwareOperations,
  federationCommercialSubmissions as submissions,
  userOrgMemberships,
  users,
  workflowExecutionDelegations,
  workflowExecutionJobs,
  workflowExecutionLeases,
  workflowRuns,
} from "@kuintessence/db";
import {
  WorkflowExecutionInterrupted,
  WorkflowNodeWaiting,
  WorkflowPlacementConfigSchema,
  workflowDsl,
} from "@kuintessence/shared";
import {
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  FederationCancellationReceiptSchema,
  FederationCancellationSchema,
  FederationDelegationSchema,
  FederationError,
  type FederationMode,
  FederationResultReceiptAckSchema,
  FederationResultReceiptSchema,
  FederationResultReportSchema,
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
} from "@kuintessence/shared/federation";
import {
  ArbitrationContextQuerySchema,
  ArbitrationContextSchema,
  ArbitrationContextViewSchema,
  ArbitrationReviewSchema,
} from "@kuintessence/shared/federation/arbitration-context";
import {
  ArbitrationDecisionIntentSchema,
  ArbitrationDecisionSchema,
  ArbitrationOutcomeSchema,
  arbitrationDecisionIntent,
} from "@kuintessence/shared/federation/arbitration-decision";
import {
  ArbitrationDecisionDeliverySchema,
  ArbitrationDecisionReceiptSchema,
  arbitrationDecisionDeliveryPayload,
} from "@kuintessence/shared/federation/arbitration-decision-delivery";
import { CommercialArbitrationTaskBindingSchema } from "@kuintessence/shared/federation/arbitration-policy";
import { ArbitrationRevocationNoticeSchema } from "@kuintessence/shared/federation/arbitration-revocation-notice";
import { calculateCommercialBill } from "@kuintessence/shared/federation/billing";
import {
  type CaseProposal,
  FabricCaseTrustSchema,
} from "@kuintessence/shared/federation/case-ledger";
import {
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
  type CommercialAdvanceResult,
  CommercialAgreementSchema,
  CommercialAgreementSummarySchema,
  CommercialBillSchema,
  CommercialExecutionApprovalSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialTerminalSchema,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialApprovalQuerySchema,
  CommercialApprovalWaitingSchema,
} from "@kuintessence/shared/federation/commercial-approval-exchange";
import {
  CommercialDisputeFreezeSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import {
  type MarketAdapterProposalInput,
  type MarketAdvanceResult,
  MarketDemandStateSchema,
  type MarketProposalInput,
  MarketProposalInputSchema,
} from "@kuintessence/shared/federation/market";
import {
  MarketRequestReceiptSchema,
  MarketRequestSchema,
} from "@kuintessence/shared/federation/market-request";
import { ReservationProposalReceiptSchema } from "@kuintessence/shared/federation/reservation-proposal";
import {
  TERMINAL_MAX_BYTES,
  TerminalChunkSchema,
  TerminalDeliverySchema,
  TerminalQuerySchema,
} from "@kuintessence/shared/federation/terminal-exchange";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { z } from "zod";
import { JobCancellationOutbox } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationCommercialRoutes } from "../routes/federation-commercial";
import { createFederationEvidenceRoutes } from "../routes/federation-evidence";
import { createFederationOutboundRoutes } from "../routes/federation-outbound";
import { planSandboxPlacement } from "../scheduler/sandbox-planner";
import { JobService } from "../services/job-service";
import { SoftwareAvailabilityService } from "../services/software-availability";
import { createWorkflowPlacementBuilder } from "../services/workflow-placement-builder";
import { WorkflowExecutionJournalStore } from "../workflow/execution-journal";
import { FederationAdjustmentService } from "./adjustment";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { verifyArbitratedFinancialOriginal } from "./arbitrated-financial-original";
import {
  FederationArbitrationContextResponder,
  FederationArbitrationContextService,
} from "./arbitration-context";
import { FederationArbitrationDecisionService } from "./arbitration-decision";
import { FederationArbitrationDecisionDelivery } from "./arbitration-decision-delivery";
import { FederationArbitrationPolicyService } from "./arbitration-policy";
import { FederationArbitrationResolutionService } from "./arbitration-resolution";
import { FederationArbitrationReviewService } from "./arbitration-review";
import { FederationArbitrationRevocationDelivery } from "./arbitration-revocations";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationCaseArbitrationDecisionService } from "./case-arbitration-decisions";
import type { CaseClient } from "./case-client";
import { FederationCasePublicationService } from "./case-publications";
import { FederationCaseSubmissionService } from "./case-submissions";
import { FederationClosingAutomation } from "./closing-automation";
import { FederationClosingPolicyService } from "./closing-policy";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialApprovalExchange } from "./commercial-approval-exchange";
import type { CommercialClient } from "./commercial-client";
import { FederationCommercialExecutionService } from "./commercial-execution";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationCommercialWorker } from "./commercial-worker";
import { FederationDisclosureService } from "./disclosure";
import { FederationEvidenceService } from "./disclosure-delivery";
import { FederationDisclosurePolicyService } from "./disclosure-policy";
import { FederationDispatchAuthorization } from "./dispatch-authorization";
import { FederationDisputeDelivery } from "./dispute-delivery";
import { assertFederationTaskNotDisputed, lockFederationDisputeTask } from "./dispute-freeze";
import { FederationDisputeFreezeExchange } from "./dispute-freeze-exchange";
import { FederationDisputeService } from "./disputes";
import { FederationExecutionAutomation } from "./execution-automation";
import { FederationExecutionBindingService } from "./execution-binding";
import { FederationExecutionConfirmationService } from "./execution-confirmation";
import { FederationExecutionMonitor } from "./execution-monitor";
import { FederationExecutionStopService } from "./execution-stop";
import { FederationExecutionTerminalService } from "./execution-terminal";
import { FederationTerminalExchange } from "./execution-terminal-exchange";
import { FabricClientFailure } from "./fabric-client";
import { createFederationIngress } from "./ingress";
import { FederationMarketService } from "./market";
import type { MarketClient } from "./market-client";
import { FederationMarketRequestService } from "./market-requests";
import { FederationOutboundService } from "./outbound";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { FederationPermissionService } from "./permissions";
import { FederationPreparationService } from "./preparation";
import { FederationRefundService } from "./refund";
import {
  FederationReservationPolicyService,
  ReservationPolicyInputSchema,
} from "./reservation-policy";
import { FederationReservationProposalService } from "./reservation-proposals";
import { FederationSettlementService } from "./settlement";
import {
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import type { FederationStorageGuard } from "./storage-capacity";
import { FederationTerminalAutomation } from "./terminal-automation";
import { FederationTerminalPolicyService, TerminalPolicyInputSchema } from "./terminal-policy";
import { testAgreement, testDelegation, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";
import { observeUnreservedClosure, retireUnreservedIntents } from "./unreserved-closure";
import { bindWorkflowDelegation, type WorkflowDelegationPlan } from "./workflow-delegations";
import { FederationWorkflowExecutor } from "./workflow-executor";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Commercial PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const arbitrationSites: string[] = [];
const fixtures: {
  a: Awaited<ReturnType<typeof testKeys>>;
  b: Awaited<ReturnType<typeof testKeys>>;
  actor: { orgId: string; userId: string };
}[] = [];
class Adapter implements CommercialClient {
  receipt?: CommercialClient["receipt"];
  prepares: CommercialAdapterProposalInput[] = [];
  advances: string[] = [];
  offline = false;
  outcome: "pending" | "committed" | "invalid" = "committed";
  onAdvance?: (token: string, transactionId: string) => Promise<CommercialAdvanceResult>;
  async prepare(input: CommercialAdapterProposalInput) {
    this.prepares.push(input);
    if (this.offline) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const transactionId = randomBytes(32).toString("hex");
    return { transactionId, recovery: Buffer.from(`proposal:${transactionId}`).toString("base64") };
  }
  async advance(token: string): Promise<CommercialAdvanceResult> {
    this.advances.push(token);
    const [stage, transactionId] = Buffer.from(token, "base64").toString().split(":");
    if (!transactionId) throw new Error("Invalid test checkpoint");
    const [saved] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.transactionId, transactionId));
    expect(saved?.recovery).toBe(token);
    expect(saved?.stage).toBe(stage);
    if (this.offline) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    if (this.onAdvance) return this.onAdvance(token, transactionId);
    if (stage === "proposal")
      return {
        state: "prepared",
        transactionId,
        recovery: Buffer.from(`transaction:${transactionId}`).toString("base64"),
      };
    if (this.outcome === "pending") return { state: "pending", transactionId, recovery: token };
    if (this.outcome === "invalid")
      return { state: "invalid", transactionId, validationCode: 11, blockNumber: "7" };
    return { state: "committed", transactionId, blockNumber: "8" };
  }
}
async function fixture(
  mode: FederationMode = "bilateral_attested",
  grant = true,
  execution = false,
) {
  const [a, b] = await Promise.all([testKeys(), testKeys()]);
  const actor = { orgId: randomUUID(), userId: randomUUID() };
  await db.insert(orgs).values({ id: actor.orgId, name: "Commercial test scope" });
  await db.insert(users).values({
    id: actor.userId,
    orgId: actor.orgId,
    email: `${actor.userId}@test.invalid`,
    role: "platform_admin",
  });
  await db.insert(userOrgMemberships).values({ ...actor, role: "owner" });
  if (grant)
    await new FederationPermissionService(db).set(
      { ...actor, capability: "agreement.approve", enabled: true },
      actor.userId,
    );
  const trust = new FederationTrustRegistry(db);
  for (const key of [a, b]) {
    await trust.addSite(
      { id: key.signing.siteId, name: "Commercial institution", endpoint: "https://test.invalid" },
      actor.userId,
    );
    await trust.addKey(
      key.signing.siteId,
      {
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: execution
          ? [
              "commercial-agreement",
              "commercial-usage",
              "commercial-reservation",
              "commercial-release",
              "commercial-terminal",
              "result-receipt",
              "status-query",
              "status-report",
              "result-report",
              "cancellation-receipt",
              "agreement",
              "acceptance",
              "delegation",
              "cancellation",
            ]
          : ["commercial-agreement", "commercial-usage"],
        validFrom: "2020-01-01T00:00:00Z",
        validUntil: "2099-01-01T00:00:00Z",
      },
      actor.userId,
    );
  }
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    agreement: {
      ...testAgreement(a.signing.siteId, b.signing.siteId, mode),
      validFrom: "2020-01-01T00:00:00Z",
      validUntil: "2099-01-01T00:00:00Z",
    },
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        perQuantity: "3600",
        amount: "9007199254740993123",
      },
    ],
    termsText: "Private commercial test terms",
  });
  const adapter = new Adapter();
  const approvals = new FederationCommercialAgreementService(db, a.signing);
  const service = new FederationCommercialSubmissionService(db, a.signing.siteId, adapter);
  const value = {
    a,
    b,
    actor,
    terms,
    adapter,
    approvals,
    service,
    trust,
    revisionId: terms.agreement.agreementRevisionId,
  };
  fixtures.push(value);
  return value;
}
async function approveBoth(f: Awaited<ReturnType<typeof fixture>>) {
  const own = await f.approvals.approve(f.actor, f.terms);
  const other = await signFederationMessage(CommercialAgreementSchema, f.terms, f.b.signing);
  await f.approvals.attachCounterparty(f.actor, f.revisionId, other);
  return { own, other };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) {
  const [row] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.localSiteId, f.a.signing.siteId));
  if (!row) throw new Error("Missing test submission");
  return row;
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const row = await pending(f);
  await db
    .update(submissions)
    .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(submissions.id, row.id));
}
afterAll(async () => {
  const allSites = fixtures.flatMap((f) => [f.a.signing.siteId, f.b.signing.siteId]);
  await db
    .delete(federationCommercialAdjustments)
    .where(inArray(federationCommercialAdjustments.localSiteId, allSites));
  await db
    .delete(federationCommercialSettlements)
    .where(inArray(federationCommercialSettlements.localSiteId, allSites));
  await db.delete(federationArbitrationResolutions).where(
    inArray(
      federationArbitrationResolutions.localSiteId,
      fixtures.flatMap((f) => [f.a.signing.siteId, f.b.signing.siteId]),
    ),
  );
  if (arbitrationSites.length) {
    const queue = await db
      .select({ id: federationCaseSubmissions.id })
      .from(federationCaseSubmissions)
      .where(inArray(federationCaseSubmissions.localSiteId, arbitrationSites));
    if (queue.length)
      await db.delete(federationCaseAttempts).where(
        inArray(
          federationCaseAttempts.submissionId,
          queue.map((q) => q.id),
        ),
      );
    await db
      .delete(federationCaseSubmissions)
      .where(inArray(federationCaseSubmissions.localSiteId, arbitrationSites));
    await db
      .delete(federationCaseArbitrationDecisions)
      .where(inArray(federationCaseArbitrationDecisions.localSiteId, arbitrationSites));
    await db.delete(auditLog).where(
      inArray(
        auditLog.actor,
        arbitrationSites.map((id) => `case-ledger:${id}`),
      ),
    );
  }

  if (arbitrationSites.length)
    await db
      .delete(federationArbitrationDecisionDeliveries)
      .where(inArray(federationArbitrationDecisionDeliveries.localSiteId, arbitrationSites));
  if (arbitrationSites.length)
    await db
      .delete(federationArbitrationDecisions)
      .where(inArray(federationArbitrationDecisions.localSiteId, arbitrationSites));
  if (arbitrationSites.length)
    await db
      .delete(federationReceivedDisclosures)
      .where(inArray(federationReceivedDisclosures.localSiteId, arbitrationSites));

  if (arbitrationSites.length) {
    await db
      .delete(federationEvidenceCases)
      .where(inArray(federationEvidenceCases.localSiteId, arbitrationSites));
    await db
      .delete(federationArbitrationRevocationNotices)
      .where(inArray(federationArbitrationRevocationNotices.localSiteId, arbitrationSites));
    await db
      .delete(federationArbitrationRevocationDeliveries)
      .where(inArray(federationArbitrationRevocationDeliveries.localSiteId, arbitrationSites));
    await db.delete(auditLog).where(
      inArray(
        auditLog.actor,
        arbitrationSites.map((site) => `arbitration-revocation:${site}`),
      ),
    );
    await db
      .delete(federationCertificates)
      .where(inArray(federationCertificates.siteId, arbitrationSites));
    await db
      .delete(federationSigningKeys)
      .where(inArray(federationSigningKeys.siteId, arbitrationSites));
  }
  for (const f of fixtures) {
    const siteIds = [f.a.signing.siteId, f.b.signing.siteId];
    await db
      .delete(federationReceivedArbitrationDecisions)
      .where(inArray(federationReceivedArbitrationDecisions.localSiteId, siteIds));
    await db
      .delete(federationDisclosureDownloads)
      .where(inArray(federationDisclosureDownloads.localSiteId, siteIds));
    await db
      .delete(federationDisclosureReadAuthorizations)
      .where(inArray(federationDisclosureReadAuthorizations.localSiteId, siteIds));
    await db
      .delete(federationDisclosures)
      .where(inArray(federationDisclosures.localSiteId, siteIds));
    await db
      .delete(federationDisclosurePolicies)
      .where(inArray(federationDisclosurePolicies.localSiteId, siteIds));
    await db
      .delete(federationDisputeFreezes)
      .where(inArray(federationDisputeFreezes.localSiteId, siteIds));
    await db
      .delete(federationDisputeDeliveries)
      .where(inArray(federationDisputeDeliveries.localSiteId, siteIds));
    await db
      .delete(federationArbitrationPolicies)
      .where(inArray(federationArbitrationPolicies.localSiteId, siteIds));
    await db.delete(federationDisputes).where(inArray(federationDisputes.localSiteId, siteIds));
    await db
      .delete(workflowExecutionDelegations)
      .where(inArray(workflowExecutionDelegations.localSiteId, siteIds));
    await db.delete(workflowRuns).where(eq(workflowRuns.submittedBy, f.actor.userId));
    await db
      .delete(federationMarketRequests)
      .where(inArray(federationMarketRequests.localSiteId, siteIds));
    await db
      .delete(federationReservationProposals)
      .where(inArray(federationReservationProposals.localSiteId, siteIds));
    await db
      .delete(federationCommercialApprovalSyncs)
      .where(inArray(federationCommercialApprovalSyncs.localSiteId, siteIds));
    await db
      .delete(federationTerminalChunks)
      .where(inArray(federationTerminalChunks.localSiteId, siteIds));
    await db
      .delete(federationTerminalSyncs)
      .where(inArray(federationTerminalSyncs.localSiteId, siteIds));
    await db
      .delete(federationCommercialBills)
      .where(inArray(federationCommercialBills.localSiteId, siteIds));
    await db.delete(federationCertificates).where(inArray(federationCertificates.siteId, siteIds));
    await db
      .delete(federationCancellations)
      .where(inArray(federationCancellations.localSiteId, siteIds));
    const rows = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(inArray(submissions.localSiteId, siteIds));
    if (rows.length)
      await db.delete(attempts).where(
        inArray(
          attempts.submissionId,
          rows.map((row) => row.id),
        ),
      );
    await db.delete(submissions).where(inArray(submissions.localSiteId, siteIds));
    const marketRows = await db
      .select({ id: marketSubmissions.id })
      .from(marketSubmissions)
      .where(inArray(marketSubmissions.localSiteId, siteIds));
    if (marketRows.length)
      await db.delete(marketAttempts).where(
        inArray(
          marketAttempts.submissionId,
          marketRows.map((row) => row.id),
        ),
      );
    await db
      .delete(federationUnreservedClosures)
      .where(inArray(federationUnreservedClosures.localSiteId, siteIds));
    await db.delete(marketSubmissions).where(inArray(marketSubmissions.localSiteId, siteIds));
    await db
      .delete(federationExecutionTerminals)
      .where(inArray(federationExecutionTerminals.localSiteId, siteIds));
    await db
      .delete(federationResultReceipts)
      .where(inArray(federationResultReceipts.localSiteId, siteIds));
    const jobIds = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.orgId, f.actor.orgId));
    await db.delete(softwareOperations).where(inArray(softwareOperations.federationJobId, jobIds));
    await db
      .delete(federationTerminalEvidence)
      .where(inArray(federationTerminalEvidence.jobId, jobIds));
    await db.delete(workflowExecutionJobs).where(inArray(workflowExecutionJobs.jobId, jobIds));
    await db.delete(jobs).where(eq(jobs.orgId, f.actor.orgId));
    await db
      .delete(federationTerminalPolicies)
      .where(inArray(federationTerminalPolicies.localSiteId, siteIds));
    await db.delete(executionApprovals).where(inArray(executionApprovals.localSiteId, siteIds));
    await db
      .delete(federationReservationPolicies)
      .where(inArray(federationReservationPolicies.localSiteId, siteIds));
    const reservations = db
      .select({ id: federationReservations.id })
      .from(federationReservations)
      .where(inArray(federationReservations.senderSiteId, siteIds));
    const runs = await db
      .select({ id: federationWorkflowBindings.workflowRunId })
      .from(federationWorkflowBindings)
      .where(inArray(federationWorkflowBindings.reservationId, reservations));
    await db
      .delete(federationWorkflowBindings)
      .where(inArray(federationWorkflowBindings.reservationId, reservations));
    if (runs.length)
      await db.delete(workflowRuns).where(
        inArray(
          workflowRuns.id,
          runs.map((run) => run.id),
        ),
      );
    await db
      .delete(federationAttestationOutbox)
      .where(
        inArray(
          federationAttestationOutbox.evidenceId,
          db
            .select({ id: federationEvidence.id })
            .from(federationEvidence)
            .where(inArray(federationEvidence.reservationId, reservations)),
        ),
      );
    await db
      .delete(federationEvidence)
      .where(inArray(federationEvidence.reservationId, reservations));
    await db
      .delete(federationReservations)
      .where(inArray(federationReservations.senderSiteId, siteIds));
    await db
      .delete(federationResultImports)
      .where(inArray(federationResultImports.localSiteId, siteIds));
    await db.delete(federationOutbound).where(inArray(federationOutbound.localSiteId, siteIds));
    await db
      .delete(federationAssetMappings)
      .where(eq(federationAssetMappings.localOrgId, f.actor.orgId));
    await db.delete(federationMaterials).where(eq(federationMaterials.localOrgId, f.actor.orgId));
    await db.delete(softwareAssets).where(eq(softwareAssets.ownerUserId, f.actor.userId));
    await db
      .delete(federationAgreements)
      .where(inArray(federationAgreements.targetSiteId, siteIds));
    await db
      .delete(federationAgreementApprovals)
      .where(inArray(federationAgreementApprovals.localSiteId, siteIds));
    await db
      .delete(federationCommercialRefunds)
      .where(inArray(federationCommercialRefunds.localSiteId, siteIds));
    await db
      .delete(federationClosingTasks)
      .where(inArray(federationClosingTasks.localSiteId, siteIds));
    await db
      .delete(federationClosingPolicies)
      .where(inArray(federationClosingPolicies.localSiteId, siteIds));
    await db.delete(contracts).where(inArray(contracts.localSiteId, siteIds));
    await db.delete(auditLog).where(eq(auditLog.orgId, f.actor.orgId));
    await db
      .delete(federationCapabilities)
      .where(eq(federationCapabilities.userId, f.actor.userId));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, f.actor.orgId));
    await db.delete(users).where(eq(users.orgId, f.actor.orgId));
    await db.delete(orgs).where(eq(orgs.id, f.actor.orgId));
    for (const key of [f.a, f.b]) {
      await db
        .delete(federationSigningKeys)
        .where(eq(federationSigningKeys.siteId, key.signing.siteId));
      await db.delete(federationSites).where(eq(federationSites.id, key.signing.siteId));
    }
  }
  if (terminalAgentIds.length)
    await db.delete(agents).where(inArray(agents.agentId, terminalAgentIds));
  if (arbitrationSites.length)
    await db.delete(federationSites).where(inArray(federationSites.id, arbitrationSites));
  await db.$client.end({ timeout: 5 });
});

test("platform role cannot sign; current organization grant and explicit commercial key purpose are required", async () => {
  const f = await fixture("bilateral_attested", false);
  await expect(f.approvals.approve(f.actor, f.terms)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: true },
    f.actor.userId,
  );
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["agreement"] })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await expect(f.approvals.approve(f.actor, f.terms)).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  expect(
    await db.select().from(contracts).where(eq(contracts.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test("commercial approval is immutable, exact and private to the local organization", async () => {
  const f = await fixture(),
    otherScope = await fixture();
  const record = await f.approvals.approve(f.actor, f.terms);
  expect(record.terms.prices[0]?.amount).toBe("9007199254740993123");
  const summary = CommercialAgreementSummarySchema.parse(
    JSON.parse(JSON.stringify((await f.approvals.list(f.actor, 50, 0))[0])),
  );
  expect(summary.sourceName).toBe("Commercial institution");
  expect(summary.targetSiteId).toBe(f.b.signing.siteId);
  expect(summary.consideration).toBe("paid");
  expect(JSON.stringify(summary)).not.toContain(f.terms.termsText);
  expect((await f.approvals.approve(f.actor, f.terms)).approvalJws).toBe(record.approvalJws);
  await expect(
    f.approvals.approve(f.actor, { ...f.terms, termsText: "Replacement" }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await expect(f.approvals.get(otherScope.actor, f.revisionId)).rejects.toMatchObject({
    code: "AGREEMENT_UNAVAILABLE",
  });
  expect(await f.approvals.list(otherScope.actor, 50, 0)).toHaveLength(0);
  const wrong = await signFederationMessage(
    CommercialAgreementSchema,
    { ...f.terms, termsText: "Different signed terms" },
    f.b.signing,
  );
  await expect(f.approvals.attachCounterparty(f.actor, f.revisionId, wrong)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  await expect(
    f.approvals.attachCounterparty(f.actor, f.revisionId, record.approvalJws),
  ).rejects.toThrow();
  expect(
    await db.select().from(submissions).where(eq(submissions.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test.each([
  "bilateral_direct",
  "bilateral_attested",
  "ledger_coordinated",
] as const)("%s approvals preserve mode semantics and never activate execution or budgets", async (mode) => {
  const f = await fixture(mode);
  const { other } = await approveBoth(f);
  await Promise.all([
    f.approvals.attachCounterparty(f.actor, f.revisionId, other),
    f.approvals.attachCounterparty(f.actor, f.revisionId, other),
  ]);
  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.localSiteId, f.a.signing.siteId));
  expect(rows).toHaveLength(mode === "bilateral_direct" ? 0 : 1);
  expect(
    await db
      .select()
      .from(federationAgreements)
      .where(eq(federationAgreements.revisionId, f.revisionId)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
  if (mode === "bilateral_direct") expect(await f.service.advanceNext()).toBe(false);
  else {
    f.adapter.offline = true;
    expect(await f.service.advanceNext()).toBe(true);
    expect((await pending(f)).state).toBe("pending");
    expect((await pending(f)).lastError).toBe("LEDGER_UNAVAILABLE");
  }
});

test("each checkpoint is persisted before external effects; concurrent workers and restarts retain original transaction", async () => {
  const f = await fixture();
  await approveBoth(f);
  await Promise.all([f.service.advanceNext(), f.service.advanceNext()]);
  expect(f.adapter.prepares).toHaveLength(1);
  await f.service.advanceNext();
  const row = await pending(f);
  const [prepared] = await db.select().from(attempts).where(eq(attempts.submissionId, row.id));
  expect(prepared?.stage).toBe("transaction");
  f.adapter.outcome = "pending";
  const restarted = new FederationCommercialSubmissionService(db, f.a.signing.siteId, f.adapter);
  await restarted.advanceNext();
  expect((await pending(f)).lastError).toBe("LEDGER_PENDING");
  const status = await restarted.status(f.actor, f.revisionId, 50, 0);
  expect(JSON.stringify(status)).not.toContain("recovery");
  expect(JSON.stringify(status)).not.toContain(f.terms.termsText);
  await ready(f);
  f.adapter.outcome = "committed";
  await restarted.advanceNext();
  expect((await pending(f)).state).toBe("committed");
  expect(
    (await restarted.status(f.actor, f.revisionId, 50, 0)).submissions[0]?.transaction
      ?.transactionId,
  ).toBe(prepared?.transactionId);
  expect(f.adapter.prepares).toHaveLength(1);
  expect(await restarted.advanceNext()).toBe(false);
});

test("revoked trust stops new disclosure, while confirmed INVALID attempts require explicit review and remain in history", async () => {
  const f = await fixture();
  await approveBoth(f);
  await f.service.advanceNext();
  await f.trust.revoke(f.b.signing.siteId, { keyId: f.b.signing.keyId }, f.actor.userId);
  await f.service.advanceNext();
  expect(f.adapter.advances).toHaveLength(0);
  expect((await pending(f)).state).toBe("needs_review");
  const valid = await fixture();
  await approveBoth(valid);
  await valid.service.advanceNext();
  await valid.service.advanceNext();
  valid.adapter.outcome = "invalid";
  await valid.service.advanceNext();
  expect((await pending(valid)).state).toBe("needs_review");
  const row = await pending(valid);
  await valid.service.retry(valid.actor, valid.revisionId, row.id);
  valid.adapter.outcome = "committed";
  for (let i = 0; i < 3; i++) await valid.service.advanceNext();
  expect((await pending(valid)).state).toBe("committed");
  const history = await db.select().from(attempts).where(eq(attempts.submissionId, row.id));
  expect(history.map((item) => item.stage).sort()).toEqual(["committed", "invalid"]);
});

test("uncertain submitted outcome cannot be abandoned by retry and stale lease cannot write a terminal result", async () => {
  const f = await fixture();
  await approveBoth(f);
  await f.service.advanceNext();
  await f.service.advanceNext();
  const row = await pending(f);
  f.adapter.onAdvance = async () => ({
    state: "committed",
    transactionId: "0".repeat(64),
    blockNumber: "9",
  });
  await f.service.advanceNext();
  expect((await pending(f)).state).toBe("needs_review");
  await db
    .update(submissions)
    .set({ leaseToken: randomUUID(), leaseUntil: sql`clock_timestamp() + interval '90 seconds'` })
    .where(eq(submissions.id, row.id));
  await expect(f.service.retry(f.actor, f.revisionId, row.id)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  await db
    .update(submissions)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(submissions.id, row.id));
  await f.service.retry(f.actor, f.revisionId, row.id);
  f.adapter.onAdvance = async (_token, transactionId) => {
    await db
      .update(submissions)
      .set({ leaseToken: randomUUID(), leaseUntil: sql`clock_timestamp() + interval '90 seconds'` })
      .where(eq(submissions.id, row.id));
    return { state: "committed", transactionId, blockNumber: "9" };
  };
  await f.service.advanceNext();
  expect((await pending(f)).state).toBe("pending");
  expect(await f.service.advanceNext()).toBe(false);
  await db
    .update(submissions)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(submissions.id, row.id));
  f.adapter.onAdvance = undefined;
  await f.service.advanceNext();
  expect((await pending(f)).state).toBe("committed");
  expect(f.adapter.prepares).toHaveLength(1);
});

test("HTTP requires human scope, rejects unknown fields, hides private data from status and audit", async () => {
  const f = await fixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let human = true;
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    if (!human) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(f.approvals, f.service));
  human = false;
  expect((await app.request("/federation/commercial-agreements")).status).toBe(403);
  human = true;
  const response = await app.request("/federation/commercial-agreements/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terms: f.terms, channel: "arbitrary" }),
  });
  expect(response.status).toBe(400);
  await approveBoth(f);
  const status = await app.request(`/federation/commercial-agreements/${f.revisionId}/submissions`);
  expect(status.status).toBe(200);
  expect(status.headers.get("cache-control")).toBe("no-store");
  expect(await status.text()).not.toContain("approvalJws");
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actor, f.actor.userId),
        sql`${auditLog.action} LIKE 'federation.commercial.%'`,
      ),
    );
  expect(audits).toHaveLength(2);
  expect(JSON.stringify(audits)).not.toContain(f.terms.termsText);
  expect(JSON.stringify(audits)).not.toContain(f.terms.prices[0]?.amount ?? "missing");
  const worker = new FederationCommercialWorker(
    new FederationCommercialSubmissionService(db, f.a.signing.siteId),
  );
  await worker.tick();
  await worker.stop();
  expect(f.adapter.prepares).toHaveLength(0);
});

async function executionFixture(
  explicitPurpose = true,
  withMaterials = false,
  withResults = false,
  amounts?: { budgetLimit: string; maxTaskAmount: string },
  mode: FederationMode = "ledger_coordinated",
) {
  const f = await fixture(mode, true, explicitPurpose);
  if (amounts) Object.assign(f.terms.agreement, amounts);
  const availability = new SoftwareAvailabilityService(db);
  const assets = new FederationAssetService(db, {
    authorizeSoftware: (id, principal, capability) =>
      availability.assertAssetCapability(id, principal, capability),
  });
  let inputManifestDigest = `sha256:${"c".repeat(64)}`;
  let environmentLockDigest = `sha256:${"d".repeat(64)}`;
  if (withMaterials) {
    for (const capability of ["asset.map", "delegation.submit"] as const)
      await new FederationPermissionService(db).set(
        { ...f.actor, capability, enabled: true },
        f.actor.userId,
      );
    const content = "printf 'confirmed\\n'";
    const payload = {
      kind: "sandbox-script",
      language: "bash",
      content,
      entrypoint: "main.sh",
      sha256: createHash("sha256").update(content).digest("hex"),
      runtimeContractRef: { name: "bash", version: "1" },
      inputs: {},
      outputs: {},
    };
    const assetId = randomUUID(),
      revisionId = randomUUID();
    await db.insert(softwareAssets).values({
      id: assetId,
      kind: "sandbox-script",
      name: "Confirmed test script",
      version: "1",
      source: "sp-published",
      lifecycle: "published",
      visibility: "platform-public",
      ownerUserId: f.actor.userId,
      payload,
    });
    await db
      .insert(softwareAssetRevisions)
      .values({ id: revisionId, assetId, revision: 1, payload });
    const reference = {
      originSiteId: f.a.signing.siteId,
      kind: "script" as const,
      id: assetId,
      revision: "1",
      digest: federationMaterialDigest(payload),
    };
    f.terms.agreement.templates = [reference];
    await assets.register(f.actor, { reference, localRevisionId: revisionId });
    inputManifestDigest = (
      await assets.putMaterial(f.actor, f.a.signing.siteId, {
        protocolVersion: 1,
        kind: "inputs",
        parameters: {},
        datasets: [],
        bindings: [],
      })
    ).digest;
    environmentLockDigest = (
      await assets.putMaterial(f.actor, f.a.signing.siteId, {
        protocolVersion: 1,
        kind: "environment-lock",
        target: { platform: "linux", architecture: "x86_64" },
        nativeLockDigest: `sha256:${"c".repeat(64)}`,
        software: [],
        sandboxRuntime: { kind: "OCI", digest: `sha256:${"d".repeat(64)}` },
      })
    ).digest;
  }
  if (withResults)
    f.terms.agreement.resultPolicy = {
      scope: "persistent-files",
      maxFiles: 10,
      maxBytes: 1024,
      availableUntil: "2099-01-01T00:00:00Z",
    };
  const { own } = await approveBoth(f);
  const reservation = CommercialReservationSchema.parse({
    protocolVersion: 1,
    kind: "commercial-reservation",
    domainId: f.terms.domainId,
    reservationId: randomUUID(),
    demandId: randomUUID(),
    claimVersion: 2,
    agreementDigest: own.digest,
    salt: randomBytes(32).toString("hex"),
    request: {
      protocolVersion: 1,
      kind: "delegation",
      operationId: randomUUID(),
      senderSiteId: f.a.signing.siteId,
      recipientSiteId: f.b.signing.siteId,
      agreementRevisionId: f.revisionId,
      mode,
      budgetDomainId: f.terms.agreement.budgetDomainId,
      epoch: f.terms.agreement.epoch,
      unit: f.terms.agreement.unit,
      taskId: randomUUID(),
      attempt: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      executionExpiresAt: new Date(Date.now() + 1200000).toISOString(),
      template: f.terms.agreement.templates[0],
      resources: f.terms.agreement.resourceLimit,
      maxAmount: "60",
      inputManifestDigest,
      environmentLockDigest,
    },
  });
  const state = MarketDemandStateSchema.parse({
    demand: {
      protocolVersion: 1,
      demandId: reservation.demandId,
      sourceSiteId: f.a.signing.siteId,
      title: "Approved public task",
      description: "",
      platform: "linux",
      architecture: "x86_64",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      resources: reservation.request.resources,
    },
    digest: `sha256:${"e".repeat(64)}`,
    version: 2,
    status: "CLAIMED",
    claim: {
      demandId: reservation.demandId,
      claimId: reservation.reservationId,
      providerSiteId: f.b.signing.siteId,
      commercialDomainId: f.terms.domainId,
      expectedVersion: 1,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    },
    cancellation: null,
  });
  const publication = { operation: "publish-demand" as const, demand: state.demand };
  await db.insert(marketSubmissions).values({
    id: reservation.demandId,
    demandId: reservation.demandId,
    localSiteId: f.a.signing.siteId,
    localOrgId: f.actor.orgId,
    requestedBy: f.actor.userId,
    input: publication,
    digest: federationMaterialDigest(publication),
    state: "committed",
  });
  let queries = 0;
  let onQuery: (() => Promise<void>) | undefined;
  const service = new FederationCommercialExecutionService(db, f.a.signing, {
    query: async () => {
      queries++;
      await onQuery?.();
      return { operation: "get-demand", demand: state };
    },
  });
  return {
    ...f,
    reservation,
    assets,
    state,
    execution: service,
    queries: () => queries,
    onQuery: (callback: () => Promise<void>) => {
      onQuery = callback;
    },
  };
}
async function arbitrationForExecution(
  f: Awaited<ReturnType<typeof executionFixture>>,
  fields: ("dueAmount" | "grossAmount")[] = ["dueAmount"],
) {
  const arbitratorSiteId = randomUUID();
  arbitrationSites.push(arbitratorSiteId);
  await f.trust.addSite(
    { id: arbitratorSiteId, name: "Arbitrator", endpoint: "https://arbitrator.test.invalid" },
    f.actor.userId,
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "arbitration.approve", enabled: true },
    f.actor.userId,
  );
  for (const key of [f.a, f.b]) {
    const [row] = await db
      .select()
      .from(federationSigningKeys)
      .where(eq(federationSigningKeys.siteId, key.signing.siteId));
    if (!row) throw new Error("Missing fixture key");
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: [...row.allowedKinds, "commercial-arbitration-policy"] })
      .where(
        and(
          eq(federationSigningKeys.siteId, row.siteId),
          eq(federationSigningKeys.keyId, row.keyId),
        ),
      );
  }
  const counterpart = new FederationCommercialAgreementService(db, f.b.signing);
  await counterpart.approve(f.actor, f.terms);
  await counterpart.attachCounterparty(
    f.actor,
    f.revisionId,
    (await f.approvals.get(f.actor, f.revisionId)).approvalJws,
  );
  const source = new FederationArbitrationPolicyService(db, f.a.signing);
  const target = new FederationArbitrationPolicyService(db, f.b.signing);
  const policy = await source.draft(f.actor, f.revisionId, {
    policyId: randomUUID(),
    arbitratorSiteId,
    subjectTypes: ["bill"],
    disclosures: [{ recordType: "bill", fields }],
    requiredEvidence: [{ recordType: "bill", fields }],
    decisionRule: "designated-arbitrator",
    actions: ["settle", "adjust", "resolve-without-financial-change"],
    maxChargedAmount: "60",
    validUntil: "2098-01-01T00:00:00Z",
  });
  const a = await source.approve(f.actor, f.revisionId, policy);
  const b = await target.approve(f.actor, f.revisionId, policy);
  const binding = {
    policyId: policy.policyId,
    policyDigest: a.digest,
    sourceJws: a.approvalJws,
    targetJws: b.approvalJws,
  };
  const confirm = async () => {
    await source.attachCounterparty(f.actor, f.revisionId, policy.policyId, b.approvalJws);
    await target.attachCounterparty(f.actor, f.revisionId, policy.policyId, a.approvalJws);
  };
  return { source, target, policy, binding, confirm };
}

async function arbitrationAdmission(
  mode: FederationMode,
  fields?: ("dueAmount" | "grossAmount")[],
) {
  if (mode === "ledger_coordinated") {
    const f = await terminalSourceFixture("completed", false, true, fields);
    if (!f.arbitration) throw new Error("Missing original coordinated consent");
    await f.approveTerminal();
    const source = await f.sourceTerminal.countersign(
      f.actor,
      f.revisionId,
      f.reservation.reservationId,
      await f.proposal(),
    );
    await db
      .update(federationExecutionTerminals)
      .set({ counterpartyJws: source.approvalJws })
      .where(
        and(
          eq(federationExecutionTerminals.localSiteId, f.b.signing.siteId),
          eq(federationExecutionTerminals.reservationId, f.reservation.reservationId),
        ),
      );
    const admission = new FederationAdmission(
      db,
      f.b.signing,
      f.b.verification,
      undefined,
      f.confirmation,
    );
    const receive = async (request: typeof f.reservation.request) =>
      admission.receive({
        requestJws: await signFederationMessage(FederationDelegationSchema, request, f.a.signing),
        authenticatedPeerSiteId: f.a.signing.siteId,
        senderKey: f.a.verification,
      });
    return { ...f, arbitration: f.arbitration, receive };
  }
  const f = await executionFixture(true, true, false, undefined, mode);
  const arbitration = await arbitrationForExecution(f, fields);
  const source = new FederationAgreementService(db, f.a.signing);
  const target = new FederationAgreementService(db, f.b.signing);
  const executionUserId = randomUUID();
  await db.insert(users).values({
    id: executionUserId,
    orgId: f.actor.orgId,
    email: `${executionUserId}@test.invalid`,
    role: "user",
    serviceAccount: true,
  });
  await db
    .insert(userOrgMemberships)
    .values({ userId: executionUserId, orgId: f.actor.orgId, role: "member" });
  const a = await source.approve(f.actor, { terms: f.terms.agreement });
  const b = await target.approve(f.actor, { terms: f.terms.agreement, executionUserId });
  await source.attachCounterparty(f.actor, f.revisionId, b.approvalJws);
  await target.attachCounterparty(f.actor, f.revisionId, a.approvalJws);
  const admission = new FederationAdmission(db, f.b.signing, f.b.verification);
  const outbound = new FederationOutboundService(
    db,
    f.a.signing,
    async (_endpoint, requestJws) =>
      (
        await admission.receive({
          requestJws,
          authenticatedPeerSiteId: f.a.signing.siteId,
          senderKey: f.a.verification,
        })
      ).receiptJws,
    f.assets,
  );
  const receive = async (request: typeof f.reservation.request) =>
    admission.receive({
      requestJws: await signFederationMessage(FederationDelegationSchema, request, f.a.signing),
      authenticatedPeerSiteId: f.a.signing.siteId,
      senderKey: f.a.verification,
    });
  return { ...f, arbitration, outbound, receive };
}

test("arbitration original admission rejects missing or changed consent without budget effects and replays after revocation", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await arbitrationAdmission(mode);
    const request = { ...f.reservation.request, arbitration: f.arbitration.binding };
    const budget = () =>
      db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, request.budgetDomainId));
    const before = await budget();
    for (const service of [() => f.outbound.enqueue(f.actor, request), () => f.receive(request)])
      await expect(service()).rejects.toThrow("POLICY_DENIED");
    await f.arbitration.confirm();
    for (const patch of [
      { policyId: randomUUID() },
      { policyDigest: `sha256:${"0".repeat(64)}` },
      { sourceJws: f.arbitration.binding.targetJws },
      { targetJws: `${f.arbitration.binding.targetJws}x` },
    ]) {
      const invalid = { ...request, arbitration: { ...request.arbitration, ...patch } };
      await expect(f.outbound.enqueue(f.actor, invalid)).rejects.toBeInstanceOf(FederationError);
      await expect(f.receive(invalid)).rejects.toBeInstanceOf(FederationError);
    }
    expect(await budget()).toEqual(before);
    expect(
      await db
        .select()
        .from(federationOutbound)
        .where(eq(federationOutbound.operationId, request.operationId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.operationId, request.operationId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(federationCompletionClaims)
        .where(
          inArray(federationCompletionClaims.localSiteId, [f.a.signing.siteId, f.b.signing.siteId]),
        ),
    ).toHaveLength(0);
    await f.outbound.enqueue(f.actor, request);
    const received = await f.receive(request);
    const after = await budget();
    await f.arbitration.source.revoke(f.actor, f.revisionId, request.arbitration.policyId);
    await f.arbitration.target.revoke(f.actor, f.revisionId, request.arbitration.policyId);
    expect((await f.outbound.enqueue(f.actor, request)).operationId).toBe(request.operationId);
    expect(await f.receive(request)).toEqual(received);
    for (const changed of [
      f.reservation.request,
      { ...request, arbitration: { ...request.arbitration, policyId: randomUUID() } },
    ]) {
      await expect(f.outbound.enqueue(f.actor, changed)).rejects.toThrow("OPERATION_CONFLICT");
      await expect(f.receive(changed)).rejects.toThrow("OPERATION_CONFLICT");
    }
    const next = { ...request, operationId: randomUUID(), taskId: randomUUID(), maxAmount: "1" };
    await expect(f.outbound.enqueue(f.actor, next)).rejects.toThrow("AUTHORIZATION_EXPIRED");
    await expect(f.receive(next)).rejects.toThrow("AUTHORIZATION_EXPIRED");
    expect(await budget()).toEqual(after);
    const [saved] = await db
      .select()
      .from(federationOutbound)
      .where(eq(federationOutbound.operationId, request.operationId));
    expect(saved?.request).toEqual(request);
  }
});

test("arbitration cannot be attached retroactively to a legacy delegation", async () => {
  const f = await arbitrationAdmission("bilateral_direct");
  await f.arbitration.confirm();
  const request = f.reservation.request;
  const accepted = await f.outbound.enqueue(f.actor, request);
  const receipt = await f.receive(request);
  const changed = { ...request, arbitration: f.arbitration.binding };
  await expect(f.outbound.enqueue(f.actor, changed)).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.receive(changed)).rejects.toThrow("OPERATION_CONFLICT");
  expect(await f.outbound.enqueue(f.actor, request)).toEqual(accepted);
  expect(await f.receive(request)).toEqual(receipt);
  const [saved] = await db
    .select()
    .from(federationOutbound)
    .where(eq(federationOutbound.operationId, request.operationId));
  expect(saved?.request).not.toHaveProperty("arbitration");
});

test("arbitration workflow reference resolves once into the original durable signed intent", async () => {
  const f = await arbitrationAdmission("bilateral_direct");
  await f.arbitration.confirm();
  const runId = randomUUID();
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Arbitration workflow",
    status: "running",
    submittedBy: f.actor.userId,
    startedAt: new Date(),
    input: { executionModel: "durable-v2", orgId: f.actor.orgId, role: "user", yaml: "" },
  });
  const journal = new WorkflowExecutionJournalStore(db);
  const lease = await journal.acquire(runId);
  if (!lease) throw new Error("Missing workflow lease");
  const {
    operationId: _op,
    taskId: _task,
    attempt: _attempt,
    issuedAt: _issued,
    expiresAt: _expires,
    ...base
  } = f.reservation.request;
  const plan: WorkflowDelegationPlan = {
    ...base,
    arbitration: {
      policyId: f.arbitration.binding.policyId,
      policyDigest: f.arbitration.binding.policyDigest,
    },
  };
  const invocation = { path: JSON.stringify(["node", "remote"]) };
  try {
    await expect(
      bindWorkflowDelegation(lease, f.actor, "remote", invocation, plan, 600, () => new Date()),
    ).rejects.toThrow("POLICY_DENIED");
    expect(
      await db
        .select()
        .from(workflowExecutionDelegations)
        .where(eq(workflowExecutionDelegations.runId, runId)),
    ).toHaveLength(0);
    const sent = await f.outbound.enqueueForWorkflow(
      f.actor,
      lease,
      "remote",
      invocation,
      plan,
      600,
    );
    const [saved] = await db
      .select()
      .from(workflowExecutionDelegations)
      .where(eq(workflowExecutionDelegations.runId, runId));
    expect(saved?.request.arbitration).toEqual(f.arbitration.binding);
    await f.arbitration.source.revoke(
      f.actor,
      f.revisionId,
      plan.arbitration?.policyId ?? "missing",
    );
    expect(
      await f.outbound.enqueueForWorkflow(f.actor, lease, "remote", invocation, plan, 600),
    ).toEqual(sent);
    await expect(
      f.outbound.enqueueForWorkflow(f.actor, lease, "remote", invocation, base, 600),
    ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
    expect(
      (
        await db
          .select()
          .from(workflowExecutionDelegations)
          .where(eq(workflowExecutionDelegations.runId, runId))
      )[0]?.request,
    ).toEqual(saved?.request);
  } finally {
    await lease.release();
  }
});

test("arbitration lock waits cannot extend original source, receiver or coordinated admission windows", async () => {
  for (const boundary of ["source", "receiver", "coordinated"] as const) {
    const f = await arbitrationAdmission("bilateral_direct");
    const coordinated = boundary === "coordinated" ? await executionFixture() : undefined;
    const active = coordinated ?? f;
    const a = coordinated ? await arbitrationForExecution(coordinated) : f.arbitration;
    await a.confirm();
    const request = { ...active.reservation.request, arbitration: a.binding };
    const siteId = boundary === "receiver" ? f.b.signing.siteId : active.a.signing.siteId;
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const blocker = db.transaction(async (tx) => {
      await tx
        .select()
        .from(federationArbitrationPolicies)
        .where(
          and(
            eq(federationArbitrationPolicies.localSiteId, siteId),
            eq(federationArbitrationPolicies.policyId, a.policy.policyId),
          ),
        )
        .for("update");
      const rows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      if (!rows[0]) throw new Error("Missing lock holder");
      locked.resolve(rows[0].pid);
      await release.promise;
    });
    const pid = await locked.promise;
    const operation = (
      coordinated
        ? coordinated.execution.approve(active.actor, active.revisionId, {
            ...active.reservation,
            request,
          })
        : boundary === "source"
          ? f.outbound.enqueue(f.actor, request)
          : f.receive(request)
    ).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const blocked = await db.execute(
          sql`select pid from pg_stat_activity where ${pid} = ANY(pg_blocking_pids(pid))`,
        );
        if (blocked.length) {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      // Real PostgreSQL lock wait; only elapsed wall time is injected to avoid a ten-minute test.
      setSystemTime(new Date(Date.parse(request.expiresAt) + 1));
      release.resolve();
      await blocker;
      expect(await operation).toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    } finally {
      release.resolve();
      await blocker;
      await operation;
      setSystemTime();
    }
    expect(
      await db
        .select()
        .from(federationOutbound)
        .where(eq(federationOutbound.operationId, request.operationId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.operationId, request.operationId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(executionApprovals)
        .where(eq(executionApprovals.localSiteId, active.a.signing.siteId)),
    ).toHaveLength(0);
  }
});

test("arbitration coordinated approval checks original consent and preserves already signed reservations", async () => {
  const f = await executionFixture();
  const a = await arbitrationForExecution(f);
  f.reservation.request.arbitration = a.binding;
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toThrow(
    "POLICY_DENIED",
  );
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
  await a.confirm();
  const approved = await approveReservation(f);
  await a.source.revoke(f.actor, f.revisionId, a.policy.policyId);
  expect((await f.execution.approve(f.actor, f.revisionId, f.reservation)).approvalJws).toBe(
    approved.own.approvalJws,
  );
  await expect(
    f.execution.approve(f.actor, f.revisionId, {
      ...f.reservation,
      request: { ...f.reservation.request, arbitration: undefined },
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

async function approveReservation(f: Awaited<ReturnType<typeof executionFixture>>) {
  const own = await f.execution.approve(f.actor, f.revisionId, f.reservation);
  const other = await signFederationMessage(
    CommercialExecutionApprovalSchema,
    f.reservation,
    f.b.signing,
  );
  await f.execution.attachCounterparty(f.actor, f.revisionId, f.reservation.reservationId, other);
  return { own, other };
}
async function releasePayload(f: Awaited<ReturnType<typeof executionFixture>>) {
  const original = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
  return CommercialReleaseSchema.parse({
    protocolVersion: 1,
    kind: "commercial-release",
    releaseId: randomUUID(),
    domainId: f.terms.domainId,
    reservationId: f.reservation.reservationId,
    reservationDigest: original.digest,
    sourceSiteId: f.a.signing.siteId,
    targetSiteId: f.b.signing.siteId,
    expectedGateVersion: 1,
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
    reason: "Withdraw before activation",
  });
}

test("execution approval requires explicit signing purpose and current scope across market I/O", async () => {
  const legacy = await executionFixture(false);
  await expect(
    legacy.execution.approve(legacy.actor, legacy.revisionId, legacy.reservation),
  ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
  const f = await executionFixture();
  await expect(
    f.execution.approve({ ...f.actor, orgId: randomUUID() }, f.revisionId, f.reservation),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(f.queries()).toBe(0);
  f.onQuery(async () => {
    await new FederationPermissionService(db).set(
      { ...f.actor, capability: "agreement.approve", enabled: false },
      f.actor.userId,
    );
  });
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test("execution approvals bind contract, claim, resources and immutable content; lost replies stay idempotent", async () => {
  const f = await executionFixture();
  await expect(
    f.execution.approve(f.actor, f.revisionId, {
      ...f.reservation,
      agreementDigest: `sha256:${"0".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await expect(
    f.execution.approve(f.actor, f.revisionId, {
      ...f.reservation,
      request: {
        ...f.reservation.request,
        resources: { ...f.reservation.request.resources, cpus: 2 },
      },
    }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  f.state.version = 3;
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  f.state.version = 2;
  const [one, two] = await Promise.all([
    f.execution.approve(f.actor, f.revisionId, f.reservation),
    f.execution.approve(f.actor, f.revisionId, f.reservation),
  ]);
  expect(one.approvalJws).toBe(two.approvalJws);
  f.state.status = "ACTIVE";
  const queries = f.queries();
  expect((await f.execution.approve(f.actor, f.revisionId, f.reservation)).digest).toBe(one.digest);
  expect(f.queries()).toBe(queries);
  await expect(
    f.execution.approve(f.actor, f.revisionId, { ...f.reservation, salt: "a".repeat(64) }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
});

test("execution counterparty attachment is atomic, rejects crossed signatures and queues only once", async () => {
  const f = await executionFixture();
  const own = await f.execution.approve(f.actor, f.revisionId, f.reservation);
  await expect(
    f.execution.attachCounterparty(f.actor, f.revisionId, own.recordId, own.approvalJws),
  ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
  const changed = await signFederationMessage(
    CommercialExecutionApprovalSchema,
    { ...f.reservation, salt: "b".repeat(64) },
    f.b.signing,
  );
  await expect(
    f.execution.attachCounterparty(f.actor, f.revisionId, own.recordId, changed),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  const other = await signFederationMessage(
    CommercialExecutionApprovalSchema,
    f.reservation,
    f.b.signing,
  );
  const input = {
    operation: "reserve-execution" as const,
    domainId: f.terms.domainId,
    recordId: own.recordId,
    digest: own.digest,
    envelope: {
      sourceSiteId: f.a.signing.siteId,
      targetSiteId: f.b.signing.siteId,
      sourceJws: own.approvalJws,
      targetJws: other,
    },
  };
  const injected = randomUUID();
  await db.insert(submissions).values({
    id: injected,
    localSiteId: f.a.signing.siteId,
    agreementRevisionId: f.revisionId,
    input,
  });
  await expect(
    f.execution.attachCounterparty(f.actor, f.revisionId, own.recordId, other),
  ).rejects.toThrow();
  expect((await f.execution.get(f.actor, f.revisionId, own.recordId)).counterpartyJws).toBeNull();
  await db.delete(submissions).where(eq(submissions.id, injected));
  await Promise.all([
    f.execution.attachCounterparty(f.actor, f.revisionId, own.recordId, other),
    f.execution.attachCounterparty(f.actor, f.revisionId, own.recordId, other),
  ]);
  const stored = await f.execution.get(f.actor, f.revisionId, own.recordId);
  expect(stored.counterpartyJws).toBe(other);
  expect(stored.submission?.state).toBe("pending");
  const audit = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actor, f.actor.userId),
        eq(auditLog.action, "federation.commercial.execution.counterparty"),
      ),
    );
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain(other);
});

test("execution submission ordering waits for contract then reserve; recovery never creates a second intent", async () => {
  const f = await executionFixture();
  await approveReservation(f);
  const release = await releasePayload(f);
  await f.execution.approve(f.actor, f.revisionId, release);
  await f.execution.attachCounterparty(
    f.actor,
    f.revisionId,
    release.releaseId,
    await signFederationMessage(CommercialExecutionApprovalSchema, release, f.b.signing),
  );
  for (let step = 0; step < 3; step++) expect(await f.service.advanceNext()).toBe(true);
  expect(f.adapter.prepares.map((input) => input.operation)).toEqual(["register-agreement"]);
  expect(await f.service.advanceNext()).toBe(true);
  expect(await f.service.advanceNext()).toBe(true);
  f.adapter.outcome = "pending";
  expect(await f.service.advanceNext()).toBe(true);
  const original = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
  expect(original.submission?.transaction?.stage).toBe("transaction");
  expect(await f.service.advanceNext()).toBe(false);
  f.adapter.outcome = "committed";
  await db
    .update(submissions)
    .set({ nextAttemptAt: sql`clock_timestamp()` })
    .where(eq(submissions.id, original.submission?.id ?? randomUUID()));
  const restarted = new FederationCommercialSubmissionService(db, f.a.signing.siteId, f.adapter);
  for (let step = 0; step < 4; step++) expect(await restarted.advanceNext()).toBe(true);
  const complete = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
  expect(complete.submission?.transaction?.transactionId).toBe(
    original.submission?.transaction?.transactionId,
  );
  expect((await f.execution.get(f.actor, f.revisionId, release.releaseId)).submission?.state).toBe(
    "committed",
  );
  expect(f.adapter.prepares.map((input) => input.operation)).toEqual([
    "register-agreement",
    "reserve-execution",
    "release-execution",
  ]);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
});

test("execution release binds original double approval and HTTP excludes automation, foreign scope and checkpoints", async () => {
  const f = await executionFixture();
  await approveReservation(f);
  const release = await releasePayload(f);
  await expect(
    f.execution.approve(f.actor, f.revisionId, {
      ...release,
      reservationDigest: `sha256:${"0".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  f.state.status = "ACTIVE";
  await expect(f.execution.approve(f.actor, f.revisionId, release)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let human = true;
  let orgId = f.actor.orgId;
  app.use("*", async (c, next) => {
    c.set("principal" as never, { ...f.actor, orgId } as never);
    if (!human) c.set("automation" as never, true as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(f.approvals, f.service, undefined, undefined, f.execution),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/execution-approvals`;
  human = false;
  expect((await app.request(path)).status).toBe(403);
  human = true;
  orgId = randomUUID();
  expect((await app.request(path)).status).toBe(403);
  orgId = f.actor.orgId;
  const response = await app.request(`${path}/${f.reservation.reservationId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).not.toContain("recovery");
  expect(body).not.toContain("leaseToken");
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...f.reservation, chaincode: "arbitrary" }),
      })
    ).status,
  ).toBe(400);
});

test("execution preflight preserves infrastructure errors, claim expiry and revoked signing trust before disclosure", async () => {
  const f = await executionFixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(f.approvals, f.service, undefined, undefined, f.execution),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/execution-approvals`;
  for (const [code, needsReview, status] of [
    ["LEDGER_UNAVAILABLE", false, 503],
    ["INVALID_ADAPTER_RESPONSE", true, 502],
  ] as const) {
    f.onQuery(async () => {
      throw new FabricClientFailure(code, needsReview);
    });
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f.reservation),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
  }
  f.onQuery(async () => {});
  if (!f.state.claim) throw new Error("Missing fixture claim");
  const expiry = f.state.claim.expiresAt;
  f.state.claim.expiresAt = new Date().toISOString();
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "AUTHORIZATION_EXPIRED",
  });
  f.state.claim.expiresAt = expiry;
  await approveReservation(f);
  for (let step = 0; step < 3; step++) await f.service.advanceNext();
  await f.trust.revoke(f.b.signing.siteId, { keyId: f.b.signing.keyId }, f.actor.userId);
  await f.service.advanceNext();
  const value = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
  expect(value.submission?.lastError).toBe("UNTRUSTED_IDENTITY");
  expect(value.submission?.state).toBe("needs_review");
  expect(f.adapter.prepares.map((input) => input.operation)).toEqual(["register-agreement"]);
});

test("execution approval cannot fund another organization's public intent or an uncommitted publication", async () => {
  const f = await executionFixture();
  const other = await fixture();
  await db
    .update(marketSubmissions)
    .set({ localOrgId: other.actor.orgId })
    .where(eq(marketSubmissions.id, f.reservation.demandId));
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  await db
    .update(marketSubmissions)
    .set({ localOrgId: f.actor.orgId, state: "pending" })
    .where(eq(marketSubmissions.id, f.reservation.demandId));
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  expect(f.queries()).toBe(0);
  await db
    .update(marketSubmissions)
    .set({ state: "committed" })
    .where(eq(marketSubmissions.id, f.reservation.demandId));
  expect((await f.execution.approve(f.actor, f.revisionId, f.reservation)).recordId).toBe(
    f.reservation.reservationId,
  );
  const targetContract = new FederationCommercialAgreementService(db, f.b.signing);
  await targetContract.approve(f.actor, f.terms);
  await targetContract.attachCounterparty(
    f.actor,
    f.revisionId,
    (await f.approvals.get(f.actor, f.revisionId)).approvalJws,
  );
  const target = new FederationCommercialExecutionService(db, f.b.signing, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  await expect(target.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  if (!f.state.claim) throw new Error("Missing fixture claim");
  const claim = { operation: "claim-demand" as const, claim: f.state.claim };
  await db.insert(marketSubmissions).values({
    id: f.reservation.reservationId,
    demandId: f.reservation.demandId,
    localSiteId: f.b.signing.siteId,
    localOrgId: other.actor.orgId,
    requestedBy: other.actor.userId,
    input: claim,
    digest: federationMaterialDigest(claim),
    state: "committed",
  });
  await expect(target.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  await db
    .update(marketSubmissions)
    .set({ localOrgId: f.actor.orgId })
    .where(eq(marketSubmissions.id, f.reservation.reservationId));
  expect((await target.approve(f.actor, f.revisionId, f.reservation)).recordId).toBe(
    f.reservation.reservationId,
  );
});

class ActivationAdapter implements MarketClient {
  inputs: MarketAdapterProposalInput[] = [];
  outcome: "pending" | "committed" | "invalid" = "committed";
  async query() {
    return { operation: "get-demand" as const, demand: null };
  }
  async prepare(input: MarketAdapterProposalInput) {
    this.inputs.push(input);
    const transactionId = randomBytes(32).toString("hex");
    return { transactionId, recovery: Buffer.from(`proposal:${transactionId}`).toString("base64") };
  }
  async advance(recovery: string): Promise<MarketAdvanceResult> {
    const [stage, transactionId] = Buffer.from(recovery, "base64").toString().split(":");
    if (!transactionId) throw new Error("Missing activation fixture transaction");
    const [stored] = await db
      .select()
      .from(marketAttempts)
      .where(eq(marketAttempts.transactionId, transactionId));
    expect(stored?.recovery).toBe(recovery);
    if (stage === "proposal")
      return {
        state: "prepared",
        transactionId,
        recovery: Buffer.from(`transaction:${transactionId}`).toString("base64"),
      };
    if (this.outcome === "pending") return { state: "pending", transactionId, recovery };
    if (this.outcome === "invalid")
      return { state: "invalid", transactionId, validationCode: 11, blockNumber: "9" };
    return { state: "committed", transactionId, blockNumber: "10" };
  }
}
async function activationFixture(
  withMaterials = false,
  withResults = false,
  withArbitration = false,
  fields?: ("dueAmount" | "grossAmount")[],
) {
  const f = await executionFixture(true, withMaterials, withResults);
  const arbitration = withArbitration ? await arbitrationForExecution(f, fields) : null;
  if (arbitration) {
    await arbitration.confirm();
    f.reservation.request.arbitration = arbitration.binding;
  }
  await approveReservation(f);
  for (let step = 0; step < 6; step++) expect(await f.service.advanceNext()).toBe(true);
  await new FederationPermissionService(db).set(
    {
      ...f.actor,
      capability: "market.publish",
      enabled: true,
    },
    f.actor.userId,
  );
  const marketAdapter = new ActivationAdapter();
  const market = new FederationMarketService(db, f.a.signing.siteId, marketAdapter);
  return { ...f, arbitration, market, marketAdapter, activationId: randomUUID() };
}

async function confirmationFixture(
  provider = false,
  withMaterials = false,
  withResults = false,
  withArbitration = false,
  fields?: ("dueAmount" | "grossAmount")[],
) {
  const f = await activationFixture(withMaterials, withResults, withArbitration, fields);
  const ordinary = new FederationAgreementService(db, f.a.signing);
  const own = await ordinary.approve(f.actor, { terms: f.terms.agreement });
  let executionUserId: string | undefined;
  let otherJws = await signFederationMessage(
    FederationAgreementSchema,
    f.terms.agreement,
    f.b.signing,
  );
  if (provider) {
    const commercial = new FederationCommercialAgreementService(db, f.b.signing);
    await commercial.approve(f.actor, f.terms);
    await commercial.attachCounterparty(
      f.actor,
      f.revisionId,
      (await f.approvals.get(f.actor, f.revisionId)).approvalJws,
    );
    if (!f.state.claim) throw new Error("Missing fixture claim");
    const input = { operation: "claim-demand" as const, claim: f.state.claim };
    await db.insert(marketSubmissions).values({
      id: f.reservation.reservationId,
      localSiteId: f.b.signing.siteId,
      localOrgId: f.actor.orgId,
      requestedBy: f.actor.userId,
      demandId: f.reservation.demandId,
      input,
      digest: federationMaterialDigest(input),
      state: "committed",
    });
    const execution = new FederationCommercialExecutionService(db, f.b.signing, {
      query: async () => ({ operation: "get-demand", demand: f.state }),
    });
    await execution.approve(f.actor, f.revisionId, f.reservation);
    await execution.attachCounterparty(
      f.actor,
      f.revisionId,
      f.reservation.reservationId,
      (await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).approvalJws,
    );
    const worker = new FederationCommercialSubmissionService(db, f.b.signing.siteId, f.adapter);
    for (let i = 0; i < 6; i++) expect(await worker.advanceNext()).toBe(true);
    executionUserId = randomUUID();
    await db.insert(users).values({
      id: executionUserId,
      orgId: f.actor.orgId,
      email: `${executionUserId}@test.invalid`,
      role: "user",
      serviceAccount: true,
    });
    await db
      .insert(userOrgMemberships)
      .values({ userId: executionUserId, orgId: f.actor.orgId, role: "member" });
    const receiver = new FederationAgreementService(db, f.b.signing);
    otherJws = (await receiver.approve(f.actor, { terms: f.terms.agreement, executionUserId }))
      .approvalJws;
    await receiver.attachCounterparty(f.actor, f.revisionId, own.approvalJws);
  }
  await ordinary.attachCounterparty(f.actor, f.revisionId, otherJws);
  await f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, f.activationId);
  for (let i = 0; i < 3; i++) expect(await f.market.advanceNext()).toBe(true);
  const activation = f.marketAdapter.inputs.find((input) => input.operation === "activate-demand");
  if (activation?.operation !== "activate-demand") throw new Error("Missing fixture activation");
  f.state.status = "ACTIVE";
  f.state.version = 3;
  f.state.activation = activation.activation;
  let clock = new Date();
  let onQuery: (() => Promise<void>) | undefined;
  let queries = 0;
  const siteId = provider ? f.b.signing.siteId : f.a.signing.siteId;
  const confirmation = new FederationExecutionConfirmationService(
    db,
    siteId,
    {
      query: async () => {
        queries++;
        await onQuery?.();
        return { operation: "get-demand", demand: f.state };
      },
    },
    () => clock,
  );
  return {
    ...f,
    ordinary,
    confirmation,
    executionUserId,
    siteId,
    market: new FederationMarketService(db, siteId, f.marketAdapter),
    queryCount: () => queries,
    beforeQuery: (callback: () => Promise<void>) => {
      onQuery = callback;
    },
    setClock: (date: Date) => {
      clock = date;
    },
    requestConfirmation: () =>
      confirmation.request(f.actor, f.revisionId, f.reservation.reservationId),
    authorizeConfirmation: () =>
      db.transaction((tx) => confirmation.authorize(tx, f.actor.orgId, f.reservation.request)),
  };
}

test("arbitration validation cannot extend a coordinated source or receiver execution proof", async () => {
  for (const provider of [false, true]) {
    const f = await confirmationFixture(provider, true, false, true);
    const proof = await f.requestConfirmation();
    for (let i = 0; i < 3; i++) expect(await f.market.advanceNext()).toBe(true);
    const original = FederationArbitrationPolicyService.prototype.authorizeRequest;
    const check = spyOn(
      FederationArbitrationPolicyService.prototype,
      "authorizeRequest",
    ).mockImplementation(async function (
      this: FederationArbitrationPolicyService,
      ...args: Parameters<typeof original>
    ) {
      await original.apply(this, args);
      f.setClock(new Date(proof.expiresAt));
    });
    try {
      if (provider) {
        const admission = new FederationAdmission(
          db,
          f.b.signing,
          f.b.verification,
          undefined,
          f.confirmation,
        );
        await expect(
          admission.receive({
            requestJws: await signFederationMessage(
              FederationDelegationSchema,
              f.reservation.request,
              f.a.signing,
            ),
            authenticatedPeerSiteId: f.a.signing.siteId,
            senderKey: f.a.verification,
          }),
        ).rejects.toMatchObject({ code: "LEDGER_PENDING" });
      } else {
        const outbound = new FederationOutboundService(
          db,
          f.a.signing,
          async () => {
            throw new Error("No delivery expected");
          },
          f.assets,
          undefined,
          f.confirmation,
        );
        await expect(outbound.enqueue(f.actor, f.reservation.request)).rejects.toMatchObject({
          code: "LEDGER_PENDING",
        });
      }
      expect(check).toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
    expect(
      await db
        .select()
        .from(federationOutbound)
        .where(eq(federationOutbound.operationId, f.reservation.request.operationId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.operationId, f.reservation.request.operationId)),
    ).toHaveLength(0);
  }
});

test("coordinated admission waits for VALID, preserves one chain reservation and creates no local budget", async () => {
  const f = await confirmationFixture(true);
  const input = {
    requestJws: await signFederationMessage(
      FederationDelegationSchema,
      f.reservation.request,
      f.a.signing,
    ),
    authenticatedPeerSiteId: f.a.signing.siteId,
    senderKey: f.a.verification,
  };
  const admission = new FederationAdmission(
    db,
    f.b.signing,
    f.b.verification,
    undefined,
    f.confirmation,
  );
  await expect(
    admission.receive({ ...input, authenticatedPeerSiteId: randomUUID() }),
  ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
  expect(f.queryCount()).toBe(0);
  await expect(
    new FederationAdmission(db, f.b.signing, f.b.verification).receive(input),
  ).rejects.toMatchObject({ code: "LEDGER_REQUIRED" });
  await expect(admission.receive(input)).rejects.toMatchObject({ code: "LEDGER_PENDING" });
  expect(
    await db
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.senderSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  const received = await Promise.all(Array.from({ length: 4 }, () => admission.receive(input)));
  expect(new Set(received.map((row) => row.reservationId))).toEqual(
    new Set([f.reservation.reservationId]),
  );
  expect(new Set(received.map((row) => row.receiptJws)).size).toBe(1);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
  await expect(
    admission.receive({
      ...input,
      requestJws: await signFederationMessage(
        FederationDelegationSchema,
        {
          ...f.reservation.request,
          maxAmount: "59",
        },
        f.a.signing,
      ),
    }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  const count = f.queryCount();
  f.beforeQuery(async () => {
    throw new FabricClientFailure("LEDGER_UNAVAILABLE");
  });
  const first = received[0];
  if (!first) throw new Error("Missing acceptance");
  expect(await admission.receive(input)).toEqual(first);
  expect(f.queryCount()).toBe(count);
});

test("coordinated source delivery and provider preparation share exact reservations and bounded dispatch authority under storage pressure", async () => {
  const f = await confirmationFixture(true, true);
  const guard = {
    async assertAdmission() {
      throw new FederationError("STORAGE_PRESSURE");
    },
  };
  const source = new FederationExecutionConfirmationService(db, f.a.signing.siteId, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  const sourceWorker = new FederationMarketService(db, f.a.signing.siteId, f.marketAdapter);
  const admission = new FederationAdmission(
    db,
    f.b.signing,
    f.b.verification,
    undefined,
    f.confirmation,
    guard,
  );
  let deliveries = 0;
  const outbound = new FederationOutboundService(
    db,
    f.a.signing,
    async (_endpoint, requestJws) => {
      deliveries++;
      return (
        await admission.receive({
          requestJws,
          authenticatedPeerSiteId: f.a.signing.siteId,
          senderKey: f.a.verification,
        })
      ).receiptJws;
    },
    f.assets,
    undefined,
    source,
    undefined,
    guard,
  );
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    await next();
  });
  app.route("/", createFederationOutboundRoutes(outbound));
  const pending = await app.request("/federation/outbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(f.reservation.request),
  });
  expect(pending.status).toBe(503);
  expect(pending.headers.get("cache-control")).toBe("no-store");
  expect(await pending.json()).toEqual({ error: { code: "LEDGER_PENDING" } });
  expect(deliveries).toBe(0);
  for (let i = 0; i < 3; i++) await sourceWorker.advanceNext();
  const queued = await Promise.all(
    Array.from({ length: 3 }, () => outbound.enqueue(f.actor, f.reservation.request)),
  );
  expect(new Set(queued.map((row) => row.operationId))).toEqual(
    new Set([f.reservation.request.operationId]),
  );
  await f.requestConfirmation();
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  expect(await outbound.deliverNext()).toBe(true);
  expect(deliveries).toBe(1);
  const [saved] = await db
    .select()
    .from(federationOutbound)
    .where(eq(federationOutbound.localSiteId, f.a.signing.siteId));
  expect(saved?.state).toBe("accepted");
  expect(saved?.receipt?.reservationId).toBe(f.reservation.reservationId);
  if (!saved?.receipt || !saved.receiptJws) throw new Error("Missing accepted delivery");
  const preparation = new FederationPreparationService(
    db,
    f.b.signing.siteId,
    f.assets,
    undefined,
    f.confirmation,
  );
  const binding = await new FederationExecutionBindingService(db, preparation).stage(
    f.reservation.reservationId,
  );
  const dispatch = new FederationDispatchAuthorization(db, preparation);
  const final = await dispatch.prepare(binding.workflowRunId);
  const deadline = await db.transaction(final);
  expect(deadline).toBe((await f.authorizeConfirmation()).expiresAtUnixMs);
  expect(deadline).toBeLessThanOrEqual(Date.now() + 300000);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
  f.setClock(new Date(deadline + 1));
  await expect(db.transaction(final)).rejects.toMatchObject({ code: "LEDGER_PENDING" });
  // Receipt recovery is observation only; it cannot renew material or dispatch authority.
  expect(await admission.completeReceipt(f.reservation.reservationId)).toEqual({
    reservationId: saved.receipt.reservationId,
    receiptJws: saved.receiptJws,
  });
});

test("coordinated admission rechecks local identity after chain confirmation and before creating a receipt", async () => {
  const f = await confirmationFixture(true);
  await f.requestConfirmation();
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  if (!f.executionUserId) throw new Error("Missing execution identity");
  await db.update(users).set({ suspended: true }).where(eq(users.id, f.executionUserId));
  const admission = new FederationAdmission(
    db,
    f.b.signing,
    f.b.verification,
    undefined,
    f.confirmation,
  );
  await expect(
    admission.receive({
      requestJws: await signFederationMessage(
        FederationDelegationSchema,
        f.reservation.request,
        f.a.signing,
      ),
      authenticatedPeerSiteId: f.a.signing.siteId,
      senderKey: f.a.verification,
    }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(
    await db
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.senderSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test("confirmation persists one public intent across concurrent refreshes and requires VALID before consumption", async () => {
  const f = await confirmationFixture();
  const rows = await Promise.all(Array.from({ length: 4 }, () => f.requestConfirmation()));
  expect(new Set(rows.map((row) => row.id)).size).toBe(1);
  const id = rows[0]?.id;
  if (!id) throw new Error("Missing confirmation");
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "LEDGER_PENDING" });
  await f.market.advanceNext();
  await f.market.advanceNext();
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "LEDGER_PENDING" });
  await f.market.advanceNext();
  const confirmed = await f.authorizeConfirmation();
  expect(confirmed.authorizationId).toBe(id);
  expect(confirmed.reservationId).toBe(f.reservation.reservationId);
  const count = f.queryCount();
  expect((await f.requestConfirmation()).id).toBe(id);
  expect(f.queryCount()).toBe(count);
  const [row] = await db.select().from(marketSubmissions).where(eq(marketSubmissions.id, id));
  expect(row?.input.operation).toBe("authorize-execution");
  for (const secret of [
    "maxAmount",
    "inputManifestDigest",
    "environmentLockDigest",
    "sourceJws",
    "termsText",
  ])
    expect(JSON.stringify(row?.input)).not.toContain(secret);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
});

test("confirmation renewal creates a new bounded intent while the old proof expires unchanged", async () => {
  const f = await confirmationFixture();
  const first = await f.requestConfirmation();
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  const [original] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, first.id));
  f.setClock(new Date(Date.parse(first.expiresAt) - 30000));
  f.beforeQuery(async () => {
    throw new FabricClientFailure("LEDGER_UNAVAILABLE");
  });
  await f.confirmation.refreshForExecution(f.actor.orgId, f.reservation.request);
  expect((await f.authorizeConfirmation()).authorizationId).toBe(first.id);
  f.beforeQuery(async () => {});
  const next = await f.requestConfirmation();
  expect(next.id).not.toBe(first.id);
  expect((await f.authorizeConfirmation()).authorizationId).toBe(first.id);
  f.setClock(new Date(Date.parse(first.expiresAt) + 1));
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "LEDGER_PENDING" });
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  expect((await f.authorizeConfirmation()).authorizationId).toBe(next.id);
  expect(
    (await db.select().from(marketSubmissions).where(eq(marketSubmissions.id, first.id)))[0],
  ).toEqual(original);
});

test("confirmation binds the exact delegation, organization and current consent across network I/O", async () => {
  const f = await confirmationFixture();
  await expect(
    f.confirmation.refresh(f.actor.orgId, {
      ...f.reservation.request,
      inputManifestDigest: `sha256:${"f".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await expect(f.confirmation.refresh(randomUUID(), f.reservation.request)).rejects.toMatchObject({
    code: "AGREEMENT_UNAVAILABLE",
  });
  f.beforeQuery(() => f.ordinary.setState(f.actor, f.revisionId, "suspended"));
  await expect(f.requestConfirmation()).rejects.toMatchObject({ code: "AGREEMENT_UNAVAILABLE" });
  expect(
    await db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, f.siteId),
          sql`${marketSubmissions.input}->>'operation' = 'authorize-execution'`,
        ),
      ),
  ).toHaveLength(0);
});

test("confirmation refuses revoked signing trust and receiver identities even with a committed proof", async () => {
  const f = await confirmationFixture(true);
  await f.requestConfirmation();
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  expect((await f.authorizeConfirmation()).reservationId).toBe(f.reservation.reservationId);
  if (!f.executionUserId) throw new Error("Missing receiver identity");
  await db.update(users).set({ suspended: true }).where(eq(users.id, f.executionUserId));
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await db.update(users).set({ suspended: false }).where(eq(users.id, f.executionUserId));
  await f.trust.revoke(f.b.signing.siteId, { keyId: f.b.signing.keyId }, f.actor.userId);
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
});

test("confirmation validates transaction evidence, payload digest and activation identity", async () => {
  const f = await confirmationFixture();
  const result = await f.requestConfirmation();
  await db
    .update(marketSubmissions)
    .set({ state: "committed" })
    .where(eq(marketSubmissions.id, result.id));
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({
    code: "INVALID_ADAPTER_RESPONSE",
  });
  await db
    .update(marketSubmissions)
    .set({ state: "pending" })
    .where(eq(marketSubmissions.id, result.id));
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  await db
    .update(marketSubmissions)
    .set({ digest: `sha256:${"0".repeat(64)}` })
    .where(eq(marketSubmissions.id, result.id));
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  const g = await confirmationFixture();
  if (!g.state.activation) throw new Error("Missing activation");
  g.state.activation = { ...g.state.activation, activationId: randomUUID() };
  await expect(g.requestConfirmation()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
});

test("confirmation audit failure rolls back the intent and revocation during query cannot sign new work", async () => {
  const f = await confirmationFixture();
  await db.execute(
    sql`CREATE FUNCTION confirmation_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.execution.confirm' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER confirmation_test_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION confirmation_test_audit_fail()`,
  );
  try {
    await expect(f.requestConfirmation()).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER confirmation_test_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION confirmation_test_audit_fail()`);
  }
  expect(
    await db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, f.siteId),
          sql`${marketSubmissions.input}->>'operation' = 'authorize-execution'`,
        ),
      ),
  ).toHaveLength(0);
  f.beforeQuery(() =>
    new FederationPermissionService(db).set(
      { ...f.actor, capability: "agreement.approve", enabled: false },
      f.actor.userId,
    ),
  );
  await expect(f.requestConfirmation()).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("confirmation HTTP accepts only an empty renewal intent and preserves human organization authorization", async () => {
  const f = await confirmationFixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, { ...f.actor, role: "platform_admin" });
    await next();
  });
  app.route(
    "/api",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.execution,
      f.confirmation,
    ),
  );
  const path = `/api/federation/commercial-agreements/${f.revisionId}/execution-approvals/${f.reservation.reservationId}/confirm`;
  const call = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await call({ gate: f.state.activation?.gate })).status).toBe(400);
  const response = await call({});
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain("recovery");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  expect((await call({})).status).toBe(403);
});

test.each([
  false,
  true,
])("execution stop is durable and fences VALID proofs without a ledger connection (provider=%s)", async (provider) => {
  const f = await confirmationFixture(provider);
  await f.requestConfirmation();
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  await f.authorizeConfirmation();
  const stops = new FederationExecutionStopService(db, f.siteId);
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      stops.request(f.actor, f.revisionId, f.reservation.reservationId),
    ),
  );
  expect(new Set(results.map((row) => row.id)).size).toBe(1);
  expect(await stops.advanceNext()).toBe(false);
  const queries = f.queryCount();
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
  await expect(f.requestConfirmation()).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
  await expect(
    f.confirmation.refreshForExecution(f.actor.orgId, f.reservation.request),
  ).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
  expect(f.queryCount()).toBe(queries);
  const restarted = new FederationExecutionStopService(db, f.siteId);
  const first = results[0];
  if (!first) throw new Error("Missing stop request");
  expect(await restarted.request(f.actor, f.revisionId, f.reservation.reservationId)).toEqual(
    first,
  );
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, f.reservation.reservationId),
          eq(auditLog.action, "federation.execution.stop"),
        ),
      ),
  ).toHaveLength(1);
  await f.trust.revoke(f.a.signing.siteId, { keyId: f.a.signing.keyId }, f.actor.userId);
  expect(await restarted.request(f.actor, f.revisionId, f.reservation.reservationId)).toEqual(
    first,
  );
});

test("execution stop wins a renewal network race before a new authorization can be persisted", async () => {
  const f = await confirmationFixture();
  const stops = new FederationExecutionStopService(db, f.siteId);
  f.beforeQuery(async () => {
    await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  });
  await expect(f.requestConfirmation()).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
  expect(
    await db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, f.siteId),
          sql`${marketSubmissions.input}->>'operation' = 'authorize-execution'`,
        ),
      ),
  ).toHaveLength(0);
});

test("execution stop enqueues once after outage and resumes an unknown ledger outcome with the same transaction", async () => {
  const f = await confirmationFixture();
  let offline = true;
  const stops = new FederationExecutionStopService(db, f.siteId, {
    query: async () => {
      if (offline) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
      return { operation: "get-demand", demand: f.state };
    },
  });
  const stop = await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  await expect(
    f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, f.activationId),
  ).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
  await stops.advanceNext();
  const pending = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
  expect(pending.stopLastError).toBe("LEDGER_UNAVAILABLE");
  expect(pending.stopSubmission).toBeNull();
  offline = false;
  await db
    .update(executionApprovals)
    .set({ stopNextAttemptAt: new Date(0) })
    .where(eq(executionApprovals.stopId, stop.id));
  await Promise.all([stops.advanceNext(), stops.advanceNext()]);
  const [saved] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, stop.id));
  expect(saved?.input).toEqual({
    operation: "request-execution-stop",
    stop: {
      demandId: f.reservation.demandId,
      stopId: stop.id,
      issuerSiteId: f.siteId,
      activationId: f.activationId,
      expectedVersion: 3,
    },
  });
  expect(await stops.advanceNext()).toBe(false);
  f.marketAdapter.outcome = "pending";
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  const [original] = await db
    .select()
    .from(marketAttempts)
    .where(eq(marketAttempts.submissionId, stop.id));
  expect(original?.stage).toBe("transaction");
  f.marketAdapter.outcome = "committed";
  await db
    .update(marketSubmissions)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(marketSubmissions.id, stop.id));
  await new FederationMarketService(db, f.siteId, f.marketAdapter).advanceNext();
  const recovered = await db
    .select()
    .from(marketAttempts)
    .where(eq(marketAttempts.submissionId, stop.id));
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.transactionId).toBe(original?.transactionId);
  expect(recovered[0]?.stage).toBe("committed");
  expect(
    (await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).stopSubmission
      ?.state,
  ).toBe("committed");
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
});

test("execution stop rejects unrelated activation and preserves its local fence while awaiting activation", async () => {
  const f = await confirmationFixture(true);
  const stops = new FederationExecutionStopService(db, f.siteId, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  const stop = await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  if (!f.state.activation) throw new Error("Missing activation");
  const gate = f.state.activation.gate;
  f.state.activation.gate = { ...gate, reservationDigest: `sha256:${"f".repeat(64)}` };
  await stops.advanceNext();
  const [bad] = await db
    .select()
    .from(executionApprovals)
    .where(eq(executionApprovals.stopId, stop.id));
  expect(bad?.stopLastError).toBe("OPERATION_CONFLICT");
  expect(
    await db.select().from(marketSubmissions).where(eq(marketSubmissions.id, stop.id)),
  ).toHaveLength(0);
  f.state.activation.gate = gate;
  f.state.status = "CLAIMED";
  await db
    .update(executionApprovals)
    .set({ stopNextAttemptAt: new Date(0) })
    .where(eq(executionApprovals.stopId, stop.id));
  await stops.advanceNext();
  const [waiting] = await db
    .select()
    .from(executionApprovals)
    .where(eq(executionApprovals.stopId, stop.id));
  expect(waiting?.stopLastError).toBe("ACTIVATION_PENDING");
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
});

test("execution stop audit is atomic and HTTP requires empty input and institutional authority", async () => {
  const f = await confirmationFixture();
  const stops = new FederationExecutionStopService(db, f.siteId);
  await db.execute(
    sql`CREATE FUNCTION stop_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.execution.stop' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER stop_test_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION stop_test_audit_fail()`,
  );
  try {
    await expect(
      stops.request(f.actor, f.revisionId, f.reservation.reservationId),
    ).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER stop_test_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION stop_test_audit_fail()`);
  }
  expect(
    (await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).stopId,
  ).toBeNull();
  const other = await fixture();
  await expect(
    stops.request(other.actor, f.revisionId, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "ASSET_UNAVAILABLE" });
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  let automation = false;
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.execution,
      f.confirmation,
      stops,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/execution-approvals/${f.reservation.reservationId}/stop`;
  const call = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await call({ activationId: f.activationId })).status).toBe(400);
  automation = true;
  expect((await call({})).status).toBe(403);
  automation = false;
  const response = await call({});
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).not.toContain("recovery");
  expect(body).not.toContain("committed");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  expect((await call({})).status).toBe(403);
});

test("execution stop is observed by the independent workflow monitor despite preparation outage", async () => {
  const f = await confirmationFixture(true, true);
  await f.requestConfirmation();
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  const admission = new FederationAdmission(
    db,
    f.b.signing,
    f.b.verification,
    undefined,
    f.confirmation,
  );
  await admission.receive({
    requestJws: await signFederationMessage(
      FederationDelegationSchema,
      f.reservation.request,
      f.a.signing,
    ),
    authenticatedPeerSiteId: f.a.signing.siteId,
    senderKey: f.a.verification,
  });
  const preparation = new FederationPreparationService(
    db,
    f.siteId,
    f.assets,
    undefined,
    f.confirmation,
  );
  const binding = await new FederationExecutionBindingService(db, preparation).stage(
    f.reservation.reservationId,
  );
  const dispatch = new FederationDispatchAuthorization(db, preparation);
  const final = await dispatch.prepare(binding.workflowRunId);
  await db.transaction(final);
  await new FederationExecutionStopService(db, f.siteId).request(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
  );
  await expect(db.transaction(final)).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
  const cancelled: string[] = [];
  const monitor = new FederationExecutionMonitor(
    db,
    {
      prepare: async () => {
        throw new FabricClientFailure("LEDGER_UNAVAILABLE");
      },
      checkActiveJobs: (runId) => dispatch.checkActiveJobs(runId),
    },
    {
      cancel: async (runId, reason) => {
        if (runId === binding.workflowRunId) {
          expect(reason?.code).toBe("FEDERATION_CANCELLATION_REQUESTED");
          cancelled.push(runId);
        }
        return "cancelling";
      },
    },
  );
  for (let i = 0; i < 4 && !cancelled.length; i++) await monitor.tick();
  expect(cancelled).toEqual([binding.workflowRunId]);
  // A requested cancellation is not a scheduler terminal receipt or budget release.
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
});

test("execution stop follows source cancellation without requiring a commercial approver grant", async () => {
  const f = await confirmationFixture(false, true);
  await f.requestConfirmation();
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  const outbound = new FederationOutboundService(
    db,
    f.a.signing,
    async () => {
      throw new Error("No transport expected");
    },
    f.assets,
    undefined,
    f.confirmation,
  );
  await outbound.enqueue(f.actor, f.reservation.request);
  const permissions = new FederationPermissionService(db);
  await permissions.set(
    { ...f.actor, capability: "delegation.cancel", enabled: true },
    f.actor.userId,
  );
  await permissions.set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  expect(
    (await outbound.cancellations.request(f.actor, f.reservation.request.operationId))?.state,
  ).toBe("queued");
  const [stopped] = await db
    .select()
    .from(executionApprovals)
    .where(
      and(
        eq(executionApprovals.localSiteId, f.siteId),
        eq(executionApprovals.recordId, f.reservation.reservationId),
      ),
    );
  expect(stopped?.stopId).toBeString();
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
});

test("stop retry requires business approval rather than publish authority", async () => {
  const f = await confirmationFixture();
  const stops = new FederationExecutionStopService(db, f.siteId, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  const stop = await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  await stops.advanceNext();
  f.marketAdapter.outcome = "invalid";
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  const permissions = new FederationPermissionService(db);
  await permissions.set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.market.retry(f.actor, stop.id)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await permissions.set(
    { ...f.actor, capability: "agreement.approve", enabled: true },
    f.actor.userId,
  );
  await permissions.set({ ...f.actor, capability: "market.read", enabled: true }, f.actor.userId);
  await permissions.set(
    { ...f.actor, capability: "market.publish", enabled: false },
    f.actor.userId,
  );
  await f.market.retry(f.actor, stop.id);
  await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
  const [saved] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, stop.id));
  expect(saved?.state).toBe("pending");
});

test("stop database constraints reject partial intents and duplicate activation submissions", async () => {
  const f = await confirmationFixture();
  const filter = and(
    eq(executionApprovals.localSiteId, f.siteId),
    eq(executionApprovals.recordId, f.reservation.reservationId),
  );
  await expect(
    db.update(executionApprovals).set({ stopId: randomUUID() }).where(filter).execute(),
  ).rejects.toThrow();
  const stops = new FederationExecutionStopService(db, f.siteId, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  const stop = await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  await stops.advanceNext();
  const [saved] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, stop.id));
  if (!saved || saved.input.operation !== "request-execution-stop") throw new Error("Missing stop");
  const id = randomUUID();
  const input = {
    operation: "request-execution-stop" as const,
    stop: { ...saved.input.stop, stopId: id },
  };
  await expect(
    db
      .insert(marketSubmissions)
      .values({ ...saved, id, input, digest: federationMaterialDigest(input) })
      .execute(),
  ).rejects.toThrow();
  await expect(
    db
      .update(marketSubmissions)
      .set({ input: { ...input, stop: { ...input.stop, issuerSiteId: randomUUID() } } })
      .where(eq(marketSubmissions.id, stop.id))
      .execute(),
  ).rejects.toThrow();
});

test("activation requires two capabilities and confirmed private reservation; public payload contains no private delegation", async () => {
  const f = await executionFixture();
  await approveReservation(f);
  const id = randomUUID();
  await expect(
    f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, id),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await new FederationPermissionService(db).set(
    {
      ...f.actor,
      capability: "market.publish",
      enabled: true,
    },
    f.actor.userId,
  );
  await expect(
    f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, id),
  ).rejects.toMatchObject({ code: "LEDGER_REQUIRED" });
  for (let step = 0; step < 6; step++) await f.service.advanceNext();
  const created = await f.execution.activate(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    id,
  );
  expect(created).toEqual({ id, demandId: f.reservation.demandId, state: "pending" });
  const [row] = await db.select().from(marketSubmissions).where(eq(marketSubmissions.id, id));
  expect(row?.input.operation).toBe("activate-demand");
  const encoded = JSON.stringify(row?.input);
  for (const secret of [
    "maxAmount",
    "inputManifestDigest",
    "environmentLockDigest",
    "sourceJws",
    "targetJws",
    "budgetDomainId",
    "termsText",
  ])
    expect(encoded).not.toContain(secret);
  expect(row?.digest).toBe(federationMaterialDigest(row?.input));
});

test("activation intent is unique and idempotent even after the gate deadline", async () => {
  const f = await activationFixture();
  const [one, two] = await Promise.all([
    f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, f.activationId),
    f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, f.activationId),
  ]);
  expect(one).toEqual(two);
  await expect(
    f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, randomUUID()),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  const later = new FederationCommercialExecutionService(
    db,
    f.a.signing,
    undefined,
    () => new Date(Date.parse(f.reservation.request.expiresAt) + 1000),
  );
  expect(
    await later.activate(f.actor, f.revisionId, f.reservation.reservationId, f.activationId),
  ).toEqual(one);
  const logs = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actor, f.actor.userId),
        eq(auditLog.action, "federation.commercial.execution.activate"),
      ),
    );
  expect(logs).toHaveLength(1);
});

test("activation refuses an already double-approved release and revoked business signing trust", async () => {
  const f = await activationFixture();
  const release = await releasePayload(f);
  await f.execution.approve(f.actor, f.revisionId, release);
  await f.execution.attachCounterparty(
    f.actor,
    f.revisionId,
    release.releaseId,
    await signFederationMessage(CommercialExecutionApprovalSchema, release, f.b.signing),
  );
  await expect(
    f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, f.activationId),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  const revoked = await activationFixture();
  await revoked.trust.revoke(
    revoked.b.signing.siteId,
    { keyId: revoked.b.signing.keyId },
    revoked.actor.userId,
  );
  await expect(
    revoked.execution.activate(
      revoked.actor,
      revoked.revisionId,
      revoked.reservation.reservationId,
      revoked.activationId,
    ),
  ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
});

test("activation checkpoints recover original transactions and retry requires commercial approval", async () => {
  const f = await activationFixture();
  await f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, f.activationId);
  expect(await f.market.advanceNext()).toBe(true);
  expect(await f.market.advanceNext()).toBe(true);
  f.marketAdapter.outcome = "pending";
  expect(await f.market.advanceNext()).toBe(true);
  const prior = await f.market.get(f.actor, f.activationId, 50, 0);
  const transactionId = prior.transactions[0]?.transactionId;
  expect(transactionId).toBeDefined();
  await db
    .update(marketSubmissions)
    .set({ state: "needs_review", lastError: "UNKNOWN" })
    .where(eq(marketSubmissions.id, f.activationId));
  await new FederationPermissionService(db).set(
    {
      ...f.actor,
      capability: "agreement.approve",
      enabled: false,
    },
    f.actor.userId,
  );
  await expect(f.market.retry(f.actor, f.activationId)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await new FederationPermissionService(db).set(
    {
      ...f.actor,
      capability: "agreement.approve",
      enabled: true,
    },
    f.actor.userId,
  );
  await f.market.retry(f.actor, f.activationId);
  f.marketAdapter.outcome = "invalid";
  const restarted = new FederationMarketService(db, f.a.signing.siteId, f.marketAdapter);
  expect(await restarted.advanceNext()).toBe(true);
  let status = await restarted.get(f.actor, f.activationId, 50, 0);
  expect(status.transactions[0]).toMatchObject({
    transactionId,
    stage: "invalid",
    validationCode: 11,
  });
  await restarted.retry(f.actor, f.activationId);
  f.marketAdapter.outcome = "committed";
  for (let step = 0; step < 3; step++) expect(await restarted.advanceNext()).toBe(true);
  status = await restarted.get(f.actor, f.activationId, 50, 0);
  expect(status.operation.state).toBe("committed");
  expect(status.transactions).toHaveLength(2);
  expect(status.transactions[1]?.transactionId).toBe(transactionId);
  expect(f.marketAdapter.inputs).toHaveLength(2);
  expect(f.marketAdapter.inputs[1]).toEqual(f.marketAdapter.inputs[0]);
});

test("activation HTTP accepts only an operation id and generic market publishing cannot bypass approval", async () => {
  const f = await activationFixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(f.approvals, f.service, undefined, undefined, f.execution),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/execution-approvals/${f.reservation.reservationId}/activate`;
  const request = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await request({ activationId: f.activationId, gate: { state: "READY" } })).status).toBe(
    400,
  );
  const response = await request({ activationId: f.activationId });
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const [row] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, f.activationId));
  if (!row || row.input.operation !== "activate-demand")
    throw new Error("Missing stored activation");
  // The HTTP validator and service both retain the narrow public input schema.
  expect(MarketProposalInputSchema.safeParse(row.input).success).toBe(false);
  await expect(
    f.market.enqueue(f.actor, row.input as unknown as MarketProposalInput),
  ).rejects.toThrow();
});

const terminalAgentIds: string[] = [];
async function terminalFixture(
  outcome: "completed" | "failed" | "cancelled" = "completed",
  withResults = false,
  withArbitration = false,
  fields?: ("dueAmount" | "grossAmount")[],
) {
  const f = await confirmationFixture(true, true, withResults, withArbitration, fields);
  await f.requestConfirmation();
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  const admission = new FederationAdmission(
    db,
    f.b.signing,
    f.b.verification,
    undefined,
    f.confirmation,
  );
  await admission.receive({
    requestJws: await signFederationMessage(
      FederationDelegationSchema,
      f.reservation.request,
      f.a.signing,
    ),
    authenticatedPeerSiteId: f.a.signing.siteId,
    senderKey: f.a.verification,
  });
  const preparation = new FederationPreparationService(
    db,
    f.siteId,
    f.assets,
    undefined,
    f.confirmation,
  );
  const binding = await new FederationExecutionBindingService(db, preparation).stage(
    f.reservation.reservationId,
  );
  await db.insert(workflowExecutionLeases).values({ runId: binding.workflowRunId });
  const agentId = `terminal-${randomUUID()}`,
    jobId = randomUUID();
  terminalAgentIds.push(agentId);
  await db.insert(agents).values({
    agentId,
    siteName: "Terminal fixture",
    schedulerType: "slurm",
    schedulerVersion: "fixture",
  });
  if (!f.executionUserId) throw new Error("Missing fixture user");
  await db.insert(jobs).values({
    id: jobId,
    name: "Terminal fixture",
    command: "private command probe",
    envVars: { SECRET: "private secret probe" },
    cpus: 1,
    memoryMb: 128,
    orgId: f.actor.orgId,
    submittedBy: f.executionUserId,
    status: "running",
    agentId,
    dispatchEpoch: 1,
    startedAt: new Date(),
    schedulerJobId: "terminal-42",
  });
  await db.insert(workflowExecutionJobs).values({
    runId: binding.workflowRunId,
    jobId,
    pathHash: "a".repeat(64),
    path: '["node","terminal"]',
    nodeId: "terminal",
    intent: {
      nodeId: "terminal",
      name: "Terminal fixture",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    },
  });
  const jobService = new JobService(db);
  await jobService.updateStatus(
    jobId,
    outcome,
    "terminal-42",
    agentId,
    undefined,
    outcome === "completed" ? 0 : 1,
    undefined,
    "terminal-event",
  );
  if (outcome === "cancelled")
    await new JobCancellationOutbox(db, { pushCancelJob: () => true }).acknowledge(
      agentId,
      jobId,
      2,
    );
  await db
    .update(workflowRuns)
    .set({ status: outcome, completedAt: new Date(), stepJobs: { terminal: jobId } })
    .where(eq(workflowRuns.id, binding.workflowRunId));
  let onQuery: (() => Promise<void>) | undefined;
  const terminal = new FederationExecutionTerminalService(db, f.b.signing, {
    query: async () => {
      await onQuery?.();
      return { operation: "get-demand", demand: f.state };
    },
  });
  return {
    ...f,
    binding,
    agentId,
    jobId,
    terminal,
    approveTerminal: () => terminal.approve(f.actor, f.revisionId, f.reservation.reservationId),
    beforeTerminalQuery: (fn: () => Promise<void>) => {
      onQuery = fn;
    },
  };
}

for (const outcome of ["completed", "failed", "cancelled"] as const)
  test(`execution terminal ${outcome} signs real bound evidence once and permanently fences confirmation`, async () => {
    const f = await terminalFixture(outcome);
    const records = await Promise.all(Array.from({ length: 4 }, () => f.approveTerminal()));
    const first = records[0];
    if (!first) throw new Error("Missing terminal");
    expect(
      records.every(
        (row) => row.terminalId === first.terminalId && row.approvalJws === first.approvalJws,
      ),
    ).toBe(true);
    expect(first.payload).toMatchObject({
      outcome,
      activationId: f.state.activation?.activationId,
      executionEvidenceDigest: federationMaterialDigest(first.evidence),
      resultManifestDigest: null,
    });
    const key = await f.trust.resolveKey(f.siteId, f.b.signing.keyId, new Date());
    expect(
      (await verifyFederationMessage(CommercialTerminalSchema, first.approvalJws, key, new Date()))
        .digest,
    ).toBe(first.digest);
    expect(first.evidence.jobs).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain("private command probe");
    expect(JSON.stringify(first)).not.toContain("private secret probe");
    await expect(f.authorizeConfirmation()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(f.requestConfirmation()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const dispatch = new FederationDispatchAuthorization(
      db,
      new FederationPreparationService(db, f.siteId, f.assets, undefined, f.confirmation),
    );
    await expect(dispatch.checkActiveJobs(f.binding.workflowRunId)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    const restarted = new FederationExecutionTerminalService(db, f.b.signing);
    expect(await restarted.approve(f.actor, f.revisionId, f.reservation.reservationId)).toEqual(
      first,
    );
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actor, f.actor.userId),
            eq(auditLog.action, "federation.execution.terminal"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
    ).toHaveLength(0);
    expect(
      (await db.select().from(submissions).where(eq(submissions.localSiteId, f.siteId))).some(
        (row) => row.input.operation === "record-execution-terminal",
      ),
    ).toBe(false);
  });

test("execution terminal refuses nonterminal jobs, missing observations and mismatched invocation evidence", async () => {
  const f = await terminalFixture();
  await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, f.jobId));
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "DATA_WAITING" });
  await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, f.jobId));
  const [saved] = await db
    .select()
    .from(federationTerminalEvidence)
    .where(eq(federationTerminalEvidence.jobId, f.jobId));
  if (!saved) throw new Error("Missing job evidence");
  await db.delete(federationTerminalEvidence).where(eq(federationTerminalEvidence.jobId, f.jobId));
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await db.insert(federationTerminalEvidence).values(saved);
  await db
    .update(workflowExecutionJobs)
    .set({ pathHash: "b".repeat(64) })
    .where(eq(workflowExecutionJobs.jobId, f.jobId));
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  expect(
    await db
      .select()
      .from(federationExecutionTerminals)
      .where(eq(federationExecutionTerminals.localSiteId, f.siteId)),
  ).toHaveLength(0);
});

test("execution terminal waits for cancellation epoch and installer-stop acknowledgements", async () => {
  const f = await terminalFixture("cancelled");
  await db.delete(jobCancellations).where(eq(jobCancellations.jobId, f.jobId));
  const [saved] = await db
    .select()
    .from(federationTerminalEvidence)
    .where(eq(federationTerminalEvidence.jobId, f.jobId));
  if (!saved) throw new Error("Missing job evidence");
  const evidence = {
    ...saved.evidence,
    source: "platform-cancellation" as const,
    agentEventId: null,
  };
  await db
    .update(federationTerminalEvidence)
    .set({ evidence, digest: federationMaterialDigest(evidence) })
    .where(eq(federationTerminalEvidence.jobId, f.jobId));
  await db.update(jobs).set({ revokedEpoch: 2 }).where(eq(jobs.id, f.jobId));
  await db.insert(softwareOperations).values({
    agentId: f.agentId,
    requestedBy: f.executionUserId,
    action: "install",
    spec: "private-spec",
    replayEnabled: true,
    federationJobId: f.jobId,
    manifestDigest: `sha256:${"a".repeat(64)}`,
    status: "running",
  });
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "DATA_WAITING" });
  await db.insert(jobCancellations).values({
    jobId: f.jobId,
    agentId: f.agentId,
    revokedEpoch: 1,
    requiresInstallationStop: true,
    createdAt: new Date(Date.now() - 1000),
    acknowledgedAt: new Date(),
  });
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "DATA_WAITING" });
  await db
    .update(jobCancellations)
    .set({ revokedEpoch: 2, requiresInstallationStop: false, acknowledgedAt: new Date() })
    .where(eq(jobCancellations.jobId, f.jobId));
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "DATA_WAITING" });
  await db
    .update(jobCancellations)
    .set({ requiresInstallationStop: true, acknowledgedAt: new Date() })
    .where(eq(jobCancellations.jobId, f.jobId));
  const terminal = await f.approveTerminal();
  expect(terminal.evidence.jobs[0]?.installations[0]).toMatchObject({
    status: "running",
    stopAcknowledgementId: expect.any(String),
  });
  expect(JSON.stringify(terminal)).not.toContain("private-spec");
});

test("execution terminal requires outstanding data cleanup acknowledgement even after Agent completion", async () => {
  const f = await terminalFixture();
  await db.insert(dataDeliveryRevocations).values({
    jobId: f.jobId,
    agentId: f.agentId,
    reasonCode: "fixture",
    revokedEpoch: 2,
    destroyRestrictedWorkRoot: true,
  });
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "DATA_WAITING" });
  await db
    .update(dataDeliveryRevocations)
    .set({ acknowledgedAt: new Date() })
    .where(eq(dataDeliveryRevocations.jobId, f.jobId));
  expect((await f.approveTerminal()).evidence.jobs[0]?.revocations).toHaveLength(1);
});

test("execution terminal checks exact market binding and explicit signing purpose", async () => {
  const f = await terminalFixture();
  if (!f.state.activation) throw new Error("Missing activation");
  const gate = f.state.activation.gate;
  f.state.activation.gate = { ...gate, reservationDigest: `sha256:${"0".repeat(64)}` };
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  f.state.activation.gate = gate;
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-reservation", "delegation"] })
    .where(
      and(
        eq(federationSigningKeys.siteId, f.siteId),
        eq(federationSigningKeys.keyId, f.b.signing.keyId),
      ),
    );
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
  expect(
    await db
      .select()
      .from(federationExecutionTerminals)
      .where(eq(federationExecutionTerminals.localSiteId, f.siteId)),
  ).toHaveLength(0);
});

test("execution terminal rechecks human authority after ledger query and rolls back the fence with failed audit", async () => {
  const f = await terminalFixture();
  f.beforeTerminalQuery(async () => {
    await new FederationPermissionService(db).set(
      { ...f.actor, capability: "agreement.approve", enabled: false },
      f.actor.userId,
    );
  });
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  f.beforeTerminalQuery(async () => {});
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: true },
    f.actor.userId,
  );
  await db.execute(
    sql`alter table audit_log add constraint test_terminal_audit check (action <> 'federation.execution.terminal' OR actor <> ${sql.raw(`'${f.actor.userId}'`)})`,
  );
  try {
    await expect(f.approveTerminal()).rejects.toThrow();
    expect(
      await db
        .select()
        .from(federationExecutionTerminals)
        .where(eq(federationExecutionTerminals.localSiteId, f.siteId)),
    ).toHaveLength(0);
    await f.authorizeConfirmation();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_terminal_audit`);
  }
  await f.approveTerminal();
});

test("execution terminal requires signed result delivery for successful workflows with a result policy", async () => {
  const f = await terminalFixture("completed", true);
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "DATA_WAITING" });
  const [reservation] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, f.reservation.reservationId));
  if (!reservation) throw new Error("Missing reservation");
  const receipt = FederationResultReceiptSchema.parse({
    protocolVersion: 1,
    kind: "result-receipt",
    receiptId: randomUUID(),
    senderSiteId: f.a.signing.siteId,
    recipientSiteId: f.siteId,
    operationId: f.reservation.request.operationId,
    agreementRevisionId: f.revisionId,
    taskId: f.reservation.request.taskId,
    attempt: 1,
    reservationId: reservation.id,
    requestDigest: reservation.requestDigest,
    manifestDigest: `sha256:${"f".repeat(64)}`,
    fileCount: 1,
    sizeBytes: 42,
    receivedAt: new Date().toISOString(),
  });
  const receiptJws = await signFederationMessage(
    FederationResultReceiptSchema,
    receipt,
    f.a.signing,
  );
  const key = await f.trust.resolveKey(f.a.signing.siteId, f.a.signing.keyId, new Date());
  const { digest } = await verifyFederationMessage(
    FederationResultReceiptSchema,
    receiptJws,
    key,
    new Date(),
  );
  const acknowledgement = FederationResultReceiptAckSchema.parse({
    protocolVersion: 1,
    kind: "result-receipt-ack",
    receiptId: receipt.receiptId,
    operationId: receipt.operationId,
    senderSiteId: f.siteId,
    recipientSiteId: f.a.signing.siteId,
    receiptDigest: digest,
    recordedAt: new Date().toISOString(),
  });
  await db.insert(federationResultReceipts).values({
    localSiteId: f.siteId,
    senderSiteId: f.a.signing.siteId,
    receiptId: receipt.receiptId,
    reservationId: reservation.id,
    receipt,
    receiptJws,
    digest,
    acknowledgement,
    acknowledgementJws: await signFederationMessage(
      FederationResultReceiptAckSchema,
      acknowledgement,
      f.b.signing,
    ),
  });
  await db
    .update(federationResultReceipts)
    .set({ receipt: { ...receipt, manifestDigest: `sha256:${"0".repeat(64)}` } })
    .where(eq(federationResultReceipts.receiptId, receipt.receiptId));
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await db
    .update(federationResultReceipts)
    .set({ receipt })
    .where(eq(federationResultReceipts.receiptId, receipt.receiptId));
  expect((await f.approveTerminal()).payload.resultManifestDigest).toBe(receipt.manifestDigest);
});

test("execution terminal refuses foreign org, source institution and caller-supplied evidence over HTTP", async () => {
  const f = await terminalFixture();
  const source = new FederationExecutionTerminalService(db, f.a.signing);
  await expect(
    source.approve(f.actor, f.revisionId, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.terminal.approve(
      { ...f.actor, orgId: randomUUID() },
      f.revisionId,
      f.reservation.reservationId,
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, { userId: f.actor.userId, orgId: f.actor.orgId } as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.execution,
      undefined,
      undefined,
      f.terminal,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/execution-approvals/${f.reservation.reservationId}/terminal`;
  const invalid = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      outcome: "completed",
      executionEvidenceDigest: `sha256:${"0".repeat(64)}`,
    }),
  });
  expect(invalid.status).toBe(400);
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(200);
});

test("execution terminal wins a renewal network race and accepts a terminal after execution expiry", async () => {
  const f = await terminalFixture("failed");
  f.setClock(new Date(Date.now() + 241000));
  f.beforeQuery(async () => {
    await f.approveTerminal();
  });
  await expect(f.requestConfirmation()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const expired = await terminalFixture("failed");
  const afterExpiry = new Date(
    Date.parse(
      expired.reservation.request.executionExpiresAt ?? expired.reservation.request.expiresAt,
    ) + 1000,
  );
  const service = new FederationExecutionTerminalService(
    db,
    expired.b.signing,
    { query: async () => ({ operation: "get-demand", demand: expired.state }) },
    () => afterExpiry,
  );
  expect(
    (await service.approve(expired.actor, expired.revisionId, expired.reservation.reservationId))
      .payload.issuedAt,
  ).toBe(afterExpiry.toISOString());
});

test("execution terminal refuses a held workflow lock without deadlocking a final dispatch", async () => {
  const f = await terminalFixture();
  await db.transaction(async (tx) => {
    await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, f.binding.workflowRunId))
      .for("update");
    await expect(f.approveTerminal()).rejects.toMatchObject({ cause: { code: "55P03" } });
    await f.confirmation.authorize(tx, f.actor.orgId, f.reservation.request);
  });
  await f.approveTerminal();
});

test("execution terminal waits for the original source cancellation cleanup monitor", async () => {
  const f = await terminalFixture("cancelled");
  const [reservation] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, f.reservation.reservationId));
  if (!reservation) throw new Error("Missing reservation");
  const request = FederationCancellationSchema.parse({
    protocolVersion: 1,
    kind: "cancellation",
    operationId: reservation.operationId,
    senderSiteId: f.a.signing.siteId,
    recipientSiteId: f.siteId,
    agreementRevisionId: f.revisionId,
    taskId: reservation.taskId,
    attempt: reservation.attempt,
    requestDigest: reservation.requestDigest,
    issuedAt: new Date().toISOString(),
  });
  const requestJws = await signFederationMessage(
    FederationCancellationSchema,
    request,
    f.a.signing,
  );
  const key = await f.trust.resolveKey(f.a.signing.siteId, f.a.signing.keyId, new Date());
  const { digest } = await verifyFederationMessage(
    FederationCancellationSchema,
    requestJws,
    key,
    new Date(),
  );
  await db.insert(federationCancellations).values({
    localSiteId: f.siteId,
    senderSiteId: f.a.signing.siteId,
    operationId: reservation.operationId,
    agreementRevisionId: f.revisionId,
    requestDigest: reservation.requestDigest,
    cancellationDigest: digest,
    request,
    requestJws,
    recordedAt: new Date(),
  });
  await expect(f.approveTerminal()).rejects.toMatchObject({ code: "DATA_WAITING" });
  await db
    .update(federationCancellations)
    .set({ confirmedAt: new Date() })
    .where(eq(federationCancellations.operationId, reservation.operationId));
  expect((await f.approveTerminal()).evidence.cancellation?.digest).toBe(digest);
});

async function terminalSourceFixture(
  outcome: "completed" | "failed" | "cancelled" = "completed",
  withResults = false,
  withArbitration = false,
  fields?: ("dueAmount" | "grossAmount")[],
) {
  const f = await terminalFixture(outcome, withResults, withArbitration, fields);
  const sourceSiteId = f.a.signing.siteId;
  const sourceConfirmation = new FederationExecutionConfirmationService(db, sourceSiteId, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  await sourceConfirmation.request(f.actor, f.revisionId, f.reservation.reservationId);
  const market = new FederationMarketService(db, sourceSiteId, f.marketAdapter);
  for (let i = 0; i < 3; i++) await market.advanceNext();
  const [reservation] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, f.reservation.reservationId));
  if (!reservation?.receiptJws) throw new Error("Missing receiver reservation");
  const outbound = new FederationOutboundService(
    db,
    f.a.signing,
    async (_endpoint, jws, path) => {
      if (!path || path === "/federation/v1/delegations") return reservation.receiptJws ?? "";
      if (path !== "/federation/v1/status") throw new Error("Unexpected fixture transport");
      const key = await f.trust.resolveKey(sourceSiteId, f.a.signing.keyId, new Date());
      const { payload: query, digest } = await verifyFederationMessage(
        FederationStatusQuerySchema,
        jws,
        key,
        new Date(),
      );
      const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...identity } = query;
      const report = FederationStatusReportSchema.parse({
        ...identity,
        kind: "status-report",
        senderSiteId: f.siteId,
        recipientSiteId: sourceSiteId,
        queryDigest: digest,
        observedAt: new Date().toISOString(),
        preparation: null,
        workflow: { status: outcome, updatedAt: new Date().toISOString() },
      });
      return signFederationMessage(FederationStatusReportSchema, report, f.b.signing);
    },
    f.assets,
    undefined,
    sourceConfirmation,
  );
  await outbound.enqueue(f.actor, f.reservation.request);
  expect(await outbound.deliverNext()).toBe(true);
  expect(await outbound.refreshStatusNext()).toBe(true);
  const sourceTerminal = new FederationExecutionTerminalService(db, f.a.signing, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  return {
    ...f,
    sourceTerminal,
    sourceConfirmation,
    outbound,
    receiver: reservation,
    proposal: () => f.terminal.proposal(f.actor, f.revisionId, f.reservation.reservationId),
  };
}

for (const outcome of ["completed", "failed", "cancelled"] as const)
  test(`terminal source ${outcome} countersigns verified local evidence and permanently fences its own execution`, async () => {
    const f = await terminalSourceFixture(outcome);
    const provider = await f.approveTerminal();
    const proposal = await f.proposal();
    const call = () =>
      f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal);
    const signed = await Promise.all([call(), call(), call()]);
    const first = signed[0];
    if (!first) throw new Error("Missing countersignature");
    expect(signed.every((row) => row.approvalJws === first.approvalJws)).toBe(true);
    expect(first.digest).toBe(provider.digest);
    expect(first.counterpartyJws).toBe(provider.approvalJws);
    expect(first.sourceReview?.requestDigest).toBe(f.receiver.requestDigest);
    expect(first.sourceReview?.requestJws).toBe(f.receiver.requestJws);
    if (!f.receiver.receiptJws) throw new Error("Missing acceptance signature");
    expect(first.sourceReview?.acceptanceJws).toBe(f.receiver.receiptJws);
    const key = await f.trust.resolveKey(f.a.signing.siteId, f.a.signing.keyId, new Date());
    expect(
      (await verifyFederationMessage(CommercialTerminalSchema, first.approvalJws, key, new Date()))
        .digest,
    ).toBe(provider.digest);
    await expect(
      db.transaction((tx) =>
        f.sourceConfirmation.authorize(tx, f.actor.orgId, f.reservation.request),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const restart = new FederationExecutionTerminalService(db, f.a.signing);
    expect(
      await restart.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal),
    ).toEqual(first);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actor, f.actor.userId),
            eq(auditLog.action, "federation.execution.terminal_countersign"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
    ).toHaveLength(0);
  });

test("terminal source rejects altered evidence, unsigned digests, wrong activation and stale local status", async () => {
  const f = await terminalSourceFixture();
  await f.approveTerminal();
  const original = await f.proposal();
  for (const field of ["evidence", "activation", "signature"] as const) {
    const proposal = structuredClone(original);
    if (field === "evidence") proposal.evidence.jobs = [];
    else if (field === "activation") proposal.payload.activationId = randomUUID();
    else
      proposal.providerJws = await signFederationMessage(
        CommercialTerminalSchema,
        proposal.payload,
        f.a.signing,
      );
    await expect(
      f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal),
    ).rejects.toThrow();
  }
  await db
    .update(federationOutbound)
    .set({ statusReport: null, statusReportJws: null, statusVerifiedAt: null })
    .where(
      and(
        eq(federationOutbound.localSiteId, f.a.signing.siteId),
        eq(federationOutbound.operationId, f.reservation.request.operationId),
      ),
    );
  await expect(
    f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, original),
  ).rejects.toMatchObject({ code: "DATA_WAITING" });
  expect(
    await db
      .select()
      .from(federationExecutionTerminals)
      .where(eq(federationExecutionTerminals.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test("terminal source rejects a signed but incomplete job stop assertion", async () => {
  const f = await terminalSourceFixture("cancelled");
  await f.approveTerminal();
  const proposal = await f.proposal();
  const job = proposal.evidence.jobs[0];
  if (!job) throw new Error("Missing job");
  job.evidence.source = "platform-cancellation";
  job.evidence.agentEventId = null;
  job.digest = federationMaterialDigest(job.evidence);
  job.cancellations = [];
  proposal.payload.executionEvidenceDigest = federationMaterialDigest(proposal.evidence);
  proposal.providerJws = await signFederationMessage(
    CommercialTerminalSchema,
    proposal.payload,
    f.b.signing,
  );
  await expect(
    f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
});

test("terminal source requires current org approval and original business signing trust", async () => {
  const f = await terminalSourceFixture();
  await f.approveTerminal();
  const proposal = await f.proposal();
  await expect(
    f.sourceTerminal.countersign(
      { ...f.actor, orgId: randomUUID() },
      f.revisionId,
      f.reservation.reservationId,
      proposal,
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await f.trust.revoke(f.siteId, { keyId: f.b.signing.keyId }, f.actor.userId);
  await expect(
    f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal),
  ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
});

test("terminal source requires its own published result import matching the signed provider manifest", async () => {
  const f = await terminalSourceFixture("completed", true);
  const [run] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, f.binding.workflowRunId));
  if (!run?.completedAt || !f.terms.agreement.resultPolicy) throw new Error("Missing completion");
  const request = f.reservation.request;
  const manifest = {
    template: request.template,
    inputManifestDigest: request.inputManifestDigest,
    environmentLockDigest: request.environmentLockDigest,
    completedAt: run.completedAt.toISOString(),
    availableUntil: f.terms.agreement.resultPolicy.availableUntil,
    outputs: [
      {
        outputId: `sha256:${"e".repeat(64)}`,
        nodeId: "terminal",
        descriptor: "result",
        type: "File" as const,
        contentDigest: `sha256:${"f".repeat(64)}`,
        sizeBytes: 42,
        files: [{ path: "result.txt", sha256: "f".repeat(64), sizeBytes: 42 }],
      },
    ],
  };
  const manifestDigest = federationMaterialDigest(manifest);
  const identity = {
    protocolVersion: 1 as const,
    operationId: request.operationId,
    agreementRevisionId: f.revisionId,
    taskId: request.taskId,
    attempt: request.attempt,
    reservationId: f.reservation.reservationId,
    requestDigest: f.receiver.requestDigest,
  };
  const receipt = FederationResultReceiptSchema.parse({
    ...identity,
    kind: "result-receipt",
    receiptId: randomUUID(),
    senderSiteId: f.a.signing.siteId,
    recipientSiteId: f.siteId,
    manifestDigest,
    fileCount: 1,
    sizeBytes: 42,
    receivedAt: new Date().toISOString(),
  });
  const receiptJws = await signFederationMessage(
    FederationResultReceiptSchema,
    receipt,
    f.a.signing,
  );
  const key = await f.trust.resolveKey(f.a.signing.siteId, f.a.signing.keyId, new Date());
  const { digest } = await verifyFederationMessage(
    FederationResultReceiptSchema,
    receiptJws,
    key,
    new Date(),
  );
  const acknowledgement = FederationResultReceiptAckSchema.parse({
    protocolVersion: 1,
    kind: "result-receipt-ack",
    receiptId: receipt.receiptId,
    operationId: request.operationId,
    senderSiteId: f.siteId,
    recipientSiteId: f.a.signing.siteId,
    receiptDigest: digest,
    recordedAt: new Date().toISOString(),
  });
  await db.insert(federationResultReceipts).values({
    localSiteId: f.siteId,
    senderSiteId: f.a.signing.siteId,
    receiptId: receipt.receiptId,
    reservationId: f.reservation.reservationId,
    receipt,
    receiptJws,
    digest,
    acknowledgement,
    acknowledgementJws: await signFederationMessage(
      FederationResultReceiptAckSchema,
      acknowledgement,
      f.b.signing,
    ),
  });
  await f.approveTerminal();
  const proposal = await f.proposal();
  const sign = () =>
    f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal);
  await expect(sign()).rejects.toMatchObject({ code: "DATA_WAITING" });
  const report = FederationResultReportSchema.parse({
    ...identity,
    kind: "result-report",
    queryId: randomUUID(),
    senderSiteId: f.siteId,
    recipientSiteId: f.a.signing.siteId,
    queryDigest: `sha256:${"a".repeat(64)}`,
    observedAt: new Date().toISOString(),
    manifestDigest,
    manifest,
  });
  const reportJws = await signFederationMessage(FederationResultReportSchema, report, f.b.signing);
  const importId = randomUUID();
  await db.insert(federationResultImports).values({
    id: importId,
    localSiteId: f.a.signing.siteId,
    localOrgId: f.actor.orgId,
    operationId: request.operationId,
    requestedBy: f.actor.userId,
    report,
    reportJws,
    manifestDigest,
  });
  await expect(sign()).rejects.toMatchObject({ code: "DATA_WAITING" });
  await db
    .update(federationResultImports)
    .set({
      state: "available",
      receipt,
      receiptJws,
      report: { ...report, manifest: { ...manifest, outputs: [] } },
    })
    .where(eq(federationResultImports.id, importId));
  await expect(sign()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await db
    .update(federationResultImports)
    .set({ report })
    .where(eq(federationResultImports.id, importId));
  expect((await sign()).sourceReview?.result).toEqual({
    importId,
    receiptDigest: digest,
    reportJws,
  });
});

test("terminal source waits for its own stopped cancellation receipt and rejects a different cancellation", async () => {
  const f = await terminalSourceFixture("cancelled");
  const identity = {
    protocolVersion: 1 as const,
    operationId: f.reservation.request.operationId,
    agreementRevisionId: f.revisionId,
    taskId: f.reservation.request.taskId,
    attempt: 1,
    requestDigest: f.receiver.requestDigest,
  };
  const cancelRequest = FederationCancellationSchema.parse({
    ...identity,
    kind: "cancellation",
    senderSiteId: f.a.signing.siteId,
    recipientSiteId: f.siteId,
    issuedAt: new Date().toISOString(),
  });
  const cancelJws = await signFederationMessage(
    FederationCancellationSchema,
    cancelRequest,
    f.a.signing,
  );
  const sourceKey = await f.trust.resolveKey(f.a.signing.siteId, f.a.signing.keyId, new Date());
  const { digest: cancelDigest } = await verifyFederationMessage(
    FederationCancellationSchema,
    cancelJws,
    sourceKey,
    new Date(),
  );
  await db.insert(federationCancellations).values({
    localSiteId: f.siteId,
    senderSiteId: f.a.signing.siteId,
    operationId: identity.operationId,
    agreementRevisionId: f.revisionId,
    requestDigest: identity.requestDigest,
    cancellationDigest: cancelDigest,
    request: cancelRequest,
    requestJws: cancelJws,
    recordedAt: new Date(),
    confirmedAt: new Date(),
  });
  const filter = and(
    eq(federationOutbound.localSiteId, f.a.signing.siteId),
    eq(federationOutbound.operationId, identity.operationId),
  );
  await db
    .update(federationOutbound)
    .set({
      cancelRequest,
      cancelJws,
      cancelDigest,
      cancelState: "pending",
      cancelRequestedBy: f.actor.userId,
      cancelNextAttemptAt: new Date(),
    })
    .where(filter);
  await f.approveTerminal();
  const proposal = await f.proposal();
  const sign = () =>
    f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal);
  await expect(sign()).rejects.toMatchObject({ code: "DATA_WAITING" });
  const cancelReceipt = FederationCancellationReceiptSchema.parse({
    ...identity,
    kind: "cancellation-receipt",
    senderSiteId: f.siteId,
    recipientSiteId: f.a.signing.siteId,
    cancellationDigest: cancelDigest,
    recordedAt: cancelRequest.issuedAt,
    observedAt: new Date().toISOString(),
    reservationId: f.reservation.reservationId,
    state: "stopped",
    workflow: { status: "cancelled", updatedAt: new Date().toISOString() },
  });
  const cancelReceiptJws = await signFederationMessage(
    FederationCancellationReceiptSchema,
    cancelReceipt,
    f.b.signing,
  );
  await db
    .update(federationOutbound)
    .set({
      cancelState: "stopped",
      cancelReceipt,
      cancelReceiptJws,
      cancelDigest: `sha256:${"0".repeat(64)}`,
    })
    .where(filter);
  await expect(sign()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await db.update(federationOutbound).set({ cancelDigest }).where(filter);
  expect((await sign()).sourceReview?.cancellation?.receiptJws).toBe(cancelReceiptJws);
});

test("terminal source atomically enqueues private terminal and recovers the same transaction after adapter outage", async () => {
  const f = await terminalSourceFixture("failed");
  await f.approveTerminal();
  const proposal = await f.proposal();
  const saved = await f.sourceTerminal.countersign(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    proposal,
  );
  const view = () => f.sourceTerminal.get(f.actor, f.revisionId, f.reservation.reservationId);
  expect((await view())?.submission?.state).toBe("pending");
  expect(await f.service.advanceNext()).toBe(true);
  const before = await view();
  expect(before?.submission?.transaction?.stage).toBe("proposal");
  f.adapter.offline = true;
  expect(await f.service.advanceNext()).toBe(true);
  expect((await view())?.submission?.transaction?.transactionId).toBe(
    before?.submission?.transaction?.transactionId,
  );
  f.adapter.offline = false;
  const worker = new FederationCommercialSubmissionService(db, f.a.signing.siteId, f.adapter);
  if (!before?.submission) throw new Error("Missing submission");
  await db
    .update(submissions)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(submissions.id, before.submission.id));
  expect(await worker.advanceNext()).toBe(true);
  expect(await worker.advanceNext()).toBe(true);
  expect((await view())?.submission).toMatchObject({
    state: "committed",
    transaction: {
      stage: "committed",
      transactionId: before.submission.transaction?.transactionId,
    },
  });
  const wire = f.adapter.prepares.find((input) => input.operation === "record-execution-terminal");
  expect(wire?.digest).toBe(saved.digest);
  expect(JSON.stringify(wire)).not.toContain("executionSnapshotDigest");
  expect(JSON.stringify(wire)).not.toContain(f.jobId);
  expect(
    await f.sourceTerminal.countersign(
      f.actor,
      f.revisionId,
      f.reservation.reservationId,
      proposal,
    ),
  ).toEqual(saved);
});

test("terminal source disclosure refuses a replaced signature and audit failure rolls back signing and enqueue", async () => {
  const f = await terminalSourceFixture();
  await f.approveTerminal();
  const proposal = await f.proposal();
  await db.execute(
    sql`alter table audit_log add constraint test_terminal_source_audit check (action <> 'federation.execution.terminal_countersign' OR actor <> ${sql.raw(`'${f.actor.userId}'`)})`,
  );
  try {
    await expect(
      f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal),
    ).rejects.toThrow();
    expect(
      await f.sourceTerminal.get(f.actor, f.revisionId, f.reservation.reservationId),
    ).toBeNull();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_terminal_source_audit`);
  }
  await f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal);
  const view = await f.sourceTerminal.get(f.actor, f.revisionId, f.reservation.reservationId);
  if (!view?.submission) throw new Error("Missing submission");
  const [row] = await db.select().from(submissions).where(eq(submissions.id, view.submission.id));
  if (row?.input.operation !== "record-execution-terminal")
    throw new Error("Missing terminal operation");
  await db
    .update(submissions)
    .set({
      input: {
        ...row.input,
        envelope: { ...row.input.envelope, sourceJws: row.input.envelope.targetJws },
      },
    })
    .where(eq(submissions.id, row.id));
  const count = f.adapter.prepares.length;
  expect(await f.service.advanceNext()).toBe(true);
  expect(f.adapter.prepares).toHaveLength(count);
  expect(
    (await f.sourceTerminal.get(f.actor, f.revisionId, f.reservation.reservationId))?.submission
      ?.state,
  ).toBe("needs_review");
});

test("terminal source rejects a signed acceptance for different consideration", async () => {
  const f = await terminalSourceFixture();
  await f.approveTerminal();
  const proposal = await f.proposal();
  const receipt = { ...f.receiver.receipt, reservedAmount: "1" };
  await db
    .update(federationOutbound)
    .set({
      receipt,
      receiptJws: await signFederationMessage(FederationAcceptanceSchema, receipt, f.b.signing),
    })
    .where(
      and(
        eq(federationOutbound.localSiteId, f.a.signing.siteId),
        eq(federationOutbound.operationId, f.reservation.request.operationId),
      ),
    );
  await expect(
    f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
});

test("terminal source HTTP requires an institutional human and the complete signed proposal", async () => {
  const f = await terminalSourceFixture();
  await f.approveTerminal();
  const proposal = await f.proposal();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, { userId: f.actor.userId, orgId: f.actor.orgId } as never);
    if (c.req.header("x-test-automation")) c.set("automation" as never, true as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.execution,
      undefined,
      undefined,
      f.sourceTerminal,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/execution-approvals/${f.reservation.reservationId}/terminal/countersign`;
  const post = (body: unknown, automation = false) =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(automation ? { "x-test-automation": "1" } : {}),
      },
      body: JSON.stringify(body),
    });
  expect((await post({})).status).toBe(400);
  expect((await post(proposal, true)).status).toBe(403);
  expect((await post(proposal)).status).toBe(200);
  expect((await post(proposal)).status).toBe(200);
});

async function closureFixture() {
  const f = await terminalSourceFixture("failed");
  await f.approveTerminal();
  const terminal = await f.sourceTerminal.countersign(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    await f.proposal(),
  );
  const view = () => f.sourceTerminal.get(f.actor, f.revisionId, f.reservation.reservationId);
  const market = new FederationMarketService(db, f.a.signing.siteId, f.marketAdapter);
  return { ...f, terminal, view, sourceMarket: market };
}

test("execution closure waits for VALID private commit and recovers public transaction without exposing private evidence", async () => {
  const f = await closureFixture();
  expect((await f.view())?.closure).toBeNull();
  for (let i = 0; i < 2; i++) await f.service.advanceNext();
  f.adapter.outcome = "pending";
  await f.service.advanceNext();
  expect((await f.view())?.closure).toBeNull();
  const pending = (await f.view())?.submission;
  if (!pending) throw new Error("Missing private terminal");
  f.adapter.outcome = "committed";
  await db
    .update(submissions)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(submissions.id, pending.id));
  await f.service.advanceNext();
  expect((await f.view())?.closure).toMatchObject({ id: f.terminal.terminalId, state: "pending" });
  const [saved] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, f.terminal.terminalId));
  if (saved?.input.operation !== "close-demand") throw new Error("Missing closure");
  expect(saved.input.closure).toMatchObject({
    expectedVersion: f.reservation.claimVersion + 1,
    gate: {
      state: "TERMINAL",
      version: 2,
      expiresAt: f.reservation.request.expiresAt,
      terminal: {
        terminalId: f.terminal.terminalId,
        activationId: f.activationId,
        digest: f.terminal.digest,
      },
    },
  });
  for (const secret of [
    f.jobId,
    f.terminal.payload.executionEvidenceDigest,
    f.terminal.approvalJws,
    "failed",
    "sourceReview",
    "locked",
    "spent",
  ])
    expect(JSON.stringify(saved.input)).not.toContain(secret);
  expect(MarketProposalInputSchema.safeParse(saved.input).success).toBe(false);
  f.marketAdapter.outcome = "pending";
  for (let i = 0; i < 3; i++) await f.sourceMarket.advanceNext();
  const before = (await f.view())?.closure?.transaction;
  expect(before?.stage).toBe("transaction");
  f.marketAdapter.outcome = "committed";
  await db
    .update(marketSubmissions)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(marketSubmissions.id, saved.id));
  await new FederationMarketService(db, f.a.signing.siteId, f.marketAdapter).advanceNext();
  expect((await f.view())?.closure).toMatchObject({
    state: "committed",
    transaction: { transactionId: before?.transactionId, stage: "committed", validationCode: 0 },
  });
  expect(await f.service.advanceNext()).toBe(false);
  expect(await f.sourceMarket.advanceNext()).toBe(false);
  expect(f.marketAdapter.inputs.filter((x) => x.operation === "close-demand")).toHaveLength(1);
});

test("execution closure backfills historical committed terminals once after restart without live signing keys or network", async () => {
  const f = await closureFixture();
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  await db.delete(marketSubmissions).where(eq(marketSubmissions.id, f.terminal.terminalId));
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: new Date() })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  f.adapter.offline = true;
  const count = f.adapter.prepares.length;
  const restarted = new FederationCommercialSubmissionService(db, f.a.signing.siteId, f.adapter);
  await Promise.all([restarted.advanceNext(), f.service.advanceNext()]);
  expect((await f.view())?.closure?.state).toBe("pending");
  expect(f.adapter.prepares).toHaveLength(count);
  expect(await restarted.advanceNext()).toBe(false);
  await f.sourceMarket.advanceNext();
  expect((await f.view())?.closure?.transaction?.stage).toBe("proposal");
});

test("execution closure does not accept committed state without a valid transaction receipt", async () => {
  const f = await closureFixture();
  const pending = (await f.view())?.submission;
  if (!pending) throw new Error("Missing private terminal");
  await db.update(submissions).set({ state: "committed" }).where(eq(submissions.id, pending.id));
  await f.service.advanceNext();
  expect((await f.view())?.closure).toBeNull();
  expect((await f.view())?.submission).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
  });
  expect(f.adapter.prepares.some((x) => x.operation === "record-execution-terminal")).toBe(false);
});

test("execution closure rejects invalid private commits and conflicting public identity", async () => {
  const f = await closureFixture();
  f.adapter.outcome = "invalid";
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  expect((await f.view())?.closure).toBeNull();
  expect((await f.view())?.submission?.state).toBe("needs_review");
  const g = await closureFixture();
  for (let i = 0; i < 3; i++) await g.service.advanceNext();
  const [saved] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, g.terminal.terminalId));
  if (saved?.input.operation !== "close-demand") throw new Error("Missing closure");
  const input = {
    ...saved.input,
    closure: { ...saved.input.closure, expectedVersion: saved.input.closure.expectedVersion + 1 },
  };
  await db
    .update(marketSubmissions)
    .set({ input, digest: federationMaterialDigest(input) })
    .where(eq(marketSubmissions.id, saved.id));
  await g.sourceMarket.advanceNext();
  expect((await g.view())?.closure).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    transaction: null,
  });
  expect(g.marketAdapter.inputs.some((x) => x.operation === "close-demand")).toBe(false);
});

test("execution closure audit rollback preserves private transaction checkpoint and recovers it unchanged", async () => {
  const f = await closureFixture();
  for (let i = 0; i < 2; i++) await f.service.advanceNext();
  const before = (await f.view())?.submission;
  if (!before) throw new Error("Missing terminal submission");
  await db.execute(
    sql`alter table audit_log add constraint test_closure_audit check (action <> 'federation.execution.close_enqueue' OR actor <> ${sql.raw(`'${f.actor.userId}'`)})`,
  );
  try {
    await f.service.advanceNext();
    expect((await f.view())?.closure).toBeNull();
    expect((await f.view())?.submission?.transaction?.stage).toBe("transaction");
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_closure_audit`);
  }
  await db
    .update(submissions)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(submissions.id, before.id));
  await f.service.advanceNext();
  expect((await f.view())?.submission?.transaction).toMatchObject({
    stage: "committed",
    transactionId: before.transaction?.transactionId,
  });
  expect((await f.view())?.closure?.state).toBe("pending");
});

for (const stopping of [false, true])
  test(`execution closure accepts original ACTIVE version and retires unqueued stop after CLOSED (stopping=${stopping})`, async () => {
    const f = await closureFixture();
    const stops = new FederationExecutionStopService(db, f.a.signing.siteId, {
      query: async () => ({ operation: "get-demand", demand: f.state }),
    });
    const stop = await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
    if (stopping) {
      f.state.status = "STOPPING";
      f.state.version++;
      f.state.stopRequest = {
        stopId: stop.id,
        issuerSiteId: f.a.signing.siteId,
        demandId: f.reservation.demandId,
        activationId: f.activationId,
        expectedVersion: f.reservation.claimVersion + 1,
      };
    }
    for (let i = 0; i < 3; i++) await f.service.advanceNext();
    const [saved] = await db
      .select()
      .from(marketSubmissions)
      .where(eq(marketSubmissions.id, f.terminal.terminalId));
    if (saved?.input.operation !== "close-demand") throw new Error("Missing closure");
    f.state.status = "CLOSED";
    f.state.version++;
    f.state.closure = saved.input.closure;
    expect(MarketDemandStateSchema.safeParse(f.state).success).toBe(true);
    expect(await stops.advanceNext()).toBe(true);
    expect(await stops.advanceNext()).toBe(false);
    const [approval] = await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.stopId, stop.id));
    expect(approval).toMatchObject({
      stopId: stop.id,
      stopNextAttemptAt: null,
      stopLastError: null,
    });
    expect(
      await db.select().from(marketSubmissions).where(eq(marketSubmissions.id, stop.id)),
    ).toHaveLength(0);
    await expect(
      f.sourceConfirmation.request(f.actor, f.revisionId, f.reservation.reservationId),
    ).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
  });

for (const steps of [0, 1, 2])
  test(`terminal fence blocks undisclosed renewals but recovers submitted transactions (steps=${steps})`, async () => {
    const f = await terminalFixture("failed");
    f.setClock(new Date(Date.now() + 241000));
    await f.requestConfirmation();
    const [renewal] = await db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, f.siteId),
          eq(marketSubmissions.state, "pending"),
          sql`${marketSubmissions.input}->>'operation' = 'authorize-execution'`,
        ),
      );
    if (!renewal) throw new Error("Missing renewal");
    for (let i = 0; i < steps; i++) await f.market.advanceNext();
    const [before] = await db
      .select()
      .from(marketAttempts)
      .where(eq(marketAttempts.submissionId, renewal.id));
    await f.approveTerminal();
    const count = f.marketAdapter.inputs.length;
    await f.market.advanceNext();
    const [after] = await db
      .select()
      .from(marketSubmissions)
      .where(eq(marketSubmissions.id, renewal.id));
    expect(after?.state).toBe(steps === 2 ? "committed" : "needs_review");
    expect(after?.lastError).toBe(steps === 2 ? null : "EXECUTION_TERMINAL");
    expect(f.marketAdapter.inputs).toHaveLength(count);
    if (steps === 2) {
      const [attempt] = await db
        .select()
        .from(marketAttempts)
        .where(eq(marketAttempts.submissionId, renewal.id));
      expect(attempt?.transactionId).toBe(before?.transactionId);
    }
  });

test("terminal fence blocks undisclosed stops and CLOSED with mismatched reservation cannot retire a stop", async () => {
  const f = await terminalFixture("failed");
  const stops = new FederationExecutionStopService(db, f.siteId, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  const stop = await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  await stops.advanceNext();
  await f.approveTerminal();
  const count = f.marketAdapter.inputs.length;
  await f.market.advanceNext();
  const [submission] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, stop.id));
  expect(submission).toMatchObject({ state: "needs_review", lastError: "EXECUTION_TERMINAL" });
  expect(f.marketAdapter.inputs).toHaveLength(count);
  const g = await closureFixture();
  for (let i = 0; i < 3; i++) await g.service.advanceNext();
  const [closure] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, g.terminal.terminalId));
  if (closure?.input.operation !== "close-demand" || !g.state.activation)
    throw new Error("Missing closure");
  g.state.status = "CLOSED";
  g.state.version++;
  g.state.closure = closure.input.closure;
  const otherDigest = `sha256:${"f".repeat(64)}`;
  g.state.closure.gate.reservationDigest = otherDigest;
  g.state.activation.gate.reservationDigest = otherDigest;
  const otherStops = new FederationExecutionStopService(db, g.a.signing.siteId, {
    query: async () => ({ operation: "get-demand", demand: g.state }),
  });
  const otherStop = await otherStops.request(g.actor, g.revisionId, g.reservation.reservationId);
  await otherStops.advanceNext();
  const [approval] = await db
    .select()
    .from(executionApprovals)
    .where(eq(executionApprovals.stopId, otherStop.id));
  expect(approval?.stopLastError).toBe("OPERATION_CONFLICT");
  expect(approval?.stopNextAttemptAt).not.toBeNull();
});

async function terminalExchangeFixture() {
  const f = await terminalSourceFixture("failed");
  const fingerprint = randomBytes(32).toString("hex");
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: f.a.signing.siteId,
    certificatePem: "TLS registry fixture; handshake tested separately",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  for (const siteId of [f.a.signing.siteId, f.b.signing.siteId]) {
    const [key] = await db
      .select()
      .from(federationSigningKeys)
      .where(eq(federationSigningKeys.siteId, siteId));
    if (!key) throw new Error("Missing key");
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: [
          ...key.allowedKinds,
          "terminal-query",
          "terminal-chunk",
          "terminal-delivery",
          "terminal-ack",
        ],
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  }
  const provider = new FederationTerminalExchange(db, f.b.signing);
  let failAfterReceive = false;
  let offline = false;
  const requests: string[] = [];
  const send: FederationSend = async (_endpoint, jws, path) => {
    if (offline) throw new Error("offline fixture");
    if (!path) throw new Error("Missing terminal path");
    requests.push(path);
    const result =
      path === "/federation/v1/terminals"
        ? await provider.receiveQuery(jws, fingerprint)
        : path === "/federation/v1/terminal-signatures"
          ? await provider.receiveDelivery(jws, fingerprint)
          : (() => {
              throw new Error("Unexpected terminal path");
            })();
    if (failAfterReceive) throw new Error("lost fixture response");
    return result;
  };
  const exchange = new FederationTerminalExchange(db, f.a.signing, send);
  const view = () => exchange.get(f.actor, f.revisionId, f.reservation.reservationId);
  const due = () =>
    db
      .update(federationTerminalSyncs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(federationTerminalSyncs.localSiteId, f.a.signing.siteId));
  await exchange.discover();
  return {
    ...f,
    provider,
    exchange,
    fingerprint,
    view,
    due,
    send,
    requests,
    offline: (value: boolean) => {
      offline = value;
    },
    loseReply: (value: boolean) => {
      failAfterReceive = value;
    },
  };
}

test("terminal exchange receives evidence without signing and returns approved signature exactly once after lost reply", async () => {
  const f = await terminalExchangeFixture();
  expect(await f.exchange.advanceNext()).toBe(true);
  expect((await f.view()).sync).toMatchObject({ state: "pending", proposal: null });
  const provider = await f.approveTerminal();
  await f.due();
  await Promise.all([f.exchange.advanceNext(), f.exchange.advanceNext()]);
  const received = (await f.view()).sync;
  expect(received?.state).toBe("ready");
  expect(received?.proposal).toEqual(await f.proposal());
  expect(await f.exchange.advanceNext()).toBe(false);
  expect(await f.sourceTerminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toBeNull();
  if (!received?.proposal) throw new Error("Missing proposal");
  const signed = await f.sourceTerminal.countersign(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    received.proposal,
  );
  f.loseReply(true);
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.state).toBe("pending");
  expect(
    (await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId))?.counterpartyJws,
  ).toBe(signed.approvalJws);
  f.loseReply(false);
  await f.due();
  await new FederationTerminalExchange(db, f.a.signing, f.send).advanceNext();
  expect((await f.view()).sync).toMatchObject({ state: "complete", lastError: null });
  expect(await f.exchange.advanceNext()).toBe(false);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actor, f.actor.userId),
          eq(auditLog.action, "federation.execution.terminal_receive_signature"),
        ),
      ),
  ).toHaveLength(1);
  expect(
    (await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId))?.payload,
  ).toEqual(provider.payload);
});

test("terminal exchange resumes more than one MiB across restart with bounded chunks and no duplicated retained bytes", async () => {
  const f = await terminalExchangeFixture();
  const original = await f.approveTerminal();
  const evidence = structuredClone(original.evidence);
  const first = evidence.jobs[0];
  if (!first) throw new Error("Missing job evidence");
  evidence.jobs = Array.from({ length: 80 }, (_, i) => {
    const row = structuredClone(first);
    row.evidence.jobId = randomUUID();
    row.evidence.invocationPathHash = createHash("sha256").update(String(i)).digest("hex");
    row.evidence.scheduler.node = "x".repeat(20000);
    row.digest = federationMaterialDigest(row.evidence);
    return row;
  });
  const payload = {
    ...original.payload,
    executionEvidenceDigest: federationMaterialDigest(evidence, TERMINAL_MAX_BYTES),
  };
  const approvalJws = await signFederationMessage(CommercialTerminalSchema, payload, f.b.signing);
  const key = await f.trust.resolveKey(f.b.signing.siteId, f.b.signing.keyId, new Date());
  const signed = await verifyFederationMessage(
    CommercialTerminalSchema,
    approvalJws,
    key,
    new Date(),
  );
  await db
    .update(federationExecutionTerminals)
    .set({ payload, evidence, approvalJws, digest: signed.digest })
    .where(
      and(
        eq(federationExecutionTerminals.localSiteId, f.b.signing.siteId),
        eq(federationExecutionTerminals.reservationId, f.reservation.reservationId),
      ),
    );
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.nextOffset).toBe(65536);
  f.offline(true);
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.nextOffset).toBe(65536);
  f.offline(false);
  await f.due();
  const restart = new FederationTerminalExchange(db, f.a.signing, f.send);
  for (let i = 0; i < 40 && (await f.view()).sync?.state === "pending"; i++)
    await restart.advanceNext();
  const view = (await f.view()).sync;
  expect(view?.state).toBe("ready");
  expect(view?.totalBytes).toBeGreaterThan(1048576);
  expect(view?.proposal?.evidence).toEqual(evidence);
  expect(
    await db
      .select()
      .from(federationTerminalChunks)
      .where(eq(federationTerminalChunks.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
  if (!view?.proposal) throw new Error("Missing proposal");
  expect(
    (
      await f.sourceTerminal.countersign(
        f.actor,
        f.revisionId,
        f.reservation.reservationId,
        view.proposal,
      )
    ).digest,
  ).toBe(signed.digest);
});

test("terminal exchange rejects revoked certificate, swapped identity and unauthorized message purposes", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  await db
    .update(federationCertificates)
    .set({ revokedAt: new Date() })
    .where(eq(federationCertificates.fingerprint, f.fingerprint));
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.state).toBe("needs_review");
  await db
    .update(federationCertificates)
    .set({ revokedAt: null })
    .where(eq(federationCertificates.fingerprint, f.fingerprint));
  await f.exchange.retry(f.actor, f.revisionId, f.reservation.reservationId);
  const malicious = new FederationTerminalExchange(db, f.a.signing, async (_endpoint, jws) => {
    const own = await f.trust.resolveKey(f.a.signing.siteId, f.a.signing.keyId, new Date());
    const { payload } = await verifyFederationMessage(TerminalQuerySchema, jws, own, new Date());
    const wrong = await signFederationMessage(
      TerminalQuerySchema,
      { ...payload, taskId: randomUUID() },
      f.a.signing,
    );
    return f.provider.receiveQuery(wrong, f.fingerprint);
  });
  await malicious.advanceNext();
  expect((await f.view()).sync?.lastError).toBe("POLICY_DENIED");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-terminal"] })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await f.exchange.retry(f.actor, f.revisionId, f.reservation.reservationId);
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.lastError).toBe("UNTRUSTED_IDENTITY");
  expect((await f.view()).sync?.proposal).toBeNull();
});

test("terminal exchange rejects signed inconsistent chunks and does not replace a partial download", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  const bad = new FederationTerminalExchange(db, f.a.signing, async (_endpoint, jws) => {
    const response = await f.provider.receiveQuery(jws, f.fingerprint);
    const key = await f.trust.resolveKey(f.b.signing.siteId, f.b.signing.keyId, new Date());
    const { payload } = await verifyFederationMessage(
      TerminalChunkSchema,
      response,
      key,
      new Date(),
    );
    if (!payload.item) throw new Error("Missing chunk");
    return signFederationMessage(
      TerminalChunkSchema,
      { ...payload, item: { ...payload.item, totalBytes: payload.item.totalBytes + 1 } },
      f.b.signing,
    );
  });
  await bad.advanceNext();
  expect((await f.view()).sync).toMatchObject({
    state: "needs_review",
    nextOffset: 0,
    proposal: null,
  });
  expect(
    await db
      .select()
      .from(federationTerminalChunks)
      .where(eq(federationTerminalChunks.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test("terminal exchange attachment rolls back on audit failure and rejects a different signed terminal", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  await f.exchange.advanceNext();
  const proposal = (await f.view()).sync?.proposal;
  if (!proposal) throw new Error("Missing proposal");
  await f.sourceTerminal.countersign(f.actor, f.revisionId, f.reservation.reservationId, proposal);
  await db.execute(
    sql`alter table audit_log add constraint test_terminal_delivery_audit check (action <> 'federation.execution.terminal_receive_signature' OR actor <> ${sql.raw(`'${f.actor.userId}'`)})`,
  );
  try {
    await f.exchange.advanceNext();
    expect(
      (await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId))?.counterpartyJws,
    ).toBeNull();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_terminal_delivery_audit`);
  }
  await f.due();
  const bad = new FederationTerminalExchange(db, f.a.signing, async (_endpoint, jws) => {
    const own = await f.trust.resolveKey(f.a.signing.siteId, f.a.signing.keyId, new Date());
    const { payload } = await verifyFederationMessage(TerminalDeliverySchema, jws, own, new Date());
    const sourceJws = await signFederationMessage(
      CommercialTerminalSchema,
      { ...proposal.payload, salt: randomBytes(32).toString("hex") },
      f.a.signing,
    );
    return f.provider.receiveDelivery(
      await signFederationMessage(TerminalDeliverySchema, { ...payload, sourceJws }, f.a.signing),
      f.fingerprint,
    );
  });
  await bad.advanceNext();
  expect((await f.view()).sync?.lastError).toBe("OPERATION_CONFLICT");
  expect(
    (await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId))?.counterpartyJws,
  ).toBeNull();
  await f.exchange.retry(f.actor, f.revisionId, f.reservation.reservationId);
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.state).toBe("complete");
});

test("terminal exchange rechecks local purpose and refuses stale leases after peer response", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  const revoked = new FederationTerminalExchange(db, f.a.signing, async (...args) => {
    const response = await f.send(...args);
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: ["commercial-terminal"] })
      .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
    return response;
  });
  await revoked.advanceNext();
  expect((await f.view()).sync).toMatchObject({
    state: "needs_review",
    proposal: null,
    lastError: "UNTRUSTED_IDENTITY",
  });
  const g = await terminalExchangeFixture();
  await g.approveTerminal();
  const late = new FederationTerminalExchange(db, g.a.signing, async (...args) => {
    const response = await g.send(...args);
    await db
      .update(federationTerminalSyncs)
      .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) })
      .where(eq(federationTerminalSyncs.localSiteId, g.a.signing.siteId));
    return response;
  });
  await late.advanceNext();
  expect((await g.view()).sync).toMatchObject({
    state: "pending",
    nextOffset: 0,
    lastError: null,
    proposal: null,
  });
});

test("terminal exchange status and received approval enforce organization and empty human intent", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  await f.exchange.advanceNext();
  await expect(
    f.exchange.get({ ...f.actor, orgId: randomUUID() }, f.revisionId, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.execution,
      f.sourceConfirmation,
      undefined,
      f.sourceTerminal,
      f.exchange,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/execution-approvals/${f.reservation.reservationId}/terminal`;
  const get = await app.request(`${path}/exchange`);
  expect(get.status).toBe(200);
  expect(get.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await get.json())).not.toContain("leaseToken");
  expect(
    (
      await app.request(`${path}/countersign-received`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"outcome":"completed"}',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(`${path}/countersign-received`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.state).toBe("complete");
});

test("terminal exchange quarantines invalid signed JSON and disabled transport keeps history without network", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  const bad = new FederationTerminalExchange(db, f.a.signing, async (_endpoint, jws) => {
    const response = await f.provider.receiveQuery(jws, f.fingerprint);
    const key = await f.trust.resolveKey(f.b.signing.siteId, f.b.signing.keyId, new Date());
    const { payload } = await verifyFederationMessage(
      TerminalChunkSchema,
      response,
      key,
      new Date(),
    );
    if (!payload.item) throw new Error("Missing chunk");
    const bytes = Buffer.from("invalid JSON");
    return signFederationMessage(
      TerminalChunkSchema,
      {
        ...payload,
        item: {
          ...payload.item,
          totalBytes: bytes.length,
          bytes: bytes.toString("base64"),
          proposalDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        },
      },
      f.b.signing,
    );
  });
  await bad.advanceNext();
  expect((await f.view()).sync).toMatchObject({
    state: "needs_review",
    proposal: null,
    lastError: "INVALID_MESSAGE",
  });
  const disabled = new FederationTerminalExchange(db, f.a.signing);
  await disabled.discover();
  expect(await disabled.advanceNext()).toBe(false);
  expect((await disabled.get(f.actor, f.revisionId, f.reservation.reservationId)).sync?.state).toBe(
    "needs_review",
  );
  await expect(
    disabled.retry(f.actor, f.revisionId, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "ASSET_UNAVAILABLE" });
});

test("terminal exchange manual approval finishes signature delivery and clears an interrupted download", async () => {
  const f = await terminalExchangeFixture();
  const original = await f.approveTerminal();
  const evidence = structuredClone(original.evidence),
    job = evidence.jobs[0];
  if (!job) throw new Error("Missing evidence");
  job.evidence.scheduler.node = "x".repeat(80000);
  job.digest = federationMaterialDigest(job.evidence);
  const payload = {
    ...original.payload,
    executionEvidenceDigest: federationMaterialDigest(evidence, TERMINAL_MAX_BYTES),
  };
  const approvalJws = await signFederationMessage(CommercialTerminalSchema, payload, f.b.signing);
  const key = await f.trust.resolveKey(f.b.signing.siteId, f.b.signing.keyId, new Date());
  const { digest } = await verifyFederationMessage(
    CommercialTerminalSchema,
    approvalJws,
    key,
    new Date(),
  );
  await db
    .update(federationExecutionTerminals)
    .set({ payload, evidence, approvalJws, digest })
    .where(
      and(
        eq(federationExecutionTerminals.localSiteId, f.b.signing.siteId),
        eq(federationExecutionTerminals.reservationId, f.reservation.reservationId),
      ),
    );
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.nextOffset).toBe(65536);
  await f.sourceTerminal.countersign(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    await f.proposal(),
  );
  await f.exchange.advanceNext();
  expect((await f.view()).sync).toMatchObject({
    state: "complete",
    nextOffset: 0,
    totalBytes: null,
    proposal: null,
  });
  expect(
    await db
      .select()
      .from(federationTerminalChunks)
      .where(eq(federationTerminalChunks.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test("terminal exchange expired lease discards a late response without requiring human review", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  const late = new FederationTerminalExchange(db, f.a.signing, async (...args) => {
    const response = await f.send(...args);
    await db
      .update(federationTerminalSyncs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationTerminalSyncs.localSiteId, f.a.signing.siteId));
    return response;
  });
  await late.advanceNext();
  expect((await f.view()).sync).toMatchObject({ state: "pending", lastError: null, nextOffset: 0 });
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.state).toBe("ready");
});

test("terminal exchange explicit retry fences errors from the expired worker", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  const late = new FederationTerminalExchange(db, f.a.signing, async () => {
    await db
      .update(federationTerminalSyncs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationTerminalSyncs.localSiteId, f.a.signing.siteId));
    await f.exchange.retry(f.actor, f.revisionId, f.reservation.reservationId);
    throw new Error("late transport failure");
  });
  await late.advanceNext();
  expect((await f.view()).sync).toMatchObject({ state: "pending", lastError: null, nextOffset: 0 });
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.state).toBe("ready");
});

async function terminalPolicyFixture(
  outcome: "completed" | "failed" | "cancelled" = "completed",
  withResults = false,
) {
  const f = await terminalFixture(outcome, withResults);
  const policies = new FederationTerminalPolicyService(db, f.siteId);
  const worker = new FederationTerminalAutomation(db, f.siteId, f.terminal);
  const grant = (outcomes: ("completed" | "failed" | "cancelled")[] = [outcome]) =>
    policies.grant(f.actor, f.revisionId, {
      outcomes,
      validUntil: new Date(Date.now() + 3600_000).toISOString(),
    });
  const view = async () =>
    (
      await db
        .select()
        .from(executionApprovals)
        .where(
          and(
            eq(executionApprovals.localSiteId, f.siteId),
            eq(executionApprovals.recordId, f.reservation.reservationId),
          ),
        )
    )[0];
  return { ...f, policies, worker, grant, view };
}

test("terminal automation is opt-in and concurrent workers sign once with institutional provenance", async () => {
  const f = await terminalPolicyFixture();
  expect(await f.worker.advanceNext()).toBe(false);
  const policy = await f.grant();
  const results = await Promise.all([f.worker.advanceNext(), f.worker.advanceNext()]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const terminal = await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId);
  expect(terminal).toMatchObject({ authorizationPolicyId: policy.id, approvedBy: f.actor.userId });
  expect(await f.worker.advanceNext()).toBe(false);
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actor, `terminal-policy:${policy.id}`),
        eq(auditLog.action, "federation.execution.terminal"),
      ),
    );
  expect(audits).toHaveLength(1);
  expect(await f.policies.revoke(f.actor, f.revisionId, policy.id)).toMatchObject({
    id: policy.id,
    revokedBy: f.actor.userId,
  });
  expect(
    (await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId))?.approvalJws,
  ).toBe(terminal?.approvalJws);
  await expect(f.requestConfirmation()).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("terminal automation rechecks revocation after network query and replacement requires explicit retry", async () => {
  const f = await terminalPolicyFixture();
  const policy = await f.grant();
  f.beforeTerminalQuery(async () => {
    await f.policies.revoke(f.actor, f.revisionId, policy.id);
  });
  await f.worker.advanceNext();
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toBeNull();
  expect(await f.view()).toMatchObject({
    terminalAutoState: "needs_review",
    terminalAutoError: "AUTHORIZATION_EXPIRED",
  });
  const replacement = await f.grant();
  expect(await f.worker.advanceNext()).toBe(false);
  f.beforeTerminalQuery(async () => {});
  await f.policies.retry(f.actor, f.revisionId, f.reservation.reservationId);
  await f.worker.advanceNext();
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toMatchObject({
    authorizationPolicyId: replacement.id,
  });
});

test("terminal automation checks expiry at signing and never follows a grant into another revision or institution", async () => {
  const f = await terminalPolicyFixture();
  const policy = await f.grant();
  let now = new Date();
  const expired = new FederationExecutionTerminalService(
    db,
    f.b.signing,
    {
      query: async () => {
        now = policy.validUntil;
        return { operation: "get-demand", demand: f.state };
      },
    },
    () => now,
  );
  await expect(expired.automate(policy.id, f.reservation.reservationId)).rejects.toMatchObject({
    code: "AUTHORIZATION_EXPIRED",
  });
  const g = await terminalPolicyFixture();
  await expect(g.terminal.automate(policy.id, g.reservation.reservationId)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await expect(f.terminal.automate(policy.id, g.reservation.reservationId)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toBeNull();
});

test("terminal automation preserves outcome restrictions and quarantines unapproved results", async () => {
  const f = await terminalPolicyFixture("failed");
  await f.grant(["completed"]);
  await f.worker.advanceNext();
  expect(await f.view()).toMatchObject({
    terminalAutoState: "needs_review",
    terminalAutoError: "POLICY_DENIED",
  });
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toBeNull();
});

test("terminal automation skips running work and waits for result receipts without weakening evidence checks", async () => {
  const f = await terminalPolicyFixture("completed", true);
  await f.grant();
  await db
    .update(workflowRuns)
    .set({ status: "running", completedAt: null })
    .where(eq(workflowRuns.id, f.binding.workflowRunId));
  expect(await f.worker.advanceNext()).toBe(false);
  await db
    .update(workflowRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(workflowRuns.id, f.binding.workflowRunId));
  expect(await f.worker.advanceNext()).toBe(true);
  expect(await f.view()).toMatchObject({
    terminalAutoState: "pending",
    terminalAutoError: "DATA_WAITING",
  });
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toBeNull();
});

test("terminal automation retries ledger outages and database contention but quarantines invalid ledger evidence", async () => {
  const f = await terminalPolicyFixture();
  await f.grant();
  f.beforeTerminalQuery(async () => {
    throw new FabricClientFailure("LEDGER_UNAVAILABLE");
  });
  await f.worker.advanceNext();
  expect(await f.view()).toMatchObject({
    terminalAutoState: "pending",
    terminalAutoError: "LEDGER_UNAVAILABLE",
  });
  await f.policies.retry(f.actor, f.revisionId, f.reservation.reservationId);
  f.beforeTerminalQuery(async () => {
    throw new Error("busy", { cause: { code: "55P03" } });
  });
  await f.worker.advanceNext();
  expect(await f.view()).toMatchObject({
    terminalAutoState: "pending",
    terminalAutoError: "DATABASE_BUSY",
  });
  await f.policies.retry(f.actor, f.revisionId, f.reservation.reservationId);
  f.beforeTerminalQuery(async () => {
    throw new FabricClientFailure("INVALID_LEDGER_RESPONSE", true);
  });
  await f.worker.advanceNext();
  expect(await f.view()).toMatchObject({
    terminalAutoState: "needs_review",
    terminalAutoError: "INVALID_LEDGER_RESPONSE",
  });
});

test("terminal automation stale worker errors cannot overwrite an explicit retry", async () => {
  const f = await terminalPolicyFixture();
  await f.grant();
  f.beforeTerminalQuery(async () => {
    await f.policies.retry(f.actor, f.revisionId, f.reservation.reservationId);
    throw new FabricClientFailure("INVALID_LEDGER_RESPONSE", true);
  });
  await f.worker.advanceNext();
  expect(await f.view()).toMatchObject({ terminalAutoState: "pending", terminalAutoError: null });
  f.beforeTerminalQuery(async () => {});
  await f.worker.advanceNext();
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).not.toBeNull();
});

test("terminal policy requires explicit human capability, immutable replacement and valid bounded input", async () => {
  const f = await terminalPolicyFixture();
  for (const input of [
    { outcomes: [], validUntil: "2099-01-01T00:00:00Z" },
    { outcomes: ["completed", "completed"], validUntil: "2099-01-01T00:00:00Z" },
    { outcomes: ["completed"], validUntil: "2099-01-01T00:00:00Z", billApproval: true },
  ])
    expect(TerminalPolicyInputSchema.safeParse(input).success).toBe(false);
  await expect(
    f.policies.grant(f.actor, f.revisionId, {
      outcomes: ["completed"],
      validUntil: "2000-01-01T00:00:00Z",
    }),
  ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  const policy = await f.grant();
  await expect(f.grant()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await expect(
    f.policies.revoke({ ...f.actor, orgId: randomUUID() }, f.revisionId, policy.id),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.policies.revoke(f.actor, f.revisionId, policy.id)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  // Institutional consent survives the grantor's personal role change; revocation is explicit.
  await f.worker.advanceNext();
  const [terminal] = await db
    .select()
    .from(federationExecutionTerminals)
    .where(eq(federationExecutionTerminals.localSiteId, f.siteId));
  expect(terminal?.authorizationPolicyId).toBe(policy.id);
});

test("terminal automation rolls back signature and execution fence if audit fails", async () => {
  const f = await terminalPolicyFixture();
  const policy = await f.grant();
  await db.execute(
    sql`alter table audit_log add constraint test_auto_terminal_audit check (actor <> ${sql.raw(`'terminal-policy:${policy.id}'`)})`,
  );
  try {
    await f.worker.advanceNext();
    expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toBeNull();
    expect(await f.view()).toMatchObject({
      terminalAutoState: "needs_review",
      terminalAutoError: "INTERNAL_ERROR",
    });
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_auto_terminal_audit`);
  }
  await f.policies.retry(f.actor, f.revisionId, f.reservation.reservationId);
  await f.worker.advanceNext();
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).not.toBeNull();
});

test("terminal automation independently authorizes both institutions and completes signature return", async () => {
  const f = await terminalExchangeFixture();
  const providerPolicies = new FederationTerminalPolicyService(db, f.siteId);
  const sourcePolicies = new FederationTerminalPolicyService(db, f.a.signing.siteId);
  const providerWorker = new FederationTerminalAutomation(db, f.siteId, f.terminal);
  const sourceWorker = new FederationTerminalAutomation(db, f.a.signing.siteId, f.sourceTerminal);
  const provider = await providerPolicies.grant(f.actor, f.revisionId, {
    outcomes: ["failed"],
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
  });
  await providerWorker.advanceNext();
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.state).toBe("ready");
  expect(await sourceWorker.advanceNext()).toBe(false);
  expect(await f.sourceTerminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toBeNull();
  const source = await sourcePolicies.grant(f.actor, f.revisionId, {
    outcomes: ["failed"],
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
  });
  await sourceWorker.advanceNext();
  await f.exchange.advanceNext();
  expect((await f.view()).sync?.state).toBe("complete");
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).toMatchObject({
    authorizationPolicyId: provider.id,
  });
  expect(
    await f.sourceTerminal.get(f.actor, f.revisionId, f.reservation.reservationId),
  ).toMatchObject({ authorizationPolicyId: source.id, submission: { state: "pending" } });
});

test("terminal policy API binds human organization and rejects extra authority fields", async () => {
  const f = await terminalPolicyFixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let automated = false;
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    c.set("automation" as never, automated as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.execution,
      undefined,
      undefined,
      f.terminal,
      undefined,
      f.policies,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/terminal-policies`;
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const input = {
    outcomes: ["completed"],
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
  };
  expect((await post(path, { ...input, orgId: randomUUID() })).status).toBe(400);
  automated = true;
  expect((await post(path, input)).status).toBe(403);
  automated = false;
  const response = await post(path, input);
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  const listing = await app.request(path);
  expect(listing.status).toBe(200);
  expect(listing.headers.get("cache-control")).toBe("no-store");
  expect((await post(`${path}/${body.data.id}/revoke`, { reason: "extra" })).status).toBe(400);
  expect((await post(`${path}/${body.data.id}/revoke`, {})).status).toBe(200);
});

test("terminal automation clears waiting errors after successful durable approval", async () => {
  const f = await terminalPolicyFixture();
  await f.grant();
  f.beforeTerminalQuery(async () => {
    throw new FabricClientFailure("LEDGER_UNAVAILABLE");
  });
  await f.worker.advanceNext();
  expect((await f.view())?.terminalAutoError).toBe("LEDGER_UNAVAILABLE");
  f.beforeTerminalQuery(async () => {});
  await db
    .update(executionApprovals)
    .set({ terminalAutoNextAt: new Date(0) })
    .where(eq(executionApprovals.localSiteId, f.siteId));
  await f.worker.advanceNext();
  expect((await f.view())?.terminalAutoError).toBeNull();
  expect(await f.terminal.get(f.actor, f.revisionId, f.reservation.reservationId)).not.toBeNull();
});

test("terminal policy grant and revocation are atomic with their audit records", async () => {
  const f = await terminalPolicyFixture();
  await db.execute(
    sql`alter table audit_log add constraint test_terminal_policy_audit check (action NOT IN ('federation.terminal_policy.grant','federation.terminal_policy.revoke') OR actor <> ${sql.raw(`'${f.actor.userId}'`)})`,
  );
  try {
    await expect(f.grant()).rejects.toThrow();
    expect(await f.policies.list(f.actor, f.revisionId)).toHaveLength(0);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_terminal_policy_audit`);
  }
  const policy = await f.grant();
  await db.execute(
    sql`alter table audit_log add constraint test_terminal_policy_revoke check (action <> 'federation.terminal_policy.revoke' OR actor <> ${sql.raw(`'${f.actor.userId}'`)})`,
  );
  try {
    await expect(f.policies.revoke(f.actor, f.revisionId, policy.id)).rejects.toThrow();
    expect((await f.policies.list(f.actor, f.revisionId))[0]?.revokedAt).toBeNull();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_terminal_policy_revoke`);
  }
});

async function approvalTransport(f: Awaited<ReturnType<typeof fixture>>) {
  const fingerprints: string[] = [];
  for (const site of [f.a, f.b]) {
    const fingerprint = randomBytes(32).toString("hex");
    fingerprints.push(fingerprint);
    await db.insert(federationCertificates).values({
      fingerprint,
      siteId: site.signing.siteId,
      certificatePem: "fixture; TLS handshake covered by gateway tests",
      validFrom: new Date("2020-01-01"),
      validUntil: new Date("2099-01-01"),
    });
    const [key] = await db
      .select()
      .from(federationSigningKeys)
      .where(eq(federationSigningKeys.siteId, site.signing.siteId));
    if (!key) throw new Error("Missing test key");
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: [
          ...key.allowedKinds,
          "commercial-approval-query",
          "commercial-approval-waiting",
        ],
      })
      .where(eq(federationSigningKeys.siteId, site.signing.siteId));
  }
  const aReceiver = new FederationCommercialApprovalExchange(db, f.a.signing);
  const bReceiver = new FederationCommercialApprovalExchange(db, f.b.signing);
  let hook: ((jws: string, response: string) => Promise<string>) | undefined;
  let lost = false;
  let requests = 0;
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/commercial-approvals");
    requests++;
    const response = await bReceiver.receive(jws, fingerprints[0] ?? "");
    if (lost) throw new Error("response lost");
    return hook ? hook(jws, response) : response;
  };
  const a = new FederationCommercialApprovalExchange(db, f.a.signing, send);
  const b = new FederationCommercialApprovalExchange(db, f.b.signing, async (_endpoint, jws) =>
    aReceiver.receive(jws, fingerprints[1] ?? ""),
  );
  const due = () =>
    db
      .update(federationCommercialApprovalSyncs)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        inArray(federationCommercialApprovalSyncs.localSiteId, [
          f.a.signing.siteId,
          f.b.signing.siteId,
        ]),
      );
  return {
    a,
    b,
    aReceiver,
    bReceiver,
    fingerprints,
    send,
    due,
    lose: (value: boolean) => {
      lost = value;
    },
    hook: (fn: typeof hook) => {
      hook = fn;
    },
    requests: () => requests,
  };
}
async function approvalExchangeFixture(
  mode: FederationMode = "bilateral_attested",
  peerApproved = true,
) {
  const f = await fixture(mode);
  const own = await f.approvals.approve(f.actor, f.terms);
  const other = new FederationCommercialAgreementService(db, f.b.signing);
  if (peerApproved) await other.approve(f.actor, f.terms);
  const transport = await approvalTransport(f);
  await Promise.all([transport.a.discover(), transport.b.discover()]);
  const view = async () => (await transport.a.list(f.actor, f.revisionId, 50, 0)).records[0];
  return { ...f, transport, own, other, view };
}

test("approval exchange waits for independent consent then attaches exact signatures with no resigning", async () => {
  const f = await approvalExchangeFixture("bilateral_attested", false);
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "pending", lastError: null });
  expect((await f.approvals.get(f.actor, f.revisionId)).counterpartyJws).toBeNull();
  const other = await f.other.approve(f.actor, f.terms);
  await f.transport.due();
  await f.transport.b.discover();
  await Promise.all([f.transport.a.advanceNext(), f.transport.b.advanceNext()]);
  const own = await f.approvals.get(f.actor, f.revisionId);
  expect(own.approvalJws).toBe(f.own.approvalJws);
  expect(own.counterpartyJws).toBe(other.approvalJws);
  expect((await f.other.get(f.actor, f.revisionId)).counterpartyJws).toBe(f.own.approvalJws);
  expect(await f.view()).toMatchObject({ state: "complete" });
  expect(
    await db.select().from(submissions).where(eq(submissions.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(1);
  expect(await f.transport.a.advanceNext()).toBe(false);
});

test("approval exchange direct cooperation creates no ledger work and recovers lost responses once", async () => {
  const f = await approvalExchangeFixture("bilateral_direct");
  f.transport.lose(true);
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "pending", lastError: "EXCHANGE_RETRY" });
  expect((await f.approvals.get(f.actor, f.revisionId)).counterpartyJws).toBeNull();
  f.transport.lose(false);
  await f.transport.due();
  const restarted = new FederationCommercialApprovalExchange(db, f.a.signing, f.transport.send);
  await Promise.all([restarted.advanceNext(), f.transport.a.advanceNext()]);
  expect(await f.view()).toMatchObject({ state: "complete" });
  expect(
    await db
      .select()
      .from(submissions)
      .where(inArray(submissions.localSiteId, [f.a.signing.siteId, f.b.signing.siteId])),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, f.actor.orgId),
          eq(auditLog.action, "federation.commercial.counterparty"),
        ),
      ),
  ).toHaveLength(1);
});

test("approval exchange refuses altered contract and a valid signature from another institution", async () => {
  const f = await approvalExchangeFixture();
  const altered = CommercialAgreementSchema.parse({
    ...f.terms,
    termsText: "different obligation",
  });
  f.transport.hook(async () =>
    signFederationMessage(CommercialAgreementSchema, altered, f.b.signing),
  );
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "needs_review", lastError: "OPERATION_CONFLICT" });
  expect((await f.approvals.get(f.actor, f.revisionId)).counterpartyJws).toBeNull();
  await f.transport.a.retry(f.actor, {
    agreementRevisionId: f.revisionId,
    recordKind: "agreement",
    recordId: f.revisionId,
  });
  f.transport.hook(async () => f.own.approvalJws);
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "needs_review", lastError: "UNTRUSTED_IDENTITY" });
});

test("approval exchange enforces certificate, recipient, record digest and freshness at the private receiver", async () => {
  const f = await approvalExchangeFixture();
  const query = CommercialApprovalQuerySchema.parse({
    protocolVersion: 1,
    kind: "commercial-approval-query",
    queryId: randomUUID(),
    senderSiteId: f.a.signing.siteId,
    recipientSiteId: f.b.signing.siteId,
    agreementRevisionId: f.revisionId,
    domainId: f.terms.domainId,
    recordKind: "agreement",
    recordId: f.revisionId,
    recordDigest: f.own.digest,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const receive = async (value: typeof query, fingerprint = f.transport.fingerprints[0] ?? "") =>
    f.transport.bReceiver.receive(
      await signFederationMessage(CommercialApprovalQuerySchema, value, f.a.signing),
      fingerprint,
    );
  await expect(receive(query, f.transport.fingerprints[1])).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  await expect(receive({ ...query, recipientSiteId: randomUUID() })).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  await expect(
    receive({ ...query, recordDigest: `sha256:${"f".repeat(64)}` }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await expect(
    receive({
      ...query,
      issuedAt: new Date(Date.now() - 120000).toISOString(),
      expiresAt: new Date(Date.now() - 60000).toISOString(),
    }),
  ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  await db
    .update(federationCertificates)
    .set({ revokedAt: new Date() })
    .where(eq(federationCertificates.fingerprint, f.transport.fingerprints[0] ?? ""));
  await expect(receive(query)).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
});

test("approval exchange rejects a signed waiting response for another query", async () => {
  const f = await approvalExchangeFixture("bilateral_attested", false);
  f.transport.hook(async (_query, response) => {
    const key = await f.trust.resolveKey(f.b.signing.siteId, f.b.signing.keyId, new Date());
    const { payload } = await verifyFederationMessage(
      CommercialApprovalWaitingSchema,
      response,
      key,
      new Date(),
    );
    return signFederationMessage(
      CommercialApprovalWaitingSchema,
      { ...payload, queryId: randomUUID() },
      f.b.signing,
    );
  });
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "needs_review", lastError: "OPERATION_CONFLICT" });
});

test("approval exchange rechecks purpose and endpoint changes during network IO", async () => {
  const f = await approvalExchangeFixture();
  f.transport.hook(async (_request, response) => {
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: ["commercial-agreement"] })
      .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
    return response;
  });
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "needs_review", lastError: "UNTRUSTED_IDENTITY" });
  const g = await approvalExchangeFixture();
  g.transport.hook(async (_request, response) => {
    await g.trust.updateSite(
      g.b.signing.siteId,
      { name: "Changed endpoint", endpoint: "https://changed.invalid" },
      g.actor.userId,
    );
    return response;
  });
  await g.transport.a.advanceNext();
  expect(await g.view()).toMatchObject({ state: "needs_review", lastError: "UNTRUSTED_IDENTITY" });
  expect((await g.approvals.get(g.actor, g.revisionId)).counterpartyJws).toBeNull();
});

test("approval exchange stale leases and explicit retry cannot be overwritten by late responses", async () => {
  const f = await approvalExchangeFixture();
  f.transport.hook(async (_request, response) => {
    await db
      .update(federationCommercialApprovalSyncs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationCommercialApprovalSyncs.localSiteId, f.a.signing.siteId));
    await f.transport.a.retry(f.actor, {
      agreementRevisionId: f.revisionId,
      recordKind: "agreement",
      recordId: f.revisionId,
    });
    return response;
  });
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "pending", lastError: null });
  expect((await f.approvals.get(f.actor, f.revisionId)).counterpartyJws).toBeNull();
  f.transport.hook(undefined);
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "complete" });
});

test("approval exchange rolls back the attachment, sync and ledger intent on audit failure", async () => {
  const f = await approvalExchangeFixture();
  await db.execute(
    sql`alter table audit_log add constraint test_approval_exchange_audit check (actor <> ${sql.raw(`'commercial-exchange:${f.a.signing.siteId}'`)})`,
  );
  try {
    await f.transport.a.advanceNext();
    expect((await f.approvals.get(f.actor, f.revisionId)).counterpartyJws).toBeNull();
    expect(await f.view()).toMatchObject({ state: "pending", lastError: "EXCHANGE_RETRY" });
    expect(
      await db.select().from(submissions).where(eq(submissions.localSiteId, f.a.signing.siteId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_approval_exchange_audit`);
  }
  await f.transport.due();
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "complete" });
});

test("approval exchange disabled transport and foreign org cannot operate on another contract", async () => {
  const f = await approvalExchangeFixture();
  const disabled = new FederationCommercialApprovalExchange(db, f.a.signing);
  await disabled.discover();
  expect(await disabled.advanceNext()).toBe(false);
  expect((await disabled.list(f.actor, f.revisionId, 50, 0)).enabled).toBe(false);
  expect(f.transport.requests()).toBe(0);
  await expect(
    f.transport.a.list({ ...f.actor, orgId: randomUUID() }, f.revisionId, 50, 0),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.transport.a.retry(
      { ...f.actor, orgId: randomUUID() },
      { agreementRevisionId: f.revisionId, recordKind: "agreement", recordId: f.revisionId },
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("approval exchange recovers a manually attached signature without repeating the ledger intent", async () => {
  const f = await approvalExchangeFixture();
  const other = await f.other.get(f.actor, f.revisionId);
  await f.approvals.attachCounterparty(f.actor, f.revisionId, other.approvalJws);
  await f.transport.a.advanceNext();
  expect(f.transport.requests()).toBe(0);
  expect(await f.view()).toMatchObject({ state: "complete" });
  expect(
    await db.select().from(submissions).where(eq(submissions.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(1);
});

test("approval exchange existing consent survives personal role changes without granting new approval", async () => {
  const f = await approvalExchangeFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  await f.transport.a.advanceNext();
  const [saved] = await db
    .select()
    .from(contracts)
    .where(
      and(eq(contracts.localSiteId, f.a.signing.siteId), eq(contracts.revisionId, f.revisionId)),
    );
  expect(saved?.counterpartyJws).not.toBeNull();
  await expect(
    f.approvals.approve(f.actor, {
      ...f.terms,
      agreement: { ...f.terms.agreement, agreementRevisionId: randomUUID() },
    }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

async function executionApprovalExchangeFixture() {
  const f = await executionFixture();
  const other = new FederationCommercialAgreementService(db, f.b.signing);
  await other.approve(f.actor, f.terms);
  await other.attachCounterparty(
    f.actor,
    f.revisionId,
    (await f.approvals.get(f.actor, f.revisionId)).approvalJws,
  );
  if (!f.state.claim) throw new Error("Missing fixture claim");
  const claim = { operation: "claim-demand" as const, claim: f.state.claim };
  await db.insert(marketSubmissions).values({
    id: f.reservation.reservationId,
    localSiteId: f.b.signing.siteId,
    localOrgId: f.actor.orgId,
    requestedBy: f.actor.userId,
    demandId: f.reservation.demandId,
    input: claim,
    digest: federationMaterialDigest(claim),
    state: "committed",
  });
  const executionB = new FederationCommercialExecutionService(db, f.b.signing, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  const original = await f.execution.approve(f.actor, f.revisionId, f.reservation);
  const counterpart = await executionB.approve(f.actor, f.revisionId, f.reservation);
  const transport = await approvalTransport(f);
  return { ...f, executionB, original, counterpart, transport };
}

test("approval exchange completes preapproved reservations and releases without activating execution", async () => {
  const f = await executionApprovalExchangeFixture();
  await Promise.all([f.transport.a.discover(), f.transport.b.discover()]);
  await Promise.all([f.transport.a.advanceNext(), f.transport.b.advanceNext()]);
  expect(
    (await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).counterpartyJws,
  ).toBe(f.counterpart.approvalJws);
  expect(
    (await f.executionB.get(f.actor, f.revisionId, f.reservation.reservationId)).counterpartyJws,
  ).toBe(f.original.approvalJws);
  const release = await releasePayload(f);
  await f.execution.approve(f.actor, f.revisionId, release);
  await f.executionB.approve(f.actor, f.revisionId, release);
  await Promise.all([f.transport.a.discover(), f.transport.b.discover()]);
  await Promise.all([f.transport.a.advanceNext(), f.transport.b.advanceNext()]);
  expect(
    (await f.execution.get(f.actor, f.revisionId, release.releaseId)).counterpartyJws,
  ).not.toBeNull();
  expect(
    (await f.transport.a.list(f.actor, f.revisionId, 50, 0)).records.every(
      (row) => row.state === "complete",
    ),
  ).toBe(true);
  expect(
    await db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, f.a.signing.siteId),
          sql`${marketSubmissions.input}->>'operation' = 'activate-demand'`,
        ),
      ),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
});

test("approval exchange authenticated unrelated institutions cannot obtain private contract signatures", async () => {
  const f = await approvalExchangeFixture();
  const outsider = await approvalExchangeFixture();
  const query = CommercialApprovalQuerySchema.parse({
    protocolVersion: 1,
    kind: "commercial-approval-query",
    queryId: randomUUID(),
    senderSiteId: outsider.a.signing.siteId,
    recipientSiteId: f.b.signing.siteId,
    agreementRevisionId: f.revisionId,
    domainId: f.terms.domainId,
    recordKind: "agreement",
    recordId: f.revisionId,
    recordDigest: f.own.digest,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  await expect(
    f.transport.bReceiver.receive(
      await signFederationMessage(CommercialApprovalQuerySchema, query, outsider.a.signing),
      outsider.transport.fingerprints[0] ?? "",
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("approval exchange expired network failures retain a recoverable original pending record", async () => {
  const f = await approvalExchangeFixture();
  f.transport.hook(async () => {
    await db
      .update(federationCommercialApprovalSyncs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationCommercialApprovalSyncs.localSiteId, f.a.signing.siteId));
    throw new Error("late failed request");
  });
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "pending", lastError: null });
  f.transport.hook(undefined);
  await f.transport.a.advanceNext();
  expect(await f.view()).toMatchObject({ state: "complete" });
});

test("approval exchange HTTP exposes only progress and human retry cannot steal a live lease", async () => {
  const f = await approvalExchangeFixture();
  const app = new Hono();
  let automated = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    c.set("automation" as never, automated as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.transport.a,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/approval-exchange`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = JSON.stringify(await response.json());
  for (const forbidden of ["leaseToken", "termsText", "approvalJws", "prices"])
    expect(text).not.toContain(forbidden);
  const retry = (body: string) =>
    app.request(`${path}/agreement/${f.revisionId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  expect((await retry('{"approve":true}')).status).toBe(400);
  automated = true;
  expect((await retry("{}")).status).toBe(403);
  automated = false;
  await db
    .update(federationCommercialApprovalSyncs)
    .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) })
    .where(eq(federationCommercialApprovalSyncs.localSiteId, f.a.signing.siteId));
  expect((await retry("{}")).status).toBe(409);
  await db
    .update(federationCommercialApprovalSyncs)
    .set({ leaseUntil: new Date(0) })
    .where(eq(federationCommercialApprovalSyncs.localSiteId, f.a.signing.siteId));
  expect((await retry("{}")).status).toBe(200);
  await f.transport.a.advanceNext();
  expect((await retry("{}")).status).toBe(409);
});

test("approval exchange preserves preapproved release recovery after the cooperation contract expires", async () => {
  const f = await executionApprovalExchangeFixture();
  await f.transport.a.discover();
  await f.transport.b.discover();
  await f.transport.a.advanceNext();
  await f.transport.b.advanceNext();
  const release = await releasePayload(f);
  await f.execution.approve(f.actor, f.revisionId, release);
  const peer = await f.executionB.approve(f.actor, f.revisionId, release);
  await db
    .update(federationSigningKeys)
    .set({ validUntil: new Date("2101-01-01T00:00:00Z") })
    .where(inArray(federationSigningKeys.siteId, [f.a.signing.siteId, f.b.signing.siteId]));
  try {
    await db
      .update(federationCertificates)
      .set({ validUntil: new Date("2101-01-01T00:00:00Z") })
      .where(inArray(federationCertificates.siteId, [f.a.signing.siteId, f.b.signing.siteId]));
    setSystemTime(new Date("2100-01-01T00:00:00Z"));
    await f.transport.a.discover();
    expect(await f.transport.a.advanceNext()).toBe(true);
    expect(
      (await f.transport.a.list(f.actor, f.revisionId, 50, 0)).records.find(
        (r) => r.recordKind === "release",
      ),
    ).toMatchObject({ state: "complete", lastError: null });
    expect((await f.execution.get(f.actor, f.revisionId, release.releaseId)).counterpartyJws).toBe(
      peer.approvalJws,
    );
    expect(
      (await f.transport.a.list(f.actor, f.revisionId, 50, 0)).records.find(
        (r) => r.recordKind === "release",
      )?.state,
    ).toBe("complete");
  } finally {
    setSystemTime();
  }
});

async function reservationPolicyFixture(
  provider = false,
  amounts?: { budgetLimit: string; maxTaskAmount: string },
  withMaterials = false,
) {
  const f = await executionFixture(true, withMaterials, false, amounts);
  const signing = provider ? f.b.signing : f.a.signing;
  if (provider) {
    const agreements = new FederationCommercialAgreementService(db, signing);
    await agreements.approve(f.actor, f.terms);
    const [source] = await db
      .select()
      .from(contracts)
      .where(eq(contracts.localSiteId, f.a.signing.siteId));
    if (!source) throw new Error("Missing source contract");
    await agreements.attachCounterparty(f.actor, f.revisionId, source.approvalJws);
    const input = MarketProposalInputSchema.parse({
      operation: "claim-demand",
      claim: f.state.claim,
    });
    await db.insert(marketSubmissions).values({
      id: f.reservation.reservationId,
      demandId: f.reservation.demandId,
      localSiteId: signing.siteId,
      localOrgId: f.actor.orgId,
      requestedBy: f.actor.userId,
      input,
      digest: federationMaterialDigest(input),
      state: "committed",
    });
  }
  const policies = new FederationReservationPolicyService(db, signing.siteId);
  const states = new Map([[f.reservation.demandId, f.state]]);
  let onQuery: () => Promise<void> = async () => {};
  const execution = new FederationCommercialExecutionService(db, signing, {
    query: async (input) => {
      if (input.operation !== "get-demand") throw new Error("Unexpected policy query");
      await onQuery();
      return { operation: "get-demand", demand: states.get(input.demandId) ?? null };
    },
  });
  const policyInput = {
    maxTaskAmount: "60",
    maxTotalAmount: "100",
    maxTasks: 2,
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
  };
  const grant = (input: Partial<typeof policyInput> = {}) =>
    policies.grant(f.actor, f.revisionId, { ...policyInput, ...input });
  const extra = async (maxAmount = "60") => {
    const reserve = CommercialReservationSchema.parse({
      ...f.reservation,
      reservationId: randomUUID(),
      demandId: randomUUID(),
      request: {
        ...f.reservation.request,
        operationId: randomUUID(),
        taskId: randomUUID(),
        maxAmount,
      },
    });
    const state = MarketDemandStateSchema.parse({
      ...f.state,
      demand: { ...f.state.demand, demandId: reserve.demandId },
      claim: { ...f.state.claim, claimId: reserve.reservationId, demandId: reserve.demandId },
    });
    states.set(reserve.demandId, state);
    const input = MarketProposalInputSchema.parse(
      provider
        ? { operation: "claim-demand", claim: state.claim }
        : { operation: "publish-demand", demand: state.demand },
    );
    await db.insert(marketSubmissions).values({
      id: provider ? reserve.reservationId : reserve.demandId,
      localSiteId: signing.siteId,
      localOrgId: f.actor.orgId,
      requestedBy: f.actor.userId,
      demandId: reserve.demandId,
      input,
      digest: federationMaterialDigest(input),
      state: "committed",
    });
    return reserve;
  };
  const view = async () =>
    (
      await db
        .select()
        .from(federationReservationPolicies)
        .where(eq(federationReservationPolicies.localSiteId, signing.siteId))
    )[0];
  const rows = () =>
    db.select().from(executionApprovals).where(eq(executionApprovals.localSiteId, signing.siteId));
  return {
    ...f,
    execution,
    policies,
    grant,
    extra,
    view,
    rows,
    signing,
    policyInput,
    beforeQuery: (fn: () => Promise<void>) => {
      onQuery = fn;
    },
    sourceJws: () => signFederationMessage(CommercialReservationSchema, f.reservation, f.a.signing),
  };
}

test("reservation preauthorization is opt-in, bounded and replaceable only by explicit revoke", async () => {
  const f = await reservationPolicyFixture();
  await expect(f.execution.approvePreauthorized(randomUUID(), f.reservation)).rejects.toMatchObject(
    { code: "POLICY_DENIED" },
  );
  expect(
    ReservationPolicyInputSchema.safeParse({ ...f.policyInput, approvedBy: f.actor.userId })
      .success,
  ).toBe(false);
  expect(ReservationPolicyInputSchema.safeParse({ ...f.policyInput, maxTasks: 0 }).success).toBe(
    false,
  );
  expect(
    ReservationPolicyInputSchema.safeParse({
      ...f.policyInput,
      maxTaskAmount: "61",
      maxTotalAmount: "60",
    }).success,
  ).toBe(false);
  await expect(f.grant({ maxTaskAmount: "61" })).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(f.grant({ maxTotalAmount: "9007199254740993123" })).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await expect(f.grant({ validUntil: "2100-01-01T00:00:00Z" })).rejects.toMatchObject({
    code: "AUTHORIZATION_EXPIRED",
  });
  await expect(f.grant({ validUntil: new Date(0).toISOString() })).rejects.toMatchObject({
    code: "AUTHORIZATION_EXPIRED",
  });
  const policy = await f.grant();
  await expect(f.grant()).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await f.policies.revoke(f.actor, f.revisionId, policy.id);
  expect((await f.grant()).id).not.toBe(policy.id);
  expect(await f.policies.list(f.actor, f.revisionId, 1)).toHaveLength(1);
  expect(await f.policies.list(f.actor, f.revisionId, 1, 1)).toHaveLength(1);
});

test("reservation preauthorization concurrent replay signs and consumes once without creating ledger work", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant({ maxTotalAmount: "60", maxTasks: 1 });
  const [one, two] = await Promise.all([
    f.execution.approvePreauthorized(policy.id, f.reservation),
    f.execution.approvePreauthorized(policy.id, f.reservation),
  ]);
  expect(one.approvalJws).toBe(two.approvalJws);
  expect(one).toMatchObject({
    authorizationPolicyId: policy.id,
    approvedBy: f.actor.userId,
    counterpartyJws: null,
  });
  expect(await f.view()).toMatchObject({ authorizedTasks: 1, authorizedAmount: "60" });
  expect((await f.execution.approvePreauthorized(policy.id, f.reservation)).approvalJws).toBe(
    one.approvalJws,
  );
  expect(
    await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor, `reservation-policy:${policy.id}`)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, f.signing.siteId),
          sql`${submissions.input}->>'operation' = 'reserve-execution'`,
        ),
      ),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
  await expect(
    f.execution.approvePreauthorized(policy.id, { ...f.reservation, salt: "1".repeat(64) }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
});

test("reservation preauthorization concurrent different tasks cannot overspend the last signing allowance", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant();
  const extra = await f.extra();
  const results = await Promise.allSettled([
    f.execution.approvePreauthorized(policy.id, f.reservation),
    f.execution.approvePreauthorized(policy.id, extra),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "POLICY_DENIED" },
  });
  expect(await f.view()).toMatchObject({ authorizedTasks: 1, authorizedAmount: "60" });
  expect(await f.rows()).toHaveLength(1);
  const remaining = await f.extra("40");
  await f.execution.approvePreauthorized(policy.id, remaining);
  expect(await f.view()).toMatchObject({ authorizedTasks: 2, authorizedAmount: "100" });
});

test("reservation preauthorization counts zero-value tasks and keeps manual approvals distinct", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant({ maxTasks: 1, maxTaskAmount: "0", maxTotalAmount: "0" });
  const one = await f.extra("0"),
    two = await f.extra("0");
  const manual = await f.execution.approve(f.actor, f.revisionId, one);
  expect((await f.execution.approvePreauthorized(policy.id, one)).approvalJws).toBe(
    manual.approvalJws,
  );
  expect(await f.view()).toMatchObject({ authorizedTasks: 0, authorizedAmount: "0" });
  await f.execution.approvePreauthorized(policy.id, two);
  await expect(
    f.execution.approvePreauthorized(policy.id, await f.extra("0")),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(await f.view()).toMatchObject({ authorizedTasks: 1, authorizedAmount: "0" });
});

test("reservation preauthorization survives grantor role changes but explicit revoke stops new signatures", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant();
  const permissions = new FederationPermissionService(db);
  await permissions.set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.grant()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const approved = await f.execution.approvePreauthorized(policy.id, f.reservation);
  await permissions.set(
    { ...f.actor, capability: "agreement.approve", enabled: true },
    f.actor.userId,
  );
  await f.policies.revoke(f.actor, f.revisionId, policy.id);
  await expect(
    f.execution.approvePreauthorized(policy.id, await f.extra("1")),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect((await f.rows())[0]?.approvalJws).toBe(approved.approvalJws);
  expect(await f.view()).toMatchObject({ authorizedTasks: 1, authorizedAmount: "60" });
});

test("reservation preauthorization rechecks revocation and deadlines after market I/O", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant();
  f.beforeQuery(async () => {
    await f.policies.revoke(f.actor, f.revisionId, policy.id);
  });
  await expect(f.execution.approvePreauthorized(policy.id, f.reservation)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  expect(await f.rows()).toHaveLength(0);
  const replacement = await f.grant();
  f.beforeQuery(async () => {
    await db
      .update(federationReservationPolicies)
      .set({ validUntil: new Date(Date.now() - 1), validFrom: new Date(Date.now() - 10000) })
      .where(eq(federationReservationPolicies.id, replacement.id));
  });
  await expect(
    f.execution.approvePreauthorized(replacement.id, f.reservation),
  ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  expect(await f.rows()).toHaveLength(0);
});

test("reservation preauthorization limits task lifetime, templates, resources and local market consent", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant();
  const change = (request: Partial<typeof f.reservation.request>) => ({
    ...f.reservation,
    request: { ...f.reservation.request, ...request },
  });
  await expect(
    f.execution.approvePreauthorized(
      policy.id,
      change({ executionExpiresAt: new Date(Date.now() + 7200_000).toISOString() }),
    ),
  ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  await expect(
    f.execution.approvePreauthorized(
      policy.id,
      change({ resources: { ...f.reservation.request.resources, cpus: 2 } }),
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.execution.approvePreauthorized(
      policy.id,
      change({
        template: { ...f.reservation.request.template, digest: `sha256:${"f".repeat(64)}` },
      }),
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.execution.approvePreauthorized(policy.id, {
      ...f.reservation,
      agreementDigest: `sha256:${"f".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await db
    .update(marketSubmissions)
    .set({ state: "pending" })
    .where(eq(marketSubmissions.id, f.reservation.demandId));
  await expect(f.execution.approvePreauthorized(policy.id, f.reservation)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  expect(await f.view()).toMatchObject({ authorizedTasks: 0 });
});

test("reservation preauthorization rejects ledger outage and changed claim without consuming authority", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant();
  f.beforeQuery(async () => {
    throw new FabricClientFailure("LEDGER_UNAVAILABLE");
  });
  await expect(f.execution.approvePreauthorized(policy.id, f.reservation)).rejects.toMatchObject({
    code: "LEDGER_UNAVAILABLE",
  });
  f.beforeQuery(async () => {});
  f.state.status = "ACTIVE";
  await expect(f.execution.approvePreauthorized(policy.id, f.reservation)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  expect(await f.view()).toMatchObject({ authorizedTasks: 0, authorizedAmount: "0" });
});

test("reservation preauthorization provider requires the exact source signature and its own policy", async () => {
  const f = await reservationPolicyFixture(true);
  const policy = await f.grant();
  await expect(f.execution.approvePreauthorized(policy.id, f.reservation)).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  const wrongSigner = await signFederationMessage(
    CommercialReservationSchema,
    f.reservation,
    f.b.signing,
  );
  await expect(
    f.execution.approvePreauthorized(policy.id, f.reservation, wrongSigner),
  ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
  const changed = await signFederationMessage(
    CommercialReservationSchema,
    { ...f.reservation, salt: "e".repeat(64) },
    f.a.signing,
  );
  await expect(
    f.execution.approvePreauthorized(policy.id, f.reservation, changed),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  const source = await f.sourceJws();
  const approved = await f.execution.approvePreauthorized(policy.id, f.reservation, source);
  expect(approved).toMatchObject({ authorizationPolicyId: policy.id, counterpartyJws: null });
  expect(await f.view()).toMatchObject({ authorizedTasks: 1 });
  const sourceService = new FederationCommercialExecutionService(db, f.a.signing);
  await expect(sourceService.approvePreauthorized(policy.id, f.reservation)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});

test("reservation preauthorization rechecks source key purposes after network I/O", async () => {
  const f = await reservationPolicyFixture(true);
  const policy = await f.grant();
  const source = await f.sourceJws();
  f.beforeQuery(async () => {
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: ["commercial-agreement"] })
      .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  });
  await expect(
    f.execution.approvePreauthorized(policy.id, f.reservation, source),
  ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
  expect(await f.rows()).toHaveLength(0);
  expect(await f.view()).toMatchObject({ authorizedTasks: 0 });
});

test("reservation preauthorization requires current contract trust and cannot grant across institutions", async () => {
  const f = await reservationPolicyFixture();
  const other = await reservationPolicyFixture();
  await expect(f.policies.grant(other.actor, f.revisionId, f.policyInput)).rejects.toMatchObject({
    code: "AGREEMENT_UNAVAILABLE",
  });
  const policy = await f.grant();
  await expect(f.policies.revoke(other.actor, f.revisionId, policy.id)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  await expect(
    other.execution.approvePreauthorized(policy.id, f.reservation),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  f.beforeQuery(async () => {
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: new Date() })
      .where(eq(federationSigningKeys.siteId, f.b.signing.siteId));
  });
  await expect(f.execution.approvePreauthorized(policy.id, f.reservation)).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  expect(await f.rows()).toHaveLength(0);
});

test("reservation preauthorization audit failure rolls back both signature and cumulative authority", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant();
  await db.execute(
    sql`alter table audit_log add constraint test_reservation_policy_audit check (actor <> ${sql.raw(`'reservation-policy:${policy.id}'`)})`,
  );
  try {
    await expect(f.execution.approvePreauthorized(policy.id, f.reservation)).rejects.toThrow();
    expect(await f.rows()).toHaveLength(0);
    expect(await f.view()).toMatchObject({ authorizedTasks: 0, authorizedAmount: "0" });
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_reservation_policy_audit`);
  }
  await f.execution.approvePreauthorized(policy.id, f.reservation);
  expect(await f.view()).toMatchObject({ authorizedTasks: 1, authorizedAmount: "60" });
});

test("reservation preauthorization HTTP requires a human organization grant and strict input", async () => {
  const f = await reservationPolicyFixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let automated = false;
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    c.set("automation" as never, automated as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.execution,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.policies,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/reservation-policies`;
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post(path, { ...f.policyInput, orgId: randomUUID() })).status).toBe(400);
  automated = true;
  expect((await post(path, f.policyInput)).status).toBe(403);
  automated = false;
  const response = await post(path, f.policyInput);
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  const listing = await app.request(path);
  expect(listing.status).toBe(200);
  expect(listing.headers.get("cache-control")).toBe("no-store");
  expect((await post(`${path}/${body.data.id}/revoke`, { maxTasks: 100 })).status).toBe(400);
  expect((await post(`${path}/${body.data.id}/revoke`, {})).status).toBe(200);
  expect((await post(`${path}/${body.data.id}/revoke`, {})).status).toBe(200);
});

test("reservation preauthorization preserves exact amounts above the JavaScript integer limit", async () => {
  const f = await reservationPolicyFixture(false, {
    budgetLimit: "9007199254740993123",
    maxTaskAmount: "9007199254740993122",
  });
  const policy = await f.grant({
    maxTaskAmount: "9007199254740993122",
    maxTotalAmount: "9007199254740993123",
    maxTasks: 3,
  });
  await f.execution.approvePreauthorized(policy.id, {
    ...f.reservation,
    request: { ...f.reservation.request, maxAmount: "9007199254740993122" },
  });
  await f.execution.approvePreauthorized(policy.id, await f.extra("1"));
  expect(await f.view()).toMatchObject({
    authorizedTasks: 2,
    authorizedAmount: "9007199254740993123",
  });
  await expect(
    f.execution.approvePreauthorized(policy.id, await f.extra("1")),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(await f.rows()).toHaveLength(2);
});

test("reservation preauthorization grants require dual coordinated consent and charity permits no monetary authority", async () => {
  const input = {
    maxTaskAmount: "1",
    maxTotalAmount: "1",
    maxTasks: 1,
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
  };
  const unsigned = await fixture("ledger_coordinated", true, true);
  await unsigned.approvals.approve(unsigned.actor, unsigned.terms);
  const unsignedPolicies = new FederationReservationPolicyService(db, unsigned.a.signing.siteId);
  await expect(
    unsignedPolicies.grant(unsigned.actor, unsigned.revisionId, input),
  ).rejects.toMatchObject({ code: "LEDGER_REQUIRED" });
  const direct = await fixture("bilateral_direct", true, true);
  await approveBoth(direct);
  await expect(
    new FederationReservationPolicyService(db, direct.a.signing.siteId).grant(
      direct.actor,
      direct.revisionId,
      input,
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const charity = await fixture("ledger_coordinated", true, true);
  charity.terms.consideration = "charity";
  charity.terms.prices = charity.terms.prices.map((price) => ({ ...price, amount: "0" }));
  await approveBoth(charity);
  const policies = new FederationReservationPolicyService(db, charity.a.signing.siteId);
  await expect(policies.grant(charity.actor, charity.revisionId, input)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  expect(
    await policies.grant(charity.actor, charity.revisionId, {
      ...input,
      maxTaskAmount: "0",
      maxTotalAmount: "0",
    }),
  ).toMatchObject({ authorizedAmount: "0", maxTotalAmount: "0" });
});

async function reservationProposalFixture(
  execution: boolean | "activation" | "confirmation" = false,
  guards?: {
    source: Pick<FederationStorageGuard, "assertAdmission">;
    target: Pick<FederationStorageGuard, "assertAdmission">;
  },
) {
  const f = await reservationPolicyFixture(true);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "delegation.submit", enabled: true },
    f.actor.userId,
  );
  if (execution)
    await new FederationPermissionService(db).set(
      { ...f.actor, capability: "market.publish", enabled: true },
      f.actor.userId,
    );
  const sourcePolicies = new FederationReservationPolicyService(db, f.a.signing.siteId);
  const sourcePolicy = await sourcePolicies.grant(f.actor, f.revisionId, {
    ...f.policyInput,
    allowActivation: execution === true || execution === "activation",
    allowExecutionConfirmation: execution === true || execution === "confirmation",
  });
  const targetPolicy = await f.policies.grant(f.actor, f.revisionId, {
    ...f.policyInput,
    allowExecutionConfirmation: execution === true || execution === "confirmation",
  });
  const fingerprints: string[] = [];
  for (const site of [f.a, f.b]) {
    const fingerprint = randomBytes(32).toString("hex");
    fingerprints.push(fingerprint);
    await db.insert(federationCertificates).values({
      fingerprint,
      siteId: site.signing.siteId,
      certificatePem: "fixture; transport certificates covered by real TLS tests",
      validFrom: new Date("2020-01-01"),
      validUntil: new Date("2099-01-01"),
    });
    const [key] = await db
      .select()
      .from(federationSigningKeys)
      .where(eq(federationSigningKeys.siteId, site.signing.siteId));
    if (!key) throw new Error("Missing key");
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: [...key.allowedKinds, "reservation-proposal-receipt"] })
      .where(eq(federationSigningKeys.siteId, site.signing.siteId));
  }
  let queryHook: () => Promise<void> = async () => {};
  const market: Pick<MarketClient, "query"> = {
    query: async () => {
      await queryHook();
      return { operation: "get-demand", demand: f.state };
    },
  };
  const target = new FederationReservationProposalService(
    db,
    f.b.signing,
    undefined,
    market,
    guards?.target,
  );
  let sendHook: ((response: string) => Promise<string>) | undefined;
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/reservation-proposals");
    const result = await target.receive(jws, fingerprints[0] ?? "");
    return sendHook ? sendHook(result) : result;
  };
  const source = new FederationReservationProposalService(
    db,
    f.a.signing,
    send,
    market,
    guards?.source,
  );
  const view = async (provider = false) =>
    (
      await db
        .select()
        .from(federationReservationProposals)
        .where(
          eq(
            federationReservationProposals.localSiteId,
            provider ? f.b.signing.siteId : f.a.signing.siteId,
          ),
        )
    )[0];
  const due = () =>
    db
      .update(federationReservationProposals)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        inArray(federationReservationProposals.localSiteId, [
          f.a.signing.siteId,
          f.b.signing.siteId,
        ]),
      );
  return {
    ...f,
    source,
    target,
    sourcePolicies,
    sourcePolicy,
    targetPolicy,
    fingerprints,
    send,
    market,
    view,
    due,
    submit: () => source.submit(f.actor, f.revisionId, sourcePolicy.id, f.reservation),
    beforeClaim: (fn: () => Promise<void>) => {
      queryHook = fn;
    },
    afterSend: (fn: (response: string) => Promise<string>) => {
      sendHook = fn;
    },
  };
}

test("reservation proposal queue automatically approves both institutions but a delivery receipt is not approval", async () => {
  const f = await reservationProposalFixture();
  const queued = await f.submit();
  expect(queued.state).toBe("pending");
  expect(await f.rows()).toHaveLength(0);
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "sending", policyId: f.sourcePolicy.id });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]).toMatchObject({
    authorizedTasks: 1,
    authorizedAmount: "60",
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "delivered" });
  expect(await f.view(true)).toMatchObject({
    state: "pending",
    approvedAt: null,
    sourceFingerprint: f.fingerprints[0],
  });
  expect(await f.rows()).toHaveLength(0);
  await f.target.advanceNext();
  expect(await f.view(true)).toMatchObject({ state: "approved" });
  expect((await f.rows())[0]).toMatchObject({
    authorizationPolicyId: f.targetPolicy.id,
    counterpartyJws: null,
  });
  expect((await f.policies.list(f.actor, f.revisionId))[0]).toMatchObject({
    authorizedTasks: 1,
    authorizedAmount: "60",
  });
  expect(await f.target.advanceNext()).toBe(false);
  const list = await f.source.list(f.actor, f.revisionId);
  expect(JSON.stringify(list)).not.toContain("sourceJws");
  expect(JSON.stringify(list)).not.toContain("leaseToken");
  expect(
    await db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, f.b.signing.siteId),
          sql`${submissions.input}->>'operation' = 'reserve-execution'`,
        ),
      ),
  ).toHaveLength(0);
});

test("reservation proposal replay and lost delivery responses survive restarts without signing twice", async () => {
  const f = await reservationProposalFixture();
  await Promise.all([f.submit(), f.submit()]);
  await Promise.all([f.source.advanceNext(), f.source.advanceNext()]);
  f.afterSend(async () => {
    throw new Error("lost receipt");
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "sending", lastError: "PROPOSAL_RETRY" });
  expect(await f.view(true)).toMatchObject({ state: "pending" });
  await f.target.advanceNext();
  await f.due();
  f.afterSend(async (receipt) => receipt);
  const restarted = new FederationReservationProposalService(db, f.a.signing, f.send, f.market);
  await restarted.advanceNext();
  expect(await f.view()).toMatchObject({ state: "delivered" });
  expect((await f.rows()).length).toBe(1);
  expect((await f.policies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(1);
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, f.actor.orgId),
        eq(auditLog.action, "federation.reservation_proposal.receive"),
      ),
    );
  expect(audits).toHaveLength(1);
});

test("reservation proposal source requires human submit authority, correct organization, immutable intent and an active policy", async () => {
  const f = await reservationProposalFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "delegation.submit", enabled: false },
    f.actor.userId,
  );
  await expect(f.submit()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "delegation.submit", enabled: true },
    f.actor.userId,
  );
  await expect(
    f.source.submit(
      { ...f.actor, orgId: randomUUID() },
      f.revisionId,
      f.sourcePolicy.id,
      f.reservation,
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.source.submit(f.actor, f.revisionId, f.targetPolicy.id, f.reservation),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await f.submit();
  await expect(
    f.source.submit(f.actor, f.revisionId, f.sourcePolicy.id, {
      ...f.reservation,
      salt: "1".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await f.sourcePolicies.revoke(f.actor, f.revisionId, f.sourcePolicy.id);
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({
    state: "needs_review",
    lastError: "POLICY_DENIED",
    approvedAt: null,
  });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
});

test("reservation proposal reception checks its own policy, original signature and TLS institutional identity", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  await f.source.advanceNext();
  const row = await f.view();
  if (!row?.sourceJws) throw new Error("Missing approval");
  await expect(f.target.receive(row.sourceJws, f.fingerprints[1] ?? "")).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  await f.policies.revoke(f.actor, f.revisionId, f.targetPolicy.id);
  await expect(f.target.receive(row.sourceJws, f.fingerprints[0] ?? "")).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  expect(await f.view(true)).toBeUndefined();
  const replacement = await f.grant();
  await f.target.receive(row.sourceJws, f.fingerprints[0] ?? "");
  expect(await f.view(true)).toMatchObject({ policyId: replacement.id });
  const changed = await signFederationMessage(
    CommercialReservationSchema,
    { ...f.reservation, salt: "2".repeat(64) },
    f.a.signing,
  );
  await expect(f.target.receive(changed, f.fingerprints[0] ?? "")).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
});

test("reservation proposal provider rechecks the source certificate after the chain query", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  await f.source.advanceNext();
  await f.source.advanceNext();
  f.beforeClaim(async () => {
    await db
      .update(federationCertificates)
      .set({ revokedAt: new Date() })
      .where(eq(federationCertificates.fingerprint, f.fingerprints[0] ?? ""));
  });
  await f.target.advanceNext();
  expect(await f.view(true)).toMatchObject({
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
    approvedAt: null,
  });
  expect(await f.rows()).toHaveLength(0);
  expect((await f.policies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
});

test("reservation proposal source rejects misbound receipts and endpoint changes during delivery", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  await f.source.advanceNext();
  f.afterSend(async (jws) => {
    const key = await f.trust.resolveKey(f.b.signing.siteId, f.b.signing.keyId, new Date());
    const { payload } = await verifyFederationMessage(
      ReservationProposalReceiptSchema,
      jws,
      key,
      new Date(),
    );
    return signFederationMessage(
      ReservationProposalReceiptSchema,
      { ...payload, reservationId: randomUUID() },
      f.b.signing,
    );
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    deliveredAt: null,
  });
  await f.source.retry(f.actor, f.revisionId, f.reservation.reservationId);
  f.afterSend(async (jws) => {
    await db
      .update(federationSites)
      .set({ endpoint: "https://changed.test.invalid" })
      .where(eq(federationSites.id, f.b.signing.siteId));
    return jws;
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
    deliveredAt: null,
  });
});

test("reservation proposal lease loss before approval fences signatures and late failures cannot erase retry", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  f.beforeClaim(async () => {
    await db
      .update(federationReservationProposals)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
    await f.source.retry(f.actor, f.revisionId, f.reservation.reservationId);
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "pending", lastError: null, leaseToken: null });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
  f.beforeClaim(async () => {});
  await f.source.advanceNext();
  f.afterSend(async () => {
    await db
      .update(federationReservationProposals)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
    await f.source.retry(f.actor, f.revisionId, f.reservation.reservationId);
    throw new Error("late failure");
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "sending", lastError: null, leaseToken: null });
});

test("reservation proposal cannot steal a live lease and transient chain failure consumes no authority", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  f.beforeClaim(async () => {
    await expect(
      f.source.retry(f.actor, f.revisionId, f.reservation.reservationId),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    throw new FabricClientFailure("LEDGER_UNAVAILABLE");
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({
    state: "pending",
    lastError: "LEDGER_UNAVAILABLE",
    approvedAt: null,
  });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
});

test("reservation proposal approval progress, signature, allowance and audit commit together", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  await db.execute(
    sql`alter table audit_log add constraint test_proposal_audit check (action <> 'federation.reservation_proposal.approve' OR actor <> ${sql.raw(`'reservation-policy:${f.sourcePolicy.id}'`)})`,
  );
  try {
    await f.source.advanceNext();
    expect(await f.view()).toMatchObject({ state: "pending", approvedAt: null, sourceJws: null });
    expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
    expect(
      await db
        .select()
        .from(executionApprovals)
        .where(eq(executionApprovals.localSiteId, f.a.signing.siteId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_proposal_audit`);
  }
  await f.due();
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "sending" });
});

test("reservation proposal disabled sender does not sign queued source work but inbound approval remains available", async () => {
  const f = await reservationProposalFixture();
  const disabled = new FederationReservationProposalService(db, f.a.signing, undefined, f.market);
  await expect(
    disabled.submit(f.actor, f.revisionId, f.sourcePolicy.id, f.reservation),
  ).rejects.toMatchObject({ code: "ASSET_UNAVAILABLE" });
  await f.submit();
  expect(await disabled.advanceNext()).toBe(false);
  expect((await disabled.list(f.actor, f.revisionId)).sendEnabled).toBe(false);
  await f.source.advanceNext();
  await f.source.advanceNext();
  await f.target.advanceNext();
  expect(await f.view(true)).toMatchObject({ state: "approved" });
});

test("reservation proposal HTTP separates human submission from private signed transport", async () => {
  const f = await reservationProposalFixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let automated = false;
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    c.set("automation" as never, automated as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.execution,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.policies,
      f.source,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/reservation-proposals`;
  const post = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const input = { policyId: f.sourcePolicy.id, proposal: f.reservation };
  automated = true;
  expect((await post(input)).status).toBe(403);
  automated = false;
  expect((await post({ ...input, approvedBy: f.actor.userId })).status).toBe(400);
  expect((await post(input)).status).toBe(202);
  expect((await app.request(path)).status).toBe(200);
  await f.source.advanceNext();
  const row = await f.view();
  const ingress = createFederationIngress(db, f.b.signing);
  const peerPath = "/federation/v1/reservation-proposals";
  expect(
    (await ingress.request(peerPath, { method: "POST", body: row?.sourceJws ?? "" })).status,
  ).toBe(415);
  const response = await ingress.request(peerPath, {
    method: "POST",
    body: row?.sourceJws ?? "",
    headers: {
      "content-type": "application/jose",
      "x-kq-federation-cert": f.fingerprints[0] ?? "",
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/jose");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await f.view(true))?.state).toBe("pending");
});

test("reservation proposal production worker feeds signature exchange and queues both private reservations", async () => {
  const f = await reservationProposalFixture();
  const exchange = await approvalTransport(f);
  const sourceWorker = new FederationCommercialWorker(
    f.service,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    exchange.a,
    f.source,
  );
  const providerWorker = new FederationCommercialWorker(
    new FederationCommercialSubmissionService(db, f.b.signing.siteId, f.adapter),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    exchange.b,
    f.target,
  );
  await f.submit();
  await sourceWorker.tick();
  await providerWorker.tick();
  await exchange.due();
  await sourceWorker.tick();
  expect(await f.view()).toMatchObject({ state: "delivered" });
  expect(await f.view(true)).toMatchObject({ state: "approved" });
  const rows = await db
    .select()
    .from(executionApprovals)
    .where(inArray(executionApprovals.localSiteId, [f.a.signing.siteId, f.b.signing.siteId]));
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => !!row.counterpartyJws)).toBe(true);
  const work = await db
    .select()
    .from(submissions)
    .where(
      and(
        inArray(submissions.localSiteId, [f.a.signing.siteId, f.b.signing.siteId]),
        sql`${submissions.input}->>'operation' = 'reserve-execution'`,
      ),
    );
  expect(work).toHaveLength(2);
  expect(
    (await exchange.a.list(f.actor, f.revisionId, 50, 0)).records.every(
      (row) => row.state === "complete",
    ),
  ).toBe(true);
});

test("reservation proposal resumes an existing human approval without charging institutional allowance", async () => {
  const f = await reservationProposalFixture();
  const sourceExecution = new FederationCommercialExecutionService(db, f.a.signing, f.market);
  const manual = await sourceExecution.approve(f.actor, f.revisionId, f.reservation);
  await f.submit();
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "sending", sourceJws: manual.approvalJws });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
});

test("reservation proposal expired delivery success cannot finish a replacement lease", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  await f.source.advanceNext();
  f.afterSend(async (receipt) => {
    await db
      .update(federationReservationProposals)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
    await f.source.retry(f.actor, f.revisionId, f.reservation.reservationId);
    return receipt;
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "sending", deliveredAt: null, lastError: null });
  f.afterSend(async (receipt) => receipt);
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "delivered" });
});

async function executionAutomationFixture(enabled: boolean | "activation" | "confirmation" = true) {
  const f = await reservationProposalFixture(enabled);
  const ordinarySource = new FederationAgreementService(db, f.a.signing);
  const ordinaryProvider = new FederationAgreementService(db, f.b.signing);
  const executionUserId = randomUUID();
  await db.insert(users).values({
    id: executionUserId,
    orgId: f.actor.orgId,
    email: `${executionUserId}@test.invalid`,
    role: "user",
    serviceAccount: true,
  });
  await db
    .insert(userOrgMemberships)
    .values({ userId: executionUserId, orgId: f.actor.orgId, role: "member" });
  const sourceConsent = await ordinarySource.approve(f.actor, { terms: f.terms.agreement });
  const providerConsent = await ordinaryProvider.approve(f.actor, {
    terms: f.terms.agreement,
    executionUserId,
  });
  await ordinarySource.attachCounterparty(f.actor, f.revisionId, providerConsent.approvalJws);
  await ordinaryProvider.attachCounterparty(f.actor, f.revisionId, sourceConsent.approvalJws);
  await f.submit();
  await f.source.advanceNext();
  await f.source.advanceNext();
  await f.target.advanceNext();
  const exchange = await approvalTransport(f);
  await exchange.a.discover();
  await exchange.b.discover();
  await exchange.a.advanceNext();
  await exchange.b.advanceNext();
  const providerCommercial = new FederationCommercialSubmissionService(
    db,
    f.b.signing.siteId,
    f.adapter,
  );
  for (let i = 0; i < 6; i++) {
    await f.service.advanceNext();
    await providerCommercial.advanceNext();
  }
  const marketAdapter = new ActivationAdapter();
  const marketSource = new FederationMarketService(db, f.a.signing.siteId, marketAdapter);
  const marketProvider = new FederationMarketService(db, f.b.signing.siteId, marketAdapter);
  const sourceAutomation = new FederationExecutionAutomation(db, f.a.signing, f.market);
  const providerAutomation = new FederationExecutionAutomation(db, f.b.signing, f.market);
  const confirmation = new FederationExecutionConfirmationService(db, f.a.signing.siteId, f.market);
  const sourceExecution = new FederationCommercialExecutionService(db, f.a.signing, f.market);
  const dueExecution = () =>
    db
      .update(federationReservationProposals)
      .set({ executionNextAt: new Date(0) })
      .where(
        inArray(federationReservationProposals.localSiteId, [
          f.a.signing.siteId,
          f.b.signing.siteId,
        ]),
      );
  const commitMarket = async (provider = false) => {
    for (let i = 0; i < 3; i++) await (provider ? marketProvider : marketSource).advanceNext();
    const [activation] = await db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, f.a.signing.siteId),
          sql`${marketSubmissions.input}->>'operation' = 'activate-demand'`,
          eq(marketSubmissions.state, "committed"),
        ),
      );
    if (activation?.input.operation === "activate-demand") {
      f.state.status = "ACTIVE";
      f.state.version = 3;
      f.state.activation = activation.input.activation;
    }
  };
  const activate = async () => {
    await sourceAutomation.discover();
    await sourceAutomation.advanceNext();
    await commitMarket();
    await dueExecution();
  };
  const confirmations = () =>
    db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, f.a.signing.siteId),
          sql`${marketSubmissions.input}->>'operation' = 'authorize-execution'`,
        ),
      );
  return {
    ...f,
    sourceAutomation,
    providerAutomation,
    sourceExecution,
    confirmation,
    executionUserId,
    marketAdapter,
    marketSource,
    marketProvider,
    commitMarket,
    dueExecution,
    activate,
    confirmations,
  };
}

test("execution automation is opt-in and source activation grants require current market authority", async () => {
  const f = await executionAutomationFixture(false);
  expect(f.sourcePolicy).toMatchObject({
    allowActivation: false,
    allowExecutionConfirmation: false,
  });
  await f.sourceAutomation.discover();
  expect(await f.sourceAutomation.advanceNext()).toBe(false);
  await expect(
    f.sourceExecution.activatePreauthorized(f.sourcePolicy.id, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.confirmation.requestPreauthorized(f.sourcePolicy.id, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await f.sourcePolicies.revoke(f.actor, f.revisionId, f.sourcePolicy.id);
  await expect(
    f.sourcePolicies.grant(f.actor, f.revisionId, { ...f.policyInput, allowActivation: true }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "market.publish", enabled: true },
    f.actor.userId,
  );
  await expect(
    f.policies.grant(f.actor, f.revisionId, { ...f.policyInput, allowActivation: true }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const replacement = await f.sourcePolicies.grant(f.actor, f.revisionId, {
    ...f.policyInput,
    allowActivation: true,
  });
  await expect(
    f.sourceExecution.activatePreauthorized(replacement.id, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("execution automation progresses both sites only after VALID and keeps machine provenance", async () => {
  const f = await executionAutomationFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "market.publish", enabled: false },
    f.actor.userId,
  );
  await f.sourceAutomation.discover();
  await f.providerAutomation.discover();
  await Promise.all([f.sourceAutomation.advanceNext(), f.sourceAutomation.advanceNext()]);
  expect(await f.view()).toMatchObject({
    executionState: "pending",
    confirmationId: null,
    executionError: null,
  });
  const [activation] = await db
    .select()
    .from(marketSubmissions)
    .where(
      and(
        eq(marketSubmissions.localSiteId, f.a.signing.siteId),
        sql`${marketSubmissions.input}->>'operation' = 'activate-demand'`,
      ),
    );
  expect(activation).toMatchObject({
    state: "pending",
    authorizationPolicyId: f.sourcePolicy.id,
    requestedBy: f.actor.userId,
  });
  await f.providerAutomation.advanceNext();
  expect(await f.view(true)).toMatchObject({
    executionState: "pending",
    executionError: null,
    confirmationId: null,
  });
  await f.commitMarket();
  await f.dueExecution();
  await f.sourceAutomation.advanceNext();
  await f.providerAutomation.advanceNext();
  const proof = (await f.confirmations())[0];
  expect(proof).toMatchObject({ state: "pending", authorizationPolicyId: f.sourcePolicy.id });
  expect(await f.view()).toMatchObject({ executionState: "pending" });
  await f.commitMarket();
  await f.commitMarket(true);
  await f.dueExecution();
  await f.sourceAutomation.advanceNext();
  await f.providerAutomation.advanceNext();
  expect(await f.view()).toMatchObject({ executionState: "complete" });
  expect(await f.view(true)).toMatchObject({ executionState: "complete" });
  expect(await f.sourceAutomation.advanceNext()).toBe(false);
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actor, `reservation-policy:${f.sourcePolicy.id}`),
        eq(auditLog.action, "federation.execution.confirm"),
      ),
    );
  expect(audits).toHaveLength(1);
  expect(
    (
      await db
        .select()
        .from(federationReservationPolicies)
        .where(eq(federationReservationPolicies.id, f.sourcePolicy.id))
    )[0],
  ).toMatchObject({ authorizedTasks: 1, authorizedAmount: "60" });
});

test("execution automation activation is idempotent and can reuse an explicit human activation", async () => {
  const f = await executionAutomationFixture();
  const manualId = randomUUID();
  await f.sourceExecution.activate(f.actor, f.revisionId, f.reservation.reservationId, manualId);
  const [one, two] = await Promise.all([
    f.sourceExecution.activatePreauthorized(f.sourcePolicy.id, f.reservation.reservationId),
    f.sourceExecution.activatePreauthorized(f.sourcePolicy.id, f.reservation.reservationId),
  ]);
  expect(one.id).toBe(manualId);
  expect(two.id).toBe(manualId);
  const [record] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, manualId));
  expect(record?.authorizationPolicyId).toBeNull();
  expect(await f.confirmations()).toHaveLength(0);
});

test("execution automation rechecks policy revocation after confirmation query and retains earlier activation", async () => {
  const f = await executionAutomationFixture();
  await f.activate();
  f.beforeClaim(async () => {
    await f.sourcePolicies.revoke(f.actor, f.revisionId, f.sourcePolicy.id);
  });
  await f.sourceAutomation.advanceNext();
  expect(await f.view()).toMatchObject({
    executionState: "needs_review",
    executionError: "POLICY_DENIED",
    confirmationId: null,
  });
  expect(await f.confirmations()).toHaveLength(0);
  const activationId = (await f.view())?.activationId;
  const [activation] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, activationId ?? ""));
  expect(activation?.state).toBe("committed");
});

test("execution automation stops on a local fence or expired policy without new market intents", async () => {
  const f = await executionAutomationFixture();
  await f.sourceAutomation.discover();
  await db
    .update(executionApprovals)
    .set({
      stopId: randomUUID(),
      stopRequestedBy: f.actor.userId,
      stopRequestedAt: new Date(),
      stopNextAttemptAt: new Date(),
    })
    .where(eq(executionApprovals.localSiteId, f.a.signing.siteId));
  await f.sourceAutomation.advanceNext();
  expect(await f.view()).toMatchObject({
    executionState: "needs_review",
    executionError: "CANCELLATION_REQUESTED",
    activationId: null,
  });
  await f.providerAutomation.discover();
  await db
    .update(federationReservationPolicies)
    .set({ validFrom: new Date(Date.now() - 20000), validUntil: new Date(Date.now() - 10000) })
    .where(eq(federationReservationPolicies.id, f.targetPolicy.id));
  await f.providerAutomation.advanceNext();
  expect(await f.view(true)).toMatchObject({
    executionState: "needs_review",
    executionError: "AUTHORIZATION_EXPIRED",
    confirmationId: null,
  });
});

test("execution automation does not create a replacement for an INVALID market transaction", async () => {
  const f = await executionAutomationFixture();
  f.marketAdapter.outcome = "invalid";
  await f.sourceAutomation.discover();
  await f.sourceAutomation.advanceNext();
  await f.commitMarket();
  await f.dueExecution();
  await f.sourceAutomation.advanceNext();
  expect(await f.view()).toMatchObject({
    executionState: "needs_review",
    executionError: "LEDGER_INVALID",
    confirmationId: null,
  });
  const id = (await f.view())?.activationId;
  expect(await f.sourceAutomation.advanceNext()).toBe(false);
  await f.sourceAutomation.retry(f.actor, f.revisionId, f.reservation.reservationId);
  await f.sourceAutomation.advanceNext();
  expect(await f.view()).toMatchObject({ executionState: "needs_review", activationId: id });
});

test("execution automation will not bypass unresolved confirmation work or mark unproven commit complete", async () => {
  const f = await executionAutomationFixture();
  await f.activate();
  const proof = await f.confirmation.requestPreauthorized(
    f.sourcePolicy.id,
    f.reservation.reservationId,
  );
  const [record] = await f.confirmations();
  if (record?.input.operation !== "authorize-execution") throw new Error("Missing confirmation");
  const input = {
    ...record.input,
    authorization: {
      ...record.input.authorization,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    },
  };
  await db
    .update(marketSubmissions)
    .set({ input, digest: federationMaterialDigest(input) })
    .where(eq(marketSubmissions.id, proof.id));
  expect(
    (await f.confirmation.requestPreauthorized(f.sourcePolicy.id, f.reservation.reservationId)).id,
  ).toBe(proof.id);
  await db
    .update(marketSubmissions)
    .set({ state: "needs_review", lastError: "LEDGER_INVALID" })
    .where(eq(marketSubmissions.id, proof.id));
  await expect(
    f.confirmation.requestPreauthorized(f.sourcePolicy.id, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "LEDGER_INVALID", needsReview: true });
  expect(await f.confirmations()).toHaveLength(1);
  await db
    .update(marketSubmissions)
    .set({ state: "committed", lastError: null, input: record.input, digest: record.digest })
    .where(eq(marketSubmissions.id, proof.id));
  await f.sourceAutomation.advanceNext();
  expect(await f.view()).toMatchObject({
    executionState: "needs_review",
    executionError: "INVALID_ADAPTER_RESPONSE",
  });
});

test("execution automation respects receiver identity revocation and explicit scope", async () => {
  const f = await executionAutomationFixture();
  await f.activate();
  await f.providerAutomation.discover();
  await db.update(users).set({ suspended: true }).where(eq(users.id, f.executionUserId));
  await f.providerAutomation.advanceNext();
  expect((await f.view(true))?.executionState).toBe("needs_review");
  expect((await f.view(true))?.confirmationId).toBeNull();
  await expect(
    f.sourceAutomation.retry(
      { ...f.actor, orgId: randomUUID() },
      f.revisionId,
      f.reservation.reservationId,
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.sourceExecution.activatePreauthorized(f.targetPolicy.id, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("execution automation lease loss around network query cannot issue a late confirmation", async () => {
  const f = await executionAutomationFixture();
  await f.activate();
  f.beforeClaim(async () => {
    await expect(
      f.sourceAutomation.retry(f.actor, f.revisionId, f.reservation.reservationId),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await db
      .update(federationReservationProposals)
      .set({ executionLeaseUntil: new Date(0) })
      .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
    await f.sourceAutomation.retry(f.actor, f.revisionId, f.reservation.reservationId);
  });
  await f.sourceAutomation.advanceNext();
  expect(await f.confirmations()).toHaveLength(0);
  expect(await f.view()).toMatchObject({
    executionState: "pending",
    executionError: null,
    executionLeaseToken: null,
  });
  f.beforeClaim(async () => {});
  await f.sourceAutomation.advanceNext();
  expect(await f.confirmations()).toHaveLength(1);
});

test("execution automation audit failure rolls back activation before progress can advance", async () => {
  const f = await executionAutomationFixture();
  await f.sourceAutomation.discover();
  await db.execute(
    sql`alter table audit_log add constraint test_activation_policy_audit check (action <> 'federation.commercial.execution.activate' OR actor <> ${sql.raw(`'reservation-policy:${f.sourcePolicy.id}'`)})`,
  );
  try {
    await f.sourceAutomation.advanceNext();
    expect(await f.view()).toMatchObject({ executionState: "pending", activationId: null });
    const records = await db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, f.a.signing.siteId),
          sql`${marketSubmissions.input}->>'operation' = 'activate-demand'`,
        ),
      );
    expect(records).toHaveLength(0);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_activation_policy_audit`);
  }
  await f.dueExecution();
  await f.sourceAutomation.advanceNext();
  expect((await f.view())?.activationId).not.toBeNull();
});

test("execution automation activation-only policy finishes without authorizing execution", async () => {
  const f = await executionAutomationFixture("activation");
  await f.activate();
  await f.sourceAutomation.advanceNext();
  expect(await f.view()).toMatchObject({ executionState: "complete", confirmationId: null });
  expect(await f.confirmations()).toHaveLength(0);
  await f.providerAutomation.discover();
  expect(await f.providerAutomation.advanceNext()).toBe(false);
  await expect(
    db.transaction((tx) => f.confirmation.authorize(tx, f.actor.orgId, f.reservation.request)),
  ).rejects.toMatchObject({ code: "LEDGER_PENDING" });
});

test("execution automation confirmation-only policy waits for independent activation", async () => {
  const f = await executionAutomationFixture("confirmation");
  await f.sourceAutomation.discover();
  await f.sourceAutomation.advanceNext();
  expect(await f.view()).toMatchObject({
    executionState: "pending",
    activationId: null,
    confirmationId: null,
  });
  const activation = await f.sourceExecution.activate(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    randomUUID(),
  );
  await f.commitMarket();
  await f.dueExecution();
  await f.sourceAutomation.advanceNext();
  await f.commitMarket();
  await f.dueExecution();
  await f.sourceAutomation.advanceNext();
  expect(await f.view()).toMatchObject({ executionState: "complete", activationId: null });
  expect((await f.confirmations())[0]?.authorizationPolicyId).toBe(f.sourcePolicy.id);
  const [manual] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, activation.id));
  expect(manual?.authorizationPolicyId).toBeNull();
});

test("execution automation HTTP retry requires current human authority and preserves completed progress", async () => {
  const f = await executionAutomationFixture("activation");
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let automated = false;
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    c.set("automation" as never, automated as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      f.sourceExecution,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.sourcePolicies,
      f.source,
      f.sourceAutomation,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/reservation-proposals/${f.reservation.reservationId}/execution-retry`;
  const post = (body: unknown = {}, route = path) =>
    app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  automated = true;
  expect((await post()).status).toBe(403);
  automated = false;
  expect((await post({ policyId: randomUUID() })).status).toBe(400);
  expect((await post({}, path.replace(f.revisionId, randomUUID()))).status).toBe(409);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  expect((await post()).status).toBe(403);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: true },
    f.actor.userId,
  );
  expect((await post()).status).toBe(200);
  await f.activate();
  await f.sourceAutomation.advanceNext();
  expect((await post()).status).toBe(409);
  expect(await f.view()).toMatchObject({ executionState: "complete" });
});

async function marketRequestFixture(
  enabled = true,
  limit = 2,
  workflow = false,
  guards?: {
    source: Pick<FederationStorageGuard, "assertAdmission">;
    target: Pick<FederationStorageGuard, "assertAdmission">;
  },
) {
  const f = await reservationPolicyFixture(true, undefined, workflow);
  await db
    .delete(marketSubmissions)
    .where(inArray(marketSubmissions.localSiteId, [f.a.signing.siteId, f.b.signing.siteId]));
  for (const capability of ["delegation.submit", "market.publish", "market.claim"] as const)
    await new FederationPermissionService(db).set(
      { ...f.actor, capability, enabled: true },
      f.actor.userId,
    );
  const sourcePolicies = new FederationReservationPolicyService(db, f.a.signing.siteId);
  const sourcePolicy = await sourcePolicies.grant(f.actor, f.revisionId, {
    ...f.policyInput,
    maxTasks: limit,
    allowMarketPublish: enabled,
    allowActivation: workflow,
    allowExecutionConfirmation: workflow,
  });
  const providerPolicy = await f.policies.grant(f.actor, f.revisionId, {
    ...f.policyInput,
    maxTasks: limit,
    allowMarketClaim: enabled,
    allowExecutionConfirmation: workflow,
  });
  const fingerprints: string[] = [];
  for (const party of [f.a, f.b]) {
    const fingerprint = randomBytes(32).toString("hex");
    fingerprints.push(fingerprint);
    await db.insert(federationCertificates).values({
      siteId: party.signing.siteId,
      fingerprint,
      certificatePem: "fixture; real transport covered separately",
      validFrom: new Date("2020-01-01"),
      validUntil: new Date("2099-01-01"),
    });
    const [key] = await db
      .select()
      .from(federationSigningKeys)
      .where(eq(federationSigningKeys.siteId, party.signing.siteId));
    if (!key) throw new Error("Missing key");
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: [
          ...key.allowedKinds,
          "market-request",
          "market-request-receipt",
          "reservation-proposal-receipt",
        ],
      })
      .where(eq(federationSigningKeys.siteId, party.signing.siteId));
  }
  const request = MarketRequestSchema.parse({
    protocolVersion: 1,
    kind: "market-request",
    demand: { ...f.state.demand, expiresAt: f.reservation.request.expiresAt },
    proposal: {
      ...f.reservation,
      request: { ...f.reservation.request, operationId: f.reservation.reservationId },
    },
  });
  let state: z.infer<typeof MarketDemandStateSchema> | null = null;
  let queryHook: (() => Promise<void>) | undefined;
  const query: Pick<MarketClient, "query"> = {
    query: async () => {
      await queryHook?.();
      return { operation: "get-demand", demand: state };
    },
  };
  const adapter = new ActivationAdapter();
  const sourceMarket = new FederationMarketService(db, f.a.signing.siteId, adapter),
    providerMarket = new FederationMarketService(db, f.b.signing.siteId, adapter);
  const target = new FederationMarketRequestService(
    db,
    f.b.signing,
    undefined,
    query,
    guards?.target,
  );
  let sendHook: ((jws: string, response: string) => Promise<string>) | undefined;
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/market-requests");
    const result = await target.receive(jws, fingerprints[0] ?? "");
    return sendHook ? sendHook(jws, result) : result;
  };
  const source = new FederationMarketRequestService(db, f.a.signing, send, query, guards?.source);
  const view = async (provider = false) =>
    (
      await db
        .select()
        .from(federationMarketRequests)
        .where(
          eq(
            federationMarketRequests.localSiteId,
            provider ? f.b.signing.siteId : f.a.signing.siteId,
          ),
        )
    )[0];
  const due = () =>
    db
      .update(federationMarketRequests)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        inArray(federationMarketRequests.localSiteId, [f.a.signing.siteId, f.b.signing.siteId]),
      );
  const commit = async (provider = false) => {
    const service = provider ? providerMarket : sourceMarket;
    for (let i = 0; i < 3; i++) await service.advanceNext();
    const [row] = await db
      .select()
      .from(marketSubmissions)
      .where(
        and(
          eq(marketSubmissions.localSiteId, provider ? f.b.signing.siteId : f.a.signing.siteId),
          eq(marketSubmissions.state, "committed"),
        ),
      );
    if (row?.input.operation === "publish-demand")
      state = MarketDemandStateSchema.parse({
        demand: row.input.demand,
        digest: federationMaterialDigest(row.input.demand),
        version: 1,
        status: "OPEN",
        claim: null,
        cancellation: null,
      });
    if (row?.input.operation === "claim-demand")
      state = MarketDemandStateSchema.parse({
        demand: request.demand,
        digest: federationMaterialDigest(request.demand),
        version: 2,
        status: "CLAIMED",
        claim: row.input.claim,
        cancellation: null,
      });
    await due();
  };
  const submit = (raw = request) => source.submit(f.actor, f.revisionId, sourcePolicy.id, raw);
  const publish = async () => {
    await submit();
    await source.advanceNext();
    await commit();
  };
  const deliver = async () => {
    await publish();
    await source.advanceNext();
  };
  const claim = async () => {
    await deliver();
    await target.advanceNext();
    await commit(true);
    await target.advanceNext();
    await due();
  };
  const receiverProposals = new FederationReservationProposalService(
    db,
    f.b.signing,
    undefined,
    query,
    guards?.target,
  );
  const proposalSend: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/reservation-proposals");
    return receiverProposals.receive(jws, fingerprints[0] ?? "");
  };
  const sourceProposals = new FederationReservationProposalService(
    db,
    f.a.signing,
    proposalSend,
    query,
    guards?.source,
  );
  return {
    ...f,
    sourcePolicies,
    sourcePolicy,
    providerPolicy,
    request,
    query,
    adapter,
    commercialAdapter: f.adapter,
    sourceMarket,
    providerMarket,
    source,
    target,
    view,
    due,
    commit,
    submit,
    publish,
    deliver,
    claim,
    fingerprints,
    send,
    sourceProposals,
    receiverProposals,
    state: () => state,
    setState: (value: typeof state) => {
      state = value;
    },
    beforeQuery: (fn: typeof queryHook) => {
      queryHook = fn;
    },
    afterSend: (fn: typeof sendHook) => {
      sendHook = fn;
    },
  };
}

test("market request permissions are opt-in and publishing/claim grants belong to their own institution", async () => {
  const f = await marketRequestFixture(false);
  await expect(f.submit()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await f.sourcePolicies.revoke(f.actor, f.revisionId, f.sourcePolicy.id);
  await f.policies.revoke(f.actor, f.revisionId, f.providerPolicy.id);
  await expect(
    f.sourcePolicies.grant(f.actor, f.revisionId, { ...f.policyInput, allowMarketClaim: true }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.policies.grant(f.actor, f.revisionId, { ...f.policyInput, allowMarketPublish: true }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  for (const capability of ["market.publish", "market.claim"] as const)
    await new FederationPermissionService(db).set(
      { ...f.actor, capability, enabled: false },
      f.actor.userId,
    );
  await expect(
    f.sourcePolicies.grant(f.actor, f.revisionId, { ...f.policyInput, allowMarketPublish: true }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.policies.grant(f.actor, f.revisionId, { ...f.policyInput, allowMarketClaim: true }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});
test("market request production worker publishes only public demand and hands off after real VALID checkpoints", async () => {
  const f = await marketRequestFixture();
  await Promise.all([f.submit(), f.submit()]);
  const worker = new FederationCommercialWorker(
    f.service,
    undefined,
    undefined,
    undefined,
    f.sourceMarket,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    f.source,
  );
  await worker.tick();
  await worker.stop();
  await f.commit();
  await f.source.advanceNext();
  expect(await f.view(true)).toMatchObject({ state: "pending", marketSubmissionId: null });
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(inArray(executionApprovals.localSiteId, [f.a.signing.siteId, f.b.signing.siteId])),
  ).toHaveLength(0);
  await f.target.advanceNext();
  expect((await f.view(true))?.state).toBe("pending");
  await f.commit(true);
  await f.target.advanceNext();
  await f.due();
  for (const capability of ["delegation.submit", "market.publish", "market.claim"] as const)
    await new FederationPermissionService(db).set(
      { ...f.actor, capability, enabled: false },
      f.actor.userId,
    );
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("complete");
  expect((await f.view(true))?.state).toBe("complete");
  const [proposal] = await db
    .select()
    .from(federationReservationProposals)
    .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
  expect(proposal).toMatchObject({
    policyId: f.sourcePolicy.id,
    state: "pending",
    requestedBy: f.actor.userId,
  });
  await f.sourceProposals.advanceNext();
  await f.sourceProposals.advanceNext();
  await f.receiverProposals.advanceNext();
  const approved = await db
    .select()
    .from(executionApprovals)
    .where(inArray(executionApprovals.localSiteId, [f.a.signing.siteId, f.b.signing.siteId]));
  expect(approved).toHaveLength(2);
  expect(approved.every((r) => r.authorizationPolicyId)).toBe(true);
  const inputs = f.adapter.inputs;
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toEqual({ operation: "publish-demand", demand: f.request.demand });
  expect(JSON.stringify(inputs)).not.toContain(f.request.proposal.agreementDigest);
  expect(JSON.stringify(inputs)).not.toContain('"maxAmount"');
  expect(JSON.stringify(inputs)).not.toContain('"request"');
  const policy = (await f.sourcePolicies.list(f.actor, f.revisionId))[0];
  expect(policy).toMatchObject({
    marketAuthorizedTasks: 1,
    marketAuthorizedAmount: "60",
    authorizedTasks: 1,
    authorizedAmount: "60",
  });
});
test("market request reception is durable only and duplicate signed delivery cannot create claims", async () => {
  const f = await marketRequestFixture();
  await f.deliver();
  const row = await f.view();
  if (!row?.sourceJws) throw new Error("Missing request");
  await Promise.all([
    f.target.receive(row.sourceJws, f.fingerprints[0] ?? ""),
    f.target.receive(row.sourceJws, f.fingerprints[0] ?? ""),
  ]);
  expect((await f.view(true))?.marketSubmissionId).toBeNull();
  const [policy] = await f.policies.list(f.actor, f.revisionId);
  expect(policy).toMatchObject({
    marketAuthorizedTasks: 1,
    marketAuthorizedAmount: "60",
    authorizedTasks: 0,
  });
});
test("market request amount and count authority remain bounded under concurrent distinct tasks", async () => {
  const f = await marketRequestFixture(true, 1);
  const id = randomUUID(),
    demandId = randomUUID();
  const second = MarketRequestSchema.parse({
    ...f.request,
    demand: { ...f.request.demand, demandId },
    proposal: {
      ...f.request.proposal,
      reservationId: id,
      demandId,
      request: { ...f.request.proposal.request, operationId: id },
    },
  });
  const result = await Promise.allSettled([f.submit(), f.submit(second)]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const g = await marketRequestFixture();
  await g.submit();
  const nextId = randomUUID(),
    nextDemand = randomUUID();
  const next = MarketRequestSchema.parse({
    ...g.request,
    demand: { ...g.request.demand, demandId: nextDemand },
    proposal: {
      ...g.request.proposal,
      reservationId: nextId,
      demandId: nextDemand,
      request: { ...g.request.proposal.request, operationId: nextId },
    },
  });
  await expect(g.submit(next)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect((await g.sourcePolicies.list(g.actor, g.revisionId))[0]).toMatchObject({
    marketAuthorizedTasks: 1,
    marketAuthorizedAmount: "60",
    authorizedTasks: 0,
  });
});
test("market request policy bounds original template resources and contract before public disclosure", async () => {
  const f = await marketRequestFixture();
  const cpus = 100;
  const altered = MarketRequestSchema.parse({
    ...f.request,
    demand: { ...f.request.demand, resources: { ...f.request.demand.resources, cpus } },
    proposal: {
      ...f.request.proposal,
      request: {
        ...f.request.proposal.request,
        resources: { ...f.request.proposal.request.resources, cpus },
      },
    },
  });
  await expect(f.submit(altered)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.submit({ ...f.request, proposal: { ...f.request.proposal, domainId: randomUUID() } }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    f.submit({
      ...f.request,
      proposal: {
        ...f.request.proposal,
        request: {
          ...f.request.proposal.request,
          template: { ...f.request.proposal.request.template, revision: "other" },
        },
      },
    }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(await f.view()).toBeUndefined();
});
test("market request rejects another claimant or modified public demand without preparing a new transaction", async () => {
  for (const change of ["claimant", "demand"] as const) {
    const f = await marketRequestFixture();
    await f.deliver();
    const state = f.state();
    if (!state) throw new Error("Missing state");
    f.setState(
      change === "claimant"
        ? MarketDemandStateSchema.parse({
            ...state,
            status: "CLAIMED",
            version: 2,
            claim: {
              demandId: f.request.demand.demandId,
              claimId: randomUUID(),
              providerSiteId: randomUUID(),
              expectedVersion: 1,
              expiresAt: f.request.proposal.request.expiresAt,
            },
          })
        : { ...state, demand: { ...state.demand, title: "changed" } },
    );
    await f.target.advanceNext();
    expect((await f.view(true))?.state).toBe("needs_review");
    expect(f.adapter.inputs).toHaveLength(1);
  }
});
test("market request cannot substitute INVALID or unknown publish transactions with fresh requests", async () => {
  const f = await marketRequestFixture();
  await f.submit();
  await f.source.advanceNext();
  f.adapter.outcome = "invalid";
  await f.commit();
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("needs_review");
  await f.source.retry(f.actor, f.revisionId, f.request.proposal.reservationId);
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("needs_review");
  expect(f.adapter.inputs).toHaveLength(1);
  expect(await f.view(true)).toBeUndefined();
  const g = await marketRequestFixture();
  await g.submit();
  await g.source.advanceNext();
  g.adapter.outcome = "pending";
  await g.commit();
  await g.source.advanceNext();
  expect((await g.view())?.state).toBe("pending");
  expect(await g.view(true)).toBeUndefined();
  expect(g.adapter.inputs).toHaveLength(1);
});
test("market request refuses unproven committed state and a forged claimed receipt", async () => {
  const f = await marketRequestFixture();
  await f.submit();
  await f.source.advanceNext();
  await db
    .update(marketSubmissions)
    .set({ state: "committed" })
    .where(eq(marketSubmissions.localSiteId, f.a.signing.siteId));
  await f.due();
  await f.source.advanceNext();
  expect((await f.view())?.lastError).toBe("INVALID_ADAPTER_RESPONSE");
  const g = await marketRequestFixture();
  await g.publish();
  g.afterSend(async (_jws, response) => {
    const peer = await new FederationTrustRegistry(db).resolveKey(
      g.b.signing.siteId,
      federationMessageKeyId(response),
      new Date(),
    );
    const v = await verifyFederationMessage(MarketRequestReceiptSchema, response, peer, new Date());
    return signFederationMessage(
      MarketRequestReceiptSchema,
      { ...v.payload, state: "claimed" },
      g.b.signing,
    );
  });
  await g.source.advanceNext();
  expect(await g.view()).toMatchObject({ state: "pending", lastError: null });
  expect(
    await db
      .select()
      .from(federationReservationProposals)
      .where(eq(federationReservationProposals.localSiteId, g.a.signing.siteId)),
  ).toHaveLength(0);
});
test("market request checks provider policy and original certificate again after chain query", async () => {
  for (const change of ["policy", "certificate"] as const) {
    const f = await marketRequestFixture();
    await f.deliver();
    f.beforeQuery(async () => {
      if (change === "policy") await f.policies.revoke(f.actor, f.revisionId, f.providerPolicy.id);
      else
        await db
          .update(federationCertificates)
          .set({ revokedAt: new Date() })
          .where(eq(federationCertificates.fingerprint, f.fingerprints[0] ?? ""));
    });
    await f.target.advanceNext();
    expect((await f.view(true))?.state).toBe("needs_review");
    expect((await f.view(true))?.marketSubmissionId).toBeNull();
  }
});
test("market request source rechecks policy, endpoint and receipt binding before reservation handoff", async () => {
  for (const change of ["policy", "endpoint", "receipt"] as const) {
    const f = await marketRequestFixture();
    await f.claim();
    f.afterSend(async (_jws, response) => {
      if (change === "policy")
        await f.sourcePolicies.revoke(f.actor, f.revisionId, f.sourcePolicy.id);
      if (change === "endpoint")
        await db
          .update(federationSites)
          .set({ endpoint: "https://changed.invalid" })
          .where(eq(federationSites.id, f.b.signing.siteId));
      if (change === "receipt") {
        const peer = await new FederationTrustRegistry(db).resolveKey(
          f.b.signing.siteId,
          federationMessageKeyId(response),
          new Date(),
        );
        const v = await verifyFederationMessage(
          MarketRequestReceiptSchema,
          response,
          peer,
          new Date(),
        );
        return signFederationMessage(
          MarketRequestReceiptSchema,
          { ...v.payload, reservationId: randomUUID() },
          f.b.signing,
        );
      }
      return response;
    });
    await f.source.advanceNext();
    const result = await f.view();
    expect({ change, state: result?.state, error: result?.lastError }).toMatchObject({
      change,
      state: "needs_review",
    });
    expect(
      await db
        .select()
        .from(federationReservationProposals)
        .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId)),
    ).toHaveLength(0);
  }
});
test("market request lease fencing rejects late claim insertion and late source success or failure", async () => {
  const f = await marketRequestFixture();
  await f.deliver();
  f.beforeQuery(async () => {
    await expect(
      f.target.retry(f.actor, f.revisionId, f.request.proposal.reservationId),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await db
      .update(federationMarketRequests)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationMarketRequests.localSiteId, f.b.signing.siteId));
    await f.target.retry(f.actor, f.revisionId, f.request.proposal.reservationId);
  });
  await f.target.advanceNext();
  expect((await f.view(true))?.marketSubmissionId).toBeNull();
  for (const fail of [false, true]) {
    const g = await marketRequestFixture();
    await g.claim();
    g.afterSend(async (_jws, response) => {
      await db
        .update(federationMarketRequests)
        .set({ leaseUntil: new Date(0) })
        .where(eq(federationMarketRequests.localSiteId, g.a.signing.siteId));
      await g.source.retry(g.actor, g.revisionId, g.request.proposal.reservationId);
      if (fail) throw new Error("late network failure");
      return response;
    });
    await g.source.advanceNext();
    expect(await g.view()).toMatchObject({ state: "pending", lastError: null });
    expect(
      await db
        .select()
        .from(federationReservationProposals)
        .where(eq(federationReservationProposals.localSiteId, g.a.signing.siteId)),
    ).toHaveLength(0);
    g.afterSend(undefined);
    await g.source.advanceNext();
    expect((await g.view())?.state).toBe("complete");
  }
});
test("market request lost reply and restarted source preserve one request and one institutional charge", async () => {
  const f = await marketRequestFixture();
  await f.publish();
  f.afterSend(async () => {
    throw new Error("lost reply");
  });
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("pending");
  expect((await f.view(true))?.state).toBe("pending");
  await f.target.advanceNext();
  await f.commit(true);
  await f.target.advanceNext();
  await f.due();
  f.afterSend(undefined);
  const restart = new FederationMarketRequestService(db, f.a.signing, f.send, f.query);
  await restart.advanceNext();
  expect((await f.view())?.state).toBe("complete");
  expect(f.adapter.inputs).toHaveLength(2);
  expect((await f.policies.list(f.actor, f.revisionId))[0]?.marketAuthorizedTasks).toBe(1);
});
test("market request handoff audit failure rolls back proposal and completion together", async () => {
  const f = await marketRequestFixture();
  await f.claim();
  await db.execute(
    sql`alter table audit_log add constraint test_market_request_audit check (action <> 'federation.reservation_proposal.submit' OR target <> ${sql.raw(`'${f.request.proposal.reservationId}'`)})`,
  );
  try {
    await f.source.advanceNext();
    expect((await f.view())?.state).toBe("pending");
    expect(
      await db
        .select()
        .from(federationReservationProposals)
        .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_market_request_audit`);
  }
  await f.due();
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("complete");
});
test("market request HTTP validates human and organization scope, hides private fields and protects completed retry", async () => {
  const f = await marketRequestFixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let automated = false;
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    c.set("automation" as never, automated as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.source,
    ),
  );
  const path = `/federation/commercial-agreements/${f.revisionId}/market-requests`;
  const post = (body: unknown, route = path) =>
    app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = { policyId: f.sourcePolicy.id, request: f.request };
  automated = true;
  expect((await post(body)).status).toBe(403);
  automated = false;
  expect((await post({ ...body, approvedBy: f.actor.userId })).status).toBe(400);
  expect((await post(body)).status).toBe(202);
  expect((await post(body, path.replace(f.revisionId, randomUUID()))).status).toBe(403);
  const response = await app.request(path);
  expect(response.status).toBe(200);
  const data = JSON.stringify(await response.json());
  for (const key of ['"sourceJws"', '"leaseToken"', '"payload"']) expect(data).not.toContain(key);
  await f.claim();
  await f.source.advanceNext();
  expect((await post({}, `${path}/${f.request.proposal.reservationId}/retry`)).status).toBe(409);
  const ingress = createFederationIngress(db, f.b.signing);
  expect(
    (await ingress.request("/federation/v1/market-requests", { method: "POST", body: "bad" }))
      .status,
  ).toBe(415);
});

test("market request conflicting demand identity returns a domain conflict without losing the original intent", async () => {
  const f = await marketRequestFixture();
  const original = MarketRequestSchema.parse({
    ...f.request,
    proposal: { ...f.request.proposal, request: { ...f.request.proposal.request, maxAmount: "1" } },
  });
  await f.submit(original);
  const id = randomUUID();
  const conflicting = MarketRequestSchema.parse({
    ...original,
    proposal: {
      ...original.proposal,
      reservationId: id,
      request: { ...original.proposal.request, operationId: id },
    },
  });
  await expect(f.submit(conflicting)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  const sourceJws = await signFederationMessage(MarketRequestSchema, original, f.a.signing);
  await f.target.receive(sourceJws, f.fingerprints[0] ?? "");
  const conflictJws = await signFederationMessage(MarketRequestSchema, conflicting, f.a.signing);
  await expect(f.target.receive(conflictJws, f.fingerprints[0] ?? "")).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]).toMatchObject({
    marketAuthorizedTasks: 1,
    marketAuthorizedAmount: "1",
  });
  expect((await f.policies.list(f.actor, f.revisionId))[0]).toMatchObject({
    marketAuthorizedTasks: 1,
    marketAuthorizedAmount: "1",
  });
});

async function workflowMarketFixture() {
  const f = await marketRequestFixture(true, 2, true);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "delegation.read", enabled: true },
    f.actor.userId,
  );
  const ordinarySource = new FederationAgreementService(db, f.a.signing);
  const ordinaryProvider = new FederationAgreementService(db, f.b.signing);
  const executionUserId = randomUUID();
  await db.insert(users).values({
    id: executionUserId,
    orgId: f.actor.orgId,
    email: `${executionUserId}@test.invalid`,
    role: "user",
    serviceAccount: true,
  });
  await db
    .insert(userOrgMemberships)
    .values({ userId: executionUserId, orgId: f.actor.orgId, role: "member" });
  const sourceConsent = await ordinarySource.approve(f.actor, { terms: f.terms.agreement });
  const providerConsent = await ordinaryProvider.approve(f.actor, {
    terms: f.terms.agreement,
    executionUserId,
  });
  await ordinarySource.attachCounterparty(f.actor, f.revisionId, providerConsent.approvalJws);
  await ordinaryProvider.attachCounterparty(f.actor, f.revisionId, sourceConsent.approvalJws);
  const runId = randomUUID();
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Coordinated source workflow",
    status: "running",
    submittedBy: f.actor.userId,
    startedAt: new Date(),
    input: { executionModel: "durable-v2", orgId: f.actor.orgId, role: "user", yaml: "" },
  });
  let lease = await new WorkflowExecutionJournalStore(db).acquire(runId, 300000);
  if (!lease) throw new Error("Missing workflow lease");
  const sourceConfirmation = new FederationExecutionConfirmationService(
    db,
    f.a.signing.siteId,
    f.query,
  );
  const providerConfirmation = new FederationExecutionConfirmationService(
    db,
    f.b.signing.siteId,
    f.query,
  );
  const admission = new FederationAdmission(
    db,
    f.b.signing,
    f.b.verification,
    undefined,
    providerConfirmation,
  );
  const send: FederationSend = async (_endpoint, requestJws, path) => {
    expect(path).toBeUndefined();
    return (
      await admission.receive({
        requestJws,
        authenticatedPeerSiteId: f.a.signing.siteId,
        senderKey: f.a.verification,
      })
    ).receiptJws;
  };
  const outbound = new FederationOutboundService(
    db,
    f.a.signing,
    send,
    f.assets,
    undefined,
    sourceConfirmation,
    f.source,
  );
  const executor = new FederationWorkflowExecutor(db, f.a.signing.siteId, outbound);
  const node = workflowDsl.WorkflowNodeSchema.parse({
    id: "remote",
    name: "Remote task",
    type: "Federation",
    agreementRevisionId: f.revisionId,
    template: f.request.proposal.request.template,
    inputManifestDigest: f.request.proposal.request.inputManifestDigest,
    environmentLockDigest: f.request.proposal.request.environmentLockDigest,
    resources: f.request.proposal.request.resources,
    maxAmount: f.request.proposal.request.maxAmount,
    admissionWindowSec: 600,
    executionExpiresAt: f.request.proposal.request.executionExpiresAt,
    market: { policyId: f.sourcePolicy.id, title: "Public approved task", description: "" },
    inputSlots: [],
    outputs: [],
  });
  if (node.type !== "Federation") throw new Error("Wrong node");
  const invocation = { path: JSON.stringify(["node", "remote"]) };
  const execute = () => {
    if (!lease) throw new Error("Missing lease");
    return executor.execute(f.actor, lease, node, invocation);
  };
  const prepare = async () => {
    await expect(execute()).rejects.toMatchObject({ reason: "LEDGER_WAITING" });
    const original = await f.view();
    if (!original) throw new Error("Missing market request");
    Object.assign(f.request, original.payload);
    return original;
  };
  const marketAndSignatures = async () => {
    await f.source.advanceNext();
    await f.commit();
    await f.source.advanceNext();
    await f.target.advanceNext();
    await f.commit(true);
    await f.target.advanceNext();
    await f.due();
    await f.source.advanceNext();
    await f.sourceProposals.advanceNext();
    await f.sourceProposals.advanceNext();
    await f.receiverProposals.advanceNext();
    const exchange = await approvalTransport({ ...f, adapter: f.commercialAdapter });
    await exchange.a.discover();
    await exchange.b.discover();
    await exchange.a.advanceNext();
    await exchange.b.advanceNext();
    const providerCommercial = new FederationCommercialSubmissionService(
      db,
      f.b.signing.siteId,
      f.commercialAdapter,
    );
    for (let i = 0; i < 6; i++) {
      await f.service.advanceNext();
      await providerCommercial.advanceNext();
    }
  };
  const sourceAutomation = new FederationExecutionAutomation(db, f.a.signing, f.query);
  const providerAutomation = new FederationExecutionAutomation(db, f.b.signing, f.query);
  const dueExecution = () =>
    db
      .update(federationReservationProposals)
      .set({ executionNextAt: new Date(0) })
      .where(
        inArray(federationReservationProposals.localSiteId, [
          f.a.signing.siteId,
          f.b.signing.siteId,
        ]),
      );
  const activate = async () => {
    await sourceAutomation.discover();
    await providerAutomation.discover();
    await sourceAutomation.advanceNext();
    for (let i = 0; i < 3; i++) await f.sourceMarket.advanceNext();
    const activation = f.adapter.inputs.find((i) => i.operation === "activate-demand");
    const state = f.state();
    if (!state || activation?.operation !== "activate-demand")
      throw new Error("Missing activation");
    f.setState({ ...state, status: "ACTIVE", version: 3, activation: activation.activation });
    await dueExecution();
  };
  const confirm = async () => {
    await sourceAutomation.advanceNext();
    await providerAutomation.advanceNext();
    for (let i = 0; i < 3; i++) {
      await f.sourceMarket.advanceNext();
      await f.providerMarket.advanceNext();
    }
    await dueExecution();
    await sourceAutomation.advanceNext();
    await providerAutomation.advanceNext();
  };
  return {
    ...f,
    runId,
    node,
    invocation,
    outbound,
    executor,
    execute,
    prepare,
    marketAndSignatures,
    activate,
    confirm,
    sourceAutomation,
    providerAutomation,
    dueExecution,
    sourceConfirmation,
    lease: () => {
      if (!lease) throw new Error("Missing lease");
      return lease;
    },
    restart: async () => {
      await lease?.release();
      lease = await new WorkflowExecutionJournalStore(db).acquire(runId, 300000);
    },
  };
}

test("workflow market coordinates one immutable invocation through VALID permits into ordinary outbound delivery", async () => {
  const f = await workflowMarketFixture();
  const original = await f.prepare();
  expect(original.payload.demand).toMatchObject({
    title: f.node.market?.title,
    platform: "linux",
    architecture: "x86_64",
  });
  expect(original.payload.proposal.reservationId).toBe(
    original.payload.proposal.request.operationId,
  );
  await expect(f.execute()).rejects.toBeInstanceOf(WorkflowNodeWaiting);
  await f.restart();
  await expect(f.execute()).rejects.toMatchObject({ reason: "LEDGER_WAITING" });
  expect((await f.view())?.payload).toEqual(original.payload);
  await f.marketAndSignatures();
  await expect(f.execute()).rejects.toMatchObject({ reason: "LEDGER_WAITING" });
  await f.activate();
  await expect(f.execute()).rejects.toMatchObject({ reason: "LEDGER_WAITING" });
  await f.confirm();
  await expect(f.execute()).rejects.toMatchObject({ reason: "REMOTE_WAITING" });
  expect(await f.outbound.deliverNext()).toBe(true);
  const [sent] = await db
    .select()
    .from(federationOutbound)
    .where(eq(federationOutbound.localSiteId, f.a.signing.siteId));
  expect(sent).toMatchObject({ operationId: original.reservationId, state: "accepted" });
  expect(sent?.receipt?.reservationId).toBe(original.reservationId);
  await f.restart();
  await expect(f.execute()).rejects.toMatchObject({ reason: "REMOTE_WAITING" });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]).toMatchObject({
    marketAuthorizedTasks: 1,
    authorizedTasks: 1,
  });
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
  await f.lease().release();
});

test("workflow market rejects changed publication and raw API bypass, preserving original intent on restart", async () => {
  const f = await workflowMarketFixture();
  const original = await f.prepare();
  await expect(
    f.source.submit(f.actor, f.revisionId, f.sourcePolicy.id, original.payload),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  if (!f.node.market) throw new Error("Missing market selection");
  f.node.market.title = "Changed public title";
  await expect(f.execute()).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  expect((await f.view())?.payload).toEqual(original.payload);
  await f.lease().release();
});

test("workflow market requires explicit coordination configuration and leaves bilateral execution independent", async () => {
  const f = await workflowMarketFixture();
  f.node.market = undefined;
  expect(await f.execute()).toMatchObject({ status: "Failed" });
  expect(await f.view()).toBeUndefined();
  await f.lease().release();
});

test("workflow market expired workflow lease rolls back task intent instead of consuming institutional authority", async () => {
  const f = await workflowMarketFixture();
  await db
    .update(workflowExecutionLeases)
    .set({ expiresAt: new Date(0) })
    .where(eq(workflowExecutionLeases.runId, f.runId));
  await expect(f.execute()).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  expect(await f.view()).toBeUndefined();
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.marketAuthorizedTasks).toBe(0);
  await f.restart();
  await f.prepare();
  await f.lease().release();
});

test("workflow market cancellation before outbound prevents new publication and requires no chain connection", async () => {
  const f = await workflowMarketFixture();
  await f.prepare();
  await db.update(workflowRuns).set({ status: "cancelling" }).where(eq(workflowRuns.id, f.runId));
  f.beforeQuery(async () => {
    throw new Error("Cancelled workflow must not query the chain");
  });
  await f.outbound.cancelWorkflow(f.runId);
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({
    state: "needs_review",
    lastError: "CANCELLATION_REQUESTED",
    marketSubmissionId: null,
  });
  expect(f.adapter.inputs).toHaveLength(0);
  await f.lease().release();
});

test("workflow market cancellation after signature records a local stop before activation without a second human grant", async () => {
  const f = await workflowMarketFixture();
  await f.prepare();
  await f.marketAndSignatures();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  await db.update(workflowRuns).set({ status: "cancelling" }).where(eq(workflowRuns.id, f.runId));
  await f.outbound.cancelWorkflow(f.runId);
  const [approval] = await db
    .select()
    .from(executionApprovals)
    .where(
      and(
        eq(executionApprovals.localSiteId, f.a.signing.siteId),
        eq(executionApprovals.recordId, f.request.proposal.reservationId),
      ),
    );
  expect(approval?.stopId).toBeString();
  await f.sourceAutomation.discover();
  await f.sourceAutomation.advanceNext();
  expect(f.adapter.inputs.some((i) => i.operation === "activate-demand")).toBe(false);
  expect(
    await db
      .select()
      .from(federationOutbound)
      .where(eq(federationOutbound.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
  await f.lease().release();
});

test("workflow market cancellation during claim verification prevents the late reservation handoff", async () => {
  const f = await workflowMarketFixture();
  await f.prepare();
  await f.source.advanceNext();
  await f.commit();
  await f.source.advanceNext();
  await f.target.advanceNext();
  await f.commit(true);
  await f.target.advanceNext();
  await f.due();
  f.beforeQuery(async () => {
    await db.update(workflowRuns).set({ status: "cancelling" }).where(eq(workflowRuns.id, f.runId));
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({
    state: "needs_review",
    lastError: "CANCELLATION_REQUESTED",
  });
  expect(
    await db
      .select()
      .from(federationReservationProposals)
      .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
  await f.outbound.cancelWorkflow(f.runId);
  await f.lease().release();
});

test("workflow market audit failure rolls back publication authority and resumes the bound invocation", async () => {
  const f = await workflowMarketFixture();
  await db.execute(
    sql`alter table audit_log add constraint test_workflow_market_audit check (action <> 'federation.market_request.submit' OR org_id <> ${sql.raw(`'${f.actor.orgId}'`)})`,
  );
  try {
    await expect(f.execute()).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
    expect(await f.view()).toBeUndefined();
    expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.marketAuthorizedTasks).toBe(0);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_workflow_market_audit`);
  }
  const [binding] = await db
    .select()
    .from(workflowExecutionDelegations)
    .where(eq(workflowExecutionDelegations.runId, f.runId));
  if (!binding) throw new Error("Missing stable binding");
  await f.restart();
  const original = await f.prepare();
  expect(original.reservationId).toBe(binding.operationId);
  expect(original.payload.proposal.request).toEqual(binding.request);
  await f.lease().release();
});

test("workflow market does not silently upgrade a publication-only policy into execution authority", async () => {
  const f = await workflowMarketFixture();
  await f.sourcePolicies.revoke(f.actor, f.revisionId, f.sourcePolicy.id);
  const policy = await f.sourcePolicies.grant(f.actor, f.revisionId, {
    ...f.policyInput,
    allowMarketPublish: true,
  });
  if (!f.node.market) throw new Error("Missing selection");
  f.node.market.policyId = policy.id;
  expect(await f.execute()).toMatchObject({ status: "Failed" });
  expect(await f.view()).toBeUndefined();
  await f.lease().release();
});

test("workflow market local planning requires no source Agent for remote and control nodes but still plans real compute", async () => {
  const f = await workflowMarketFixture();
  const config = WorkflowPlacementConfigSchema.parse({});
  const workflow = workflowDsl.WorkflowSchema.parse({
    name: "Remote only",
    spec: {
      nodeDrafts: [f.node, { type: "NoAction", id: "consume", name: "Consume" }],
      nodeRelations: [{ fromId: "remote", toId: "consume", slotRelations: [] }],
    },
  });
  const build = createWorkflowPlacementBuilder(db);
  const plan = await build(f.runId, "workflow-submit", { workflow, config });
  expect(plan.request.nodes).toHaveLength(0);
  expect(plan.request.edges).toEqual([]);
  expect(planSandboxPlacement({ ...plan.request, mode: "Global" })).toMatchObject({
    assignments: [],
    objective: { total: 0 },
  });
  workflow.spec.nodeDrafts.push(
    workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "local",
      name: "Local",
      usecaseVersionId: randomUUID(),
      softwareVersionId: randomUUID(),
    }),
  );
  workflow.spec.nodeRelations.push({ fromId: "consume", toId: "local", slotRelations: [] });
  config.nodeConstraints.local = {
    mode: "Require",
    siteIds: [randomUUID()],
    clusterIds: [],
    dataMovement: "Allow",
  };
  const mixed = await build(f.runId, "workflow-submit", { workflow, config });
  expect(mixed.request.nodes.map((n) => n.id)).toEqual(["local"]);
  expect(mixed.request.edges).toEqual([]);
  expect(() => planSandboxPlacement({ ...mixed.request, mode: "Global" })).toThrow(
    "no candidate satisfies placement constraints",
  );
  await f.lease().release();
});

async function mvccFixture() {
  const f = await fixture();
  await approveBoth(f);
  const original = await pending(f);
  const queries: unknown[] = [];
  f.adapter.receipt = async (query) => {
    queries.push(query);
    return { receipt: { recordId: original.input.recordId, digest: original.input.digest } };
  };
  f.adapter.outcome = "invalid";
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  expect(await pending(f)).toMatchObject({ state: "pending", lastError: "MVCC_RECONCILING" });
  const [failed] = await db.select().from(attempts).where(eq(attempts.submissionId, original.id));
  if (!failed) throw new Error("Missing original invalid transaction");
  expect(failed).toMatchObject({ stage: "invalid", validationCode: 11 });
  return { ...f, original, failed, queries };
}

test("commercial MVCC reconciliation survives outage and restart, preserves INVALID and requires a fresh VALID", async () => {
  const f = await mvccFixture();
  const receipt = f.adapter.receipt;
  if (!receipt) throw new Error("Missing receipt client");
  f.adapter.receipt = async () => {
    throw new FabricClientFailure("LEDGER_UNAVAILABLE");
  };
  await f.service.advanceNext();
  expect(await pending(f)).toMatchObject({ state: "pending", lastError: "MVCC_RECONCILING" });
  expect(f.adapter.prepares).toHaveLength(1);
  await ready(f);
  f.adapter.receipt = receipt;
  const restart = new FederationCommercialSubmissionService(db, f.a.signing.siteId, f.adapter);
  await Promise.all([restart.advanceNext(), restart.advanceNext()]);
  expect(f.queries).toEqual([
    {
      operation: "get-commercial-receipt",
      domainId: f.original.input.domainId,
      recordType: "agreement",
      recordId: f.original.input.recordId,
    },
  ]);
  expect(f.adapter.prepares).toEqual([f.original.input, f.original.input]);
  expect((await pending(f)).state).toBe("pending");
  f.adapter.outcome = "committed";
  for (let i = 0; i < 2; i++) await restart.advanceNext();
  expect((await pending(f)).state).toBe("committed");
  const history = await db.select().from(attempts).where(eq(attempts.submissionId, f.original.id));
  expect(history).toHaveLength(2);
  expect(history.find((row) => row.id === f.failed.id)).toEqual(f.failed);
  expect(history.find((row) => row.number === 2)).toMatchObject({
    stage: "committed",
    validationCode: 0,
  });
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target, f.original.id),
        eq(auditLog.action, "federation.commercial.mvcc_reconcile"),
      ),
    );
  expect(audits).toHaveLength(1);
  expect(audits[0]?.diff).toMatchObject({
    after: {
      previousTransactionId: f.failed.transactionId,
      validationCode: 11,
      receipt: { digest: f.original.input.digest },
    },
  });
  expect(JSON.stringify(audits)).not.toContain(JSON.stringify(f.original.input.envelope));
});

test.each([
  "absent",
  "different",
])("commercial MVCC reconciliation refuses %s receipt and leaves explicit manual review available", async (kind) => {
  const f = await mvccFixture();
  f.adapter.receipt = async () => ({
    receipt:
      kind === "absent"
        ? null
        : { recordId: f.original.input.recordId, digest: `sha256:${"f".repeat(64)}` },
  });
  await f.service.advanceNext();
  expect((await pending(f)).state).toBe("needs_review");
  expect(f.adapter.prepares).toHaveLength(1);
  await f.service.retry(f.actor, f.revisionId, f.original.id);
  await f.service.advanceNext();
  expect(f.adapter.prepares).toHaveLength(2);
  expect(f.adapter.prepares[1]).toEqual(f.original.input);
});

test("commercial MVCC reconciliation is bounded and never retries a second conflict automatically", async () => {
  const f = await mvccFixture();
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  expect((await pending(f)).state).toBe("needs_review");
  expect(f.queries).toHaveLength(1);
  expect(f.adapter.prepares).toHaveLength(2);
  expect(await f.service.advanceNext()).toBe(false);
});

test.each([
  "query",
  "prepare",
])("commercial MVCC reconciliation rechecks revoked trust after %s", async (boundary) => {
  const f = await mvccFixture();
  const revoke = () =>
    f.trust.revoke(f.b.signing.siteId, { keyId: f.b.signing.keyId }, f.actor.userId);
  if (boundary === "query")
    f.adapter.receipt = async () => {
      await revoke();
      return { receipt: { recordId: f.original.input.recordId, digest: f.original.input.digest } };
    };
  else {
    const prepare = f.adapter.prepare.bind(f.adapter);
    f.adapter.prepare = async (input) => {
      const result = await prepare(input);
      await revoke();
      return result;
    };
  }
  await f.service.advanceNext();
  expect(await pending(f)).toMatchObject({
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
  });
  expect(await db.select().from(attempts).where(eq(attempts.submissionId, f.original.id))).toEqual([
    f.failed,
  ]);
});

test("commercial MVCC reconciliation cannot save a new checkpoint under a replaced lease", async () => {
  const f = await mvccFixture();
  const replacement = randomUUID();
  f.adapter.receipt = async () => {
    await db
      .update(submissions)
      .set({ leaseToken: replacement, leaseUntil: sql`clock_timestamp() + interval '90 seconds'` })
      .where(eq(submissions.id, f.original.id));
    return { receipt: { recordId: f.original.input.recordId, digest: f.original.input.digest } };
  };
  await f.service.advanceNext();
  expect((await pending(f)).leaseToken).toBe(replacement);
  expect(await db.select().from(attempts).where(eq(attempts.submissionId, f.original.id))).toEqual([
    f.failed,
  ]);
});

test("commercial MVCC reconciliation audit failure rolls back the replacement checkpoint", async () => {
  const f = await mvccFixture();
  await db.execute(
    sql`alter table audit_log add constraint test_mvcc_reconcile_audit check (action <> 'federation.commercial.mvcc_reconcile' OR target <> ${sql.raw(`'${f.original.id}'`)})`,
  );
  try {
    await f.service.advanceNext();
    expect(await pending(f)).toMatchObject({ state: "pending", lastError: "MVCC_RECONCILING" });
    expect(
      await db.select().from(attempts).where(eq(attempts.submissionId, f.original.id)),
    ).toEqual([f.failed]);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_mvcc_reconcile_audit`);
  }
  await ready(f);
  await f.service.advanceNext();
  expect(
    await db.select().from(attempts).where(eq(attempts.submissionId, f.original.id)),
  ).toHaveLength(2);
});

test.each([
  "endorsement",
  "unknown",
])("commercial MVCC reconciliation never replaces an %s outcome", async (outcome) => {
  const f = await fixture();
  await approveBoth(f);
  let queries = 0;
  f.adapter.receipt = async () => {
    queries++;
    return { receipt: null };
  };
  for (let i = 0; i < 2; i++) await f.service.advanceNext();
  f.adapter.onAdvance = async (recovery, transactionId) =>
    outcome === "unknown"
      ? { state: "pending", recovery, transactionId }
      : { state: "invalid", transactionId, validationCode: 10, blockNumber: "7" };
  await f.service.advanceNext();
  expect(queries).toBe(0);
  expect(f.adapter.prepares).toHaveLength(1);
  expect((await pending(f)).state).toBe(outcome === "unknown" ? "pending" : "needs_review");
});

test("coordinated bill waits for the exact source terminal receipt without requiring a local terminal submission", async () => {
  const f = await terminalSourceFixture();
  const terminal = await f.approveTerminal();
  const source = await f.sourceTerminal.countersign(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    await f.proposal(),
  );
  await db
    .update(federationExecutionTerminals)
    .set({ counterpartyJws: source.approvalJws })
    .where(
      and(
        eq(federationExecutionTerminals.localSiteId, f.siteId),
        eq(federationExecutionTerminals.terminalId, terminal.terminalId),
      ),
    );
  for (const siteId of [f.a.signing.siteId, f.b.signing.siteId]) {
    const [key] = await db
      .select()
      .from(federationSigningKeys)
      .where(eq(federationSigningKeys.siteId, siteId));
    if (!key) throw new Error("Missing fixture key");
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: [...key.allowedKinds, "commercial-bill"] })
      .where(eq(federationSigningKeys.siteId, siteId));
  }
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: true },
    f.actor.userId,
  );
  const wireDigest = (value: unknown) =>
    `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  const agreementDigest = wireDigest(f.terms);
  const report = CommercialUsageSchema.parse({
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId: f.terms.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest,
    sourceSiteId: f.a.signing.siteId,
    targetSiteId: f.siteId,
    taskId: f.reservation.request.taskId,
    attempt: f.reservation.request.attempt,
    salt: "c".repeat(64),
    reportedAt: new Date().toISOString(),
    periodStart: f.reservation.request.issuedAt,
    periodEnd: terminal.payload.observedAt,
    measurements: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        quantity: "1",
        evidenceDigest: `sha256:${"d".repeat(64)}`,
      },
    ],
  });
  const bill = CommercialBillSchema.parse({
    protocolVersion: 1,
    kind: "commercial-bill",
    billId: randomUUID(),
    domainId: f.terms.domainId,
    agreementDigest,
    priceVersionId: f.terms.priceVersionId,
    reportId: report.reportId,
    reportDigest: wireDigest(report),
    request: f.reservation.request,
    reservationId: f.reservation.reservationId,
    discount: null,
    calculation: calculateCommercialBill(f.terms, f.reservation.request, report),
    issuedAt: new Date().toISOString(),
    salt: "e".repeat(64),
  });
  const sourceJws = await signFederationMessage(CommercialBillSchema, bill, f.a.signing);
  const targetJws = await signFederationMessage(CommercialBillSchema, bill, f.b.signing);
  const digest = wireDigest(bill);
  await db.insert(federationCommercialBills).values({
    localSiteId: f.siteId,
    localOrgId: f.actor.orgId,
    billId: bill.billId,
    agreementRevisionId: f.revisionId,
    taskId: bill.request.taskId,
    attempt: bill.request.attempt,
    payload: bill,
    digest,
    approvalJws: targetJws,
    counterpartyJws: sourceJws,
    approvedBy: f.actor.userId,
  });
  await db.insert(submissions).values({
    id: randomUUID(),
    localSiteId: f.siteId,
    agreementRevisionId: f.revisionId,
    state: "committed",
    input: {
      operation: "record-usage",
      domainId: bill.domainId,
      recordId: report.reportId,
      digest: bill.reportDigest,
      envelope: {
        providerJws: await signFederationMessage(CommercialUsageSchema, report, f.b.signing),
      },
    },
  });
  const id = randomUUID();
  await db.insert(submissions).values({
    id,
    localSiteId: f.siteId,
    agreementRevisionId: f.revisionId,
    input: {
      operation: "confirm-bill",
      domainId: bill.domainId,
      recordId: bill.billId,
      digest,
      envelope: { sourceSiteId: f.a.signing.siteId, targetSiteId: f.siteId, sourceJws, targetJws },
    },
  });
  const adapter = new Adapter();
  const worker = new FederationCommercialSubmissionService(db, f.siteId, adapter);
  const read = async () => (await db.select().from(submissions).where(eq(submissions.id, id)))[0];
  const due = () =>
    db
      .update(submissions)
      .set({ nextAttemptAt: sql`clock_timestamp()` })
      .where(eq(submissions.id, id));
  adapter.receipt = async (query) => {
    expect(query).toEqual({
      operation: "get-commercial-receipt",
      domainId: bill.domainId,
      recordType: "terminal",
      recordId: terminal.terminalId,
    });
    return { receipt: null };
  };
  expect(await worker.advanceNext()).toBe(true);
  expect((await read())?.lastError).toBe("LEDGER_PENDING");
  expect((await read())?.state).toBe("pending");
  expect(adapter.prepares).toHaveLength(0);
  adapter.receipt = async () => ({
    receipt: { recordId: terminal.terminalId, digest: `sha256:${"0".repeat(64)}` },
  });
  await due();
  await worker.advanceNext();
  expect((await read())?.state).toBe("needs_review");
  expect(adapter.prepares).toHaveLength(0);
  adapter.receipt = async () => {
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: new Date() })
      .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
    return { receipt: { recordId: terminal.terminalId, digest: terminal.digest } };
  };
  await worker.retry(f.actor, f.revisionId, id);
  await worker.advanceNext();
  expect((await read())?.lastError).toBe("UNTRUSTED_IDENTITY");
  expect(adapter.prepares).toHaveLength(0);
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: null })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  adapter.receipt = async () => ({
    receipt: { recordId: terminal.terminalId, digest: terminal.digest },
  });
  await worker.retry(f.actor, f.revisionId, id);
  await worker.advanceNext();
  expect(adapter.prepares.map((input) => input.operation)).toEqual(["confirm-bill"]);
  expect(
    await db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, f.siteId),
          sql`${submissions.input}->>'operation' = 'record-execution-terminal'`,
        ),
      ),
  ).toHaveLength(0);
});

test("commercial storage pressure gates fresh manual reservations but preserves original approvals", async () => {
  const f = await executionFixture();
  let blocked = true;
  const service = new FederationCommercialExecutionService(
    db,
    f.a.signing,
    {
      query: async () => ({ operation: "get-demand", demand: f.state }),
    },
    undefined,
    {
      async assertAdmission(mode) {
        expect(mode).toBe("ledger_coordinated");
        if (blocked) throw new FederationError("STORAGE_PRESSURE");
      },
    },
  );
  await expect(service.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "STORAGE_PRESSURE",
  });
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.recordId, f.reservation.reservationId)),
  ).toHaveLength(0);
  blocked = false;
  const first = await service.approve(f.actor, f.revisionId, f.reservation);
  blocked = true;
  expect((await service.approve(f.actor, f.revisionId, f.reservation)).approvalJws).toBe(
    first.approvalJws,
  );
  await expect(
    service.approve(f.actor, f.revisionId, { ...f.reservation, salt: "1".repeat(64) }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
});

test("proposal storage pressure pauses new source and receiver intents without consuming policy, then resumes original delivery", async () => {
  let sourceBlocked = true,
    targetBlocked = true;
  const guards = {
    source: {
      async assertAdmission() {
        if (sourceBlocked) throw new FederationError("STORAGE_PRESSURE");
      },
    },
    target: {
      async assertAdmission() {
        if (targetBlocked) throw new FederationError("STORAGE_PRESSURE");
      },
    },
  };
  const f = await reservationProposalFixture(false, guards);
  await expect(f.submit()).rejects.toMatchObject({ code: "STORAGE_PRESSURE" });
  expect(await f.view()).toBeUndefined();
  sourceBlocked = false;
  await f.submit();
  sourceBlocked = true;
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("sending");
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "sending", lastError: "STORAGE_PRESSURE" });
  expect(await f.view(true)).toBeUndefined();
  expect((await f.policies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
  targetBlocked = false;
  await f.due();
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("delivered");
  const original = await f.view();
  if (!original?.sourceJws) throw new Error("Missing proposal signature");
  targetBlocked = true;
  await f.target.receive(original.sourceJws, f.fingerprints[0] ?? "");
  await f.target.advanceNext();
  expect((await f.view(true))?.state).toBe("approved");
  expect((await f.policies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(1);
});

test("market request storage pressure gates new intents and preserves accepted claim to reservation handoff", async () => {
  let sourceBlocked = true,
    targetBlocked = true;
  const guards = {
    source: {
      async assertAdmission() {
        if (sourceBlocked) throw new FederationError("STORAGE_PRESSURE");
      },
    },
    target: {
      async assertAdmission() {
        if (targetBlocked) throw new FederationError("STORAGE_PRESSURE");
      },
    },
  };
  const f = await marketRequestFixture(true, 2, false, guards);
  await expect(f.submit()).rejects.toMatchObject({ code: "STORAGE_PRESSURE" });
  expect(await f.view()).toBeUndefined();
  sourceBlocked = false;
  await f.submit();
  sourceBlocked = true;
  await f.source.advanceNext();
  await f.commit();
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({ state: "pending", lastError: "STORAGE_PRESSURE" });
  expect(await f.view(true)).toBeUndefined();
  expect((await f.policies.list(f.actor, f.revisionId))[0]?.marketAuthorizedTasks).toBe(0);
  const original = await f.view();
  if (!original?.sourceJws) throw new Error("Missing market signature");
  const ingress = createFederationIngress(
    db,
    f.b.signing,
    undefined,
    undefined,
    undefined,
    undefined,
    guards.target,
  );
  const response = await ingress.request("/federation/v1/market-requests", {
    method: "POST",
    headers: {
      "content-type": "application/jose",
      "x-kq-federation-cert": f.fingerprints[0] ?? "",
    },
    body: original.sourceJws,
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "STORAGE_PRESSURE" } });
  targetBlocked = false;
  await f.due();
  await f.source.advanceNext();
  expect(await f.view(true)).toMatchObject({ state: "pending" });
  targetBlocked = true;
  await f.target.receive(original.sourceJws, f.fingerprints[0] ?? "");
  await f.target.advanceNext();
  await f.commit(true);
  await f.target.advanceNext();
  await expect(
    f.sourceProposals.submit(f.actor, f.revisionId, f.sourcePolicy.id, {
      ...f.request.proposal,
      salt: "1".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await f.due();
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("complete");
  await f.sourceProposals.advanceNext();
  await f.sourceProposals.advanceNext();
  await f.receiverProposals.advanceNext();
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.recordId, f.request.proposal.reservationId)),
  ).toHaveLength(2);
});

test("commercial storage pressure is rechecked after the market query before signing approval is persisted", async () => {
  const f = await executionFixture();
  let blocked = false;
  const service = new FederationCommercialExecutionService(
    db,
    f.a.signing,
    {
      query: async () => {
        blocked = true;
        return { operation: "get-demand", demand: f.state };
      },
    },
    undefined,
    {
      async assertAdmission() {
        if (blocked) throw new FederationError("STORAGE_PRESSURE");
      },
    },
  );
  await expect(service.approve(f.actor, f.revisionId, f.reservation)).rejects.toMatchObject({
    code: "STORAGE_PRESSURE",
  });
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.recordId, f.reservation.reservationId)),
  ).toHaveLength(0);
});

test("completion pool charges automatic market and reservation handoffs once per site through approval", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const sourceStorage = testCompletionStorage(),
    targetStorage = testCompletionStorage();
  const f = await marketRequestFixture(true, 2, false, {
    source: sourceStorage.guard,
    target: targetStorage.guard,
  });
  const sourcePool = new FederationCompletionCapacity(db, f.a.signing.siteId, sourceStorage.guard);
  const targetPool = new FederationCompletionCapacity(db, f.b.signing.siteId, targetStorage.guard);
  for (const [pool, storage] of [
    [sourcePool, sourceStorage],
    [targetPool, targetStorage],
  ] as const)
    await pool.configure(
      { reserveId: storage.reserveId, capacityBytes: "60", taskBytes: "60", marketBytes: "20" },
      f.actor.userId,
    );
  await f.submit();
  expect(await sourcePool.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
  await f.source.advanceNext();
  await f.commit();
  await f.source.advanceNext();
  expect(await targetPool.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
  sourceStorage.pressure();
  targetStorage.pressure();
  await f.target.advanceNext();
  await f.commit(true);
  await f.target.advanceNext();
  await f.due();
  await f.source.advanceNext();
  expect((await f.view())?.state).toBe("complete");
  await f.sourceProposals.advanceNext();
  await f.sourceProposals.advanceNext();
  await f.receiverProposals.advanceNext();
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.recordId, f.request.proposal.reservationId)),
  ).toHaveLength(2);
  expect(await sourcePool.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
  expect(await targetPool.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
});

test("completion pool manual approval preflight cannot leave a claim when remote validation fails", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const f = await executionFixture(),
    storage = testCompletionStorage();
  const capacity = new FederationCompletionCapacity(db, f.a.signing.siteId, storage.guard);
  await capacity.configure(
    { reserveId: storage.reserveId, capacityBytes: "80", taskBytes: "60", marketBytes: "20" },
    f.actor.userId,
  );
  const service = new FederationCommercialExecutionService(
    db,
    f.a.signing,
    {
      query: async () => {
        throw new Error("Remote market unavailable");
      },
    },
    undefined,
    storage.guard,
  );
  await expect(service.approve(f.actor, f.revisionId, f.reservation)).rejects.toThrow(
    "Remote market unavailable",
  );
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "20", obligations: 1 });
  const recovery = new FederationCommercialExecutionService(
    db,
    f.a.signing,
    { query: async () => ({ operation: "get-demand", demand: f.state }) },
    undefined,
    storage.guard,
  );
  await recovery.approve(f.actor, f.revisionId, f.reservation);
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "80", obligations: 2 });
});

test("completion release late execution stop renews before writing and keeps duplicate requests free", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  const f = await executionFixture();
  await approveReservation(f);
  const siteId = f.a.signing.siteId,
    storage = testCompletionStorage();
  const capacity = new FederationCompletionCapacity(db, siteId, storage.guard);
  const policy = {
    reserveId: storage.reserveId,
    capacityBytes: "80",
    taskBytes: "60",
    marketBytes: "20",
  };
  await capacity.configure(policy, f.actor.userId);
  // Controlled released state isolates the stop writer; it does not prove coordinated closure.
  await db
    .update(claims)
    .set({ releasedAt: new Date() })
    .where(and(eq(claims.localSiteId, siteId), eq(claims.kind, "task")));
  await capacity.configure({ ...policy, capacityBytes: "50", taskBytes: "10" }, f.actor.userId);
  const service = new FederationExecutionStopService(db, siteId, undefined, storage.guard);
  await expect(
    service.request(f.actor, f.revisionId, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "STORAGE_PRESSURE" });
  const read = async () =>
    (
      await db
        .select()
        .from(executionApprovals)
        .where(
          and(
            eq(executionApprovals.localSiteId, siteId),
            eq(executionApprovals.recordId, f.reservation.reservationId),
          ),
        )
    )[0];
  expect((await read())?.stopId).toBeNull();
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "20" });
  await capacity.configure(policy, f.actor.userId);
  const first = await service.request(f.actor, f.revisionId, f.reservation.reservationId);
  expect((await read())?.stopNextAttemptAt).not.toBeNull();
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "80" });
  storage.pressure();
  expect(await service.request(f.actor, f.revisionId, f.reservation.reservationId)).toEqual(first);
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "80" });
});

test("completion release retains public market claims until cancellation is committed", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  const f = await executionFixture(),
    storage = testCompletionStorage();
  const siteId = f.a.signing.siteId;
  const capacity = new FederationCompletionCapacity(db, siteId, storage.guard);
  await capacity.configure(
    { reserveId: storage.reserveId, capacityBytes: "100", taskBytes: "60", marketBytes: "20" },
    f.actor.userId,
  );
  await capacity.advanceNext();
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "20" });
  const input = {
    operation: "cancel-open-demand" as const,
    cancellation: {
      cancellationId: randomUUID(),
      demandId: f.reservation.demandId,
      expectedVersion: 1,
    },
  };
  await db.insert(marketSubmissions).values({
    id: input.cancellation.cancellationId,
    demandId: f.reservation.demandId,
    localSiteId: siteId,
    localOrgId: f.actor.orgId,
    requestedBy: f.actor.userId,
    input,
    digest: federationMaterialDigest(input),
    state: "needs_review",
  });
  await db.update(claims).set({ nextCheckAt: new Date() }).where(eq(claims.localSiteId, siteId));
  await capacity.advanceNext();
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "20" });
  await db
    .update(marketSubmissions)
    .set({ state: "committed" })
    .where(eq(marketSubmissions.id, input.cancellation.cancellationId));
  await db.update(claims).set({ nextCheckAt: new Date() }).where(eq(claims.localSiteId, siteId));
  await capacity.advanceNext();
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "0", releasedObligations: 1 });
});

async function preexecutionClosureFixture() {
  const f = await executionFixture();
  await approveReservation(f);
  const release = await releasePayload(f);
  await f.execution.approve(f.actor, f.revisionId, release);
  await f.execution.attachCounterparty(
    f.actor,
    f.revisionId,
    release.releaseId,
    await signFederationMessage(CommercialExecutionApprovalSchema, release, f.b.signing),
  );
  const view = async () =>
    (
      await db.select().from(marketSubmissions).where(eq(marketSubmissions.id, release.releaseId))
    )[0];
  const marketAdapter = new ActivationAdapter();
  const market = new FederationMarketService(db, f.a.signing.siteId, marketAdapter);
  const advance = async (count = 9) => {
    for (let i = 0; i < count; i++) await f.service.advanceNext();
  };
  return { ...f, release, view, market, marketAdapter, advance };
}

test("pre-execution closure waits for VALID release then closes the public market and drains the original stop", async () => {
  const f = await preexecutionClosureFixture();
  const stops = new FederationExecutionStopService(db, f.a.signing.siteId, {
    query: async () => ({ operation: "get-demand", demand: f.state }),
  });
  const stop = await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  await stops.advanceNext();
  expect(
    (await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).stopLastError,
  ).toBe("ACTIVATION_PENDING");
  await f.advance(8);
  expect(await f.view()).toBeUndefined();
  await f.advance(1);
  const closure = await f.view();
  if (closure?.input.operation !== "close-demand") throw new Error("Missing release closure");
  expect(closure).toMatchObject({ state: "pending", requestedBy: f.actor.userId });
  expect(closure.input.closure).toMatchObject({
    closureId: f.release.releaseId,
    expectedVersion: 2,
    gate: { state: "REVOKED", version: 2, reservationId: f.reservation.reservationId },
  });
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  expect((await f.view())?.state).toBe("committed");
  expect(f.marketAdapter.inputs).toHaveLength(1);
  expect(JSON.stringify(f.marketAdapter.inputs)).not.toContain("maxAmount");
  f.state.status = "CLOSED";
  f.state.version = 3;
  f.state.closure = closure.input.closure;
  await db
    .update(executionApprovals)
    .set({ stopNextAttemptAt: new Date(0) })
    .where(eq(executionApprovals.recordId, f.reservation.reservationId));
  await stops.advanceNext();
  expect(await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).toMatchObject({
    stopId: stop.id,
    stopNextAttemptAt: null,
    stopLastError: null,
  });
  expect(await stops.request(f.actor, f.revisionId, f.reservation.reservationId)).toEqual(stop);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "market.publish", enabled: true },
    f.actor.userId,
  );
  await expect(
    f.execution.activate(f.actor, f.revisionId, f.reservation.reservationId, randomUUID()),
  ).rejects.toMatchObject({ code: "CANCELLATION_REQUESTED" });
});

test("pre-execution closure audit failure retains the release checkpoint and retries without another private transaction", async () => {
  const f = await preexecutionClosureFixture();
  await f.advance(8);
  const before = (await f.execution.get(f.actor, f.revisionId, f.release.releaseId)).submission;
  if (!before) throw new Error("Missing release submission");
  const constraint = sql.identifier(`test_release_close_${randomUUID().replaceAll("-", "")}`);
  await db.execute(sql`ALTER TABLE audit_log ADD CONSTRAINT ${constraint}
    CHECK (action <> 'federation.execution.close_enqueue') NOT VALID`);
  try {
    await f.advance(1);
    expect(await f.view()).toBeUndefined();
    expect(
      (await f.execution.get(f.actor, f.revisionId, f.release.releaseId)).submission?.transaction
        ?.stage,
    ).toBe("transaction");
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT ${constraint}`);
  }
  await db
    .update(submissions)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(submissions.id, before.id));
  await f.advance(1);
  expect((await f.view())?.state).toBe("pending");
  expect(
    (await f.execution.get(f.actor, f.revisionId, f.release.releaseId)).submission?.transaction,
  ).toMatchObject({ stage: "committed", transactionId: before.transaction?.transactionId });
  expect(
    f.adapter.prepares.filter((input) => input.operation === "release-execution"),
  ).toHaveLength(1);
});

test("pre-execution closure rejects an invalid private commit and a changed public gate", async () => {
  const f = await preexecutionClosureFixture();
  await f.advance(8);
  f.adapter.outcome = "invalid";
  await f.advance(1);
  expect(await f.view()).toBeUndefined();
  const g = await preexecutionClosureFixture();
  await g.advance();
  const closure = await g.view();
  if (closure?.input.operation !== "close-demand") throw new Error("Missing release closure");
  const input = {
    ...closure.input,
    closure: {
      ...closure.input.closure,
      gate: { ...closure.input.closure.gate, reservationDigest: `sha256:${"a".repeat(64)}` },
    },
  };
  await db
    .update(marketSubmissions)
    .set({ input, digest: federationMaterialDigest(input) })
    .where(eq(marketSubmissions.id, closure.id));
  await g.market.advanceNext();
  expect(g.marketAdapter.inputs).toHaveLength(0);
  expect((await g.view())?.state).toBe("needs_review");
});

test("pre-execution closure recovers a committed legacy release without requiring current signing trust", async () => {
  const f = await preexecutionClosureFixture();
  await f.advance();
  const first = await f.view();
  if (!first) throw new Error("Missing closure");
  await db.delete(marketSubmissions).where(eq(marketSubmissions.id, first.id));
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: new Date() })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await f.advance(1);
  expect((await f.view())?.input).toEqual(first.input);
  for (let i = 0; i < 3; i++) await f.market.advanceNext();
  expect((await f.view())?.state).toBe("committed");
  expect(
    f.adapter.prepares.filter((input) => input.operation === "release-execution"),
  ).toHaveLength(1);
});

test("pre-execution closure is queued only by the source after both institutions commit the same release", async () => {
  const f = await executionApprovalExchangeFixture();
  await Promise.all([f.transport.a.discover(), f.transport.b.discover()]);
  await Promise.all([f.transport.a.advanceNext(), f.transport.b.advanceNext()]);
  const release = await releasePayload(f);
  await f.execution.approve(f.actor, f.revisionId, release);
  await f.executionB.approve(f.actor, f.revisionId, release);
  await Promise.all([f.transport.a.discover(), f.transport.b.discover()]);
  await Promise.all([f.transport.a.advanceNext(), f.transport.b.advanceNext()]);
  const provider = new FederationCommercialSubmissionService(db, f.b.signing.siteId, new Adapter());
  for (let i = 0; i < 9; i++) await provider.advanceNext();
  expect((await f.executionB.get(f.actor, f.revisionId, release.releaseId)).submission?.state).toBe(
    "committed",
  );
  expect(
    await db.select().from(marketSubmissions).where(eq(marketSubmissions.id, release.releaseId)),
  ).toHaveLength(0);
  expect(await provider.advanceNext()).toBe(false);
  for (let i = 0; i < 9; i++) await f.service.advanceNext();
  const [closure] = await db
    .select()
    .from(marketSubmissions)
    .where(eq(marketSubmissions.id, release.releaseId));
  expect(closure).toMatchObject({ localSiteId: f.a.signing.siteId, state: "pending" });
});

test("pre-execution closure for a different reservation cannot retire a local stop", async () => {
  const f = await preexecutionClosureFixture();
  await f.advance();
  const closure = await f.view();
  if (closure?.input.operation !== "close-demand") throw new Error("Missing release closure");
  const changed = {
    ...f.state,
    status: "CLOSED" as const,
    version: 3,
    closure: {
      ...closure.input.closure,
      gate: { ...closure.input.closure.gate, reservationDigest: `sha256:${"f".repeat(64)}` },
    },
  };
  const stops = new FederationExecutionStopService(db, f.a.signing.siteId, {
    query: async () => ({ operation: "get-demand", demand: changed }),
  });
  await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  await stops.advanceNext();
  const row = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
  expect(row.stopLastError).toBe("OPERATION_CONFLICT");
  expect(row.stopNextAttemptAt).not.toBeNull();
});

async function preexecutionCapacityFixture() {
  const f = await executionAutomationFixture();
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  const sourceStorage = testCompletionStorage(),
    providerStorage = testCompletionStorage();
  const sourceCapacity = new FederationCompletionCapacity(
    db,
    f.a.signing.siteId,
    sourceStorage.guard,
  );
  const providerCapacity = new FederationCompletionCapacity(
    db,
    f.b.signing.siteId,
    providerStorage.guard,
  );
  for (const [capacity, storage] of [
    [sourceCapacity, sourceStorage],
    [providerCapacity, providerStorage],
  ] as const)
    await capacity.configure(
      { reserveId: storage.reserveId, capacityBytes: "100", taskBytes: "60", marketBytes: "20" },
      f.actor.userId,
    );
  const release = await releasePayload(f);
  const target = new FederationCommercialExecutionService(db, f.b.signing, f.market);
  const commitRelease = async () => {
    const own = await f.sourceExecution.approve(f.actor, f.revisionId, release);
    const other = await target.approve(f.actor, f.revisionId, release);
    await f.sourceExecution.attachCounterparty(
      f.actor,
      f.revisionId,
      release.releaseId,
      other.approvalJws,
    );
    await target.attachCounterparty(f.actor, f.revisionId, release.releaseId, own.approvalJws);
    const provider = new FederationCommercialSubmissionService(db, f.b.signing.siteId, f.adapter);
    for (let i = 0; i < 3; i++) {
      await f.service.advanceNext();
      await provider.advanceNext();
    }
  };
  const close = async () => {
    for (let i = 0; i < 3; i++) await f.marketSource.advanceNext();
    const [closed] = await db
      .select()
      .from(marketSubmissions)
      .where(eq(marketSubmissions.id, release.releaseId));
    if (closed?.input.operation !== "close-demand" || closed.state !== "committed")
      throw new Error("Closure not committed");
    f.state.status = "CLOSED";
    f.state.version = 3;
    f.state.closure = closed.input.closure;
  };
  const scan = async (provider = false) => {
    const site = provider ? f.b.signing.siteId : f.a.signing.siteId;
    await db
      .update(claims)
      .set({ nextCheckAt: new Date(0) })
      .where(eq(claims.localSiteId, site));
    const capacity = provider ? providerCapacity : sourceCapacity;
    for (let i = 0; i < 4; i++) if (!(await capacity.advanceNext())) break;
    return capacity.inspect();
  };
  const taskClaim = async (provider = false) =>
    (
      await db
        .select()
        .from(claims)
        .where(
          and(
            eq(claims.localSiteId, provider ? f.b.signing.siteId : f.a.signing.siteId),
            eq(claims.kind, "task"),
          ),
        )
    )[0];
  return {
    ...f,
    sourceCapacity,
    providerCapacity,
    sourceStorage,
    providerStorage,
    release,
    target,
    commitRelease,
    close,
    scan,
    taskClaim,
  };
}

test("pre-execution capacity releases both local tasks and manual market allocations without a fictitious bill", async () => {
  const f = await preexecutionCapacityFixture();
  for (const provider of [false, true])
    expect(await f.scan(provider)).toMatchObject({ allocatedBytes: "80" });
  await f.commitRelease();
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "0", releasedObligations: 2 });
  await f.providerAutomation.discover();
  expect(await f.providerAutomation.advanceNext()).toBe(false);
  expect((await f.view(true))?.executionState).toBe("idle");
  await expect(
    f.providerAutomation.retry(f.actor, f.revisionId, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(await f.scan()).toMatchObject({ allocatedBytes: "80" });
  expect((await f.taskClaim())?.releaseBlocker).toBe("market-closure");
  await f.close();
  expect(await f.scan()).toMatchObject({ allocatedBytes: "0", releasedObligations: 2 });
  expect(
    await db
      .select()
      .from(federationCommercialBills)
      .where(eq(federationCommercialBills.agreementRevisionId, f.revisionId)),
  ).toHaveLength(0);
});

test("pre-execution capacity keeps an outstanding stop until the exact public closure is observed", async () => {
  const f = await preexecutionCapacityFixture();
  await f.commitRelease();
  const stops = new FederationExecutionStopService(
    db,
    f.b.signing.siteId,
    f.market,
    f.providerStorage.guard,
  );
  const original = await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "80" });
  expect((await f.taskClaim(true))?.releaseBlocker).toBe("execution-stop");
  await f.close();
  await stops.advanceNext();
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "0" });
  f.providerStorage.pressure();
  expect(await stops.request(f.actor, f.revisionId, f.reservation.reservationId)).toEqual(original);
  expect(await f.providerCapacity.inspect()).toMatchObject({ allocatedBytes: "0" });
});

test("pre-execution capacity rejects invalid private evidence and changed task identity", async () => {
  const f = await preexecutionCapacityFixture();
  await f.commitRelease();
  const submitted = (await f.target.get(f.actor, f.revisionId, f.release.releaseId)).submission;
  if (!submitted) throw new Error("Missing private release");
  await db
    .update(attempts)
    .set({ stage: "invalid", validationCode: 11 })
    .where(eq(attempts.submissionId, submitted.id));
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "80" });
  expect((await f.taskClaim(true))?.releaseBlocker).toBe("release-evidence");
  await db
    .update(attempts)
    .set({ stage: "committed", validationCode: 0 })
    .where(eq(attempts.submissionId, submitted.id));
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  await db
    .update(claims)
    .set({ digest: `sha256:${"f".repeat(64)}` })
    .where(and(eq(claims.localSiteId, f.b.signing.siteId), eq(claims.kind, "task")));
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "60" });
  expect((await f.taskClaim(true))?.releaseBlocker).toBe("identity");
});

test("pre-execution capacity waits for execution automation and fences subsequent discovery retry and conflicting releases", async () => {
  const f = await preexecutionCapacityFixture();
  await f.sourceAutomation.discover();
  await f.commitRelease();
  await f.close();
  expect(await f.scan()).toMatchObject({ allocatedBytes: "60" });
  expect((await f.taskClaim())?.releaseBlocker).toBe("proposal");
  await f.sourceAutomation.advanceNext();
  expect(await f.scan()).toMatchObject({ allocatedBytes: "0" });
  await f.sourceAutomation.discover();
  expect(await f.sourceAutomation.advanceNext()).toBe(false);
  await expect(
    f.sourceAutomation.retry(f.actor, f.revisionId, f.reservation.reservationId),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(f.marketAdapter.inputs.some((input) => input.operation === "activate-demand")).toBe(false);
  await expect(
    f.sourceExecution.approve(f.actor, f.revisionId, { ...f.release, releaseId: randomUUID() }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  const original = await f.sourceExecution.get(f.actor, f.revisionId, f.release.releaseId);
  expect((await f.sourceExecution.approve(f.actor, f.revisionId, f.release)).approvalJws).toBe(
    original.approvalJws,
  );
  expect(await f.sourceCapacity.inspect()).toMatchObject({ allocatedBytes: "0" });
});

test("pre-execution capacity discovery skips signatures being attached and cannot enqueue a stale exchange after them", async () => {
  const f = await executionApprovalExchangeFixture();
  await db.transaction(async (tx) => {
    await tx
      .select()
      .from(executionApprovals)
      .where(
        and(
          eq(executionApprovals.localSiteId, f.a.signing.siteId),
          eq(executionApprovals.recordId, f.reservation.reservationId),
        ),
      )
      .for("update");
    await f.transport.a.discover();
    expect((await f.transport.a.list(f.actor, f.revisionId, 50, 0)).records).toHaveLength(0);
  });
  await f.execution.attachCounterparty(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    f.counterpart.approvalJws,
  );
  await f.transport.a.discover();
  expect((await f.transport.a.list(f.actor, f.revisionId, 50, 0)).records).toHaveLength(0);
});

test("execution automation discovery retires a stopped candidate without failing the worker pass", async () => {
  const f = await executionAutomationFixture();
  await db
    .update(executionApprovals)
    .set({
      stopId: randomUUID(),
      stopRequestedBy: f.actor.userId,
      stopRequestedAt: new Date(),
      stopNextAttemptAt: new Date(),
    })
    .where(eq(executionApprovals.localSiteId, f.a.signing.siteId));
  await f.sourceAutomation.discover();
  expect(await f.view()).toMatchObject({
    executionState: "needs_review",
    executionError: "CANCELLATION_REQUESTED",
    activationId: null,
  });
  expect(await f.sourceAutomation.advanceNext()).toBe(false);
  await f.sourceAutomation.discover();
  expect(await f.sourceAutomation.advanceNext()).toBe(false);
});

function unreservedClosedState(state: z.infer<typeof MarketDemandStateSchema>) {
  if (!state.claim) throw new Error("Missing original claim");
  return MarketDemandStateSchema.parse({
    ...state,
    digest: federationMaterialDigest(state.demand),
    status: "CLOSED",
    version: state.claim.expectedVersion + 2,
    unreservedClosure: {
      demandId: state.demand.demandId,
      closureId: randomUUID(),
      claimId: state.claim.claimId,
      commercialDomainId: state.claim.commercialDomainId,
      issuerSiteId: state.claim.providerSiteId,
      expectedVersion: state.claim.expectedVersion + 1,
    },
  });
}
async function observeTestClosure(siteId: string, state: z.infer<typeof MarketDemandStateSchema>) {
  return observeUnreservedClosure(db, siteId, {
    query: async () => ({ operation: "get-demand", demand: state }),
  });
}

test("unreserved local closure retires signed proposals and rejects retry and late receiver admission", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  await f.source.advanceNext();
  const signed = (await f.view())?.sourceJws;
  if (!signed) throw new Error("Missing source signature");
  const closed = unreservedClosedState(f.state);
  for (const site of [f.a.signing.siteId, f.b.signing.siteId]) {
    await observeTestClosure(site, closed);
    await retireUnreservedIntents(db, site);
  }
  expect(await f.view()).toMatchObject({
    state: "closed",
    executionState: "closed",
    sourceJws: signed,
  });
  expect(await f.source.advanceNext()).toBe(false);
  await expect(f.source.retry(f.actor, f.revisionId, f.reservation.reservationId)).rejects.toThrow(
    "CANCELLATION_REQUESTED",
  );
  await expect(f.target.receive(signed, f.fingerprints[0] ?? "")).rejects.toThrow(
    "CANCELLATION_REQUESTED",
  );
  expect(await f.view(true)).toBeUndefined();
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toThrow(
    "CANCELLATION_REQUESTED",
  );
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(1);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toThrow(
    "POLICY_DENIED",
  );
});

test("unreserved local closure during claim preflight fences a stale success before signing and consuming authority", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  f.beforeClaim(async () => {
    await observeTestClosure(f.a.signing.siteId, unreservedClosedState(f.state));
  });
  await f.source.advanceNext();
  expect(await f.view()).toMatchObject({
    state: "needs_review",
    lastError: "CANCELLATION_REQUESTED",
    approvedAt: null,
  });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
  await retireUnreservedIntents(db, f.a.signing.siteId);
  expect(await f.view()).toMatchObject({ state: "closed", leaseToken: null });
});

test("unreserved local closure prevents signature rediscovery attachment and manual exchange retry", async () => {
  const f = await executionApprovalExchangeFixture();
  await f.transport.a.discover();
  const closed = unreservedClosedState(f.state);
  for (const site of [f.a.signing.siteId, f.b.signing.siteId]) {
    await observeTestClosure(site, closed);
    await retireUnreservedIntents(db, site);
  }
  expect((await f.transport.a.list(f.actor, f.revisionId, 50, 0)).records[0]?.state).toBe("closed");
  await f.transport.b.discover();
  expect((await f.transport.b.list(f.actor, f.revisionId, 50, 0)).records).toHaveLength(0);
  await expect(
    f.transport.a.retry(f.actor, {
      recordKind: "reservation",
      recordId: f.reservation.reservationId,
      agreementRevisionId: f.revisionId,
    }),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
  await expect(
    f.execution.attachCounterparty(
      f.actor,
      f.revisionId,
      f.reservation.reservationId,
      f.counterpart.approvalJws,
    ),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
  expect(
    (await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).submission,
  ).toBeNull();
});

test("unreserved local closure ends automatic market handoff but preserves completed requests and original policy use", async () => {
  const f = await marketRequestFixture();
  await f.claim();
  const state = f.state();
  if (!state) throw new Error("Missing market state");
  const closed = unreservedClosedState(state);
  for (const site of [f.a.signing.siteId, f.b.signing.siteId]) {
    await observeTestClosure(site, closed);
    await retireUnreservedIntents(db, site);
  }
  expect(await f.view()).toMatchObject({ state: "closed", completedAt: null });
  expect(await f.view(true)).toMatchObject({ state: "complete" });
  await expect(
    f.source.retry(f.actor, f.revisionId, f.request.proposal.reservationId),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
  expect(await f.source.advanceNext()).toBe(false);
  expect((await f.submit()).state).toBe("closed");
  expect(
    await db
      .select()
      .from(federationReservationProposals)
      .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.marketAuthorizedTasks).toBe(1);
});

test("unreserved local closure preserves unknown private transactions for recovery but forbids a fresh retry", async () => {
  const f = await executionFixture();
  await approveReservation(f);
  for (let i = 0; i < 5; i++) await f.service.advanceNext();
  const before = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
  if (!before.submission) throw new Error("Missing reserve submission");
  expect(before.submission.transaction?.stage).toBe("transaction");
  await observeTestClosure(f.a.signing.siteId, unreservedClosedState(f.state));
  await db
    .update(submissions)
    .set({ state: "needs_review" })
    .where(eq(submissions.id, before.submission.id));
  await f.service.retry(f.actor, f.revisionId, before.submission.id);
  f.adapter.outcome = "invalid";
  await f.service.advanceNext();
  const after = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
  expect(after.submission?.transaction).toMatchObject({
    stage: "invalid",
    transactionId: before.submission.transaction?.transactionId,
  });
  await expect(f.service.retry(f.actor, f.revisionId, before.submission.id)).rejects.toThrow(
    "CANCELLATION_REQUESTED",
  );
  expect(
    f.adapter.prepares.filter((input) => input.operation === "reserve-execution"),
  ).toHaveLength(1);
});

test("unreserved local closure waits for live leases and fences expired workers without deleting signed history", async () => {
  const f = await reservationProposalFixture();
  await f.submit();
  const token = randomUUID();
  await db
    .update(federationReservationProposals)
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + 60_000) })
    .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
  await observeTestClosure(f.a.signing.siteId, unreservedClosedState(f.state));
  await retireUnreservedIntents(db, f.a.signing.siteId);
  expect(await f.view()).toMatchObject({ state: "pending", leaseToken: token });
  await db
    .update(federationReservationProposals)
    .set({ leaseUntil: new Date(0) })
    .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
  await retireUnreservedIntents(db, f.a.signing.siteId);
  expect(await f.view()).toMatchObject({
    state: "closed",
    leaseToken: null,
    executionState: "closed",
  });
  expect(await f.source.advanceNext()).toBe(false);
});

test("unreserved local closure drains an exact pending stop without an activation but refuses a different claim", async () => {
  const f = await executionApprovalExchangeFixture();
  let state = unreservedClosedState(f.state);
  const stops = new FederationExecutionStopService(db, f.a.signing.siteId, {
    query: async () => ({ operation: "get-demand", demand: state }),
  });
  await stops.request(f.actor, f.revisionId, f.reservation.reservationId);
  const original = structuredClone(state);
  if (!state.claim || !state.unreservedClosure) throw new Error("Missing claim");
  state.claim.claimId = randomUUID();
  state.unreservedClosure.claimId = state.claim.claimId;
  await stops.advanceNext();
  expect(
    (await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).stopLastError,
  ).toBe("OPERATION_CONFLICT");
  await db
    .update(executionApprovals)
    .set({ stopNextAttemptAt: new Date(0) })
    .where(
      and(
        eq(executionApprovals.localSiteId, f.a.signing.siteId),
        eq(executionApprovals.recordId, f.reservation.reservationId),
      ),
    );
  state = original;
  await stops.advanceNext();
  expect(await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId)).toMatchObject({
    stopNextAttemptAt: null,
    stopLastError: null,
    stopSubmission: null,
  });
});

test("unreserved local closure also retires preapproved releases without creating replacement ledger work", async () => {
  const f = await executionApprovalExchangeFixture();
  await f.execution.attachCounterparty(
    f.actor,
    f.revisionId,
    f.reservation.reservationId,
    f.counterpart.approvalJws,
  );
  const release = await releasePayload(f);
  const approved = await f.execution.approve(f.actor, f.revisionId, release);
  await f.transport.a.discover();
  await observeTestClosure(f.a.signing.siteId, unreservedClosedState(f.state));
  await retireUnreservedIntents(db, f.a.signing.siteId);
  const sync = (await f.transport.a.list(f.actor, f.revisionId, 50, 0)).records.find(
    (row) => row.recordId === release.releaseId,
  );
  expect(sync?.state).toBe("closed");
  await expect(
    f.execution.attachCounterparty(
      f.actor,
      f.revisionId,
      release.releaseId,
      await signFederationMessage(CommercialExecutionApprovalSchema, release, f.b.signing),
    ),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
  const view = await f.execution.get(f.actor, f.revisionId, release.releaseId);
  expect(view.approvalJws).toBe(approved.approvalJws);
  expect(view.submission).toBeNull();
  await f.transport.a.discover();
  expect(await f.transport.a.advanceNext()).toBe(false);
});

async function unreservedCapacityFixture(signed = false) {
  const f = await reservationProposalFixture();
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  await f.submit();
  if (signed) {
    await f.source.advanceNext();
    await f.source.advanceNext();
    await f.target.advanceNext();
  }
  const providerLedger = new FederationCommercialSubmissionService(
    db,
    f.b.signing.siteId,
    f.adapter,
  );
  for (let i = 0; i < 3; i++) {
    await f.service.advanceNext();
    await providerLedger.advanceNext();
  }
  const capacities: InstanceType<typeof FederationCompletionCapacity>[] = [];
  for (const site of [f.a.signing.siteId, f.b.signing.siteId]) {
    const storage = testCompletionStorage();
    const capacity = new FederationCompletionCapacity(db, site, storage.guard);
    await capacity.configure(
      { reserveId: storage.reserveId, capacityBytes: "200", taskBytes: "60", marketBytes: "20" },
      f.actor.userId,
    );
    capacities.push(capacity);
  }
  const sourceCapacity = capacities[0],
    providerCapacity = capacities[1];
  if (!sourceCapacity || !providerCapacity) throw new Error("Missing capacity fixture");
  const sourceExecution = new FederationCommercialExecutionService(db, f.a.signing, f.market);
  const close = async () => {
    const state = unreservedClosedState(f.state);
    for (const site of [f.a.signing.siteId, f.b.signing.siteId])
      await observeTestClosure(site, state);
  };
  const retire = async () => {
    for (const site of [f.a.signing.siteId, f.b.signing.siteId])
      await retireUnreservedIntents(db, site);
  };
  const scan = async (provider = false) => {
    const site = provider ? f.b.signing.siteId : f.a.signing.siteId;
    await db
      .update(claims)
      .set({ nextCheckAt: new Date(0) })
      .where(eq(claims.localSiteId, site));
    const capacity = provider ? providerCapacity : sourceCapacity;
    for (let i = 0; i < 4; i++) if (!(await capacity.advanceNext())) break;
    return capacity.inspect();
  };
  const reserve = async () => {
    const other = await f.execution.get(f.actor, f.revisionId, f.reservation.reservationId);
    await sourceExecution.attachCounterparty(
      f.actor,
      f.revisionId,
      f.reservation.reservationId,
      other.approvalJws,
    );
  };
  const record = () => sourceExecution.get(f.actor, f.revisionId, f.reservation.reservationId);
  return {
    ...f,
    sourceCapacity,
    providerCapacity,
    sourceExecution,
    close,
    retire,
    scan,
    reserve,
    record,
    claims,
  };
}

test("unreserved capacity releases an unsigned closed task and both manual market allocations after local queues drain", async () => {
  const f = await unreservedCapacityFixture();
  expect((await f.scan()).allocatedBytes).toBe("80");
  await f.close();
  expect((await f.scan()).allocatedBytes).toBe("80");
  await f.retire();
  expect(await f.scan()).toMatchObject({ allocatedBytes: "0", releasedObligations: 2 });
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "0", releasedObligations: 1 });
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(0);
  await expect(f.source.retry(f.actor, f.revisionId, f.reservation.reservationId)).rejects.toThrow(
    "CANCELLATION_REQUESTED",
  );
});

test("unreserved capacity abandons only unbroadcast proposals and exposes closed ledger status without a success receipt", async () => {
  const f = await unreservedCapacityFixture(true);
  await f.reserve();
  await f.service.advanceNext();
  const before = await f.record();
  expect(before.submission?.transaction?.stage).toBe("proposal");
  await f.close();
  await f.retire();
  const after = await f.record();
  expect(after.submission).toMatchObject({
    state: "closed",
    transaction: {
      stage: "abandoned",
      transactionId: before.submission?.transaction?.transactionId,
    },
  });
  expect((await f.scan()).allocatedBytes).toBe("0");
  expect((await f.scan(true)).allocatedBytes).toBe("0");
  await expect(f.service.retry(f.actor, f.revisionId, before.submission?.id ?? "")).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

test("unreserved capacity retains an unknown private transaction until its original INVALID is recovered", async () => {
  const f = await unreservedCapacityFixture(true);
  await f.reserve();
  for (let i = 0; i < 2; i++) await f.service.advanceNext();
  const before = await f.record();
  expect(before.submission?.transaction?.stage).toBe("transaction");
  await f.close();
  await f.retire();
  expect((await f.scan()).allocatedBytes).toBe("80");
  expect((await f.scan(true)).allocatedBytes).toBe("0");
  f.adapter.outcome = "invalid";
  await new FederationCommercialSubmissionService(db, f.a.signing.siteId, f.adapter).advanceNext();
  await f.retire();
  expect((await f.record()).submission).toMatchObject({
    state: "closed",
    transaction: { stage: "invalid", transactionId: before.submission?.transaction?.transactionId },
  });
  expect((await f.scan()).allocatedBytes).toBe("0");
  expect(
    f.adapter.prepares.filter((input) => input.operation === "reserve-execution"),
  ).toHaveLength(1);
});

test("unreserved capacity keeps a live lease and rejects changed evidence or task bytes before release", async () => {
  const f = await unreservedCapacityFixture();
  await db
    .update(federationReservationProposals)
    .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) })
    .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
  await f.close();
  await f.retire();
  expect((await f.scan()).allocatedBytes).toBe("80");
  await db
    .update(federationReservationProposals)
    .set({ leaseUntil: new Date(0) })
    .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
  await f.retire();
  const [evidence] = await db
    .select()
    .from(federationUnreservedClosures)
    .where(eq(federationUnreservedClosures.localSiteId, f.a.signing.siteId));
  if (!evidence) throw new Error("Missing closure evidence");
  await db
    .update(federationUnreservedClosures)
    .set({ digest: `sha256:${"0".repeat(64)}` })
    .where(eq(federationUnreservedClosures.localSiteId, f.a.signing.siteId));
  expect((await f.scan()).allocatedBytes).toBe("80");
  await db
    .update(federationUnreservedClosures)
    .set({ digest: evidence.digest })
    .where(eq(federationUnreservedClosures.localSiteId, f.a.signing.siteId));
  const original = await f.view();
  if (!original) throw new Error("Missing proposal");
  await db
    .update(federationReservationProposals)
    .set({ digest: `sha256:${"0".repeat(64)}` })
    .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
  expect((await f.scan()).allocatedBytes).toBe("80");
  await db
    .update(federationReservationProposals)
    .set({ digest: original.digest })
    .where(eq(federationReservationProposals.localSiteId, f.a.signing.siteId));
  expect((await f.scan()).allocatedBytes).toBe("0");
});

test("unreserved capacity rollback preserves proposal checkpoints and allocations when retirement audit fails", async () => {
  const f = await unreservedCapacityFixture(true);
  await f.reserve();
  await f.service.advanceNext();
  await f.close();
  await db.execute(
    sql`CREATE FUNCTION unreserved_retire_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.commercial.retire_unreserved' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER unreserved_retire_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION unreserved_retire_audit_fail()`,
  );
  try {
    await expect(f.retire()).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER unreserved_retire_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION unreserved_retire_audit_fail()`);
  }
  expect((await f.record()).submission).toMatchObject({
    state: "pending",
    transaction: { stage: "proposal" },
  });
  expect((await f.scan()).allocatedBytes).toBe("80");
  await f.retire();
  expect((await f.scan()).allocatedBytes).toBe("0");
});

test("unreserved capacity refuses inconsistent committed private evidence and does not infer a refund", async () => {
  const f = await unreservedCapacityFixture(true);
  await f.reserve();
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  await f.close();
  await f.retire();
  expect((await f.record()).submission?.state).toBe("committed");
  expect((await f.scan()).allocatedBytes).toBe("80");
  expect((await f.sourcePolicies.list(f.actor, f.revisionId))[0]?.authorizedTasks).toBe(1);
});

test("unreserved capacity retains an active parent workflow and release auditing remains atomic", async () => {
  const f = await unreservedCapacityFixture();
  const runId = randomUUID();
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Unreserved parent workflow",
    status: "running",
    submittedBy: f.actor.userId,
  });
  await db.insert(workflowExecutionLeases).values({ runId });
  await db.insert(workflowExecutionDelegations).values({
    runId,
    pathHash: "a".repeat(64),
    path: "remote",
    nodeId: "remote",
    localSiteId: f.a.signing.siteId,
    operationId: f.reservation.request.operationId,
    intentDigest: "b".repeat(64),
    request: f.reservation.request,
  });
  await f.close();
  await f.retire();
  expect((await f.scan()).allocatedBytes).toBe("80");
  await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, runId));
  await db.execute(
    sql`CREATE FUNCTION unreserved_release_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.storage.completion.release' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER unreserved_release_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION unreserved_release_audit_fail()`,
  );
  try {
    await expect(f.scan()).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER unreserved_release_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION unreserved_release_audit_fail()`);
  }
  expect((await f.sourceCapacity.inspect()).allocatedBytes).toBe("80");
  expect((await f.scan()).allocatedBytes).toBe("0");
});

async function refundFixture(admitted = true, mode: FederationMode = "bilateral_direct") {
  const f = await fixture(mode, true, true);
  f.terms.agreement.budgetLimit = "90071992547409931";
  f.terms.agreement.maxTaskAmount = "9007199254740993";
  for (const key of [f.a, f.b]) {
    const [row] = await db
      .select()
      .from(federationSigningKeys)
      .where(eq(federationSigningKeys.keyId, key.signing.keyId));
    if (!row) throw new Error("Missing fixture key");
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: [...row.allowedKinds, "commercial-refund"] })
      .where(eq(federationSigningKeys.keyId, key.signing.keyId));
  }
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "settlement.approve", enabled: true },
    f.actor.userId,
  );
  const approved = await approveBoth(f);
  const providerContract = new FederationCommercialAgreementService(db, f.b.signing);
  await providerContract.approve(f.actor, f.terms);
  await providerContract.attachCounterparty(f.actor, f.revisionId, approved.own.approvalJws);
  const sourceAgreement = new FederationAgreementService(db, f.a.signing);
  const own = await sourceAgreement.approve(f.actor, { terms: f.terms.agreement });
  const other = await signFederationMessage(
    FederationAgreementSchema,
    f.terms.agreement,
    f.b.signing,
  );
  await sourceAgreement.attachCounterparty(f.actor, f.revisionId, other);
  const executionUserId = randomUUID();
  await db.insert(users).values({
    id: executionUserId,
    orgId: f.actor.orgId,
    email: `${executionUserId}@test.invalid`,
    role: "user",
    serviceAccount: true,
  });
  await db
    .insert(userOrgMemberships)
    .values({ userId: executionUserId, orgId: f.actor.orgId, role: "member" });
  const aKey = await f.trust.resolveKey(f.a.signing.siteId, f.a.signing.keyId, new Date());
  const bKey = await f.trust.resolveKey(f.b.signing.siteId, f.b.signing.keyId, new Date());
  const admission = new FederationAdmission(db, f.b.signing, bKey);
  await admission.installApprovedAgreement({
    sourceApprovalJws: own.approvalJws,
    targetApprovalJws: other,
    sourceKey: aKey,
    targetKey: bKey,
    identity: { userId: executionUserId, orgId: f.actor.orgId },
  });
  const request = FederationDelegationSchema.parse({
    ...testDelegation(f.terms.agreement),
    maxAmount: f.terms.agreement.maxTaskAmount,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const requestJws = await signFederationMessage(FederationDelegationSchema, request, f.a.signing);
  const verified = await verifyFederationMessage(
    FederationDelegationSchema,
    requestJws,
    aKey,
    new Date(),
  );
  const accepted = admitted
    ? await admission.receive({
        requestJws,
        authenticatedPeerSiteId: f.a.signing.siteId,
        senderKey: aKey,
      })
    : null;
  const receipt = accepted
    ? (
        await verifyFederationMessage(
          FederationAcceptanceSchema,
          accepted.receiptJws,
          bKey,
          new Date(),
        )
      ).payload
    : null;
  const cancel = FederationCancellationSchema.parse({
    protocolVersion: 1,
    kind: "cancellation",
    operationId: request.operationId,
    senderSiteId: request.senderSiteId,
    recipientSiteId: request.recipientSiteId,
    agreementRevisionId: f.revisionId,
    taskId: request.taskId,
    attempt: request.attempt,
    requestDigest: verified.digest,
    issuedAt: new Date().toISOString(),
  });
  const cancelJws = await signFederationMessage(FederationCancellationSchema, cancel, f.a.signing);
  const cancellation = await verifyFederationMessage(
    FederationCancellationSchema,
    cancelJws,
    aKey,
    new Date(),
  );
  const recordedAt = new Date();
  const { issuedAt: _cancelIssuedAt, ...cancelIdentity } = cancel;
  const cancelReceipt = FederationCancellationReceiptSchema.parse({
    ...cancelIdentity,
    kind: "cancellation-receipt",
    senderSiteId: request.recipientSiteId,
    recipientSiteId: request.senderSiteId,
    cancellationDigest: cancellation.digest,
    recordedAt: recordedAt.toISOString(),
    observedAt: recordedAt.toISOString(),
    reservationId: accepted?.reservationId ?? null,
    state: "stopped",
    workflow: null,
  });
  const cancelReceiptJws = await signFederationMessage(
    FederationCancellationReceiptSchema,
    cancelReceipt,
    f.b.signing,
  );
  await db.insert(federationCancellations).values({
    localSiteId: f.b.signing.siteId,
    senderSiteId: f.a.signing.siteId,
    operationId: request.operationId,
    agreementRevisionId: f.revisionId,
    requestDigest: verified.digest,
    cancellationDigest: cancellation.digest,
    request: cancel,
    requestJws: cancelJws,
    recordedAt,
    confirmedAt: recordedAt,
  });
  await db.insert(federationOutbound).values({
    localSiteId: f.a.signing.siteId,
    operationId: request.operationId,
    agreementRevisionId: f.revisionId,
    localOrgId: f.actor.orgId,
    submittedBy: f.actor.userId,
    taskId: request.taskId,
    attempt: request.attempt,
    budgetDomainId: request.budgetDomainId,
    epoch: request.epoch,
    amount: request.maxAmount,
    endpoint: "https://test.invalid",
    request,
    requestDigest: verified.digest,
    requestJws,
    receipt,
    receiptJws: accepted?.receiptJws ?? null,
    state: admitted ? "accepted" : "queued",
    cancelRequest: cancel,
    cancelJws,
    cancelDigest: cancellation.digest,
    cancelRequestedBy: f.actor.userId,
    cancelState: "stopped",
    cancelReceipt,
    cancelReceiptJws,
    cancelNextAttemptAt: recordedAt,
  });
  const source = new FederationRefundService(db, f.a.signing),
    provider = new FederationRefundService(db, f.b.signing);
  const value = await source.draft(
    f.actor,
    f.revisionId,
    request.operationId,
    randomUUID(),
    "Cancelled before execution",
  );
  const budget = async () =>
    (
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, request.budgetDomainId))
    )[0];
  return { ...f, source, provider, value, request, requestJws, accepted, admission, aKey, budget };
}

test.each([
  true,
  false,
])("bilateral refund applies once after both financial signatures, preserves cancellation and original admission (admitted=%s)", async (admitted) => {
  const f = await refundFixture(admitted);
  const before = await f.budget();
  const a = await f.source.approve(f.actor, f.revisionId, f.value);
  const b = await f.provider.approve(f.actor, f.revisionId, f.value);
  expect(await f.budget()).toEqual(before);
  await Promise.all([
    f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws),
    f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws),
  ]);
  await f.source.attachCounterparty(f.actor, f.revisionId, f.value.refundId, b.approvalJws);
  const restarted = new FederationRefundService(db, f.b.signing);
  await restarted.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws);
  expect(await f.budget()).toMatchObject({
    available: f.terms.agreement.budgetLimit,
    reserved: "0",
    spent: "0",
  });
  const [operation] = await db
    .select()
    .from(federationOutbound)
    .where(eq(federationOutbound.operationId, f.request.operationId));
  expect(operation).toMatchObject({
    settledAmount: "0",
    amount: f.request.maxAmount,
    cancelState: "stopped",
    state: admitted ? "accepted" : "queued",
  });
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.appliedAt).toBeInstanceOf(
    Date,
  );
  expect(
    await db
      .select()
      .from(submissions)
      .where(inArray(submissions.localSiteId, [f.a.signing.siteId, f.b.signing.siteId])),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.orgId, f.actor.orgId), eq(auditLog.action, "federation.refund.apply")),
      ),
  ).toHaveLength(2);
  await expect(
    f.provider.approve(f.actor, f.revisionId, { ...f.value, refundId: randomUUID() }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  if (admitted) {
    if (!f.accepted) throw new Error("Missing admission fixture");
    expect(
      (
        await f.admission.receive({
          requestJws: f.requestJws,
          authenticatedPeerSiteId: f.a.signing.siteId,
          senderKey: f.aKey,
        })
      ).reservationId,
    ).toBe(f.accepted.reservationId);
    const [reservation] = await db
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.id, f.accepted.reservationId));
    expect(reservation).toMatchObject({ settledAmount: "0", amount: f.request.maxAmount });
  } else
    await expect(
      f.admission.receive({
        requestJws: f.requestJws,
        authenticatedPeerSiteId: f.a.signing.siteId,
        senderKey: f.aKey,
      }),
    ).rejects.toThrow("CANCELLATION_REQUESTED");
  expect(await f.budget()).toMatchObject({
    available: f.terms.agreement.budgetLimit,
    reserved: "0",
    spent: "0",
  });
});

test("bilateral refund needs a distinct financial grant and explicit key purpose, not cancellation authority", async () => {
  const f = await refundFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "settlement.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.source.approve(f.actor, f.revisionId, f.value)).rejects.toThrow("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "settlement.approve", enabled: true },
    f.actor.userId,
  );
  const [key] = await db
    .select()
    .from(federationSigningKeys)
    .where(eq(federationSigningKeys.keyId, f.a.signing.keyId));
  if (!key) throw new Error("Missing key");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: key.allowedKinds.filter((v) => v !== "commercial-refund") })
    .where(eq(federationSigningKeys.keyId, f.a.signing.keyId));
  await expect(f.source.approve(f.actor, f.revisionId, f.value)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
});

test("bilateral refund refuses an executed workflow even when a stale signed cancellation receipt says no workflow", async () => {
  const f = await refundFixture();
  if (!f.accepted) throw new Error("Missing admission");
  await db.insert(workflowRuns).values({
    id: randomUUID(),
    submittedBy: f.actor.userId,
    name: "Cancelled refund fixture",
    status: "cancelled",
    input: {
      federationReservationId: f.accepted.reservationId,
      yaml: "",
      role: "user",
      orgId: f.actor.orgId,
    },
  });
  await expect(f.provider.approve(f.actor, f.revisionId, f.value)).rejects.toThrow("DATA_WAITING");
  expect((await f.budget())?.reserved).toBe(f.request.maxAmount);
});

test("bilateral refund rejects altered task, amount, signature and institution before changing any balance", async () => {
  const f = await refundFixture();
  const before = await f.budget();
  await expect(
    f.source.approve(f.actor, f.revisionId, { ...f.value, releasedAmount: "1" }),
  ).rejects.toThrow();
  await expect(
    f.provider.approve(f.actor, f.revisionId, {
      ...f.value,
      request: { ...f.request, taskId: randomUUID() },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.source.approve({ ...f.actor, orgId: randomUUID() }, f.revisionId, f.value),
  ).rejects.toThrow();
  const a = await f.source.approve(f.actor, f.revisionId, f.value);
  await expect(
    f.source.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws),
  ).rejects.toThrow();
  expect(await f.budget()).toEqual(before);
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.appliedAt).toBeNull();
});

test("bilateral refund rolls back signatures, budget and applied marker when the application audit fails", async () => {
  const f = await refundFixture();
  const a = await f.source.approve(f.actor, f.revisionId, f.value);
  await f.provider.approve(f.actor, f.revisionId, f.value);
  const before = await f.budget();
  await db.execute(
    sql`CREATE FUNCTION refund_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.refund.apply' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER refund_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refund_audit_fail()`,
  );
  try {
    await expect(
      f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws),
    ).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER refund_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION refund_audit_fail()`);
  }
  expect(await f.budget()).toEqual(before);
  expect((await f.provider.list(f.actor, f.revisionId, 10, 0)).data[0]).toMatchObject({
    appliedAt: null,
    counterpartyJws: null,
  });
  await f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws);
  expect((await f.budget())?.reserved).toBe("0");
});

test("bilateral refund rejects pending cancellation and altered stored approval bytes", async () => {
  const f = await refundFixture();
  const original = await db
    .select()
    .from(federationCancellations)
    .where(eq(federationCancellations.operationId, f.request.operationId));
  await db
    .update(federationCancellations)
    .set({ confirmedAt: null })
    .where(eq(federationCancellations.operationId, f.request.operationId));
  await expect(f.provider.approve(f.actor, f.revisionId, f.value)).rejects.toThrow("DATA_WAITING");
  await db
    .update(federationCancellations)
    .set({ confirmedAt: original[0]?.confirmedAt })
    .where(eq(federationCancellations.operationId, f.request.operationId));
  const a = await f.source.approve(f.actor, f.revisionId, f.value);
  await f.provider.approve(f.actor, f.revisionId, f.value);
  await db
    .update(federationCommercialRefunds)
    .set({ payload: { ...f.value, reason: "Changed after signature" } })
    .where(
      and(
        eq(federationCommercialRefunds.localSiteId, f.b.signing.siteId),
        eq(federationCommercialRefunds.refundId, f.value.refundId),
      ),
    );
  await expect(
    f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect((await f.budget())?.reserved).toBe(f.request.maxAmount);
});

test("bilateral refund HTTP requires a human financial approver and returns private no-store history", async () => {
  const f = await refundFixture(false);
  let human = true,
    automation = false;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    if (human)
      c.set("principal" as never, { userId: f.actor.userId, orgId: f.actor.orgId } as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route(
    "/api",
    createFederationCommercialRoutes(
      f.approvals,
      f.service,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.source,
    ),
  );
  const path = `/api/federation/commercial-agreements/${f.revisionId}/refunds`;
  const post = () =>
    app.request(`${path}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f.value),
    });
  human = false;
  expect((await post()).status).toBe(403);
  human = true;
  automation = true;
  expect((await post()).status).toBe(403);
  automation = false;
  const approved = await post();
  expect(approved.status).toBe(201);
  expect(approved.headers.get("cache-control")).toBe("no-store");
  const record = await f.provider.approve(f.actor, f.revisionId, f.value);
  const applied = await app.request(`${path}/${f.value.refundId}/counterparty`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approvalJws: record.approvalJws }),
  });
  expect(applied.status).toBe(200);
  const list = await app.request(path);
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await list.json())).toContain(f.value.refundId);
});

test("bilateral refund cannot bypass coordinated execution gates", async () => {
  const f = await fixture("ledger_coordinated");
  await approveBoth(f);
  const refunds = new FederationRefundService(db, f.a.signing);
  await expect(
    refunds.draft(f.actor, f.revisionId, randomUUID(), randomUUID(), "Wrong mode"),
  ).rejects.toThrow("POLICY_DENIED");
});

test("bilateral refund historical unadmitted approval is counted when completion capacity is enabled later", async () => {
  const f = await refundFixture(false);
  await f.provider.approve(f.actor, f.revisionId, f.value);
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const storage = testCompletionStorage();
  const capacity = new FederationCompletionCapacity(db, f.b.signing.siteId, storage.guard);
  await capacity.configure(
    { reserveId: storage.reserveId, capacityBytes: "100", taskBytes: "60", marketBytes: "20" },
    f.actor.userId,
  );
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
  await capacity.advanceNext();
  expect((await capacity.inspect()).allocatedBytes).toBe("60");
});

test("refund exchange waits for independent approval, resumes the same signatures after loss and applies each side once", async () => {
  const f = await refundFixture();
  const transport = await approvalTransport(f);
  const a = await f.source.approve(f.actor, f.revisionId, f.value);
  await transport.a.discover();
  await transport.a.advanceNext();
  const view = async () =>
    (await transport.a.list(f.actor, f.revisionId, 50, 0)).records.find(
      (row) => row.recordKind === "refund",
    );
  expect((await view())?.state).toBe("pending");
  expect((await f.budget())?.reserved).toBe(f.request.maxAmount);
  const b = await f.provider.approve(f.actor, f.revisionId, f.value);
  transport.lose(true);
  await transport.due();
  await transport.a.advanceNext();
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.appliedAt).toBeNull();
  transport.lose(false);
  await transport.due();
  await new FederationCommercialApprovalExchange(db, f.a.signing, transport.send).advanceNext();
  await transport.b.discover();
  await transport.b.advanceNext();
  expect((await view())?.state).toBe("complete");
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.counterpartyJws).toBe(
    b.approvalJws,
  );
  expect((await f.provider.list(f.actor, f.revisionId, 10, 0)).data[0]?.counterpartyJws).toBe(
    a.approvalJws,
  );
  expect((await f.budget())?.reserved).toBe("0");
  expect(await transport.a.advanceNext()).toBe(false);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.orgId, f.actor.orgId), eq(auditLog.action, "federation.refund.apply")),
      ),
  ).toHaveLength(2);
});

test("refund exchange cannot apply a late response after its lease expires", async () => {
  const f = await refundFixture();
  const transport = await approvalTransport(f);
  await f.source.approve(f.actor, f.revisionId, f.value);
  await f.provider.approve(f.actor, f.revisionId, f.value);
  await transport.a.discover();
  transport.hook(async (_query, response) => {
    await db
      .update(federationCommercialApprovalSyncs)
      .set({ leaseUntil: new Date(0) })
      .where(
        and(
          eq(federationCommercialApprovalSyncs.localSiteId, f.a.signing.siteId),
          eq(federationCommercialApprovalSyncs.recordKind, "refund"),
        ),
      );
    return response;
  });
  await transport.a.advanceNext();
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]).toMatchObject({
    appliedAt: null,
    counterpartyJws: null,
  });
  transport.hook(undefined);
  await transport.due();
  await transport.a.advanceNext();
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.appliedAt).toBeInstanceOf(
    Date,
  );
});

test("attested refund commits local release with a durable outbox while chain is offline, then only records evidence", async () => {
  const f = await refundFixture(true, "bilateral_attested");
  const a = await f.source.approve(f.actor, f.revisionId, f.value);
  const b = await f.provider.approve(f.actor, f.revisionId, f.value);
  await f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws);
  await f.source.attachCounterparty(f.actor, f.revisionId, f.value.refundId, b.approvalJws);
  await db
    .update(submissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(submissions.localSiteId, f.b.signing.siteId),
        sql`${submissions.input}->>'operation' = 'register-agreement'`,
      ),
    );
  // Isolate refund backlog from the separately tested acceptance-attestation queue.
  await db.delete(federationAttestationOutbox).where(
    inArray(
      federationAttestationOutbox.evidenceId,
      db
        .select({ id: federationEvidence.id })
        .from(federationEvidence)
        .where(eq(federationEvidence.reservationId, f.accepted?.reservationId ?? "")),
    ),
  );
  const { readAttestationBacklog } = await import("./attestation-backlog");
  expect(await readAttestationBacklog(db, f.terms.agreement, new Date())).toMatchObject({
    outstandingTasks: 1,
    outstandingAmount: f.request.maxAmount,
  });
  const adapter = new Adapter();
  adapter.offline = true;
  const service = new FederationCommercialSubmissionService(db, f.b.signing.siteId, adapter);
  expect(await service.advanceNext()).toBe(true);
  const rows = () =>
    db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, f.b.signing.siteId),
          sql`${submissions.input}->>'operation' = 'record-refund'`,
        ),
      );
  const first = (await rows())[0];
  expect(first).toMatchObject({ state: "pending", lastError: "LEDGER_UNAVAILABLE" });
  expect((await f.budget())?.reserved).toBe("0");
  adapter.offline = false;
  await db
    .update(submissions)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(submissions.id, first?.id ?? ""));
  for (let i = 0; i < 3; i++)
    await new FederationCommercialSubmissionService(db, f.b.signing.siteId, adapter).advanceNext();
  expect(await rows()).toHaveLength(1);
  expect((await rows())[0]).toMatchObject({ id: first?.id, state: "committed" });
  expect((await f.provider.list(f.actor, f.revisionId, 10, 0)).data[0]?.ledger).toMatchObject({
    id: first?.id,
    state: "committed",
    lastError: null,
  });
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.ledger).toBeNull();
  expect(await readAttestationBacklog(db, f.terms.agreement, new Date())).toMatchObject({
    outstandingTasks: 0,
    outstandingAmount: "0",
  });
  expect(await f.budget()).toMatchObject({
    available: f.terms.agreement.budgetLimit,
    reserved: "0",
    spent: "0",
  });
  await f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws);
  expect(await rows()).toHaveLength(1);
});

test("attested refund rolls back local release if its private evidence outbox cannot be saved", async () => {
  const f = await refundFixture(true, "bilateral_attested");
  const a = await f.source.approve(f.actor, f.revisionId, f.value);
  await f.provider.approve(f.actor, f.revisionId, f.value);
  await db.execute(
    sql`CREATE FUNCTION refund_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.input->>'operation' = 'record-refund' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER refund_outbox_fail BEFORE INSERT ON federation_commercial_submissions FOR EACH ROW EXECUTE FUNCTION refund_outbox_fail()`,
  );
  try {
    await expect(
      f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws),
    ).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER refund_outbox_fail ON federation_commercial_submissions`);
    await db.execute(sql`DROP FUNCTION refund_outbox_fail()`);
  }
  expect((await f.budget())?.reserved).toBe(f.request.maxAmount);
  expect((await f.provider.list(f.actor, f.revisionId, 10, 0)).data[0]).toMatchObject({
    appliedAt: null,
    counterpartyJws: null,
  });
});

async function refundCapacityFixture(admitted = true, mode: FederationMode = "bilateral_direct") {
  const f = await refundFixture(admitted, mode);
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  const a = await f.source.approve(f.actor, f.revisionId, f.value);
  const b = await f.provider.approve(f.actor, f.revisionId, f.value);
  const capacities: InstanceType<typeof FederationCompletionCapacity>[] = [];
  for (const key of [f.a, f.b]) {
    const storage = testCompletionStorage();
    const capacity = new FederationCompletionCapacity(db, key.signing.siteId, storage.guard);
    await capacity.configure(
      { reserveId: storage.reserveId, capacityBytes: "100", taskBytes: "60", marketBytes: "20" },
      f.actor.userId,
    );
    capacities.push(capacity);
  }
  const scan = async (provider = false) => {
    const site = (provider ? f.b : f.a).signing.siteId;
    await db
      .update(claims)
      .set({ nextCheckAt: new Date(0) })
      .where(eq(claims.localSiteId, site));
    const capacity = capacities[provider ? 1 : 0];
    if (!capacity) throw new Error("Missing refund capacity fixture");
    await capacity.advanceNext();
    const [claim] = await db.select().from(claims).where(eq(claims.localSiteId, site));
    return { ...(await capacity.inspect()), claim };
  };
  const apply = async () => {
    await f.source.attachCounterparty(f.actor, f.revisionId, f.value.refundId, b.approvalJws);
    await f.provider.attachCounterparty(f.actor, f.revisionId, f.value.refundId, a.approvalJws);
  };
  return { ...f, aApproval: a, bApproval: b, scan, apply, claims, capacities };
}

test.each([
  true,
  false,
])("refund completion retains single signatures then reclaims both sites without reopening the cancelled task (admitted=%s)", async (admitted) => {
  const f = await refundCapacityFixture(admitted);
  for (const provider of [false, true]) {
    expect(await f.scan(provider)).toMatchObject({
      allocatedBytes: "60",
      claim: { releaseBlocker: "refund" },
    });
  }
  await f.apply();
  const budget = await f.budget();
  for (const provider of [false, true]) {
    expect(await f.scan(provider)).toMatchObject({
      allocatedBytes: "0",
      claim: { releaseBlocker: null },
    });
  }
  await f.apply();
  expect(await f.budget()).toEqual(budget);
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "0" });
  expect(
    await db
      .select()
      .from(federationCancellations)
      .where(eq(federationCancellations.operationId, f.request.operationId)),
  ).toHaveLength(1);
});

test("refund completion waits for signature delivery and source leases after financial application", async () => {
  const f = await refundCapacityFixture();
  const exchange = (await approvalTransport(f)).a;
  await exchange.discover();
  await f.apply();
  expect(await f.scan()).toMatchObject({
    allocatedBytes: "60",
    claim: { releaseBlocker: "signature-exchange" },
  });
  expect(await exchange.advanceNext()).toBe(true);
  await db
    .update(federationOutbound)
    .set({ cancelLeaseOwner: randomUUID(), cancelLeaseUntil: new Date(Date.now() + 60000) })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  expect(await f.scan()).toMatchObject({
    allocatedBytes: "60",
    claim: { releaseBlocker: "outbound" },
  });
  await db
    .update(federationOutbound)
    .set({ cancelLeaseOwner: null, cancelLeaseUntil: null })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  expect(await f.scan()).toMatchObject({ allocatedBytes: "0" });
});

test("refund completion requires the original refund evidence VALID and retains the separate acceptance obligation", async () => {
  const f = await refundCapacityFixture(true, "bilateral_attested");
  await f.apply();
  expect(await f.scan(true)).toMatchObject({
    allocatedBytes: "60",
    claim: { releaseBlocker: "refund-ledger" },
  });
  const [refundSubmission] = await db
    .select()
    .from(submissions)
    .where(
      and(
        eq(submissions.localSiteId, f.b.signing.siteId),
        sql`${submissions.input}->>'operation' = 'record-refund'`,
      ),
    );
  if (!refundSubmission) throw new Error("Missing refund submission");
  await db
    .update(submissions)
    .set({ state: "committed" })
    .where(eq(submissions.id, refundSubmission.id));
  expect(await f.scan(true)).toMatchObject({
    allocatedBytes: "60",
    claim: { releaseBlocker: "refund-ledger" },
  });
  await db
    .update(submissions)
    .set({ state: "pending" })
    .where(eq(submissions.id, refundSubmission.id));
  const adapter = new Adapter();
  const worker = new FederationCommercialSubmissionService(db, f.b.signing.siteId, adapter);
  for (let i = 0; i < 8; i++) if (!(await worker.advanceNext())) break;
  expect(await f.scan(true)).toMatchObject({
    allocatedBytes: "60",
    claim: { releaseBlocker: "attestation" },
  });
  // Acceptance batching is covered separately; isolate its outstanding obligation here.
  await db.delete(federationAttestationOutbox).where(
    inArray(
      federationAttestationOutbox.evidenceId,
      db
        .select({ id: federationEvidence.id })
        .from(federationEvidence)
        .where(eq(federationEvidence.reservationId, f.accepted?.reservationId ?? "")),
    ),
  );
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "0" });
  expect((await f.budget())?.reserved).toBe("0");
});

test("refund completion retains corrupt refund identities and unconfirmed permanent cancellation", async () => {
  const f = await refundCapacityFixture();
  await f.apply();
  const { federationCommercialRefunds: refunds } = await import("@kuintessence/db");
  await db
    .update(refunds)
    .set({ digest: `sha256:${"0".repeat(64)}` })
    .where(eq(refunds.localSiteId, f.b.signing.siteId));
  expect(await f.scan(true)).toMatchObject({
    allocatedBytes: "60",
    claim: { releaseBlocker: "refund-identity" },
  });
  await db
    .update(refunds)
    .set({ digest: f.bApproval.digest })
    .where(eq(refunds.localSiteId, f.b.signing.siteId));
  await db
    .update(federationCancellations)
    .set({ confirmedAt: null })
    .where(eq(federationCancellations.operationId, f.request.operationId));
  expect(await f.scan(true)).toMatchObject({
    allocatedBytes: "60",
    claim: { releaseBlocker: "cancellation" },
  });
});

test("refund completion audit failure retains the allocation and a concurrent owner excludes release", async () => {
  const f = await refundCapacityFixture();
  await f.apply();
  await db.execute(
    sql`CREATE FUNCTION refund_release_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.storage.completion.release' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER refund_release_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refund_release_audit_fail()`,
  );
  try {
    await expect(f.scan(true)).rejects.toThrow();
    const [claim] = await db
      .select()
      .from(f.claims)
      .where(eq(f.claims.localSiteId, f.b.signing.siteId));
    expect(claim?.releasedAt).toBeNull();
  } finally {
    await db.execute(sql`DROP TRIGGER refund_release_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION refund_release_audit_fail()`);
  }
  await db.transaction(async (tx) => {
    await tx
      .select()
      .from(f.claims)
      .where(eq(f.claims.localSiteId, f.b.signing.siteId))
      .for("share");
    expect(await f.capacities[1]?.advanceNext()).toBe(false);
  });
  expect(await f.scan(true)).toMatchObject({ allocatedBytes: "0" });
});

test.each([
  true,
  false,
])("refund completion fences a late status poll after refund (response=%s)", async (response) => {
  const f = await refundCapacityFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "delegation.read", enabled: true },
    f.actor.userId,
  );
  let sent = false;
  const worker = new FederationOutboundService(
    db,
    f.a.signing,
    async (_endpoint, jws) => {
      sent = true;
      const { payload: query, digest } = await verifyFederationMessage(
        FederationStatusQuerySchema,
        jws,
        f.aKey,
        new Date(),
      );
      await f.apply();
      if (!response) throw new Error("Connection lost after refund");
      const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...identity } = query;
      return signFederationMessage(
        FederationStatusReportSchema,
        {
          ...identity,
          kind: "status-report",
          senderSiteId: query.recipientSiteId,
          recipientSiteId: query.senderSiteId,
          queryDigest: digest,
          observedAt: new Date().toISOString(),
          preparation: null,
          workflow: null,
        },
        f.b.signing,
      );
    },
    new FederationAssetService(db, {
      authorizeSoftware: async () => {
        throw new Error("No software access expected");
      },
    }),
  );
  expect(await worker.refreshStatusNext()).toBe(true);
  expect(sent).toBe(true);
  const [row] = await db
    .select()
    .from(federationOutbound)
    .where(eq(federationOutbound.operationId, f.request.operationId));
  expect(row).toMatchObject({
    statusClaim: null,
    statusNextAttemptAt: null,
    statusLastError: null,
    statusReport: null,
    settledAmount: "0",
  });
  expect(await worker.refreshStatusNext()).toBe(false);
  expect(await f.scan()).toMatchObject({ allocatedBytes: "0" });
});

test("refund CLI real HTTP and PostgreSQL preserve original signatures, filters and organization scope", async () => {
  const { mkdtemp, rm, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { CommercialRefundSchema, CommercialRefundApprovalSchema, CommercialRefundListSchema } =
    await import("@kuintessence/shared/federation/commercial");
  const { federationOrganizationContext } = await import("../middleware/federation-organization");
  const f = await refundFixture();
  const deps: Parameters<typeof createFederationCommercialRoutes> = [f.approvals, f.service];
  deps[20] = f.source;
  const app = new Hono();
  const token = randomUUID();
  let actor = f.actor;
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({}, 401);
    c.set("principal" as never, actor as never);
    await next();
  });
  app.use("/api/federation/*", federationOrganizationContext);
  app.route("/api", createFederationCommercialRoutes(...deps));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const dir = await mkdtemp(join(tmpdir(), "kq-refund-cli-"));
  try {
    const config = join(dir, "config.json"),
      file = join(dir, "refund.json"),
      peer = join(dir, "peer.jws");
    await writeFile(
      config,
      JSON.stringify({ serverUrl: `http://127.0.0.1:${server.port}`, token }),
      { mode: 0o600 },
    );
    const run = async (...args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
          "federation",
          "--org",
          f.actor.orgId,
          "--lang",
          "en",
          "--json",
          ...args,
        ],
        { env: { ...process.env, KQ_CONFIG_FILE: config }, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const draft = await run(
      "refunds",
      "draft",
      f.revisionId,
      f.request.operationId,
      file,
      "--id",
      f.value.refundId,
      "--reason",
      f.value.reason,
    );
    expect(draft.code).toBe(0);
    const original = CommercialRefundSchema.parse(JSON.parse(await readFile(file, "utf8")));
    expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
    const approved = await run("refunds", "approve", f.revisionId, file);
    expect(approved.code).toBe(0);
    const local = CommercialRefundApprovalSchema.parse(JSON.parse(approved.stdout));
    expect(local.payload).toEqual(original);
    expect(local.appliedAt).toBeNull();
    const other = await f.provider.approve(f.actor, f.revisionId, original);
    await writeFile(peer, other.approvalJws, { mode: 0o600 });
    const attached = await run("refunds", "attach", f.revisionId, original.refundId, peer);
    expect(attached.code).toBe(0);
    const applied = CommercialRefundApprovalSchema.parse(JSON.parse(attached.stdout));
    expect(applied.approvalJws).toBe(local.approvalJws);
    expect(applied.appliedAt).not.toBeNull();
    await f.provider.attachCounterparty(
      f.actor,
      f.revisionId,
      original.refundId,
      local.approvalJws,
    );
    expect((await f.budget())?.available).toBe(f.terms.agreement.budgetLimit);
    const listed = await run("refunds", "list", f.revisionId, "--record", original.refundId);
    expect(listed.code).toBe(0);
    const page = CommercialRefundListSchema.parse(JSON.parse(listed.stdout));
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.payload.releasedAmount).toBe(f.request.maxAmount);
    expect(page.data[0]?.ledger).toBeNull();
    const absent = await run("refunds", "list", f.revisionId, "--record", randomUUID());
    expect(absent.code).toBe(0);
    expect(CommercialRefundListSchema.parse(JSON.parse(absent.stdout)).data).toHaveLength(0);
    const repeated = await run("refunds", "attach", f.revisionId, original.refundId, peer);
    expect(repeated.code).toBe(0);
    expect(CommercialRefundApprovalSchema.parse(JSON.parse(repeated.stdout)).appliedAt).toBe(
      applied.appliedAt,
    );
    actor = { ...f.actor, orgId: randomUUID() };
    const changed = await run("refunds", "list", f.revisionId);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("ORGANIZATION_CONTEXT_CHANGED");
    actor = f.actor;
    await new FederationPermissionService(db).set(
      { ...f.actor, capability: "settlement.approve", enabled: false },
      f.actor.userId,
    );
    const denied = await run("refunds", "approve", f.revisionId, file);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("HTTP 403");
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal exchange builds its minute window from one observation", async () => {
  const f = await terminalExchangeFixture();
  await f.approveTerminal();
  const current = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => current() + 5);
  try {
    await f.exchange.advanceNext();
    const received = (await f.view()).sync;
    expect(received).toMatchObject({ state: "ready", lastError: null });
    if (!received?.proposal) throw new Error("Missing original terminal");
    await f.sourceTerminal.countersign(
      f.actor,
      f.revisionId,
      f.reservation.reservationId,
      received.proposal,
    );
    await f.exchange.advanceNext();
    expect((await f.view()).sync).toMatchObject({ state: "complete", lastError: null });
  } finally {
    clock.mockRestore();
  }
});

async function automaticRefundFixture(mode: FederationMode = "bilateral_direct", admitted = true) {
  const f = await refundFixture(admitted, mode);
  const sourcePolicies = new FederationClosingPolicyService(db, f.a.signing.siteId);
  const providerPolicies = new FederationClosingPolicyService(db, f.b.signing.siteId);
  const input = {
    kind: "refund" as const,
    outcomes: ["cancelled" as const],
    maxAmount: f.request.maxAmount,
    maxTotalAmount: f.request.maxAmount,
    maxRecords: 1,
    validUntil: new Date(Date.now() + 3600000).toISOString(),
  };
  const policy = await sourcePolicies.grant(f.actor, f.revisionId, input);
  const fingerprint = randomBytes(32).toString("hex");
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: f.a.signing.siteId,
    certificatePem: "TLS registry fixture",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  const receiver = new FederationClosingAutomation(db, f.b.signing);
  const transport: { loseReply: boolean; afterResponse?: () => Promise<void> } = {
    loseReply: false,
  };
  const sender: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/commercial-closing");
    const response = await receiver.receive(jws, fingerprint);
    await transport.afterResponse?.();
    if (transport.loseReply) throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
    return response;
  };
  const automation = new FederationClosingAutomation(db, f.a.signing, sender);
  const task = async () => (await automation.list(f.actor, f.revisionId)).records[0];
  const grants = () =>
    Promise.all([
      sourcePolicies.list(f.actor, f.revisionId),
      providerPolicies.list(f.actor, f.revisionId),
    ]);
  return {
    ...f,
    sourcePolicies,
    providerPolicies,
    policy,
    input,
    automation,
    receiver,
    fingerprint,
    transport,
    sender,
    task,
    grants,
    grantProvider: () => providerPolicies.grant(f.actor, f.revisionId, input),
  };
}

test.each([
  "bilateral_direct",
  "bilateral_attested",
] as const)("automatic refund %s requires independent authority and reuses exact signatures on retry", async (mode) => {
  const f = await automaticRefundFixture(mode);
  await f.automation.discover();
  await f.automation.advanceNext();
  const waiting = await f.task();
  expect(waiting).toMatchObject({
    kind: "refund",
    referenceId: f.request.operationId,
    state: "needs_review",
    lastError: "POLICY_DENIED",
  });
  const first = (await f.source.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect(first?.authorizationPolicyId).toBe(f.policy.id);
  expect(first?.appliedAt).toBeNull();
  expect((await f.provider.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  const providerPolicy = await f.grantProvider();
  f.transport.loseReply = true;
  await f.automation.retry(f.actor, f.revisionId, "refund", f.request.operationId);
  await f.automation.advanceNext();
  expect(await f.task()).toMatchObject({ state: "pending", recordId: first?.refundId });
  const peer = (await f.provider.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect(peer?.authorizationPolicyId).toBe(providerPolicy.id);
  expect(peer?.appliedAt).toBeInstanceOf(Date);
  const budget = await f.budget();
  await f.providerPolicies.revoke(f.actor, f.revisionId, providerPolicy.id);
  f.transport.loseReply = false;
  await f.automation.retry(f.actor, f.revisionId, "refund", f.request.operationId);
  await new FederationClosingAutomation(db, f.a.signing, f.sender).advanceNext();
  expect(await f.task()).toMatchObject({ state: "complete", recordId: first?.refundId });
  const final = (await f.source.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect(final?.payload).toEqual(first?.payload);
  expect(final?.approvalJws).toBe(first?.approvalJws);
  expect(final?.counterpartyJws).toBe(peer?.approvalJws);
  expect(final?.appliedAt).toBeInstanceOf(Date);
  expect(await f.budget()).toEqual(budget);
  for (const rows of await f.grants())
    expect(rows[0]).toMatchObject({ approvedRecords: 1, approvedAmount: f.request.maxAmount });
  const ledgerRows = await db
    .select()
    .from(submissions)
    .where(
      and(
        eq(submissions.localSiteId, f.b.signing.siteId),
        sql`${submissions.input}->>'operation' = 'record-refund'`,
      ),
    );
  expect(ledgerRows).toHaveLength(mode === "bilateral_attested" ? 1 : 0);
  if (mode === "bilateral_attested") expect(ledgerRows[0]?.state).toBe("pending");
});

test("automatic refund allows cancellation before admission without crediting the provider", async () => {
  const f = await automaticRefundFixture("bilateral_direct", false);
  await f.grantProvider();
  const budget = await f.budget();
  await f.automation.discover();
  await Promise.all([f.automation.advanceNext(), f.automation.advanceNext()]);
  expect(await f.task()).toMatchObject({ state: "complete" });
  expect(await f.budget()).toEqual(budget);
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.appliedAt).toBeInstanceOf(
    Date,
  );
  for (const rows of await f.grants()) expect(rows[0]?.approvedRecords).toBe(1);
});

test("automatic refund grant enforces financial permission, mode and preexecution outcome", async () => {
  const f = await automaticRefundFixture();
  await expect(
    f.providerPolicies.grant(f.actor, f.revisionId, { ...f.input, outcomes: ["completed"] }),
  ).rejects.toThrow();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "settlement.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.grantProvider()).rejects.toThrow("POLICY_DENIED");
  const coordinated = await fixture("ledger_coordinated", true, true);
  await approveBoth(coordinated);
  await new FederationPermissionService(db).set(
    { ...coordinated.actor, capability: "settlement.approve", enabled: true },
    coordinated.actor.userId,
  );
  await expect(
    new FederationClosingPolicyService(db, coordinated.a.signing.siteId).grant(
      coordinated.actor,
      coordinated.revisionId,
      {
        ...f.input,
        maxAmount: "1",
        maxTotalAmount: "1",
      },
    ),
  ).rejects.toThrow("POLICY_DENIED");
});

test("automatic refund institution authority survives personal role changes but needs current trust", async () => {
  const f = await automaticRefundFixture();
  await f.grantProvider();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "settlement.approve", enabled: false },
    f.actor.userId,
  );
  await f.automation.discover();
  await f.automation.advanceNext();
  expect(await f.task()).toMatchObject({ state: "complete" });
  const g = await automaticRefundFixture();
  const [key] = await db
    .select()
    .from(federationSigningKeys)
    .where(eq(federationSigningKeys.siteId, g.a.signing.siteId));
  if (!key) throw new Error("Missing signing key");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: key.allowedKinds.filter((k) => k !== "commercial-refund") })
    .where(eq(federationSigningKeys.siteId, g.a.signing.siteId));
  await g.automation.discover();
  await g.automation.advanceNext();
  expect(await g.task()).toMatchObject({
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
    recordId: null,
  });
  expect((await g.grants())[0][0]?.approvedRecords).toBe(0);
});

test.each([
  "amount",
  "total",
  "count",
] as const)("automatic refund %s quota failure rolls back the signature and task original", async (limit) => {
  const f = await automaticRefundFixture();
  await db
    .update(federationClosingPolicies)
    .set(
      limit === "amount"
        ? { maxAmount: "0" }
        : limit === "total"
          ? { approvedAmount: f.input.maxTotalAmount }
          : { approvedRecords: 1 },
    )
    .where(eq(federationClosingPolicies.id, f.policy.id));
  const before = await f.grants();
  await f.automation.discover();
  await f.automation.advanceNext();
  expect(await f.task()).toMatchObject({
    state: "needs_review",
    lastError: "BUDGET_EXHAUSTED",
    recordId: null,
  });
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  expect(await f.grants()).toEqual(before);
});

test("automatic refund rechecks cancellation and policy expiry before committing authority", async () => {
  const f = await automaticRefundFixture();
  await db
    .update(federationOutbound)
    .set({ cancelState: "pending" })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  await expect(
    f.source.automateDraft(f.policy.id, f.request.operationId, async () => {}),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationOutbound)
    .set({ cancelState: "stopped" })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  try {
    await expect(
      f.source.automateDraft(f.policy.id, f.request.operationId, async () => {
        setSystemTime(new Date(f.policy.validUntil.getTime() + 1));
      }),
    ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  } finally {
    setSystemTime();
  }
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  expect((await f.grants())[0][0]).toMatchObject({ approvedAmount: "0", approvedRecords: 0 });
});

test("automatic refund preserves an existing human approval without consuming institution authority twice", async () => {
  const f = await automaticRefundFixture();
  const original = await f.source.approve(f.actor, f.revisionId, f.value);
  await f.grantProvider();
  await f.automation.discover();
  await f.automation.advanceNext();
  const saved = (await f.source.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect(saved?.approvalJws).toBe(original.approvalJws);
  expect(saved?.authorizationPolicyId).toBeNull();
  expect((await f.grants())[0][0]?.approvedRecords).toBe(0);
  expect((await f.grants())[1][0]?.approvedRecords).toBe(1);
});

test("automatic refund fences a late response after the closing lease expires", async () => {
  const f = await automaticRefundFixture();
  await f.grantProvider();
  f.transport.afterResponse = async () => {
    await db
      .update(federationClosingTasks)
      .set({ leaseUntil: new Date(0) })
      .where(eq(federationClosingTasks.localSiteId, f.a.signing.siteId));
  };
  await f.automation.discover();
  await f.automation.advanceNext();
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.appliedAt).toBeNull();
  expect((await f.provider.list(f.actor, f.revisionId, 10, 0)).data[0]?.appliedAt).toBeInstanceOf(
    Date,
  );
  f.transport.afterResponse = undefined;
  await f.automation.retry(f.actor, f.revisionId, "refund", f.request.operationId);
  await f.automation.advanceNext();
  expect(await f.task()).toMatchObject({ state: "complete" });
  for (const rows of await f.grants()) expect(rows[0]?.approvedRecords).toBe(1);
});

test("automatic refund task retains completion capacity until its original delivery drains", async () => {
  const f = await refundCapacityFixture();
  const policy = await new FederationClosingPolicyService(db, f.a.signing.siteId).grant(
    f.actor,
    f.revisionId,
    {
      kind: "refund",
      outcomes: ["cancelled"],
      maxAmount: f.request.maxAmount,
      maxTotalAmount: f.request.maxAmount,
      maxRecords: 1,
      validUntil: new Date(Date.now() + 3600000).toISOString(),
    },
  );
  await db.insert(federationClosingTasks).values({
    localSiteId: f.a.signing.siteId,
    localOrgId: f.actor.orgId,
    agreementRevisionId: f.revisionId,
    kind: "refund",
    referenceId: f.request.operationId,
    policyId: policy.id,
    recordId: f.value.refundId,
  });
  await f.apply();
  expect(await f.scan()).toMatchObject({
    allocatedBytes: "60",
    claim: { releaseBlocker: "closing" },
  });
  await db
    .update(federationClosingTasks)
    .set({ state: "complete", completedAt: new Date() })
    .where(eq(federationClosingTasks.localSiteId, f.a.signing.siteId));
  expect(await f.scan()).toMatchObject({ allocatedBytes: "0" });
});

test("automatic refund audit failure rolls back the original and policy consumption", async () => {
  const f = await automaticRefundFixture();
  await db.execute(
    sql`alter table audit_log add constraint test_refund_policy_audit check (actor <> ${sql.raw(`'closing-policy:${f.policy.id}'`)})`,
  );
  try {
    await expect(
      f.source.automateDraft(f.policy.id, f.request.operationId, async () => {}),
    ).rejects.toThrow();
    expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
    expect((await f.grants())[0][0]).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_refund_policy_audit`);
  }
  await f.source.automateDraft(f.policy.id, f.request.operationId, async () => {});
  expect((await f.grants())[0][0]).toMatchObject({
    approvedRecords: 1,
    approvedAmount: f.request.maxAmount,
  });
});

test("automatic refund revoked authority cannot sign but explicit replacement can resume the task", async () => {
  const f = await automaticRefundFixture();
  await f.grantProvider();
  await f.automation.discover();
  await f.sourcePolicies.revoke(f.actor, f.revisionId, f.policy.id);
  await f.automation.advanceNext();
  expect(await f.task()).toMatchObject({ state: "needs_review", recordId: null });
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  const replacement = await f.sourcePolicies.grant(f.actor, f.revisionId, f.input);
  await f.automation.retry(f.actor, f.revisionId, "refund", f.request.operationId);
  await f.automation.advanceNext();
  expect(await f.task()).toMatchObject({ state: "complete", policyId: replacement.id });
  expect((await f.source.list(f.actor, f.revisionId, 10, 0)).data[0]?.authorizationPolicyId).toBe(
    replacement.id,
  );
});

// Stored-case fixtures exercise approval fencing; opening/subject verification has its own PG suite.
async function executionDisputeRow(
  f: Awaited<ReturnType<typeof executionFixture>>,
  signing = f.a.signing,
  task = f.reservation.request,
) {
  const payload = CommercialDisputeSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute",
    caseId: randomUUID(),
    domainId: f.reservation.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest: f.reservation.agreementDigest,
    sourceSiteId: f.a.signing.siteId,
    targetSiteId: f.b.signing.siteId,
    openingSiteId: signing.siteId,
    taskId: task.taskId,
    attempt: task.attempt,
    subject: {
      recordType: "usage",
      recordId: randomUUID(),
      recordDigest: `sha256:${"a".repeat(64)}`,
    },
    reason: "Disputed original usage",
    requestedResolution: "Review the original measurement",
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const openingJws = await signFederationMessage(CommercialDisputeSchema, payload, signing);
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  return {
    localSiteId: signing.siteId,
    caseId: payload.caseId,
    localOrgId: f.actor.orgId,
    agreementRevisionId: f.revisionId,
    taskId: payload.taskId,
    attempt: payload.attempt,
    payload,
    digest,
    openingJws,
    openedBy: f.actor.userId,
  };
}
async function insertExecutionDispute(row: Awaited<ReturnType<typeof executionDisputeRow>>) {
  await db.transaction(async (tx) => {
    await lockFederationDisputeTask(tx, row.localSiteId, row);
    await tx.insert(federationDisputes).values(row);
  });
}

test("execution dispute blocks fresh reservations before market I/O and scopes the fence to task and attempt", async () => {
  const f = await executionFixture();
  const row = await executionDisputeRow(f);
  await insertExecutionDispute(row);
  await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toThrow(
    "DATA_WAITING",
  );
  expect(f.queries()).toBe(0);
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.localSiteId, row.localSiteId)),
  ).toHaveLength(0);
  for (const state of ["DISPUTED", "EVIDENCE_WAITING", "DECIDED", "APPLICATION_WAITING"] as const) {
    await db
      .update(federationDisputes)
      .set({ state })
      .where(eq(federationDisputes.caseId, row.caseId));
    await expect(f.execution.approve(f.actor, f.revisionId, f.reservation)).rejects.toThrow(
      "DATA_WAITING",
    );
  }
  // A later attempt and a different task must not inherit this case's fence.
  for (const request of [
    { ...f.reservation.request, attempt: 2 },
    { ...f.reservation.request, taskId: randomUUID() },
  ]) {
    const approved = await f.execution
      .approve(f.actor, f.revisionId, {
        ...f.reservation,
        reservationId: randomUUID(),
        request,
      })
      .catch((error: unknown) => error);
    // The public claim still names the original reservation; it must reach that independent check.
    expect(approved).toMatchObject({ code: "OPERATION_CONFLICT" });
  }
  expect(f.queries()).toBe(2);
  await db
    .update(federationDisputes)
    .set({ state: "RESOLVED" })
    .where(eq(federationDisputes.caseId, row.caseId));
  expect((await f.execution.approve(f.actor, f.revisionId, f.reservation)).recordId).toBe(
    f.reservation.reservationId,
  );
});

test("execution dispute rechecks reservation and release after market I/O without saving a new commitment", async () => {
  for (const release of [false, true]) {
    const f = await executionFixture();
    if (release) await approveReservation(f);
    const payload = release ? await releasePayload(f) : f.reservation;
    const before = await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.localSiteId, f.a.signing.siteId));
    const capacity = await db
      .select()
      .from(federationCompletionClaims)
      .where(eq(federationCompletionClaims.localSiteId, f.a.signing.siteId));
    f.onQuery(async () => insertExecutionDispute(await executionDisputeRow(f)));
    await expect(f.execution.approve(f.actor, f.revisionId, payload)).rejects.toThrow(
      "DATA_WAITING",
    );
    expect(
      await db
        .select()
        .from(executionApprovals)
        .where(eq(executionApprovals.localSiteId, f.a.signing.siteId)),
    ).toEqual(before);
    expect(
      await db
        .select()
        .from(federationCompletionClaims)
        .where(eq(federationCompletionClaims.localSiteId, f.a.signing.siteId)),
    ).toEqual(capacity);
    const id =
      payload.kind === "commercial-reservation" ? payload.reservationId : payload.releaseId;
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.target, id),
            eq(auditLog.action, "federation.commercial.execution.approve"),
          ),
        ),
    ).toHaveLength(0);
  }
});

test("execution dispute preserves original reservation and release replay and counterparty completion", async () => {
  const f = await executionFixture();
  const reserve = await approveReservation(f);
  const release = await releasePayload(f);
  const first = await f.execution.approve(f.actor, f.revisionId, release);
  await insertExecutionDispute(await executionDisputeRow(f));
  const queries = f.queries();
  expect((await f.execution.approve(f.actor, f.revisionId, f.reservation)).approvalJws).toBe(
    reserve.own.approvalJws,
  );
  expect((await f.execution.approve(f.actor, f.revisionId, release)).approvalJws).toBe(
    first.approvalJws,
  );
  expect(f.queries()).toBe(queries);
  await expect(
    f.execution.approve(f.actor, f.revisionId, { ...release, salt: "f".repeat(64) }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.execution.approve(f.actor, f.revisionId, { ...release, releaseId: randomUUID() }),
  ).rejects.toThrow("DATA_WAITING");
  const other = await signFederationMessage(
    CommercialExecutionApprovalSchema,
    release,
    f.b.signing,
  );
  for (let i = 0; i < 2; i++)
    await f.execution.attachCounterparty(f.actor, f.revisionId, release.releaseId, other);
  const queued = await db
    .select()
    .from(submissions)
    .where(
      and(
        eq(submissions.localSiteId, f.a.signing.siteId),
        sql`${submissions.input}->>'recordId' = ${release.releaseId}`,
      ),
    );
  expect(queued).toHaveLength(1);
});

test("execution dispute blocks automatic source and provider commitments without consuming authorization", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  for (const provider of [false, true]) {
    const f = await reservationPolicyFixture(provider);
    const policy = await f.grant();
    const sourceJws = provider ? await f.sourceJws() : undefined;
    const before = await f.view();
    const storage = testCompletionStorage();
    const capacity = new FederationCompletionCapacity(db, f.signing.siteId, storage.guard);
    await capacity.configure(
      { reserveId: storage.reserveId, capacityBytes: "80", taskBytes: "60", marketBytes: "20" },
      f.actor.userId,
    );
    expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "20", obligations: 1 });
    const execution = new FederationCommercialExecutionService(
      db,
      f.signing,
      {
        query: async () => {
          await insertExecutionDispute(await executionDisputeRow(f, f.signing));
          return { operation: "get-demand", demand: f.state };
        },
      },
      undefined,
      storage.guard,
    );
    let completed = 0;
    await expect(
      execution.approvePreauthorized(policy.id, f.reservation, sourceJws, {
        authorize: async () => {},
        complete: async () => {
          completed++;
        },
      }),
    ).rejects.toThrow("DATA_WAITING");
    expect(completed).toBe(0);
    expect(await f.rows()).toHaveLength(0);
    expect(await f.view()).toEqual(before);
    expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "20", obligations: 1 });
  }
});

test("execution dispute returns an approval saved by a concurrent caller before opening the case", async () => {
  const f = await reservationPolicyFixture();
  const policy = await f.grant();
  const arrived = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  f.beforeQuery(async () => {
    arrived.resolve();
    await proceed.promise;
  });
  const slow = f.execution.approvePreauthorized(policy.id, f.reservation);
  let original: Awaited<typeof slow> | undefined;
  try {
    await arrived.promise;
    const concurrent = new FederationCommercialExecutionService(db, f.a.signing, {
      query: async () => ({ operation: "get-demand", demand: f.state }),
    });
    original = await concurrent.approvePreauthorized(policy.id, f.reservation);
    await insertExecutionDispute(await executionDisputeRow(f));
  } finally {
    proceed.resolve();
  }
  const recovered = await slow;
  expect(recovered.approvalJws).toBe(original?.approvalJws);
  expect(await f.view()).toMatchObject({ authorizedTasks: 1, authorizedAmount: "60" });
  expect(await f.rows()).toHaveLength(1);
  expect((await f.execution.approvePreauthorized(policy.id, f.reservation)).approvalJws).toBe(
    recovered.approvalJws,
  );
});

test("execution dispute approval waits for a concurrent case transaction and observes its committed fence", async () => {
  const f = await executionFixture();
  const row = await executionDisputeRow(f);
  const arrived = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  let opening: Promise<void> | undefined;
  f.onQuery(async () => {
    opening = db.transaction(async (tx) => {
      await lockFederationDisputeTask(tx, row.localSiteId, row);
      await tx.insert(federationDisputes).values(row);
      arrived.resolve();
      await proceed.promise;
    });
    await arrived.promise;
  });
  const result = f.execution.approve(f.actor, f.revisionId, f.reservation).then(
    () => "approved",
    (error: unknown) => error,
  );
  try {
    await arrived.promise;
    let waiting = false;
    for (let n = 0; n < 200; n++) {
      const rows = await db.execute(
        sql`select 1 from pg_locks where locktype = 'advisory' and not granted`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
  } finally {
    proceed.resolve();
    await opening;
  }
  expect(await result).toMatchObject({ code: "DATA_WAITING" });
  expect(
    await db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.localSiteId, row.localSiteId)),
  ).toHaveLength(0);
});

async function arbitrationCaseFixture(
  mode: FederationMode = "bilateral_direct",
  legacy = false,
  fields?: ("dueAmount" | "grossAmount")[],
  withSettlement = false,
) {
  const f = await arbitrationAdmission(mode, fields);
  await f.arbitration.confirm();
  const request = {
    ...f.reservation.request,
    ...(legacy ? {} : { arbitration: f.arbitration.binding }),
  };
  await f.outbound.enqueue(f.actor, request);
  await f.outbound.deliverNext();
  const [original] = await db
    .select()
    .from(federationOutbound)
    .where(eq(federationOutbound.operationId, request.operationId));
  if (!original?.receiptJws || !original.receipt)
    throw new Error("Original admission fixture was not accepted");
  for (const site of [f.a.signing.siteId, f.b.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-bill","commercial-dispute","commercial-dispute-receipt"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, site));
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "dispute.open", enabled: true },
    f.actor.userId,
  );
  const contract = await f.approvals.get(f.actor, f.revisionId);
  const [terminal] =
    mode === "ledger_coordinated"
      ? await db
          .select()
          .from(federationExecutionTerminals)
          .where(
            and(
              eq(federationExecutionTerminals.localSiteId, f.b.signing.siteId),
              eq(federationExecutionTerminals.reservationId, f.reservation.reservationId),
            ),
          )
      : [];
  const endedAt = terminal?.payload.observedAt ?? new Date().toISOString();
  const report = CommercialUsageSchema.parse({
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId: f.terms.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest: contract.digest,
    sourceSiteId: f.a.signing.siteId,
    targetSiteId: f.b.signing.siteId,
    taskId: request.taskId,
    attempt: request.attempt,
    salt: randomBytes(32).toString("hex"),
    reportedAt: endedAt,
    periodStart: request.issuedAt,
    periodEnd: endedAt,
    measurements: f.terms.prices.map((p) => ({
      metric: p.metric,
      quantityUnit: p.quantityUnit,
      quantity: "1",
      evidenceDigest: contract.digest,
    })),
  });
  // A later bill deliberately carries consent even in the legacy test; only original admission may confer it.
  const billRequest = { ...request, arbitration: f.arbitration.binding };
  const bill = CommercialBillSchema.parse({
    protocolVersion: 1,
    kind: "commercial-bill",
    billId: randomUUID(),
    domainId: f.terms.domainId,
    agreementDigest: contract.digest,
    priceVersionId: f.terms.priceVersionId,
    reportId: report.reportId,
    reportDigest: federationMaterialDigest(report),
    request: billRequest,
    reservationId: mode === "ledger_coordinated" ? f.reservation.reservationId : null,
    discount: null,
    calculation: calculateCommercialBill(f.terms, billRequest, report),
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const signatures = await Promise.all(
    [f.a, f.b].map((key) => signFederationMessage(CommercialBillSchema, bill, key.signing)),
  );
  const first = signatures[0],
    second = signatures[1];
  if (!first || !second) throw new Error("Missing signed bill fixture");
  const billDigest = `sha256:${createHash("sha256")
    .update(Buffer.from(first.split(".")[1] ?? "", "base64url"))
    .digest("hex")}`;
  for (const [site, own, other] of [
    [f.a.signing.siteId, first, second],
    [f.b.signing.siteId, second, first],
  ] as const)
    await db.insert(federationCommercialBills).values({
      localSiteId: site,
      localOrgId: f.actor.orgId,
      billId: bill.billId,
      agreementRevisionId: f.revisionId,
      taskId: request.taskId,
      attempt: request.attempt,
      payload: bill,
      digest: billDigest,
      approvalJws: own,
      counterpartyJws: other,
      approvedBy: f.actor.userId,
    });
  if (mode === "ledger_coordinated") {
    for (const key of [f.a, f.b]) {
      await db.insert(submissions).values({
        id: randomUUID(),
        localSiteId: key.signing.siteId,
        agreementRevisionId: f.revisionId,
        state: "committed",
        input: CommercialAdapterProposalInputSchema.parse({
          operation: "confirm-bill",
          domainId: bill.domainId,
          recordId: bill.billId,
          digest: billDigest,
          envelope: {
            sourceSiteId: f.a.signing.siteId,
            targetSiteId: f.b.signing.siteId,
            sourceJws: first,
            targetJws: second,
          },
        }),
      });
    }
  }
  let initialSettlement: Awaited<ReturnType<FederationSettlementService["approve"]>> | undefined;
  if (withSettlement) {
    if (mode !== "ledger_coordinated") throw new Error("Native financial fixture required");
    f.adapter.receipt = async (query) => {
      const [committed] = await db
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.state, "committed"),
            sql`${submissions.input}->>'recordId' = ${query.recordId}`,
          ),
        );
      return {
        receipt: committed ? { recordId: query.recordId, digest: committed.input.digest } : null,
      };
    };
    for (const capability of ["settlement.approve", "adjustment.approve"] as const)
      await new FederationPermissionService(db).set(
        { ...f.actor, capability, enabled: true },
        f.actor.userId,
      );
    for (const key of [f.a, f.b])
      await db
        .update(federationSigningKeys)
        .set({
          allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-settlement","commercial-adjustment"]'::jsonb`,
        })
        .where(eq(federationSigningKeys.siteId, key.signing.siteId));
    for (const key of [f.a, f.b]) {
      const worker = new FederationCommercialSubmissionService(db, key.signing.siteId, f.adapter);
      for (let i = 0; i < 12 && (await worker.advanceNext()); i++) {}
    }
    const source = new FederationSettlementService(db, f.a.signing),
      target = new FederationSettlementService(db, f.b.signing);
    const terms = await source.draft(f.actor, f.revisionId, bill.billId, randomUUID());
    const own = await source.approve(f.actor, f.revisionId, terms),
      peer = await target.approve(f.actor, f.revisionId, terms);
    await source.attachCounterparty(f.actor, f.revisionId, terms.settlementId, peer.approvalJws);
    await target.attachCounterparty(f.actor, f.revisionId, terms.settlementId, own.approvalJws);
    for (const key of [f.a, f.b]) {
      const worker = new FederationCommercialSubmissionService(db, key.signing.siteId, f.adapter);
      for (let i = 0; i < 3; i++) await worker.advanceNext();
    }
    initialSettlement = own;
  }
  const sourceCases = new FederationDisputeService(db, f.a.signing),
    targetCases = new FederationDisputeService(db, f.b.signing);
  const draft = await targetCases.draft(f.actor, f.revisionId, {
    caseId: randomUUID(),
    subject: { recordType: "bill", recordId: bill.billId, recordDigest: billDigest },
    reason: "Private case allegation",
    requestedResolution: "Review before financial execution",
  });
  const opened = await targetCases.open(f.actor, f.revisionId, draft);
  const fingerprint = randomBytes(32).toString("hex");
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: f.b.signing.siteId,
    certificatePem: "registered fixture fingerprint",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  await sourceCases.receive(opened.openingJws, fingerprint);
  const read = (target = false) =>
    (target ? targetCases : sourceCases).arbitrationBinding(f.actor, f.revisionId, draft.caseId);
  return { ...f, request, original, draft, sourceCases, targetCases, read, initialSettlement };
}

test("arbitration case binding resolves both original admissions without financial or ledger writes", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await arbitrationCaseFixture(mode);
    const before = await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.request.budgetDomainId));
    const queued = await db
      .select()
      .from(submissions)
      .where(eq(submissions.agreementRevisionId, f.revisionId));
    const { observedAt: sourceAt, ...source } = CommercialArbitrationTaskBindingSchema.parse(
      await f.read(),
    );
    const { observedAt: targetAt, ...target } = CommercialArbitrationTaskBindingSchema.parse(
      await f.read(true),
    );
    expect(source).toEqual(target);
    expect(source).toMatchObject({
      policyId: f.arbitration.policy.policyId,
      requestDigest: f.original.requestDigest,
      reservationId: f.original.receipt?.reservationId,
      arbitratorSiteId: f.arbitration.policy.arbitratorSiteId,
      mode,
    });
    expect(Date.parse(sourceAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(targetAt)).toBeLessThanOrEqual(Date.now());
    for (const secret of [
      f.original.requestJws,
      f.original.receiptJws,
      f.terms.termsText,
      f.draft.reason,
      "approvalJws",
      "maxChargedAmount",
    ])
      expect(JSON.stringify(source)).not.toContain(secret ?? "missing");
    expect(
      CommercialArbitrationTaskBindingSchema.safeParse({
        ...source,
        observedAt: sourceAt,
        approved: true,
      }).success,
    ).toBe(false);
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.request.budgetDomainId)),
    ).toEqual(before);
    expect(
      await db.select().from(submissions).where(eq(submissions.agreementRevisionId, f.revisionId)),
    ).toEqual(queued);
  }
});

test("arbitration case binding cannot infer missing original consent from a later signed bill or policy", async () => {
  const f = await arbitrationCaseFixture("bilateral_direct", true);
  for (const target of [false, true]) await expect(f.read(target)).rejects.toThrow("POLICY_DENIED");
  const [original] = await db
    .select()
    .from(federationOutbound)
    .where(eq(federationOutbound.operationId, f.request.operationId));
  expect(original?.request).not.toHaveProperty("arbitration");
  expect(original?.requestJws).toBe(f.original.requestJws);
});

test("arbitration case binding rejects changed original receipts and untrusted admission signatures", async () => {
  const f = await arbitrationCaseFixture();
  if (!f.original.receipt) throw new Error("Missing original receipt");
  const path = eq(federationOutbound.operationId, f.request.operationId);
  for (const patch of [
    { unit: "wrong" },
    { reservedAmount: "1" },
    { requestDigest: f.arbitration.binding.policyDigest },
    { acceptedAt: f.request.expiresAt },
    { attempt: 2 },
    { recipientSiteId: randomUUID() },
  ]) {
    const receipt = { ...f.original.receipt, ...patch };
    await db
      .update(federationOutbound)
      .set({
        receipt,
        receiptJws: await signFederationMessage(FederationAcceptanceSchema, receipt, f.b.signing),
      })
      .where(path);
    await expect(f.read()).rejects.toThrow("OPERATION_CONFLICT");
  }
  await db
    .update(federationOutbound)
    .set({ receipt: f.original.receipt, receiptJws: f.original.receiptJws })
    .where(path);
  const wrongId = { ...f.original.receipt, reservationId: randomUUID() };
  await db
    .update(federationReservations)
    .set({
      receipt: wrongId,
      receiptJws: await signFederationMessage(FederationAcceptanceSchema, wrongId, f.b.signing),
    })
    .where(eq(federationReservations.id, f.original.receipt.reservationId));
  await expect(f.read(true)).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'delegation'` })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await expect(f.read()).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("arbitration case binding stops at current policy revocation and ended case state", async () => {
  const f = await arbitrationCaseFixture();
  await db
    .update(federationDisputes)
    .set({ state: "RESOLVED" })
    .where(eq(federationDisputes.caseId, f.draft.caseId));
  await expect(f.read()).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationDisputes)
    .set({ state: "DISPUTED" })
    .where(eq(federationDisputes.caseId, f.draft.caseId));
  await f.arbitration.source.revoke(f.actor, f.revisionId, f.arbitration.policy.policyId);
  await f.arbitration.target.revoke(f.actor, f.revisionId, f.arbitration.policy.policyId);
  for (const target of [false, true])
    await expect(f.read(target)).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("arbitration case binding HTTP requires both human capabilities and the original organization", async () => {
  const f = await arbitrationCaseFixture();
  const args: Parameters<typeof createFederationCommercialRoutes> = [f.approvals, f.service];
  args[23] = f.sourceCases;
  const app = new Hono();
  let actor = f.actor,
    automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    c.set("automation" as never, automation as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...args));
  const path = `/federation/commercial-agreements/${f.revisionId}/disputes/${f.draft.caseId}/arbitration-binding`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(
    z.object({ data: CommercialArbitrationTaskBindingSchema }).safeParse(await response.json())
      .success,
  ).toBe(true);
  automation = true;
  expect((await app.request(path)).status).toBe(403);
  automation = false;
  for (const capability of ["arbitration.approve", "dispute.open"] as const) {
    await new FederationPermissionService(db).set(
      { ...f.actor, capability, enabled: false },
      f.actor.userId,
    );
    expect((await app.request(path)).status).toBe(403);
    await new FederationPermissionService(db).set(
      { ...f.actor, capability, enabled: true },
      f.actor.userId,
    );
  }
  const other = await fixture();
  for (const capability of ["arbitration.approve", "dispute.open"] as const)
    await new FederationPermissionService(db).set(
      { ...other.actor, capability, enabled: true },
      other.actor.userId,
    );
  actor = other.actor;
  expect((await app.request(path)).status).toBe(403);
  actor = f.actor;
  expect((await app.request(path.replace(f.revisionId, randomUUID()))).status).toBe(403);
  expect((await app.request(path.replace(f.draft.caseId, "invalid"))).status).toBe(400);
});

test("arbitration case binding permits historical admission but not policy expiry during a real lock wait", async () => {
  const f = await arbitrationCaseFixture();
  try {
    setSystemTime(new Date(Date.parse(f.request.expiresAt) + 1));
    expect((await f.read()).requestDigest).toBe(f.original.requestDigest);
  } finally {
    setSystemTime();
  }
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const blocker = db.transaction(async (tx) => {
    await tx
      .select()
      .from(federationArbitrationPolicies)
      .where(
        and(
          eq(federationArbitrationPolicies.localSiteId, f.a.signing.siteId),
          eq(federationArbitrationPolicies.policyId, f.arbitration.policy.policyId),
        ),
      )
      .for("update");
    const rows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    if (!rows[0]) throw new Error("Missing lock holder");
    locked.resolve(rows[0].pid);
    await release.promise;
  });
  const pid = await locked.promise;
  const operation = f.read().then(
    () => null,
    (error: unknown) => error,
  );
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        (
          await db.execute(
            sql`select pid from pg_stat_activity where ${pid} = ANY(pg_blocking_pids(pid))`,
          )
        ).length
      ) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    setSystemTime(new Date(f.arbitration.policy.validUntil));
    release.resolve();
    await blocker;
    expect(await operation).toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  } finally {
    release.resolve();
    await blocker;
    await operation;
    setSystemTime();
  }
});

test("arbitration case binding checks the original contract budget and mode even for matching signed request and receipt", async () => {
  const f = await arbitrationCaseFixture();
  if (!f.original.receipt) throw new Error("Missing original receipt");
  for (const patch of [
    { budgetDomainId: randomUUID() },
    { epoch: randomUUID() },
    { mode: "bilateral_attested" as const },
  ]) {
    const request = { ...f.request, ...patch };
    const requestJws = await signFederationMessage(
      FederationDelegationSchema,
      request,
      f.a.signing,
    );
    const digest = `sha256:${createHash("sha256")
      .update(Buffer.from(requestJws.split(".")[1] ?? "", "base64url"))
      .digest("hex")}`;
    const receipt = { ...f.original.receipt, ...patch, requestDigest: digest };
    await db
      .update(federationOutbound)
      .set({
        request,
        requestJws,
        requestDigest: digest,
        receipt,
        receiptJws: await signFederationMessage(FederationAcceptanceSchema, receipt, f.b.signing),
      })
      .where(eq(federationOutbound.operationId, f.request.operationId));
    await expect(f.read()).rejects.toThrow("POLICY_DENIED");
  }
});

async function arbitrationContextFixture(
  mode: FederationMode = "bilateral_direct",
  fields?: ("dueAmount" | "grossAmount")[],
  withSettlement = false,
) {
  const f = await arbitrationCaseFixture(mode, false, fields, withSettlement);
  const owner = await fixture(); // R has its own local organization and user.
  const r = await testKeys(f.arbitration.policy.arbitratorSiteId);
  await f.trust.addKey(
    r.signing.siteId,
    {
      keyId: r.signing.keyId,
      publicKeyPem: await exportSPKI(r.verification.publicKey),
      allowedKinds: ["arbitration-context-query"],
      validFrom: "2020-01-01T00:00:00Z",
      validUntil: "2099-01-01T00:00:00Z",
    },
    owner.actor.userId,
  );
  for (const key of [f.a, f.b]) {
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["arbitration-context"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, key.signing.siteId));
    await db
      .update(federationSites)
      .set({ endpoint: `https://${key.signing.siteId}.test.invalid` })
      .where(eq(federationSites.id, key.signing.siteId));
  }
  for (const capability of ["arbitration.read", "disclosure.receive"] as const)
    await new FederationPermissionService(db).set(
      { ...owner.actor, capability, enabled: true },
      owner.actor.userId,
    );
  const evidence = new FederationEvidenceService(db, r.signing);
  const scope = {
    caseId: f.draft.caseId,
    domainId: f.draft.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest: f.draft.agreementDigest,
    sourceSiteId: f.a.signing.siteId,
    targetSiteId: f.b.signing.siteId,
    evidenceRecipientSiteId: r.signing.siteId,
  };
  await evidence.register(owner.actor, scope);
  const fingerprint = randomBytes(32).toString("hex");
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: r.signing.siteId,
    certificatePem: "registered fixture fingerprint",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  const deliveries: { query: z.infer<typeof ArbitrationContextQuerySchema>; response: string }[] =
    [];
  let afterResponse: (() => Promise<void>) | undefined;
  let changeResponse: ((jws: string, key: typeof f.a) => Promise<string>) | undefined;
  let offline = false;
  const send: FederationSend = async (endpoint, jws, path) => {
    if (offline) throw new Error("offline fixture");
    const key = endpoint === `https://${f.a.signing.siteId}.test.invalid` ? f.a : f.b;
    if (
      !path ||
      ![
        "/federation/v1/arbitration-contexts",
        "/federation/v1/arbitration-decisions",
        "/federation/v1/disclosure-authorizations",
        "/federation/v1/disclosure-downloads",
      ].includes(path)
    )
      throw new Error("Unexpected context endpoint");
    const ingress = createFederationIngress(db, key.signing);
    const res = await ingress.request(path, {
      method: "POST",
      headers: { "content-type": "application/jose", "x-kq-federation-cert": fingerprint },
      body: jws,
    });
    if (res.status !== 200) {
      const body = z.object({ error: z.object({ code: z.string() }) }).parse(await res.json());
      throw new Error(body.error.code);
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
    let response = await res.text();
    if (path !== "/federation/v1/arbitration-contexts") return response;
    const query = ArbitrationContextQuerySchema.parse(
      JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString()),
    );
    deliveries.push({ query, response });
    if (changeResponse) response = await changeResponse(response, key);
    if (deliveries.length % 2 === 0) await afterResponse?.();
    return response;
  };
  const service = new FederationArbitrationContextService(db, r.signing, send);
  return {
    ...f,
    owner,
    r,
    scope,
    evidence: new FederationEvidenceService(db, r.signing, send),
    send,
    service,
    fingerprint,
    deliveries,
    read: () => service.read(owner.actor, scope.caseId),
    after: (fn: () => Promise<void>) => {
      afterResponse = fn;
    },
    change: (fn: (jws: string, key: typeof f.a) => Promise<string>) => {
      changeResponse = fn;
    },
    offline: () => {
      offline = true;
    },
  };
}

test("arbitration context reads both current original bindings through production ingress without private originals", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await arbitrationContextFixture(mode);
    // Separate evidence permission is not required for reading the already registered context.
    await new FederationPermissionService(db).set(
      { ...f.owner.actor, capability: "disclosure.receive", enabled: false },
      f.owner.actor.userId,
    );
    const budgets = await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.request.budgetDomainId));
    const queued = await db
      .select()
      .from(submissions)
      .where(eq(submissions.agreementRevisionId, f.revisionId));
    const result = ArbitrationContextViewSchema.parse(await f.read());
    expect(result.binding.policyId).toBe(f.arbitration.policy.policyId);
    expect(result.policy).toEqual(f.arbitration.policy);
    expect(result.observations.map((o) => o.siteId)).toEqual([
      f.a.signing.siteId,
      f.b.signing.siteId,
    ]);
    expect(f.deliveries).toHaveLength(2);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    const outputs = JSON.stringify([
      result,
      ...f.deliveries.map((d) =>
        JSON.parse(Buffer.from(d.response.split(".")[1] ?? "", "base64url").toString()),
      ),
    ]);
    for (const secret of [
      f.original.requestJws,
      f.original.receiptJws,
      f.terms.termsText,
      f.draft.reason,
      f.actor.userId,
      f.actor.orgId,
    ])
      expect(outputs).not.toContain(secret ?? "missing");
    expect(JSON.stringify(result)).not.toContain("Jws");
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.request.budgetDomainId)),
    ).toEqual(budgets);
    expect(
      await db.select().from(submissions).where(eq(submissions.agreementRevisionId, f.revisionId)),
    ).toEqual(queued);
    f.offline();
    await expect(f.read()).rejects.toThrow("offline fixture");
  }
});

test("arbitration context HTTP isolates human permission, local organization, closed cases and unknown paths", async () => {
  const f = await arbitrationContextFixture();
  const app = new Hono();
  let actor = f.owner.actor,
    automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    c.set("automation" as never, automation as never);
    await next();
  });
  app.route("/", createFederationEvidenceRoutes(f.evidence, f.service));
  const path = `/federation/evidence-cases/${f.scope.caseId}/arbitration-context`;
  const ok = await app.request(path);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(z.object({ data: ArbitrationContextViewSchema }).safeParse(await ok.json()).success).toBe(
    true,
  );
  automation = true;
  expect((await app.request(path)).status).toBe(403);
  automation = false;
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "arbitration.read", enabled: false },
    f.owner.actor.userId,
  );
  expect((await app.request(path)).status).toBe(403);
  actor = f.actor;
  await new FederationPermissionService(db).set(
    { ...actor, capability: "arbitration.read", enabled: true },
    actor.userId,
  );
  expect((await app.request(path)).status).toBe(403);
  actor = f.owner.actor;
  await new FederationPermissionService(db).set(
    { ...actor, capability: "arbitration.read", enabled: true },
    actor.userId,
  );
  expect((await app.request(path.replace(f.scope.caseId, randomUUID()))).status).toBe(403);
  expect((await app.request(path.replace(f.scope.caseId, "invalid"))).status).toBe(400);
  await f.evidence.close(actor, f.scope.caseId);
  expect((await app.request(path)).status).toBe(403);
});

test("arbitration context checks caller and case again after network requests", async () => {
  for (const change of ["grant", "case", "endpoint", "key", "expiry"] as const) {
    const f = await arbitrationContextFixture();
    f.after(async () => {
      if (change === "grant")
        await new FederationPermissionService(db).set(
          { ...f.owner.actor, capability: "arbitration.read", enabled: false },
          f.owner.actor.userId,
        );
      if (change === "case") await f.evidence.close(f.owner.actor, f.scope.caseId);
      if (change === "endpoint")
        await db
          .update(federationSites)
          .set({ endpoint: "https://changed.test.invalid" })
          .where(eq(federationSites.id, f.a.signing.siteId));
      if (change === "key")
        await db
          .update(federationSigningKeys)
          .set({ revokedAt: new Date() })
          .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
      if (change === "expiry") setSystemTime(new Date(Date.now() + 61000));
    });
    try {
      await expect(f.read()).rejects.toThrow(
        change === "expiry"
          ? "AUTHORIZATION_EXPIRED"
          : ["grant", "case"].includes(change)
            ? "POLICY_DENIED"
            : "UNTRUSTED_IDENTITY",
      );
    } finally {
      setSystemTime();
    }
  }
});

test("arbitration context rejects replay, altered request binding, mismatched bilateral bindings and policy signatures", async () => {
  const f = await arbitrationContextFixture();
  await f.read();
  const old = f.deliveries[0];
  if (!old) throw new Error("Missing context response");
  f.change(async () => old.response);
  await expect(f.read()).rejects.toThrow();
  for (const mutation of ["query", "binding", "policy"] as const) {
    f.change(async (jws, key) => {
      if (key.signing.siteId !== f.a.signing.siteId) return jws;
      const payload = ArbitrationContextSchema.parse(
        JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString()),
      );
      if (mutation === "query") payload.queryDigest = `sha256:${"b".repeat(64)}`;
      if (mutation === "binding") payload.binding.requestDigest = `sha256:${"c".repeat(64)}`;
      if (mutation === "policy") payload.targetJws = payload.sourceJws;
      return signFederationMessage(ArbitrationContextSchema, payload, key.signing);
    });
    await expect(f.read()).rejects.toThrow(
      mutation === "binding"
        ? "OPERATION_CONFLICT"
        : mutation === "query"
          ? "POLICY_DENIED"
          : "UNTRUSTED_IDENTITY",
    );
  }
});

test("arbitration context responder rejects another registered institution and changed case scope", async () => {
  const f = await arbitrationContextFixture();
  const query = ArbitrationContextQuerySchema.parse({
    protocolVersion: 1,
    kind: "arbitration-context-query",
    readId: randomUUID(),
    queryId: randomUUID(),
    senderSiteId: f.r.signing.siteId,
    recipientSiteId: f.a.signing.siteId,
    scope: { ...f.scope, agreementDigest: `sha256:${"c".repeat(64)}` },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  });
  const responder = new FederationArbitrationContextResponder(db, f.a.signing);
  await expect(
    responder.receive(
      await signFederationMessage(ArbitrationContextQuerySchema, query, f.r.signing),
      f.fingerprint,
    ),
  ).rejects.toThrow("POLICY_DENIED");
  const rogue = f.owner.a;
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["arbitration-context-query"] })
    .where(eq(federationSigningKeys.siteId, rogue.signing.siteId));
  const fingerprint = randomBytes(32).toString("hex");
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: rogue.signing.siteId,
    certificatePem: "registered unrelated institution",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  const rogueQuery = {
    ...query,
    scope: { ...f.scope, evidenceRecipientSiteId: rogue.signing.siteId },
    senderSiteId: rogue.signing.siteId,
  };
  await expect(
    responder.receive(
      await signFederationMessage(ArbitrationContextQuerySchema, rogueQuery, rogue.signing),
      fingerprint,
    ),
  ).rejects.toThrow("POLICY_DENIED");
  await f.arbitration.source.revoke(f.actor, f.revisionId, f.arbitration.policy.policyId);
  await expect(f.read()).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("arbitration context rejects an exact withdrawal received by R while responses are in flight", async () => {
  const f = await arbitrationContextFixture();
  for (const [key, kinds] of [
    [f.a, ["commercial-arbitration-revocation", "arbitration-revocation-notice"]],
    [f.r, ["arbitration-revocation-receipt"]],
  ] as const)
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || ${JSON.stringify(kinds)}::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, key.signing.siteId));
  const fingerprint = randomBytes(32).toString("hex");
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: f.a.signing.siteId,
    certificatePem: "registered source fingerprint",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  f.after(async () => {
    await f.arbitration.source.revoke(f.actor, f.revisionId, f.arbitration.policy.policyId);
    const withdrawal = await db.transaction((tx) =>
      f.arbitration.source.withdrawalForDelivery(tx, f.arbitration.policy.policyId),
    );
    const notice = ArbitrationRevocationNoticeSchema.parse({
      protocolVersion: 1,
      kind: "arbitration-revocation-notice",
      noticeId: randomUUID(),
      issuerSiteId: f.a.signing.siteId,
      receivingSiteId: f.r.signing.siteId,
      policy: withdrawal.payload,
      policyJws: withdrawal.approvalJws,
      revocationJws: withdrawal.revocationJws,
      issuedAt: new Date().toISOString(),
    });
    await new FederationArbitrationRevocationDelivery(
      db,
      f.r.signing,
      new FederationArbitrationPolicyService(db, f.r.signing),
    ).receive(
      await signFederationMessage(ArbitrationRevocationNoticeSchema, notice, f.a.signing),
      fingerprint,
    );
  });
  await expect(f.read()).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect(
    await db
      .select()
      .from(federationArbitrationRevocationNotices)
      .where(eq(federationArbitrationRevocationNotices.localSiteId, f.r.signing.siteId)),
  ).toHaveLength(1);
});

test("arbitration context requires explicit message purposes and registered caller certificate", async () => {
  const f = await arbitrationContextFixture();
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-disclosure-read-query"] })
    .where(eq(federationSigningKeys.siteId, f.r.signing.siteId));
  await expect(f.read()).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(f.deliveries).toHaveLength(0);
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["arbitration-context-query"] })
    .where(eq(federationSigningKeys.siteId, f.r.signing.siteId));
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'arbitration-context'` })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await expect(f.read()).rejects.toThrow("UNTRUSTED_IDENTITY");
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["arbitration-context"]'::jsonb`,
    })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await db
    .update(federationCertificates)
    .set({ revokedAt: new Date() })
    .where(eq(federationCertificates.fingerprint, f.fingerprint));
  await expect(f.read()).rejects.toThrow("UNTRUSTED_IDENTITY");
});

async function arbitrationReviewFixture(
  mode: FederationMode = "bilateral_direct",
  fields?: ("dueAmount" | "grossAmount")[],
  withSettlement = false,
) {
  const f = await arbitrationContextFixture(mode, fields, withSettlement);
  for (const siteId of [f.a.signing.siteId, f.b.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute-freeze", "commercial-disclosure-policy", "commercial-disclosure", "commercial-disclosure-read-authorization"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-disclosure-read-query", "commercial-disclosure-download-query"]'::jsonb`,
    })
    .where(eq(federationSigningKeys.siteId, f.r.signing.siteId));
  const [certificate] = await db
    .select()
    .from(federationCertificates)
    .where(eq(federationCertificates.siteId, f.b.signing.siteId));
  if (!certificate) throw new Error("Missing opener fingerprint");
  const delivery = new FederationDisputeDelivery(db, f.b.signing, async (_endpoint, jws) =>
    f.sourceCases.receive(jws, certificate.fingerprint),
  );
  await delivery.discover();
  await delivery.advanceNext();
  if (mode === "ledger_coordinated")
    f.adapter.receipt = async (query) => {
      const [published] = await db
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.state, "committed"),
            sql`${submissions.input}->>'domainId' = ${query.domainId}`,
            sql`${submissions.input}->>'recordId' = ${query.recordId}`,
          ),
        );
      return {
        receipt: published ? { recordId: query.recordId, digest: published.input.digest } : null,
      };
    };
  const receiver = new FederationDisputeFreezeExchange(db, f.a.signing, undefined, f.adapter);
  const freeze = new FederationDisputeFreezeExchange(
    db,
    f.b.signing,
    async (_endpoint, jws) => receiver.receive(jws, certificate.fingerprint),
    f.adapter,
  );
  await freeze.discover();
  await freeze.advanceNext();
  if (mode === "ledger_coordinated") {
    const worker = new FederationCommercialSubmissionService(db, f.b.signing.siteId, f.adapter);
    for (let i = 0; i < 3; i++) await worker.advanceNext();
    await freeze.advanceNext();
    await receiver.advanceNext();
  }
  const frozen = await db
    .select()
    .from(federationDisputeFreezes)
    .where(eq(federationDisputeFreezes.caseId, f.scope.caseId));
  if (frozen.length !== 2 || frozen.some((row) => row.state !== "confirmed"))
    throw new Error(
      `Fixture freeze incomplete: ${frozen.map((r) => `${r.state}:${r.lastError}`).join(",")}`,
    );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "disclosure.approve", enabled: true },
    f.actor.userId,
  );
  const aPolicy = new FederationDisclosurePolicyService(db, f.a.signing),
    bPolicy = new FederationDisclosurePolicyService(db, f.b.signing);
  const policy = await aPolicy.draft(f.actor, f.revisionId, {
    policyId: randomUUID(),
    recipientSiteId: f.r.signing.siteId,
    disclosures: [{ recordType: "bill", fields: ["dueAmount", "grossAmount"] }],
    validUntil: "2097-01-01T00:00:00Z",
  });
  const ap = await aPolicy.approve(f.actor, f.revisionId, policy),
    bp = await bPolicy.approve(f.actor, f.revisionId, policy);
  await aPolicy.attachCounterparty(f.actor, f.revisionId, policy.policyId, bp.approvalJws);
  await bPolicy.attachCounterparty(f.actor, f.revisionId, policy.policyId, ap.approvalJws);
  const aDisclosure = new FederationDisclosureService(db, f.a.signing),
    bDisclosure = new FederationDisclosureService(db, f.b.signing);
  const createMaterial = async (fields: ("dueAmount" | "grossAmount")[] = ["dueAmount"]) => {
    const draft = await aDisclosure.draft(f.actor, f.revisionId, {
      grantId: randomUUID(),
      caseId: f.scope.caseId,
      policyId: policy.policyId,
      ...f.draft.subject,
      recordType: "bill",
      fields,
      validUntil: "2096-01-01T00:00:00Z",
    });
    const a = await aDisclosure.approve(f.actor, f.revisionId, draft),
      b = await bDisclosure.approve(f.actor, f.revisionId, draft);
    await aDisclosure.attachCounterparty(f.actor, f.revisionId, draft.grant.grantId, b.approvalJws);
    await bDisclosure.attachCounterparty(f.actor, f.revisionId, draft.grant.grantId, a.approvalJws);
    const scope = {
      ...f.scope,
      grantId: draft.grant.grantId,
      disclosureDigest: a.digest,
      policyId: policy.policyId,
      policyDigest: ap.digest,
    };
    await f.evidence.import(f.owner.actor, f.scope.caseId, scope);
    return { draft, scope };
  };
  const material = await createMaterial();
  const review = new FederationArbitrationReviewService(db, f.service, f.evidence);
  return {
    ...f,
    frozen,
    material,
    createMaterial,
    aDisclosure,
    bDisclosure,
    aPolicy,
    policy,
    review,
    inspect: (grantIds = [material.draft.grant.grantId]) =>
      review.review(f.owner.actor, f.scope.caseId, { grantIds }),
  };
}

test("arbitration review verifies bilateral frozen heads and imported evidence without ledger waits or financial changes", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await arbitrationReviewFixture(mode);
    const before = await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.request.budgetDomainId));
    const queued = await db
      .select()
      .from(submissions)
      .where(eq(submissions.agreementRevisionId, f.revisionId));
    const result = ArbitrationReviewSchema.parse(await f.inspect());
    const frozen = f.frozen[0];
    if (!result.context.financial || !frozen?.payload || !frozen.digest)
      throw new Error("Missing confirmed financial context");
    expect(result.context.financial.headDigest).toBe(frozen.payload.headDigest);
    expect(result.context.financial.freezeDigest).toBe(frozen.digest);
    expect(result.context.financial?.ledgerReceipt).toBeNull();
    expect(result.evidence).toEqual([
      {
        ...f.draft.subject,
        grantId: f.material.draft.grant.grantId,
        disclosureDigest: f.material.scope.disclosureDigest,
        fields: ["dueAmount"],
      },
    ]);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    for (const secret of [
      f.original.requestJws,
      f.original.receiptJws,
      f.frozen[0]?.approvalJws,
      f.draft.reason,
      "Jws",
      '"values"',
    ])
      expect(JSON.stringify(result)).not.toContain(secret ?? "missing");
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.request.budgetDomainId)),
    ).toEqual(before);
    expect(
      await db.select().from(submissions).where(eq(submissions.agreementRevisionId, f.revisionId)),
    ).toEqual(queued);
  }
});

test("arbitration review rejects missing freeze, missing evidence, excess fields and duplicate selections", async () => {
  const pending = await arbitrationContextFixture();
  expect((await pending.read()).financial).toBeNull();
  await expect(
    new FederationArbitrationReviewService(db, pending.service, pending.evidence).review(
      pending.owner.actor,
      pending.scope.caseId,
      { grantIds: [] },
    ),
  ).rejects.toThrow("DATA_WAITING");
  const f = await arbitrationReviewFixture();
  await expect(f.inspect([])).rejects.toThrow("DATA_WAITING");
  await expect(
    f.inspect([f.material.draft.grant.grantId, f.material.draft.grant.grantId]),
  ).rejects.toThrow();
  const excess = await f.createMaterial(["dueAmount", "grossAmount"]);
  // A disclosure policy can allow more than the original arbitration policy; the latter still bounds this review.
  await expect(f.inspect([excess.draft.grant.grantId])).rejects.toThrow("POLICY_DENIED");
  await f.aDisclosure.revoke(f.actor, f.revisionId, f.material.draft.grant.grantId);
  await expect(f.inspect()).rejects.toThrow();
});

test("arbitration review requires independent evidence authority and rechecks it after the network", async () => {
  const f = await arbitrationReviewFixture();
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "disclosure.receive", enabled: false },
    f.owner.actor.userId,
  );
  await expect(f.inspect()).rejects.toThrow("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "disclosure.receive", enabled: true },
    f.owner.actor.userId,
  );
  const evidence = new FederationEvidenceService(db, f.r.signing, async (...args) => {
    const response = await f.send(...args);
    await new FederationPermissionService(db).set(
      { ...f.owner.actor, capability: "disclosure.receive", enabled: false },
      f.owner.actor.userId,
    );
    return response;
  });
  await expect(
    new FederationArbitrationReviewService(db, f.service, evidence).review(
      f.owner.actor,
      f.scope.caseId,
      { grantIds: [f.material.draft.grant.grantId] },
    ),
  ).rejects.toThrow("POLICY_DENIED");
});

test("arbitration review rejects mismatched frozen signatures, changed heads, and another case's imported material", async () => {
  const f = await arbitrationReviewFixture();
  const other = await arbitrationReviewFixture();
  await expect(f.inspect([other.material.draft.grant.grantId])).rejects.toThrow(
    "ASSET_UNAVAILABLE",
  );
  const saved = f.frozen.find((r) => r.localSiteId === f.a.signing.siteId);
  if (!saved?.counterpartyJws) throw new Error("Missing freeze original");
  await db
    .update(federationDisputeFreezes)
    .set({ counterpartyJws: saved.approvalJws })
    .where(
      and(
        eq(federationDisputeFreezes.localSiteId, f.a.signing.siteId),
        eq(federationDisputeFreezes.caseId, f.scope.caseId),
      ),
    );
  await expect(f.inspect()).rejects.toThrow("UNTRUSTED_IDENTITY");
  await db
    .update(federationDisputeFreezes)
    .set({ counterpartyJws: saved.counterpartyJws })
    .where(
      and(
        eq(federationDisputeFreezes.localSiteId, f.a.signing.siteId),
        eq(federationDisputeFreezes.caseId, f.scope.caseId),
      ),
    );
  await db
    .update(federationCommercialBills)
    .set({ counterpartyJws: null })
    .where(
      and(
        eq(federationCommercialBills.localSiteId, f.a.signing.siteId),
        eq(federationCommercialBills.billId, f.draft.subject.recordId),
      ),
    );
  await expect(f.inspect()).rejects.toThrow("DATA_WAITING");
});

test("arbitration review HTTP rejects automation and malformed selections and returns no execution permit", async () => {
  const f = await arbitrationReviewFixture();
  const app = new Hono();
  let automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.owner.actor as never);
    c.set("automation" as never, automation as never);
    await next();
  });
  app.route("/", createFederationEvidenceRoutes(f.evidence, f.service, f.review));
  const call = (body: unknown) =>
    app.request(`/federation/evidence-cases/${f.scope.caseId}/arbitration-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = await call({ grantIds: [f.material.draft.grant.grantId] });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  const parsed = z.object({ data: ArbitrationReviewSchema }).parse(await ok.json());
  expect(Object.keys(parsed.data)).toEqual(["context", "evidence", "expiresAt"]);
  expect((await call({ grantIds: [f.material.draft.grant.grantId], execute: true })).status).toBe(
    400,
  );
  automation = true;
  expect((await call({ grantIds: [f.material.draft.grant.grantId] })).status).toBe(403);
});

test("arbitration review can combine authorized fields only for the same bound original and cannot outlive context", async () => {
  const f = await arbitrationReviewFixture("bilateral_direct", ["dueAmount", "grossAmount"]);
  await expect(f.inspect()).rejects.toThrow("DATA_WAITING");
  const second = await f.createMaterial(["grossAmount"]);
  const ids = [f.material.draft.grant.grantId, second.draft.grant.grantId];
  expect((await f.inspect(ids)).evidence).toHaveLength(2);
  const evidence = new FederationEvidenceService(db, f.r.signing, async (...args) => {
    const response = await f.send(...args);
    setSystemTime(new Date(Date.now() + 31000));
    return response;
  });
  try {
    await expect(
      new FederationArbitrationReviewService(db, f.service, evidence).review(
        f.owner.actor,
        f.scope.caseId,
        { grantIds: ids },
      ),
    ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  } finally {
    setSystemTime();
  }
});

test("arbitration review rejects signed but unauthorized subject types and future freeze proofs", async () => {
  const f = await arbitrationReviewFixture();
  f.change(async (jws, key) => {
    const context = ArbitrationContextSchema.parse(
      JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString()),
    );
    context.subject.recordType = "usage";
    return signFederationMessage(ArbitrationContextSchema, context, key.signing);
  });
  await expect(f.inspect()).rejects.toThrow("POLICY_DENIED");
  const original = f.frozen[0]?.payload;
  if (!original) throw new Error("Missing frozen boundary");
  const future = { ...original, issuedAt: new Date(Date.now() + 86400000).toISOString() };
  const sourceJws = await signFederationMessage(CommercialDisputeFreezeSchema, future, f.a.signing);
  const targetJws = await signFederationMessage(CommercialDisputeFreezeSchema, future, f.b.signing);
  const digest = `sha256:${createHash("sha256")
    .update(Buffer.from(sourceJws.split(".")[1] ?? "", "base64url"))
    .digest("hex")}`;
  f.change(async (jws, key) => {
    const context = ArbitrationContextSchema.parse(
      JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString()),
    );
    if (!context.financial) throw new Error("Missing signed financial context");
    context.financial = { ...context.financial, sourceJws, targetJws, freezeDigest: digest };
    return signFederationMessage(ArbitrationContextSchema, context, key.signing);
  });
  await expect(f.inspect()).rejects.toThrow("POLICY_DENIED");
});

async function arbitrationDecisionFixture(
  mode: FederationMode = "bilateral_direct",
  withSettlement = false,
) {
  const f = await arbitrationReviewFixture(mode, undefined, withSettlement);
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "arbitration.decide", enabled: true },
    f.owner.actor.userId,
  );
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["arbitration-decision"]'::jsonb`,
    })
    .where(eq(federationSigningKeys.siteId, f.r.signing.siteId));
  const decisions = new FederationArbitrationDecisionService(db, f.r.signing, f.review);
  const input = {
    decisionId: randomUUID(),
    grantIds: [f.material.draft.grant.grantId],
    outcome: f.initialSettlement
      ? {
          action: "adjust" as const,
          bill: { recordId: f.draft.subject.recordId, recordDigest: f.draft.subject.recordDigest },
          settlement: {
            recordId: f.initialSettlement.settlementId,
            recordDigest: f.initialSettlement.digest,
          },
          previousAdjustment: null,
          chargedAmount: "50",
        }
      : {
          action: "settle" as const,
          bill: { recordId: f.draft.subject.recordId, recordDigest: f.draft.subject.recordDigest },
          chargedAmount: "50",
        },
    reason: "Accepted charge after reviewing disclosed evidence",
  };
  return {
    ...f,
    decisions,
    input,
    decisionDraft: () => decisions.draft(f.owner.actor, f.scope.caseId, input),
  };
}

test("arbitration decision stores a signed immutable basis without money changes and recovers offline after expiry", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await arbitrationDecisionFixture(mode);
    const before = await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.request.budgetDomainId));
    const queued = await db
      .select()
      .from(submissions)
      .where(eq(submissions.agreementRevisionId, f.revisionId));
    const intent = await f.decisionDraft();
    expect(intent.financial.targets).toEqual([
      { bill: f.input.outcome.bill, settlement: null, previousAdjustment: null },
    ]);
    // Human review can outlive the old 30-second observation window.
    setSystemTime(new Date(Date.now() + 31000));
    try {
      const approved = await f.decisions.approve(f.owner.actor, f.scope.caseId, intent);
      const [row] = await db
        .select()
        .from(federationArbitrationDecisions)
        .where(eq(federationArbitrationDecisions.decisionId, intent.decisionId));
      if (!row) throw new Error("Missing decision");
      const signed = await verifyFederationMessage(
        ArbitrationDecisionSchema,
        row.approvalJws,
        await f.trust.resolveKey(f.r.signing.siteId, f.r.signing.keyId, new Date()),
        new Date(),
      );
      expect(signed.digest).toBe(row.digest);
      expect(signed.payload.basisDigest).toBe(federationMaterialDigest(row.basis));
      expect(row.basis.contexts).toHaveLength(2);
      expect(row.basis.evidence).toHaveLength(1);
      for (const secret of ["Jws", '"values"', '"basis":', f.original.requestJws])
        expect(JSON.stringify(approved)).not.toContain(secret);
      expect(
        await db
          .select()
          .from(federationBudgets)
          .where(eq(federationBudgets.domainId, f.request.budgetDomainId)),
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(submissions)
          .where(eq(submissions.agreementRevisionId, f.revisionId)),
      ).toEqual(queued);
      f.offline();
      await f.arbitration.source.revoke(f.actor, f.revisionId, f.arbitration.policy.policyId);
      await f.evidence.close(f.owner.actor, f.scope.caseId);
      await db
        .update(federationSigningKeys)
        .set({ revokedAt: new Date() })
        .where(eq(federationSigningKeys.siteId, f.r.signing.siteId));
      setSystemTime(new Date(Date.now() + 31000));
      expect(
        await new FederationArbitrationDecisionService(db, f.r.signing, f.review).approve(
          f.owner.actor,
          f.scope.caseId,
          intent,
        ),
      ).toEqual(approved);
      expect(await f.decisions.read(f.owner.actor, f.scope.caseId)).toEqual(approved);
      expect(
        await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "federation.arbitration_decision.approve"),
              eq(auditLog.target, intent.decisionId),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  }
});

test("arbitration decision requires separate signer capability, current evidence and exact approved intent", async () => {
  const f = await arbitrationDecisionFixture();
  const intent = await f.decisionDraft();
  const permissions = new FederationPermissionService(db);
  await permissions.set(
    { ...f.owner.actor, capability: "arbitration.decide", enabled: false },
    f.owner.actor.userId,
  );
  await expect(f.decisionDraft()).rejects.toThrow("POLICY_DENIED");
  await expect(f.decisions.approve(f.owner.actor, f.scope.caseId, intent)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await permissions.set(
    { ...f.owner.actor, capability: "arbitration.decide", enabled: true },
    f.owner.actor.userId,
  );
  await permissions.set(
    { ...f.owner.actor, capability: "disclosure.receive", enabled: false },
    f.owner.actor.userId,
  );
  await expect(f.decisions.approve(f.owner.actor, f.scope.caseId, intent)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await permissions.set(
    { ...f.owner.actor, capability: "disclosure.receive", enabled: true },
    f.owner.actor.userId,
  );
  await expect(f.decisions.approve(f.actor, f.scope.caseId, intent)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(
    f.decisions.approve(f.owner.actor, f.scope.caseId, {
      ...intent,
      financial: { ...intent.financial, headDigest: `sha256:${"f".repeat(64)}` },
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.decisions.approve(f.owner.actor, f.scope.caseId, {
      ...intent,
      outcome: { ...f.input.outcome, chargedAmount: "61" },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.decisions.approve(f.owner.actor, f.scope.caseId, {
      ...intent,
      outcome: { action: "resolve-without-financial-change" },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'arbitration-decision'` })
    .where(eq(federationSigningKeys.siteId, f.r.signing.siteId));
  await expect(f.decisions.approve(f.owner.actor, f.scope.caseId, intent)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  expect(await f.decisions.read(f.owner.actor, f.scope.caseId)).toBeNull();
});

test("arbitration decision concurrent approvals save once and reject a second decision for the case", async () => {
  const f = await arbitrationDecisionFixture();
  const intent = await f.decisionDraft();
  const outcomes = await Promise.all([
    f.decisions.approve(f.owner.actor, f.scope.caseId, intent),
    f.decisions.approve(f.owner.actor, f.scope.caseId, intent),
  ]);
  expect(outcomes[0]).toEqual(outcomes[1]);
  expect(
    await db
      .select()
      .from(federationArbitrationDecisions)
      .where(eq(federationArbitrationDecisions.caseId, f.scope.caseId)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "federation.arbitration_decision.approve"),
          eq(auditLog.target, intent.decisionId),
        ),
      ),
  ).toHaveLength(1);
  await expect(
    f.decisions.approve(f.owner.actor, f.scope.caseId, { ...intent, decisionId: randomUUID() }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.decisions.approve(f.owner.actor, f.scope.caseId, { ...intent, reason: "Changed" }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("arbitration decision audit failure rolls back both original and basis", async () => {
  const f = await arbitrationDecisionFixture();
  const intent = await f.decisionDraft();
  await db.execute(
    sql`CREATE FUNCTION decision_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.arbitration_decision.approve' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER decision_test_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION decision_test_audit_fail()`,
  );
  try {
    await expect(f.decisions.approve(f.owner.actor, f.scope.caseId, intent)).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER decision_test_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION decision_test_audit_fail()`);
  }
  expect(await f.decisions.read(f.owner.actor, f.scope.caseId)).toBeNull();
  expect((await f.decisions.approve(f.owner.actor, f.scope.caseId, intent)).payload.intent).toEqual(
    intent,
  );
});

test("arbitration decision rechecks signer revocation after remote responses", async () => {
  const f = await arbitrationDecisionFixture();
  const intent = await f.decisionDraft();
  f.after(async () => {
    await new FederationPermissionService(db).set(
      { ...f.owner.actor, capability: "arbitration.decide", enabled: false },
      f.owner.actor.userId,
    );
  });
  await expect(f.decisions.approve(f.owner.actor, f.scope.caseId, intent)).rejects.toThrow(
    "POLICY_DENIED",
  );
  expect(await f.decisions.read(f.owner.actor, f.scope.caseId)).toBeNull();
});

test("arbitration decision HTTP preserves strict intent, human session and private basis boundary", async () => {
  const f = await arbitrationDecisionFixture();
  const app = new Hono();
  let automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.owner.actor as never);
    c.set("automation" as never, automation as never);
    await next();
  });
  app.route("/", createFederationEvidenceRoutes(f.evidence, f.service, f.review, f.decisions));
  const path = `/federation/evidence-cases/${f.scope.caseId}/arbitration-decision`;
  const post = (suffix: string, body: unknown) =>
    app.request(path + suffix, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const draft = await post("/draft", f.input);
  expect(draft.status).toBe(200);
  const { data: intent } = z
    .object({ data: ArbitrationDecisionIntentSchema })
    .parse(await draft.json());
  expect((await post("", { ...intent, execute: true })).status).toBe(400);
  const approved = await post("", intent);
  expect(approved.status).toBe(200);
  expect(approved.headers.get("cache-control")).toBe("no-store");
  const body = await approved.text();
  expect(body).not.toContain("Jws");
  expect(body).not.toContain('"basis":');
  const read = await app.request(path);
  expect(await read.text()).toBe(body);
  automation = true;
  expect((await post("", intent)).status).toBe(403);
});

test("arbitration decision outcome checks exact financial relationships and final charge ceiling", async () => {
  const f = await arbitrationDecisionFixture();
  const review = await f.inspect();
  if (!review.context.financial) throw new Error("Missing financial view");
  const target = review.context.financial.targets[0];
  if (!target) throw new Error("Missing financial target");
  review.context.policy.actions = ["settle", "adjust", "resolve-without-financial-change"];
  const salt = "a".repeat(64);
  expect(
    arbitrationDecisionIntent(
      review,
      { ...f.input, outcome: { action: "resolve-without-financial-change" } },
      salt,
    ).outcome.action,
  ).toBe("resolve-without-financial-change");
  expect(
    ArbitrationOutcomeSchema.safeParse({
      action: "resolve-without-financial-change",
      chargedAmount: "0",
    }).success,
  ).toBe(false);
  target.settlement = { recordId: randomUUID(), recordDigest: `sha256:${"a".repeat(64)}` };
  target.previousAdjustment = { recordId: randomUUID(), recordDigest: `sha256:${"b".repeat(64)}` };
  const outcome = {
    action: "adjust" as const,
    bill: target.bill,
    settlement: target.settlement,
    previousAdjustment: target.previousAdjustment,
    chargedAmount: "60",
  };
  expect(arbitrationDecisionIntent(review, { ...f.input, outcome }, salt).outcome).toEqual(outcome);
  expect(() => arbitrationDecisionIntent(review, f.input, salt)).toThrow("OPERATION_CONFLICT");
  expect(() =>
    arbitrationDecisionIntent(
      review,
      { ...f.input, outcome: { ...outcome, previousAdjustment: null } },
      salt,
    ),
  ).toThrow("OPERATION_CONFLICT");
  expect(() =>
    arbitrationDecisionIntent(
      review,
      { ...f.input, outcome: { ...outcome, chargedAmount: "9007199254740993" } },
      salt,
    ),
  ).toThrow("POLICY_DENIED");
  const firstEvidence = review.evidence[0];
  if (!firstEvidence) throw new Error("Missing selected evidence");
  review.evidence[0] = { ...firstEvidence, recordId: randomUUID() };
  expect(() => arbitrationDecisionIntent(review, { ...f.input, outcome }, salt)).toThrow(
    "DATA_WAITING",
  );
  f.change(async (jws, key) => {
    const context = ArbitrationContextSchema.parse(
      JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString()),
    );
    if (!context.financial) throw new Error("Missing signed financial context");
    const first = context.financial.targets[0];
    if (!first) throw new Error("Missing financial target");
    first.bill.recordId = randomUUID();
    return signFederationMessage(ArbitrationContextSchema, context, key.signing);
  });
  await expect(f.inspect()).rejects.toThrow("POLICY_DENIED");
});

async function arbitrationDeliveryFixture(
  mode: FederationMode = "bilateral_direct",
  noFinancial = false,
  withSettlement = false,
) {
  const f = await arbitrationDecisionFixture(mode, withSettlement);
  const intent = noFinancial
    ? await f.decisions.draft(f.owner.actor, f.scope.caseId, {
        ...f.input,
        outcome: { action: "resolve-without-financial-change" },
      })
    : await f.decisionDraft();
  await f.decisions.approve(f.owner.actor, f.scope.caseId, intent);
  for (const siteId of [f.a.signing.siteId, f.b.signing.siteId, f.r.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["arbitration-decision-delivery","arbitration-decision-receipt"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  const [original] = await db
    .select()
    .from(federationArbitrationDecisions)
    .where(eq(federationArbitrationDecisions.decisionId, intent.decisionId));
  if (!original) throw new Error("Missing original decision");
  const sent: z.infer<typeof ArbitrationDecisionDeliverySchema>[] = [];
  const send: FederationSend = async (...args) => {
    expect(args[2]).toBe("/federation/v1/arbitration-decisions");
    sent.push(
      ArbitrationDecisionDeliverySchema.parse(
        JSON.parse(Buffer.from(args[1].split(".")[1] ?? "", "base64url").toString()),
      ),
    );
    return f.send(...args);
  };
  return {
    ...f,
    intent,
    original,
    sent,
    delivery: new FederationArbitrationDecisionDelivery(db, f.r.signing, send),
    sendDecision: send,
    rows: () =>
      db
        .select()
        .from(federationArbitrationDecisionDeliveries)
        .where(eq(federationArbitrationDecisionDeliveries.decisionId, intent.decisionId)),
  };
}

test("arbitration delivery worker sends both parties the same historical original without financial changes or chain waits", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await arbitrationDeliveryFixture(mode);
    const before = await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.request.budgetDomainId));
    const states = await db
      .select()
      .from(federationDisputes)
      .where(eq(federationDisputes.caseId, f.scope.caseId));
    const queued = await db
      .select()
      .from(submissions)
      .where(eq(submissions.agreementRevisionId, f.revisionId));
    await f.arbitration.source.revoke(f.actor, f.revisionId, f.arbitration.policy.policyId);
    await f.aDisclosure.revoke(f.actor, f.revisionId, f.material.draft.grant.grantId);
    setSystemTime(new Date(Date.now() + 31000));
    try {
      const args: ConstructorParameters<typeof FederationCommercialWorker> = [
        new FederationCommercialSubmissionService(db, f.r.signing.siteId),
      ];
      args[20] = f.delivery;
      const worker = new FederationCommercialWorker(...args);
      await worker.tick();
      await worker.stop();
      const rows = await f.rows();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => ({ state: r.state, error: r.lastError }))).toEqual([
        { state: "received", error: null },
        { state: "received", error: null },
      ]);
      expect(f.sent).toHaveLength(2);
      expect(
        f.sent.every(
          (s) => s.decisionJws === f.original.approvalJws && s.decisionDigest === f.original.digest,
        ),
      ).toBe(true);
      expect(JSON.stringify(f.sent)).not.toContain('"values"');
      expect(JSON.stringify(f.sent)).not.toContain(
        f.original.basis.evidence[0]?.evidence.disclosure.sourceJws ?? "missing",
      );
      for (const key of [f.a, f.b]) {
        const result = await new FederationArbitrationDecisionDelivery(
          db,
          key.signing,
        ).receivedDecision(f.actor, f.revisionId, f.scope.caseId);
        expect(result?.digest).toBe(f.original.digest);
        expect(JSON.stringify(result)).not.toContain("Jws");
      }
      expect(
        await db
          .select()
          .from(federationDisputes)
          .where(eq(federationDisputes.caseId, f.scope.caseId)),
      ).toEqual(states);
      expect(
        await db
          .select()
          .from(federationBudgets)
          .where(eq(federationBudgets.domainId, f.request.budgetDomainId)),
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(submissions)
          .where(eq(submissions.agreementRevisionId, f.revisionId)),
      ).toEqual(queued);
    } finally {
      setSystemTime();
    }
  }
}, 60000);

test("arbitration delivery recovers a lost receipt after service reconstruction and institution key rotation", async () => {
  const f = await arbitrationDeliveryFixture();
  const lost = new FederationArbitrationDecisionDelivery(db, f.r.signing, async (...args) => {
    await f.sendDecision(...args);
    throw new Error("lost receipt");
  });
  await lost.discover();
  await lost.advanceNext();
  const first = f.sent[0];
  if (!first) throw new Error("Missing attempt");
  const rotate = async (
    old: typeof f.r,
    allowedKinds: ("arbitration-decision-delivery" | "arbitration-decision-receipt")[],
  ) => {
    const next = await testKeys(old.signing.siteId);
    next.signing.keyId = `rotated-${randomUUID()}`;
    next.verification.keyId = next.signing.keyId;
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(federationSigningKeys.siteId, old.signing.siteId),
          eq(federationSigningKeys.keyId, old.signing.keyId),
        ),
      );
    await f.trust.addKey(
      next.signing.siteId,
      {
        keyId: next.signing.keyId,
        publicKeyPem: await exportSPKI(next.verification.publicKey),
        allowedKinds,
        validFrom: "2020-01-01T00:00:00Z",
        validUntil: "2099-01-01T00:00:00Z",
      },
      f.owner.actor.userId,
    );
    return next;
  };
  const r = await rotate(f.r, ["arbitration-decision-delivery"]),
    a = await rotate(f.a, ["arbitration-decision-receipt"]),
    b = await rotate(f.b, ["arbitration-decision-receipt"]);
  const attempts: z.infer<typeof ArbitrationDecisionDeliverySchema>[] = [];
  const resumed = new FederationArbitrationDecisionDelivery(
    db,
    r.signing,
    async (endpoint, jws, path) => {
      attempts.push(
        ArbitrationDecisionDeliverySchema.parse(
          JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString()),
        ),
      );
      const key = endpoint === `https://${a.signing.siteId}.test.invalid` ? a : b;
      const response = await createFederationIngress(db, key.signing).request(path ?? "", {
        method: "POST",
        headers: { "content-type": "application/jose", "x-kq-federation-cert": f.fingerprint },
        body: jws,
      });
      if (response.status !== 200) throw new Error(await response.text());
      return response.text();
    },
  );
  // Human grants may end after a durable decision; delivery completes that existing commitment.
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "arbitration.decide", enabled: false },
    f.owner.actor.userId,
  );
  await db
    .update(federationArbitrationDecisionDeliveries)
    .set({ nextAttemptAt: sql`clock_timestamp()` })
    .where(eq(federationArbitrationDecisionDeliveries.decisionId, f.intent.decisionId));
  await resumed.advanceNext();
  await resumed.advanceNext();
  expect((await f.rows()).map((r) => ({ state: r.state, error: r.lastError }))).toEqual([
    { state: "received", error: null },
    { state: "received", error: null },
  ]);
  expect(attempts.every((v) => v.decisionJws === f.original.approvalJws)).toBe(true);
  expect(attempts.find((v) => v.receivingSiteId === first.receivingSiteId)?.deliveryId).toBe(
    first.deliveryId,
  );
  expect(
    await db
      .select()
      .from(federationReceivedArbitrationDecisions)
      .where(eq(federationReceivedArbitrationDecisions.decisionId, f.intent.decisionId)),
  ).toHaveLength(2);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "federation.arbitration_decision.receive"),
          eq(auditLog.target, f.intent.decisionId),
        ),
      ),
  ).toHaveLength(2);
});

test("arbitration delivery rejects wrong original, replayed proof, changed evidence, stale envelope and unrelated institution", async () => {
  const f = await arbitrationDeliveryFixture();
  const delivery = arbitrationDecisionDeliveryPayload(
    f.original,
    randomUUID(),
    f.a.signing.siteId,
    new Date().toISOString(),
  );
  const receiver = new FederationArbitrationDecisionDelivery(db, f.a.signing);
  const call = async (value: typeof delivery) =>
    receiver.receive(
      await signFederationMessage(ArbitrationDecisionDeliverySchema, value, f.r.signing),
      f.fingerprint,
    );
  await expect(call({ ...delivery, decisionDigest: `sha256:${"f".repeat(64)}` })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  const context = structuredClone(delivery);
  context.contexts[1] = context.contexts[0];
  await expect(call(context)).rejects.toThrow();
  const auth = structuredClone(delivery);
  const first = auth.evidenceAuthorizations[0];
  if (!first) throw new Error("Missing authorization");
  first.readId = randomUUID();
  await expect(call(auth)).rejects.toThrow("POLICY_DENIED");
  const originalRequest = f.original.payload.intent.binding.requestDigest;
  await db
    .update(federationOutbound)
    .set({ requestDigest: `sha256:${"e".repeat(64)}` })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  await expect(call(delivery)).rejects.toThrow("POLICY_DENIED");
  await db
    .update(federationOutbound)
    .set({ requestDigest: originalRequest })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  setSystemTime(new Date(Date.now() + 61000));
  try {
    await expect(call(delivery)).rejects.toThrow("AUTHORIZATION_EXPIRED");
  } finally {
    setSystemTime();
  }
  await expect(
    receiver.receive(
      await signFederationMessage(ArbitrationDecisionDeliverySchema, delivery, f.b.signing),
      f.fingerprint,
    ),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(
    await db
      .select()
      .from(federationReceivedArbitrationDecisions)
      .where(eq(federationReceivedArbitrationDecisions.decisionId, f.intent.decisionId)),
  ).toHaveLength(0);
});

test("arbitration delivery rolls back receipt on audit failure, and concurrent duplicate delivery stores once", async () => {
  const f = await arbitrationDeliveryFixture();
  const value = arbitrationDecisionDeliveryPayload(
    f.original,
    randomUUID(),
    f.a.signing.siteId,
    new Date().toISOString(),
  );
  const jws = await signFederationMessage(ArbitrationDecisionDeliverySchema, value, f.r.signing),
    receiver = new FederationArbitrationDecisionDelivery(db, f.a.signing);
  await db.execute(
    sql`CREATE FUNCTION decision_receive_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.arbitration_decision.receive' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER decision_receive_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION decision_receive_audit_fail()`,
  );
  try {
    await expect(receiver.receive(jws, f.fingerprint)).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER decision_receive_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION decision_receive_audit_fail()`);
  }
  expect(
    await db
      .select()
      .from(federationReceivedArbitrationDecisions)
      .where(eq(federationReceivedArbitrationDecisions.decisionId, f.intent.decisionId)),
  ).toHaveLength(0);
  const receipts = await Promise.all([
    receiver.receive(jws, f.fingerprint),
    receiver.receive(jws, f.fingerprint),
  ]);
  expect(receipts[0]).toBe(receipts[1]);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "federation.arbitration_decision.receive"),
          eq(auditLog.target, f.intent.decisionId),
        ),
      ),
  ).toHaveLength(1);
  const wrong = { ...value, deliveryId: randomUUID() };
  await expect(
    receiver.receive(
      await signFederationMessage(ArbitrationDecisionDeliverySchema, wrong, f.r.signing),
      f.fingerprint,
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("arbitration delivery rejects altered receipts and exposes bounded authorized status and retry", async () => {
  const f = await arbitrationDeliveryFixture();
  const wrong = new FederationArbitrationDecisionDelivery(db, f.r.signing, async (...args) => {
    const response = await f.sendDecision(...args);
    const payload = ArbitrationDecisionReceiptSchema.parse(
      JSON.parse(Buffer.from(response.split(".")[1] ?? "", "base64url").toString()),
    );
    payload.decisionDigest = `sha256:${"a".repeat(64)}`;
    const key = payload.receivingSiteId === f.a.signing.siteId ? f.a : f.b;
    return signFederationMessage(ArbitrationDecisionReceiptSchema, payload, key.signing);
  });
  await wrong.discover();
  await wrong.advanceNext();
  const row = (await f.rows()).find((r) => r.state === "needs_review");
  if (!row) throw new Error("Missing reviewed delivery");
  expect(row.lastError).toBe("OPERATION_CONFLICT");
  await expect(f.delivery.status(f.actor, f.scope.caseId)).rejects.toThrow("POLICY_DENIED");
  const app = new Hono();
  let automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.owner.actor as never);
    c.set("automation" as never, automation as never);
    await next();
  });
  app.route(
    "/",
    createFederationEvidenceRoutes(f.evidence, f.service, f.review, f.decisions, f.delivery),
  );
  const path = `/federation/evidence-cases/${f.scope.caseId}/arbitration-decision/delivery`;
  const status = await app.request(path);
  expect(status.status).toBe(200);
  expect(status.headers.get("cache-control")).toBe("no-store");
  expect(await status.text()).not.toContain("Jws");
  const retry = () =>
    app.request(`${path}/${row.receivingSiteId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  automation = true;
  expect((await retry()).status).toBe(403);
  automation = false;
  expect((await retry()).status).toBe(200);
  await f.delivery.advanceNext();
  await f.delivery.advanceNext();
  expect((await f.rows()).every((r) => r.state === "received")).toBe(true);
  const receiver = new FederationArbitrationDecisionDelivery(db, f.a.signing);
  await expect(
    receiver.receivedDecision(f.owner.actor, f.revisionId, f.scope.caseId),
  ).rejects.toThrow("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "arbitration.approve", enabled: false },
    f.actor.userId,
  );
  await expect(receiver.receivedDecision(f.actor, f.revisionId, f.scope.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
});

async function caseDecisionFixture() {
  const f = await arbitrationDecisionFixture();
  const intent = await f.decisionDraft();
  const original = await f.decisions.approve(f.owner.actor, f.scope.caseId, intent);
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "case.publish", enabled: true },
    f.owner.actor.userId,
  );
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["case-arbitration-decision"]'::jsonb`,
    })
    .where(eq(federationSigningKeys.siteId, f.r.signing.siteId));
  const keys = [f.a, f.b, f.r];
  const caseDomainId = randomUUID();
  const ledger = FabricCaseTrustSchema.parse({
    version: 1,
    generationId: randomUUID(),
    organizations: await Promise.all(
      keys.map(async (k, i) => ({
        siteId: k.signing.siteId,
        mspId: `Org${i}MSP`,
        keys: [
          {
            keyId: k.signing.keyId,
            publicKeyPem: await exportSPKI(k.verification.publicKey),
            validFrom: "2020-01-01T00:00:00Z",
            validUntil: "2099-01-01T00:00:00Z",
          },
        ],
      })),
    ),
    domains: [
      {
        domainId: caseDomainId,
        commercialDomainId: intent.binding.domainId,
        sourceSiteId: f.a.signing.siteId,
        targetSiteId: f.b.signing.siteId,
        recipientSiteId: f.r.signing.siteId,
        collection: "case_ABR_v1",
      },
    ],
    keyPurposes: keys.map((k) => ({
      siteId: k.signing.siteId,
      keyId: k.signing.keyId,
      kinds: ["case-arbitration-decision"],
    })),
  });
  const summary = new FederationCaseArbitrationDecisionService(db, f.r.signing, ledger);
  const publications = new FederationCasePublicationService(db, f.r.signing, ledger);
  const proposals: CaseProposal[] = [],
    advances: string[] = [];
  const transport = { pending: false, wrongReceipt: false, offline: false };
  const client: CaseClient = {
    prepare: async (input) => {
      if (transport.offline) throw new Error("offline");
      proposals.push(input);
      const id = randomBytes(32).toString("hex");
      return { transactionId: id, recovery: Buffer.from(`proposal:${id}`).toString("base64") };
    },
    advance: async (recovery) => {
      advances.push(recovery);
      const [stage, id] = Buffer.from(recovery, "base64").toString().split(":");
      if (!id) throw new Error("missing transaction");
      const [saved] = await db
        .select()
        .from(federationCaseAttempts)
        .where(eq(federationCaseAttempts.transactionId, id));
      expect(saved?.recovery).toBe(recovery);
      if (stage === "proposal")
        return {
          state: "prepared",
          transactionId: id,
          recovery: Buffer.from(`transaction:${id}`).toString("base64"),
        };
      expect(saved?.dispatchAuthorizedAt).not.toBeNull();
      return transport.pending
        ? { state: "pending", transactionId: id, recovery }
        : { state: "committed", transactionId: id, blockNumber: "1" };
    },
    receipt: async (input) => {
      expect(input.recordType).toBe("case-arbitration-decision");
      const proposal = proposals.at(-1);
      if (!proposal) throw new Error("missing proposal");
      return {
        receipt: {
          recordId: input.recordId,
          digest: transport.wrongReceipt ? `sha256:${"f".repeat(64)}` : proposal.digest,
        },
      };
    },
  };
  const worker = new FederationCaseSubmissionService(
    db,
    f.r.signing.siteId,
    publications,
    client,
    summary,
  );
  const row = async () =>
    (
      await db
        .select()
        .from(federationCaseSubmissions)
        .where(eq(federationCaseSubmissions.localSiteId, f.r.signing.siteId))
    )[0];
  const history = () =>
    db
      .select()
      .from(federationCaseAttempts)
      .where(
        inArray(
          federationCaseAttempts.submissionId,
          db
            .select({ id: federationCaseSubmissions.id })
            .from(federationCaseSubmissions)
            .where(eq(federationCaseSubmissions.localSiteId, f.r.signing.siteId)),
        ),
      )
      .orderBy(asc(federationCaseAttempts.number));
  const due = () =>
    db
      .update(federationCaseSubmissions)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(federationCaseSubmissions.localSiteId, f.r.signing.siteId));
  const draft = await summary.draft(f.owner.actor, f.scope.caseId, caseDomainId);
  return {
    ...f,
    original,
    ledger,
    summary,
    publications,
    worker,
    client,
    proposals,
    advances,
    transport,
    row,
    history,
    due,
    draft,
  };
}

test("case arbitration ledger persists explicit commitment, queues once and leaves budgets and disputes unchanged", async () => {
  const f = await caseDecisionFixture();
  const before = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, f.request.budgetDomainId));
  const disputes = await db
    .select()
    .from(federationDisputes)
    .where(eq(federationDisputes.caseId, f.scope.caseId));
  await f.worker.discover();
  expect(await f.row()).toBeUndefined();
  const approvals = await Promise.all(
    [1, 2].map(() => f.summary.approve(f.owner.actor, f.scope.caseId, f.draft)),
  );
  expect(approvals[0]).toEqual(approvals[1]);
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target, f.input.decisionId),
        eq(auditLog.action, "federation.case_decision.approve"),
      ),
    );
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(approvals)).not.toContain("chargedAmount");
  expect(JSON.stringify(approvals)).not.toContain(f.input.reason);
  await Promise.all([f.worker.discover(), f.worker.discover()]);
  await f.worker.advanceNext();
  await f.worker.advanceNext();
  await f.worker.advanceNext();
  await f.worker.advanceNext();
  expect(await f.row()).toMatchObject({
    publicationId: null,
    arbitrationDecisionId: f.input.decisionId,
    state: "committed",
    receipt: { digest: approvals[0]?.digest },
  });
  expect(f.proposals).toHaveLength(1);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.request.budgetDomainId)),
  ).toEqual(before);
  expect(
    await db.select().from(federationDisputes).where(eq(federationDisputes.caseId, f.scope.caseId)),
  ).toEqual(disputes);
  // A committed record remains readable after current human publication authority is removed.
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "case.publish", enabled: false },
    f.owner.actor.userId,
  );
  expect(await f.summary.read(f.owner.actor, f.scope.caseId)).toEqual(approvals[0] ?? null);
}, 60000);

test("case arbitration ledger rejects altered commitments and missing independent approval, and rolls back audit failure", async () => {
  const f = await caseDecisionFixture();
  await expect(
    f.summary.approve(f.owner.actor, f.scope.caseId, {
      ...f.draft,
      decisionDigest: `sha256:${"f".repeat(64)}`,
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.summary.draft(f.owner.actor, f.scope.caseId, randomUUID())).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(f.summary.read(f.actor, f.scope.caseId)).rejects.toThrow("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "case.publish", enabled: false },
    f.owner.actor.userId,
  );
  await expect(f.summary.approve(f.owner.actor, f.scope.caseId, f.draft)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "case.publish", enabled: true },
    f.owner.actor.userId,
  );
  await db.execute(
    sql`CREATE FUNCTION case_decision_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.case_decision.approve' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER case_decision_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION case_decision_audit_fail()`,
  );
  try {
    await expect(f.summary.approve(f.owner.actor, f.scope.caseId, f.draft)).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER case_decision_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION case_decision_audit_fail()`);
  }
  expect(await f.summary.read(f.owner.actor, f.scope.caseId)).toBeNull();
  // Expired evidence and later policy revocation cannot erase the historical commitment.
  await db
    .update(federationArbitrationPolicies)
    .set({ revokedAt: new Date(), revokedBy: f.actor.userId })
    .where(eq(federationArbitrationPolicies.policyId, f.draft.binding.policyId));
  setSystemTime(new Date(Date.now() + 60000));
  try {
    await f.summary.approve(f.owner.actor, f.scope.caseId, f.draft);
  } finally {
    setSystemTime();
  }
  let automation = false;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.owner.actor as never);
    c.set("automation" as never, automation as never);
    await next();
  });
  app.route(
    "/",
    createFederationEvidenceRoutes(
      f.evidence,
      f.service,
      f.review,
      f.decisions,
      undefined,
      f.summary,
      f.worker,
    ),
  );
  const path = `/federation/evidence-cases/${f.scope.caseId}/arbitration-decision/ledger`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).not.toContain("Jws");
  expect(body).not.toContain("chargedAmount");
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...f.draft, chargedAmount: "1" }),
      })
    ).status,
  ).toBe(400);
  automation = true;
  expect((await app.request(path)).status).toBe(403);
}, 60000);

async function rotateCaseSigner(f: Awaited<ReturnType<typeof caseDecisionFixture>>) {
  const next = await testKeys(f.r.signing.siteId);
  next.signing.keyId = `rotated-${randomUUID()}`;
  next.verification.keyId = next.signing.keyId;
  const registration = {
    keyId: next.signing.keyId,
    publicKeyPem: await exportSPKI(next.verification.publicKey),
    validFrom: "2020-01-01T00:00:00Z",
    validUntil: "2099-01-01T00:00:00Z",
  };
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(federationSigningKeys.siteId, f.r.signing.siteId),
        eq(federationSigningKeys.keyId, f.r.signing.keyId),
      ),
    );
  await f.trust.addKey(
    next.signing.siteId,
    { ...registration, allowedKinds: ["case-arbitration-decision"] },
    f.owner.actor.userId,
  );
  const trust = structuredClone(f.ledger),
    org = trust.organizations.find((org) => org.siteId === next.signing.siteId);
  if (!org) throw new Error("missing R");
  org.keys.push(registration);
  trust.keyPurposes.push({
    siteId: next.signing.siteId,
    keyId: next.signing.keyId,
    kinds: ["case-arbitration-decision"],
  });
  const service = new FederationCaseArbitrationDecisionService(db, next.signing, trust);
  return {
    next,
    service,
    worker: new FederationCaseSubmissionService(
      db,
      next.signing.siteId,
      new FederationCasePublicationService(db, next.signing, trust),
      f.client,
      service,
    ),
  };
}

test("case arbitration ledger reattests only unsent immutable content after rotation and preserves first approval", async () => {
  const f = await caseDecisionFixture();
  await f.summary.approve(f.owner.actor, f.scope.caseId, f.draft);
  await f.worker.discover();
  await f.worker.advanceNext();
  await f.worker.advanceNext();
  const [original] = await db
    .select()
    .from(federationCaseArbitrationDecisions)
    .where(eq(federationCaseArbitrationDecisions.decisionId, f.input.decisionId));
  const rotated = await rotateCaseSigner(f);
  await f.worker.advanceNext();
  expect((await f.row())?.state).toBe("needs_review");
  await rotated.service.approve(f.owner.actor, f.scope.caseId, f.draft);
  expect((await f.history())[0]?.stage).toBe("abandoned");
  const [saved] = await db
    .select()
    .from(federationCaseArbitrationDecisions)
    .where(eq(federationCaseArbitrationDecisions.decisionId, f.input.decisionId));
  expect(saved?.approvalJws).toBe(original?.approvalJws);
  expect(saved?.digest).toBe(original?.digest);
  expect(federationMessageKeyId(saved?.submissionJws ?? "")).toBe(rotated.next.signing.keyId);
  await rotated.worker.advanceNext();
  await rotated.worker.advanceNext();
  await rotated.worker.advanceNext();
  await rotated.worker.advanceNext();
  expect((await f.row())?.state).toBe("committed");
  expect(await f.history()).toHaveLength(2);
}, 60000);

test("case arbitration ledger recovers the authorized unknown transaction after rotation without replacement or money movement", async () => {
  const f = await caseDecisionFixture();
  await f.summary.approve(f.owner.actor, f.scope.caseId, f.draft);
  await f.worker.discover();
  await f.worker.advanceNext();
  await f.worker.advanceNext();
  f.transport.pending = true;
  await f.worker.advanceNext();
  const [attempt] = await f.history();
  expect(attempt?.dispatchAuthorizedAt).not.toBeNull();
  const rotated = await rotateCaseSigner(f);
  await expect(rotated.service.approve(f.owner.actor, f.scope.caseId, f.draft)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "case.publish", enabled: false },
    f.owner.actor.userId,
  );
  f.transport.pending = false;
  f.transport.wrongReceipt = true;
  await f.due();
  await rotated.worker.advanceNext();
  await rotated.worker.advanceNext();
  expect((await f.row())?.state).toBe("needs_review");
  await expect(rotated.worker.retryArbitration(f.owner.actor, f.scope.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await new FederationPermissionService(db).set(
    { ...f.owner.actor, capability: "case.publish", enabled: true },
    f.owner.actor.userId,
  );
  f.transport.wrongReceipt = false;
  await rotated.worker.retryArbitration(f.owner.actor, f.scope.caseId);
  await rotated.worker.advanceNext();
  expect((await f.row())?.state).toBe("committed");
  expect(f.proposals).toHaveLength(1);
  expect((await f.history())[0]?.transactionId).toBe(attempt?.transactionId);
}, 60000);

async function arbitrationResolutionFixture(
  mode: FederationMode = "bilateral_direct",
  financial = false,
  withSettlement = false,
) {
  const f = await arbitrationDeliveryFixture(mode, !financial, withSettlement);
  await f.delivery.discover();
  await f.delivery.advanceNext();
  await f.delivery.advanceNext();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "arbitration.execute", enabled: true },
    f.actor.userId,
  );
  return {
    ...f,
    resolveA: new FederationArbitrationResolutionService(db, f.a.signing),
    resolveB: new FederationArbitrationResolutionService(db, f.b.signing),
  };
}

test("arbitration resolution closes only the decided case, retains other freezes and never changes funds", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await arbitrationResolutionFixture(mode);
    const before = await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.request.budgetDomainId));
    const other = await f.sourceCases.draft(f.actor, f.revisionId, {
      subject: f.draft.subject,
      reason: "Second independent case",
      requestedResolution: "Review separately",
      caseId: randomUUID(),
    });
    await f.sourceCases.open(f.actor, f.revisionId, other);
    const [one, two] = await Promise.all([
      f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId),
      f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId),
    ]);
    expect(one).toEqual(two);
    expect(one.appliedAt).not.toBeNull();
    await expect(
      db.transaction((tx) => assertFederationTaskNotDisputed(tx, f.a.signing.siteId, f.request)),
    ).rejects.toThrow("DATA_WAITING");
    const [unclosed] = await db
      .select()
      .from(federationDisputes)
      .where(
        and(
          eq(federationDisputes.localSiteId, f.a.signing.siteId),
          eq(federationDisputes.caseId, other.caseId),
        ),
      );
    expect(unclosed?.state).toBe("FREEZE_PENDING");
    await f.resolveB.execute(f.actor, f.revisionId, f.scope.caseId);
    await db.transaction((tx) =>
      assertFederationTaskNotDisputed(tx, f.b.signing.siteId, f.request),
    );
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.request.budgetDomainId)),
    ).toEqual(before);
    const applied = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, f.intent.decisionId),
          eq(auditLog.action, "federation.arbitration_resolution.apply"),
        ),
      );
    expect(applied).toHaveLength(2);
    const queued = await db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.agreementRevisionId, f.revisionId),
          sql`${submissions.input}->>'operation' = 'record-arbitration-resolution'`,
        ),
      );
    expect(queued).toHaveLength(mode === "bilateral_direct" ? 0 : 2);
    await f.arbitration.source.revoke(f.actor, f.revisionId, f.arbitration.policy.policyId);
    expect(await f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId)).toEqual(one);
  }
}, 60000);

test("arbitration resolution requires separate execution authority and rejects financial awards or revoked mandates", async () => {
  const f = await arbitrationResolutionFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "arbitration.execute", enabled: false },
    f.actor.userId,
  );
  await expect(f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(f.resolveA.read(f.owner.actor, f.revisionId, f.scope.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "arbitration.execute", enabled: true },
    f.actor.userId,
  );
  await f.arbitration.source.revoke(f.actor, f.revisionId, f.arbitration.policy.policyId);
  await expect(f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  expect(await f.resolveA.read(f.actor, f.revisionId, f.scope.caseId)).toBeNull();
  const monetary = await arbitrationResolutionFixture("bilateral_direct", true);
  await expect(
    monetary.resolveA.execute(monetary.actor, monetary.revisionId, monetary.scope.caseId),
  ).rejects.toThrow("POLICY_DENIED");
}, 60000);

test("arbitration resolution audit failure rolls back case closure and execution together", async () => {
  const f = await arbitrationResolutionFixture();
  await db.execute(
    sql`CREATE FUNCTION resolution_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.arbitration_resolution.apply' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER resolution_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION resolution_audit_fail()`,
  );
  try {
    await expect(f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId)).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER resolution_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION resolution_audit_fail()`);
  }
  expect(await f.resolveA.read(f.actor, f.revisionId, f.scope.caseId)).toBeNull();
  const [record] = await db
    .select()
    .from(federationDisputes)
    .where(
      and(
        eq(federationDisputes.localSiteId, f.a.signing.siteId),
        eq(federationDisputes.caseId, f.scope.caseId),
      ),
    );
  expect(record?.state).toBe("DISPUTED");
  expect(
    (await f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId)).appliedAt,
  ).not.toBeNull();
}, 60000);

// Queue-only tests inject the authorization boundary; signed award validation has separate coverage.
async function arbitrationResolutionQueueFixture() {
  const f = await fixture("ledger_coordinated");
  await approveBoth(f);
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  const input = CommercialAdapterProposalInputSchema.parse({
    operation: "resolve-arbitrated-case",
    domainId: f.terms.domainId,
    recordId: randomUUID(),
    digest: `sha256:${"a".repeat(64)}`,
    envelope: {
      sourceSiteId: f.a.signing.siteId,
      targetSiteId: f.b.signing.siteId,
      decisionJws: "queue-only-decision",
      requestJws: "queue-only-request",
      acceptanceJws: "queue-only-acceptance",
    },
  });
  const id = randomUUID();
  await db
    .insert(submissions)
    .values({ id, localSiteId: f.a.signing.siteId, agreementRevisionId: f.revisionId, input });
  const resolution = new FederationArbitrationResolutionService(db, f.a.signing);
  const controls = { authorized: true, failApply: false };
  const authorization = spyOn(resolution, "beforeDisclosure").mockImplementation(async () => {
    if (!controls.authorized) throw new FederationError("AUTHORIZATION_EXPIRED");
  });
  const apply = spyOn(resolution, "apply").mockImplementation(async (tx, decisionId) => {
    await tx.insert(auditLog).values({
      actor: f.actor.userId,
      orgId: f.actor.orgId,
      action: "test.arbitration.queue.apply",
      target: decisionId,
    });
    if (controls.failApply) throw new Error("Injected local commit failure");
  });
  const worker = () =>
    new FederationCommercialSubmissionService(db, f.a.signing.siteId, f.adapter, resolution);
  return {
    ...f,
    input,
    id,
    controls,
    authorization,
    apply,
    worker,
    due: () =>
      db
        .update(submissions)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(submissions.id, id)),
    row: async () => (await db.select().from(submissions).where(eq(submissions.id, id)))[0],
    history: () => db.select().from(attempts).where(eq(attempts.submissionId, id)),
    restore: () => {
      authorization.mockRestore();
      apply.mockRestore();
    },
  };
}

test("arbitration resolution queue stops before dispatch when authority expires after preparation", async () => {
  const f = await arbitrationResolutionQueueFixture();
  try {
    const worker = f.worker();
    await worker.advanceNext();
    await worker.advanceNext();
    expect((await f.history())[0]?.stage).toBe("transaction");
    f.controls.authorized = false;
    const calls = f.adapter.advances.length;
    await worker.advanceNext();
    expect(f.adapter.advances).toHaveLength(calls);
    expect((await f.row())?.state).toBe("needs_review");
    expect((await f.history())[0]?.dispatchAuthorizedAt).toBeNull();
    expect(f.apply).not.toHaveBeenCalled();
  } finally {
    f.restore();
  }
});

test("arbitration resolution queue recovers the original dispatched transaction and atomically retries local apply", async () => {
  const f = await arbitrationResolutionQueueFixture();
  try {
    const worker = f.worker();
    await worker.advanceNext();
    await worker.advanceNext();
    f.adapter.outcome = "pending";
    await worker.advanceNext();
    const [sent] = await f.history();
    expect(sent?.dispatchAuthorizedAt).toBeInstanceOf(Date);
    expect(f.apply).not.toHaveBeenCalled();
    const prepares = f.adapter.prepares.length;
    const checks = f.authorization.mock.calls.length;
    f.controls.authorized = false;
    f.adapter.outcome = "committed";
    f.controls.failApply = true;
    await f.due();
    await f.worker().advanceNext();
    expect((await f.row())?.state).toBe("pending");
    expect((await f.history())[0]?.stage).toBe("transaction");
    const applied = () =>
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.target, f.input.recordId),
            eq(auditLog.action, "test.arbitration.queue.apply"),
          ),
        );
    expect(await applied()).toHaveLength(0);
    f.controls.failApply = false;
    await f.due();
    await f.worker().advanceNext();
    expect((await f.row())?.state).toBe("committed");
    expect(await applied()).toHaveLength(1);
    expect(await f.history()).toHaveLength(1);
    expect((await f.history())[0]?.transactionId).toBe(sent?.transactionId);
    expect(f.adapter.prepares).toHaveLength(prepares);
    expect(f.authorization.mock.calls).toHaveLength(checks);
  } finally {
    f.restore();
  }
});

test("arbitration resolution HTTP requires a human executor, rejects extra fields and never exposes signed envelopes", async () => {
  const f = await arbitrationResolutionFixture();
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    f.approvals,
    new FederationCommercialSubmissionService(db, f.a.signing.siteId),
  ];
  deps[30] = f.resolveA;
  let actor = f.actor,
    automation = false;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    c.set("automation" as never, automation as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...deps));
  const path = `/federation/commercial-agreements/${f.revisionId}/disputes/${f.scope.caseId}/arbitration-resolution`;
  const post = (body = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post({ outcome: "settle" })).status).toBe(400);
  automation = true;
  expect((await post()).status).toBe(403);
  automation = false;
  actor = f.owner.actor;
  expect((await post()).status).toBe(403);
  actor = f.actor;
  await new FederationPermissionService(db).set(
    { ...actor, capability: "arbitration.execute", enabled: false },
    actor.userId,
  );
  expect((await post()).status).toBe(403);
  await new FederationPermissionService(db).set(
    { ...actor, capability: "arbitration.execute", enabled: true },
    actor.userId,
  );
  const executed = await post();
  expect(executed.status).toBe(200);
  expect(executed.headers.get("cache-control")).toBe("no-store");
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).not.toContain("Jws");
  expect(body).not.toContain(f.intent.reason);
  expect(body).not.toContain("envelope");
}, 60000);

test("coordinated monetary arbitration posts only after VALID and rolls back failed local accounting", async () => {
  const f = await arbitrationResolutionFixture("ledger_coordinated", true);
  // Finish the fixture's earlier terminal publication before exercising the award queue.
  for (const key of [f.a, f.b]) {
    const prior = new FederationCommercialSubmissionService(db, key.signing.siteId, f.adapter);
    for (let i = 0; i < 12 && (await prior.advanceNext()); i++) {}
  }
  const a = await f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId);
  const b = await f.resolveB.execute(f.actor, f.revisionId, f.scope.caseId);
  expect(a.appliedAt).toBeNull();
  expect(b.appliedAt).toBeNull();
  const financial = () =>
    db
      .select()
      .from(federationCommercialSettlements)
      .where(eq(federationCommercialSettlements.settlementId, f.intent.decisionId));
  expect(await financial()).toHaveLength(0);
  await expect(
    db.transaction((tx) => f.resolveA.apply(tx, f.intent.decisionId, a.payload.decisionDigest)),
  ).rejects.toThrow("LEDGER_REQUIRED");
  const worker = new FederationCommercialSubmissionService(
    db,
    f.a.signing.siteId,
    f.adapter,
    f.resolveA,
  );
  await worker.advanceNext();
  await worker.advanceNext();
  expect(await financial()).toHaveLength(0);
  await db.execute(
    sql`CREATE FUNCTION monetary_arbitration_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.arbitration_resolution.apply' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER monetary_arbitration_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION monetary_arbitration_audit_fail()`,
  );
  try {
    await worker.advanceNext();
    expect(await financial()).toHaveLength(0);
  } finally {
    await db.execute(sql`DROP TRIGGER monetary_arbitration_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION monetary_arbitration_audit_fail()`);
  }
  await db
    .update(submissions)
    .set({ nextAttemptAt: new Date(0) })
    .where(
      and(
        eq(submissions.localSiteId, f.a.signing.siteId),
        sql`${submissions.input}->>'recordId' = ${f.intent.decisionId}`,
      ),
    );
  await worker.advanceNext();
  const provider = new FederationCommercialSubmissionService(
    db,
    f.b.signing.siteId,
    f.adapter,
    f.resolveB,
  );
  for (let i = 0; i < 3; i++) await provider.advanceNext();
  const rows = await financial();
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.arbitrationDecisionId).toBe(f.intent.decisionId);
    expect(row.approvalJws).toBeNull();
    expect(row.counterpartyJws).toBeNull();
    expect(row.appliedAt).not.toBeNull();
    expect(row.payload.chargedAmount).toBe("50");
  }
  expect(
    (
      await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, f.reservation.reservationId))
    )[0]?.settledAmount,
  ).toBe("50");
  expect(
    (
      await db
        .select()
        .from(federationOutbound)
        .where(eq(federationOutbound.operationId, f.request.operationId))
    )[0]?.settledAmount,
  ).toBe("50");
  expect(
    (await f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId)).appliedAt,
  ).not.toBeNull();
  expect(await financial()).toEqual(rows);
  const stored = rows[0];
  if (!stored) throw new Error("Missing arbitrated original");
  await expect(
    db.transaction(async (tx) => {
      await tx
        .update(federationCommercialSettlements)
        .set({ approvalJws: "fabricated-pair-signature" })
        .where(
          and(
            eq(federationCommercialSettlements.localSiteId, stored.localSiteId),
            eq(federationCommercialSettlements.settlementId, stored.settlementId),
          ),
        );
    }),
  ).rejects.toThrow();
  await expect(
    db.transaction((tx) =>
      verifyArbitratedFinancialOriginal(tx, stored.localSiteId, {
        ...stored,
        payload: { ...stored.payload, chargedAmount: "49", releasedAmount: "11" },
      }),
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");

  const listed = await new FederationSettlementService(db, f.a.signing).list(
    f.actor,
    f.revisionId,
    10,
    0,
  );
  expect(listed.data[0]?.ledger?.state).toBe("committed");
  const exchange = new FederationCommercialApprovalExchange(db, f.a.signing);
  await exchange.discover();
  expect(
    await db
      .select()
      .from(federationCommercialApprovalSyncs)
      .where(eq(federationCommercialApprovalSyncs.recordId, f.intent.decisionId)),
  ).toHaveLength(0);
  const adjustment = new FederationAdjustmentService(db, f.a.signing);
  const draft = await adjustment.draft(f.actor, f.revisionId, {
    adjustmentId: randomUUID(),
    settlementId: f.intent.decisionId,
    chargedAmount: "40",
    reason: "Bilateral correction after award",
    supportingEvidenceDigest: a.payload.decisionDigest,
  });
  expect(draft.previousChargedAmount).toBe("50");
  const newCase = await f.sourceCases.draft(f.actor, f.revisionId, {
    caseId: randomUUID(),
    subject: {
      recordType: "settlement",
      recordId: f.intent.decisionId,
      recordDigest: a.payload.decisionDigest,
    },
    reason: "Review arbitrated original",
    requestedResolution: "Review charge",
  });
  expect(newCase.subject.recordId).toBe(f.intent.decisionId);
}, 60000);

test("coordinated arbitration adjustment preserves original settlement and allows a later bilateral correction", async () => {
  const f = await arbitrationResolutionFixture("ledger_coordinated", true, true);
  if (!f.initialSettlement) throw new Error("Missing initial bilateral settlement");
  const settlement = f.initialSettlement;
  for (const [key, resolution] of [
    [f.a, f.resolveA],
    [f.b, f.resolveB],
  ] as const) {
    await resolution.execute(f.actor, f.revisionId, f.scope.caseId);
    const worker = new FederationCommercialSubmissionService(
      db,
      key.signing.siteId,
      f.adapter,
      resolution,
    );
    for (let i = 0; i < 3; i++) await worker.advanceNext();
  }
  const posted = await db
    .select()
    .from(federationCommercialAdjustments)
    .where(eq(federationCommercialAdjustments.adjustmentId, f.intent.decisionId));
  expect(posted).toHaveLength(2);
  for (const row of posted) {
    expect(row.appliedAt).not.toBeNull();
    expect(row.approvalJws).toBeNull();
    expect(row.counterpartyJws).toBeNull();
    expect(row.payload).toMatchObject({
      previousChargedAmount: settlement.payload.chargedAmount,
      chargedAmount: "50",
    });
    expect(row.arbitrationDecisionId).toBe(f.intent.decisionId);
  }
  const source = new FederationAdjustmentService(db, f.a.signing),
    target = new FederationAdjustmentService(db, f.b.signing);
  const listed = await source.list(
    f.actor,
    f.revisionId,
    10,
    0,
    undefined,
    settlement.settlementId,
  );
  expect(listed.summary?.currentChargedAmount).toBe("50");
  expect(listed.data[0]?.ledger?.state).toBe("committed");
  const terms = await source.draft(f.actor, f.revisionId, {
    adjustmentId: randomUUID(),
    settlementId: settlement.settlementId,
    chargedAmount: "45",
    reason: "Subsequent bilateral correction",
    supportingEvidenceDigest: settlement.digest,
  });
  expect(terms.previous?.adjustmentId).toBe(f.intent.decisionId);
  const own = await source.approve(f.actor, f.revisionId, terms),
    peer = await target.approve(f.actor, f.revisionId, terms);
  await source.attachCounterparty(f.actor, f.revisionId, terms.adjustmentId, peer.approvalJws);
  await target.attachCounterparty(f.actor, f.revisionId, terms.adjustmentId, own.approvalJws);
  for (const key of [f.a, f.b]) {
    const worker = new FederationCommercialSubmissionService(db, key.signing.siteId, f.adapter);
    for (let i = 0; i < 3; i++) await worker.advanceNext();
  }
  expect(
    (await source.list(f.actor, f.revisionId, 10, 0, undefined, settlement.settlementId)).summary
      ?.currentChargedAmount,
  ).toBe("45");
  expect(
    (
      await db
        .select()
        .from(federationCommercialSettlements)
        .where(eq(federationCommercialSettlements.settlementId, settlement.settlementId))
    )[0]?.payload.chargedAmount,
  ).toBe(settlement.payload.chargedAmount);
}, 60000);

test("monetary arbitration refuses an additional unresolved case before creating a commitment", async () => {
  const f = await arbitrationResolutionFixture("ledger_coordinated", true);
  const other = await f.sourceCases.draft(f.actor, f.revisionId, {
    caseId: randomUUID(),
    subject: f.draft.subject,
    reason: "Independent claim",
    requestedResolution: "Separate review",
  });
  await f.sourceCases.open(f.actor, f.revisionId, other);
  await expect(f.resolveA.execute(f.actor, f.revisionId, f.scope.caseId)).rejects.toThrow(
    "DATA_WAITING",
  );
  expect(await f.resolveA.read(f.actor, f.revisionId, f.scope.caseId)).toBeNull();
  expect(
    await db
      .select()
      .from(federationCommercialSettlements)
      .where(eq(federationCommercialSettlements.agreementRevisionId, f.revisionId)),
  ).toHaveLength(0);
}, 60000);
