import { afterAll, expect, setSystemTime, test } from "bun:test";
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
  federationAssetMappings,
  federationBudgets,
  federationCancellations,
  federationCapabilities,
  federationCertificates,
  federationCommercialApprovalSyncs,
  federationEvidence,
  federationExecutionTerminals,
  federationMaterials,
  federationOutbound,
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
  workflowExecutionJobs,
  workflowExecutionLeases,
  workflowRuns,
} from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  FederationCancellationReceiptSchema,
  FederationCancellationSchema,
  FederationDelegationSchema,
  type FederationMode,
  FederationResultReceiptAckSchema,
  FederationResultReceiptSchema,
  FederationResultReportSchema,
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
} from "@kuintessence/shared/federation";
import {
  type CommercialAdapterProposalInput,
  type CommercialAdvanceResult,
  CommercialAgreementSchema,
  CommercialAgreementSummarySchema,
  CommercialExecutionApprovalSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialTerminalSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialApprovalQuerySchema,
  CommercialApprovalWaitingSchema,
} from "@kuintessence/shared/federation/commercial-approval-exchange";
import {
  type MarketAdapterProposalInput,
  type MarketAdvanceResult,
  MarketDemandStateSchema,
  type MarketProposalInput,
  MarketProposalInputSchema,
} from "@kuintessence/shared/federation/market";
import { ReservationProposalReceiptSchema } from "@kuintessence/shared/federation/reservation-proposal";
import {
  TERMINAL_MAX_BYTES,
  TerminalChunkSchema,
  TerminalDeliverySchema,
  TerminalQuerySchema,
} from "@kuintessence/shared/federation/terminal-exchange";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { JobCancellationOutbox } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationCommercialRoutes } from "../routes/federation-commercial";
import { createFederationOutboundRoutes } from "../routes/federation-outbound";
import { JobService } from "../services/job-service";
import { SoftwareAvailabilityService } from "../services/software-availability";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialApprovalExchange } from "./commercial-approval-exchange";
import type { CommercialClient } from "./commercial-client";
import { FederationCommercialExecutionService } from "./commercial-execution";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationCommercialWorker } from "./commercial-worker";
import { FederationDispatchAuthorization } from "./dispatch-authorization";
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
import { FederationOutboundService } from "./outbound";
import type { FederationSend } from "./outbound-client";
import { FederationPermissionService } from "./permissions";
import { FederationPreparationService } from "./preparation";
import {
  FederationReservationPolicyService,
  ReservationPolicyInputSchema,
} from "./reservation-policy";
import { FederationReservationProposalService } from "./reservation-proposals";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { FederationTerminalAutomation } from "./terminal-automation";
import { FederationTerminalPolicyService, TerminalPolicyInputSchema } from "./terminal-policy";
import { testAgreement, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Commercial PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const fixtures: {
  a: Awaited<ReturnType<typeof testKeys>>;
  b: Awaited<ReturnType<typeof testKeys>>;
  actor: { orgId: string; userId: string };
}[] = [];
class Adapter implements CommercialClient {
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
  for (const f of fixtures) {
    const siteIds = [f.a.signing.siteId, f.b.signing.siteId];
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
) {
  const f = await fixture("ledger_coordinated", true, explicitPurpose);
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
      mode: "ledger_coordinated",
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
async function activationFixture(withMaterials = false, withResults = false) {
  const f = await executionFixture(true, withMaterials, withResults);
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
  return { ...f, market, marketAdapter, activationId: randomUUID() };
}

async function confirmationFixture(provider = false, withMaterials = false, withResults = false) {
  const f = await activationFixture(withMaterials, withResults);
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

test("coordinated source delivery and provider preparation share exact reservations and bounded dispatch authority", async () => {
  const f = await confirmationFixture(true, true);
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
) {
  const f = await confirmationFixture(true, true, withResults);
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
) {
  const f = await terminalFixture(outcome, withResults);
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
) {
  const f = await executionFixture(true, false, false, amounts);
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
  const target = new FederationReservationProposalService(db, f.b.signing, undefined, market);
  let sendHook: ((response: string) => Promise<string>) | undefined;
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/reservation-proposals");
    const result = await target.receive(jws, fingerprints[0] ?? "");
    return sendHook ? sendHook(result) : result;
  };
  const source = new FederationReservationProposalService(db, f.a.signing, send, market);
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
