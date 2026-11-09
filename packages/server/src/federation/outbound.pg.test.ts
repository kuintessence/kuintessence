import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  agents,
  auditLog,
  createPgDb,
  federationAgreementApprovals,
  federationAgreements,
  federationAssetMappings,
  federationBudgets,
  federationCancellations,
  federationCapabilities,
  federationCertificates,
  federationEvidence,
  federationInputAttempts,
  federationInputImports,
  federationInputTransfers,
  federationMaterials,
  federationMediaExportOperations,
  federationMediaExports,
  federationMediaKeyGrants,
  federationOutbound,
  federationPreparations,
  federationReservations,
  federationResultAttempts,
  federationResultImports,
  federationResultReceipts,
  federationResultTransfers,
  federationSigningKeys,
  federationSites,
  federationWorkflowBindings,
  federationWorkflowInputExports,
  jobs,
  netdriveFiles,
  orgs,
  softwareAssetRevisions,
  softwareAssets,
  storageQuotaPolicies,
  userOrgMemberships,
  users,
  workflowArtifactFiles,
  workflowArtifacts,
  workflowExecutionDelegations,
  workflowRuns,
} from "@kuintessence/db";
import {
  FederationInputCopyReportSchema,
  FederationInputGrantRequestSchema,
  FederationMediaExportLeaseRequestSchema,
  FederationResultCopyReportSchema,
  FederationResultGrantRequestSchema,
  type ServerMessage,
} from "@kuintessence/proto";
import {
  createUsecaseExecutor,
  WorkflowExecutionInterrupted,
  WorkflowExecutionWaiting,
  workflowDsl,
} from "@kuintessence/shared";
import {
  FederationAcceptanceSchema,
  type FederationAgreement,
  FederationAgreementSchema,
  type FederationAssetRef,
  FederationCancellationReceiptSchema,
  FederationCancellationSchema,
  FederationError,
  FederationInputDownloadGrantSchema,
  FederationInputDownloadQuerySchema,
  FederationMaterialChunkSchema,
  FederationMaterialQuerySchema,
  FederationMediaKeyGrantSchema,
  FederationMediaKeyQuerySchema,
  FederationMediaManifestSchema,
  type FederationParameterOverrides,
  FederationResultDownloadGrantSchema,
  FederationResultDownloadQuerySchema,
  FederationResultQuerySchema,
  FederationResultReceiptAckSchema,
  FederationResultReceiptSchema,
  FederationResultReportSchema,
  FederationResultVerifyTaskSchema,
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { MediaAge } from "@kuintessence/shared/federation/media-age";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportJWK, exportSPKI, generateKeyPair } from "jose";
import pino from "pino";
import { stringify } from "yaml";
import { AgentDispatcher } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminFederationStorageRoutes } from "../routes/admin-federation-storage";
import { createFederationMediaRoutes } from "../routes/federation-media";
import { createFederationOutboundRoutes } from "../routes/federation-outbound";
import { artifactBatchHash } from "../services/artifact-members";
import { NetDriveService } from "../services/netdrive";
import { StorageQuotaService } from "../services/storage-quota";
import type { ObjectStat } from "../storage/minio-client";
import { FakeMinioBackend } from "../storage/minio-client.test";
import { WorkflowAsyncRunner } from "../workflow/async-runner";
import { WorkflowExecutionJournalStore } from "../workflow/execution-journal";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { createWorkflowRunner } from "../workflow/runner";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationCancellationReceiver } from "./cancellation";
import { FederationCancellationMonitor } from "./cancellation-monitor";
import { readFederationCancellationState } from "./cancellation-state";
import type { FederationDownloadStorage } from "./download-credential";
import { FederationExecutionBindingService } from "./execution-binding";
import { createFederationIngress } from "./ingress";
import { cancelFederationInputImport, FederationInputImports } from "./input-imports";
import { FederationInputPublication } from "./input-publication";
import { FederationInputReader } from "./input-reader";
import { FederationInputStorage, type FederationInputStorageBackend } from "./input-storage";
import { FederationInputTransfers } from "./input-transfers";
import { FederationInputTransport } from "./input-transport";
import { FederationInputWorker } from "./input-worker";
import { FederationMaterialExchange } from "./material-exchange";
import { FederationMediaExportOperations } from "./media-export-operations";
import { FederationMediaExportTransport } from "./media-export-transport";
import { FederationMediaExportService } from "./media-exports";
import { FederationMediaKeyResponder } from "./media-key-exchange";
import { FederationMediaPackageService } from "./media-packages";
import { FederationOutboundService, FederationOutboundWorker } from "./outbound";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { FederationPermissionService } from "./permissions";
import { FederationPreparationService } from "./preparation";
import { FederationPreparationWorker } from "./preparation-worker";
import { FederationResultImports } from "./result-imports";
import { FederationResultReceiptReceiver, FederationResultReceiptSender } from "./result-receipts";
import { FederationResultStorage } from "./result-storage";
import { FederationResultTransport } from "./result-transport";
import { FederationResultWorker } from "./result-worker";
import { type FederationResultDownloadStorage, FederationResultResponder } from "./results";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { FederationStatusResponder } from "./status";
import type { FederationStorageGuard } from "./storage-capacity";
import { FederationTaskMediaSources } from "./task-media-source";
import { testAgreement, testDelegation, testKeys, testNow } from "./test-fixtures";
import { lockFederationTransferSlot } from "./transfer-agent";
import { FederationTrustRegistry } from "./trust-registry";
import { bindWorkflowDelegation, type WorkflowDelegationPlan } from "./workflow-delegations";
import { FederationWorkflowExecutor } from "./workflow-executor";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Isolated federation test database required");
const db = createPgDb(url, { max: 10, idle_timeout: 1 });
const actor = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const receiver = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const executionUserId = crypto.randomUUID();
const trust = new FederationTrustRegistry(db);
const permission = new FederationPermissionService(db);
const assets = new FederationAssetService(db, { authorizeSoftware: async () => {} });
let a: Awaited<ReturnType<typeof testKeys>>;
let b: Awaited<ReturnType<typeof testKeys>>;
let aService: FederationAgreementService;
let bService: FederationAgreementService;
let time = new Date(testNow);
const clock = () => time;
const sourceRunIds: string[] = [];
const sourceInputFileIds: string[] = [];
const revisions: string[] = [];
const transferAgentIds: string[] = [];
const assetIds: string[] = [];
const agreements: FederationAgreement[] = [];
const sourceFingerprint = "ab".repeat(32);
const targetFingerprint = "cd".repeat(32);

afterEach(async () => {
  const inputIds = db
    .select({ id: federationInputImports.id })
    .from(federationInputImports)
    .where(eq(federationInputImports.ownerId, executionUserId));
  const transferIds = db
    .select({ id: federationInputTransfers.id })
    .from(federationInputTransfers)
    .where(inArray(federationInputTransfers.importId, inputIds));
  await db
    .delete(netdriveFiles)
    .where(and(eq(netdriveFiles.ownerId, executionUserId), inArray(netdriveFiles.id, transferIds)));
  await db
    .delete(federationInputAttempts)
    .where(inArray(federationInputAttempts.transferId, transferIds));
  await db
    .delete(federationInputTransfers)
    .where(inArray(federationInputTransfers.importId, inputIds));
  await db
    .delete(federationInputImports)
    .where(eq(federationInputImports.ownerId, executionUserId));
  // Finished fixtures remain for final FK cleanup, but must not enter a later worker's page.
  const reservations = await db
    .select({ reservationId: federationReservations.id })
    .from(federationReservations)
    .where(eq(federationReservations.senderSiteId, a.signing.siteId));
  const deferred = new Date("2030-01-01T00:00:00Z");
  if (reservations.length)
    await db
      .insert(federationPreparations)
      .values(
        reservations.map(({ reservationId }) => ({
          reservationId,
          state: "blocked",
          blocker: "POLICY_DENIED",
          updatedAt: deferred,
        })),
      )
      .onConflictDoUpdate({
        target: federationPreparations.reservationId,
        set: { updatedAt: deferred },
      });
  await db
    .update(federationCancellations)
    .set({ nextCheckAt: deferred })
    .where(
      and(
        eq(federationCancellations.localSiteId, b.signing.siteId),
        eq(federationCancellations.senderSiteId, a.signing.siteId),
      ),
    );
  // Source delivery must also exclude every previous fixture, including standalone API tasks.
  await db
    .update(federationOutbound)
    .set({
      nextAttemptAt: new Date("2030-01-01T00:00:00Z"),
      statusNextAttemptAt: new Date("2030-01-01T00:00:00Z"),
      cancelNextAttemptAt: new Date("2030-01-01T00:00:00Z"),
    })
    .where(eq(federationOutbound.localSiteId, a.signing.siteId));
});

beforeAll(async () => {
  await db
    .insert(orgs)
    .values([actor, receiver].map(({ orgId }) => ({ id: orgId, name: "Outbound test" })));
  await db.insert(users).values([
    ...[actor, receiver].map(({ userId, orgId }) => ({
      id: userId,
      orgId,
      email: `${userId}@test.invalid`,
      role: "user" as const,
    })),
    {
      id: executionUserId,
      orgId: receiver.orgId,
      email: `${executionUserId}@test.invalid`,
      role: "user",
      serviceAccount: true,
    },
  ]);
  await db.insert(userOrgMemberships).values(
    [actor, receiver, { orgId: receiver.orgId, userId: executionUserId }].map((identity) => ({
      ...identity,
      role: "member",
    })),
  );
  [a, b] = await Promise.all([testKeys(), testKeys()]);
  for (const key of [a, b]) {
    await trust.addSite(
      { id: key.signing.siteId, name: "Test peer", endpoint: "https://peer.test.invalid" },
      actor.userId,
    );
    await trust.addKey(
      key.signing.siteId,
      {
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: [
          "agreement",
          "delegation",
          "acceptance",
          "status-query",
          "status-report",
          "cancellation",
          "cancellation-receipt",
          "result-query",
          "result-report",
          "result-download-query",
          "result-download-grant",
          "result-receipt",
          "result-receipt-ack",
          "material-query",
          "material-chunk",
          "input-download-query",
          "input-download-grant",
          "media-manifest",
          "media-key-query",
          "media-key-grant",
        ],
        validFrom: key.verification.validFrom.toISOString(),
        validUntil: key.verification.validUntil.toISOString(),
      },
      actor.userId,
    );
  }
  await db.insert(federationCertificates).values(
    [a, b].map((key, i) => ({
      siteId: key.signing.siteId,
      fingerprint: i === 0 ? sourceFingerprint : targetFingerprint,
      certificatePem: "Database fixture; real mTLS is tested by gateway.test.ts",
      validFrom: key.verification.validFrom,
      validUntil: key.verification.validUntil,
    })),
  );
  for (const identity of [actor, receiver])
    for (const capability of ["agreement.approve", "delegation.submit", "asset.map"] as const)
      await permission.set({ ...identity, capability, enabled: true }, actor.userId);
  aService = new FederationAgreementService(db, a.signing, clock);
  bService = new FederationAgreementService(db, b.signing, clock);
});

afterAll(async () => {
  const orgIds = [actor.orgId, receiver.orgId];
  await db
    .delete(federationMediaKeyGrants)
    .where(inArray(federationMediaKeyGrants.localSiteId, [a.signing.siteId, b.signing.siteId]));
  await db
    .delete(federationMediaExportOperations)
    .where(
      inArray(federationMediaExportOperations.localSiteId, [a.signing.siteId, b.signing.siteId]),
    );
  await db.delete(federationMediaExports).where(inArray(federationMediaExports.localOrgId, orgIds));
  await db
    .delete(federationResultReceipts)
    .where(inArray(federationResultReceipts.localSiteId, [a.signing.siteId, b.signing.siteId]));
  const imports = await db
    .select({ id: federationResultImports.id })
    .from(federationResultImports)
    .where(inArray(federationResultImports.localOrgId, orgIds));
  if (imports.length) {
    const ids = imports.map((row) => row.id);
    const transfers = await db
      .select({ id: federationResultTransfers.id })
      .from(federationResultTransfers)
      .where(inArray(federationResultTransfers.importId, ids));
    if (transfers.length)
      await db.delete(federationResultAttempts).where(
        inArray(
          federationResultAttempts.transferId,
          transfers.map((row) => row.id),
        ),
      );
    await db
      .delete(federationResultTransfers)
      .where(inArray(federationResultTransfers.importId, ids));
    await db.delete(federationResultImports).where(inArray(federationResultImports.id, ids));
  }
  if (transferAgentIds.length)
    await db.delete(agents).where(inArray(agents.agentId, transferAgentIds));
  await db.delete(federationOutbound).where(inArray(federationOutbound.localOrgId, orgIds));
  const termsIds = agreements.map((terms) => terms.agreementRevisionId);
  const reservations = await db
    .select({ id: federationReservations.id })
    .from(federationReservations)
    .where(inArray(federationReservations.agreementRevisionId, termsIds));
  if (reservations.length)
    await db.delete(federationEvidence).where(
      inArray(
        federationEvidence.reservationId,
        reservations.map((row) => row.id),
      ),
    );
  await db.delete(federationPreparations).where(
    inArray(
      federationPreparations.reservationId,
      reservations.map((v) => v.id),
    ),
  );
  await db.delete(federationWorkflowBindings).where(
    inArray(
      federationWorkflowBindings.reservationId,
      reservations.map((v) => v.id),
    ),
  );
  const runs = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.submittedBy, executionUserId));
  await db.delete(workflowArtifacts).where(
    inArray(
      workflowArtifacts.workflowRunId,
      runs.map((v) => v.id),
    ),
  );
  await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, executionUserId));
  await db
    .delete(federationReservations)
    .where(inArray(federationReservations.agreementRevisionId, termsIds));
  await db
    .delete(federationCancellations)
    .where(inArray(federationCancellations.agreementRevisionId, termsIds));
  await db.delete(federationAgreements).where(inArray(federationAgreements.revisionId, termsIds));
  for (const terms of agreements)
    await db
      .delete(federationBudgets)
      .where(
        and(
          eq(federationBudgets.domainId, terms.budgetDomainId),
          eq(federationBudgets.epoch, terms.epoch),
        ),
      );
  await db
    .delete(federationAgreementApprovals)
    .where(inArray(federationAgreementApprovals.localOrgId, orgIds));
  await db.delete(federationMaterials).where(inArray(federationMaterials.localOrgId, orgIds));
  await db
    .delete(federationAssetMappings)
    .where(inArray(federationAssetMappings.localOrgId, orgIds));
  await db.delete(softwareAssetRevisions).where(inArray(softwareAssetRevisions.id, revisions));
  await db.delete(softwareAssets).where(inArray(softwareAssets.id, assetIds));
  await db.delete(federationCapabilities).where(inArray(federationCapabilities.orgId, orgIds));
  await db
    .delete(federationCertificates)
    .where(inArray(federationCertificates.siteId, [a.signing.siteId, b.signing.siteId]));
  await db
    .delete(federationSigningKeys)
    .where(inArray(federationSigningKeys.siteId, [a.signing.siteId, b.signing.siteId]));
  await db
    .delete(federationSites)
    .where(inArray(federationSites.id, [a.signing.siteId, b.signing.siteId]));
  await db.delete(auditLog).where(inArray(auditLog.orgId, orgIds));
  await db.delete(jobs).where(eq(jobs.submittedBy, executionUserId));
  await db.delete(workflowRuns).where(eq(workflowRuns.submittedBy, executionUserId));
  if (sourceRunIds.length)
    await db.delete(workflowRuns).where(inArray(workflowRuns.id, sourceRunIds));
  await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.orgId, orgIds));
  if (sourceInputFileIds.length)
    await db.delete(netdriveFiles).where(inArray(netdriveFiles.id, sourceInputFileIds));
  await db.delete(users).where(inArray(users.id, [actor.userId, receiver.userId, executionUserId]));
  await db.delete(orgs).where(inArray(orgs.id, orgIds));
  await db.$client.end();
});

async function fixture(
  resultPolicy?: FederationAgreement["resultPolicy"],
  parameters: Record<string, string | number> = {},
  inputPolicy?: FederationAgreement["inputPolicy"],
  scriptInputs: Record<string, workflowDsl.ScriptInputSpec> = {},
  maxReservations = 100,
) {
  time = new Date(testNow);
  const terms = { ...testAgreement(a.signing.siteId, b.signing.siteId), maxReservations };
  if (resultPolicy) terms.resultPolicy = resultPolicy;
  if (inputPolicy) terms.inputPolicy = inputPolicy;
  agreements.push(terms);
  const assetId = crypto.randomUUID(),
    revisionId = crypto.randomUUID();
  assetIds.push(assetId);
  revisions.push(revisionId);
  const content = "printf ready";
  const payload = {
    kind: "sandbox-script" as const,
    language: "bash" as const,
    content,
    entrypoint: "main.sh",
    sha256: createHash("sha256").update(content).digest("hex"),
    runtimeContractRef: { name: "bash", version: "1" },
    inputs: scriptInputs,
    outputs: {},
  };
  await db.insert(softwareAssets).values({
    id: assetId,
    kind: "sandbox-script",
    name: "Source script",
    version: "1",
    source: "sp-published",
    lifecycle: "published",
    visibility: "platform-public",
    ownerUserId: actor.userId,
    payload,
  });
  await db.insert(softwareAssetRevisions).values({ id: revisionId, assetId, revision: 1, payload });
  const reference = {
    originSiteId: a.signing.siteId,
    kind: "script" as const,
    id: assetId,
    revision: "1",
    digest: federationMaterialDigest(payload),
  };
  terms.templates = [reference];
  await assets.register(actor, { reference, localRevisionId: revisionId });
  const inputs = await assets.putMaterial(actor, a.signing.siteId, {
    protocolVersion: 1,
    kind: "inputs",
    parameters,
    datasets: [],
    bindings: [],
  });
  const environment = await assets.putMaterial(actor, a.signing.siteId, {
    protocolVersion: 1,
    kind: "environment-lock",
    target: { platform: "linux", architecture: "x86_64" },
    nativeLockDigest: terms.termsDigest,
    software: [],
    sandboxRuntime: { kind: "OCI", digest: terms.termsDigest },
  });
  const own = await aService.approve(actor, { terms });
  const other = await bService.approve(receiver, { terms, executionUserId });
  await aService.attachCounterparty(actor, terms.agreementRevisionId, other.approvalJws);
  await bService.attachCounterparty(receiver, terms.agreementRevisionId, own.approvalJws);
  const admission = new FederationAdmission(db, b.signing, b.verification, clock);
  const sent: string[] = [];
  const receive: FederationSend = async (_endpoint, requestJws) => {
    sent.push(requestJws);
    return (
      await admission.receive({
        requestJws,
        senderKey: a.verification,
        authenticatedPeerSiteId: a.signing.siteId,
      })
    ).receiptJws;
  };
  const request = {
    ...testDelegation(terms),
    inputManifestDigest: inputs.digest,
    environmentLockDigest: environment.digest,
  };
  const service = (
    send: FederationSend = receive,
    guard?: Pick<FederationStorageGuard, "assertAdmission">,
  ) =>
    new FederationOutboundService(db, a.signing, send, assets, clock, undefined, undefined, guard);
  return { terms, request, receive, sent, service, reference };
}

async function row(operationId: string) {
  const [value] = await db
    .select()
    .from(federationOutbound)
    .where(eq(federationOutbound.operationId, operationId));
  if (!value) throw new Error("Missing outbound test row");
  return value;
}

async function workflowDelegationFixture(
  policy?: FederationAgreement["resultPolicy"],
  parameters: Record<string, string | number> = {},
  inputPolicy?: FederationAgreement["inputPolicy"],
  scriptInputs: Record<string, workflowDsl.ScriptInputSpec> = {},
) {
  const f = await fixture(policy, parameters, inputPolicy, scriptInputs);
  const registry = new WorkflowRunRegistry(db);
  const runId = crypto.randomUUID();
  sourceRunIds.push(runId);
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Source delegated workflow",
    status: "running",
    submittedBy: actor.userId,
    startedAt: new Date(),
    input: { executionModel: "durable-v2", orgId: actor.orgId, role: "user", yaml: "" },
  });
  const journal = new WorkflowExecutionJournalStore(db);
  const lease = await journal.acquire(runId);
  if (!lease) throw new Error("Missing source execution lease");
  const {
    operationId: _op,
    taskId: _task,
    attempt: _attempt,
    issuedAt: _issued,
    expiresAt: _expires,
    ...plan
  } = f.request;
  const invocation = { path: JSON.stringify(["node", "remote"]) };
  return { ...f, registry, runId, journal, lease, plan, invocation };
}

test("source storage pressure rejects new work with opaque 503 but preserves replay and delivery", async () => {
  const f = await fixture();
  let blocked = true;
  const service = f.service(undefined, {
    async assertAdmission(mode) {
      expect(mode).toBe(f.request.mode);
      if (blocked) throw new FederationError("STORAGE_PRESSURE");
    },
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    await next();
  });
  app.route("/api", createFederationOutboundRoutes(service));
  const response = await app.request("/api/federation/outbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(f.request),
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: { code: "STORAGE_PRESSURE" } });
  expect(
    await db
      .select()
      .from(federationOutbound)
      .where(eq(federationOutbound.operationId, f.request.operationId)),
  ).toHaveLength(0);
  expect(
    await db.select().from(auditLog).where(eq(auditLog.target, f.request.operationId)),
  ).toHaveLength(0);
  blocked = false;
  const accepted = await service.enqueue(actor, f.request);
  blocked = true;
  expect((await service.enqueue(actor, f.request)).operationId).toBe(accepted.operationId);
  await expect(service.enqueue(actor, { ...f.request, maxAmount: "19" })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await service.deliverNext();
  expect((await row(f.request.operationId)).state).toBe("accepted");
});

test("source storage observation cannot extend the admission authorization window", async () => {
  const f = await fixture();
  const service = f.service(undefined, {
    async assertAdmission() {
      time = new Date(Date.parse(f.request.expiresAt) + 1);
    },
  });
  await expect(service.enqueue(actor, f.request)).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect(
    await db
      .select()
      .from(federationOutbound)
      .where(eq(federationOutbound.operationId, f.request.operationId)),
  ).toHaveLength(0);
});

test("workflow storage pressure waits before material capture and resumes an exact durable binding", async () => {
  const f = await workflowDelegationFixture();
  const service = f.service(undefined, {
    async assertAdmission() {
      throw new FederationError("STORAGE_PRESSURE");
    },
  });
  await expect(
    service.enqueueForWorkflow(
      actor,
      f.lease,
      "remote",
      f.invocation,
      f.plan,
      600,
      { value: "new" },
      { invalid: true },
    ),
  ).rejects.toThrow("STORAGE_PRESSURE");
  expect(
    await db
      .select()
      .from(workflowExecutionDelegations)
      .where(eq(workflowExecutionDelegations.runId, f.runId)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationWorkflowInputExports)
      .where(eq(federationWorkflowInputExports.runId, f.runId)),
  ).toHaveLength(0);
  const node = workflowDsl.WorkflowNodeSchema.parse({
    type: "Federation",
    id: "remote",
    name: "Remote",
    agreementRevisionId: f.terms.agreementRevisionId,
    template: f.reference,
    inputManifestDigest: f.request.inputManifestDigest,
    environmentLockDigest: f.request.environmentLockDigest,
    resources: f.request.resources,
    maxAmount: "1",
  });
  if (node.type !== "Federation") throw new Error("Missing federation node");
  const executor = new FederationWorkflowExecutor(db, a.signing.siteId, service, clock);
  await expect(executor.execute(actor, f.lease, node, f.invocation)).rejects.toMatchObject({
    reason: "STORAGE_WAITING",
  });
  const request = await bindWorkflowDelegation(
    f.lease,
    actor,
    "remote",
    f.invocation,
    f.plan,
    600,
    clock,
  );
  expect(
    (await service.enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600))
      .operationId,
  ).toBe(request.operationId);
  await expect(
    service.enqueueForWorkflow(
      actor,
      f.lease,
      "remote",
      f.invocation,
      { ...f.plan, maxAmount: "19" },
      600,
    ),
  ).rejects.toThrow("changed its delegation intent");
  await expect(
    service.enqueueForWorkflow(receiver, f.lease, "remote", f.invocation, f.plan, 600),
  ).rejects.toThrow("POLICY_DENIED");
  await f.lease.release();
});

test("workflow storage is rechecked before creating the durable binding", async () => {
  const f = await workflowDelegationFixture();
  let calls = 0;
  const service = f.service(undefined, {
    async assertAdmission() {
      if (++calls === 2) throw new FederationError("STORAGE_PRESSURE");
    },
  });
  await expect(
    service.enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600),
  ).rejects.toThrow("STORAGE_PRESSURE");
  expect(calls).toBe(2);
  expect(
    await db
      .select()
      .from(workflowExecutionDelegations)
      .where(eq(workflowExecutionDelegations.runId, f.runId)),
  ).toHaveLength(0);
  await f.lease.release();
});

test("workflow delegation keeps one immutable operation across concurrent calls and recovery, with separate loop invocations", async () => {
  const f = await workflowDelegationFixture();
  const plan = { ...f.plan, maxAmount: "20" };
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.service().enqueueForWorkflow(actor, f.lease, "remote", f.invocation, plan, 600),
    ),
  );
  expect(new Set(results.map((r) => r.operationId)).size).toBe(1);
  const first = results[0];
  if (!first) throw new Error("Missing delegation");
  const original = await row(first.operationId);
  await f.lease.release();
  time = new Date(time.getTime() + 120_000);
  const lease = await new WorkflowExecutionJournalStore(db).acquire(f.runId);
  if (!lease) throw new Error("Missing recovery lease");
  const recovered = await f
    .service()
    .enqueueForWorkflow(actor, lease, "remote", f.invocation, plan, 600);
  expect(recovered.operationId).toBe(first.operationId);
  expect((await row(first.operationId)).request).toEqual(original.request);
  const loop = await f
    .service()
    .enqueueForWorkflow(
      actor,
      lease,
      "remote",
      { path: JSON.stringify(["loop", "each", 1, "node", "remote"]) },
      plan,
      600,
    );
  expect(loop.operationId).not.toBe(first.operationId);
  expect((await row(loop.operationId)).taskId).not.toBe(original.taskId);
  expect(
    await db
      .select()
      .from(workflowExecutionDelegations)
      .where(eq(workflowExecutionDelegations.runId, f.runId)),
  ).toHaveLength(2);
  await lease.release();
});

test("workflow parameter derivation preserves the base, keeps scalar types and does not require asset-map authority", async () => {
  const f = await workflowDelegationFixture(undefined, { preserved: "base" });
  const plan = { ...f.plan, maxAmount: "20" };
  await permission.set({ ...actor, capability: "asset.map", enabled: false }, actor.userId);
  try {
    const queued = await f
      .service()
      .enqueueForWorkflow(actor, f.lease, "remote", f.invocation, plan, 600, {
        value: 6,
        enabled: true,
        label: "confidential-input",
      });
    const request = (await row(queued.operationId)).request;
    expect(request.inputManifestDigest).not.toBe(plan.inputManifestDigest);
    const base = await db.transaction((tx) =>
      assets.readMaterial(tx, actor.orgId, a.signing.siteId, plan.inputManifestDigest),
    );
    const derived = await db.transaction((tx) =>
      assets.readMaterial(tx, actor.orgId, a.signing.siteId, request.inputManifestDigest),
    );
    if (base.kind !== "inputs" || derived.kind !== "inputs")
      throw new Error("Expected input manifests");
    expect(base).toMatchObject({ parameters: { preserved: "base" } });
    expect(derived).toEqual({
      ...base,
      parameters: { preserved: "base", value: 6, enabled: true, label: "confidential-input" },
    });
    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, request.inputManifestDigest));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "federation.material.derive",
      diff: { after: { derivedFrom: plan.inputManifestDigest } },
    });
    expect(JSON.stringify(audit)).not.toContain("confidential-input");
    await f.lease.release();
    const lease = await f.journal.acquire(f.runId);
    if (!lease) throw new Error("Missing restored lease");
    expect(
      (
        await f.service().enqueueForWorkflow(actor, lease, "remote", f.invocation, plan, 600, {
          enabled: true,
          label: "confidential-input",
          value: 6,
        })
      ).operationId,
    ).toBe(queued.operationId);
    await expect(
      f.service().enqueueForWorkflow(actor, lease, "remote", f.invocation, plan, 600, { value: 7 }),
    ).rejects.toThrow("changed its delegation intent");
    const other = await f
      .service()
      .enqueueForWorkflow(
        actor,
        lease,
        "remote",
        { path: JSON.stringify(["node", "loop", "iteration", 1, "node", "remote"]) },
        plan,
        600,
        { value: 7 },
      );
    expect(other.operationId).not.toBe(queued.operationId);
    expect((await row(other.operationId)).request.inputManifestDigest).not.toBe(
      request.inputManifestDigest,
    );
    await lease.release();
  } finally {
    await permission.set({ ...actor, capability: "asset.map", enabled: true }, actor.userId);
  }
});

test("workflow parameter derivation refuses files, oversized content, foreign scope, environment edits and cancelled leases", async () => {
  const f = await workflowDelegationFixture();
  const service = f.service();
  const file = {
    value: { fileMetadataId: crypto.randomUUID(), fileMetadataName: "secret.dat" },
  } as unknown as FederationParameterOverrides;
  await expect(
    service.enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600, file),
  ).rejects.toThrow("INVALID_MESSAGE");
  await expect(
    service.enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600, {
      value: "x".repeat(1024 * 1024 + 1),
    }),
  ).rejects.toThrow("INVALID_MESSAGE");
  await expect(
    service.enqueueForWorkflow(receiver, f.lease, "remote", f.invocation, f.plan, 600, {
      value: "secret",
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    service.enqueueForWorkflow(
      actor,
      f.lease,
      "remote",
      f.invocation,
      { ...f.plan, inputManifestDigest: f.plan.environmentLockDigest },
      600,
      { value: "new" },
    ),
  ).rejects.toThrow("INVALID_MESSAGE");
  await f.registry.requestCancel(f.runId);
  await expect(
    service.enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600, {
      value: "new",
    }),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  expect(
    await db
      .select()
      .from(workflowExecutionDelegations)
      .where(eq(workflowExecutionDelegations.runId, f.runId)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationOutbound)
      .where(eq(federationOutbound.agreementRevisionId, f.plan.agreementRevisionId)),
  ).toHaveLength(0);
  await f.lease.release();
});

test("workflow parameter source prerequisites wait for data instead of reporting a result-transfer wait", async () => {
  const f = await workflowDelegationFixture();
  const node = workflowDsl.WorkflowNodeSchema.parse({
    type: "Federation",
    id: "remote",
    name: "Remote",
    agreementRevisionId: f.terms.agreementRevisionId,
    template: f.reference,
    inputManifestDigest: `sha256:${"f".repeat(64)}`,
    environmentLockDigest: f.request.environmentLockDigest,
    resources: f.request.resources,
    maxAmount: "1",
  });
  if (node.type !== "Federation") throw new Error("Missing federation node");
  const executor = new FederationWorkflowExecutor(db, a.signing.siteId, f.service(), clock);
  await expect(
    executor.execute(actor, f.lease, node, f.invocation, { value: "input" }),
  ).rejects.toThrow("DATA_WAITING");
  expect(f.sent).toHaveLength(0);
  await f.lease.release();
});

test("workflow delegation rejects changed intent, foreign owners, stale leases and implicit onward delegation", async () => {
  const f = await workflowDelegationFixture();
  const service = f.service();
  const first = await service.enqueueForWorkflow(
    actor,
    f.lease,
    "remote",
    f.invocation,
    f.plan,
    600,
  );
  await expect(
    service.enqueueForWorkflow(
      actor,
      f.lease,
      "remote",
      f.invocation,
      { ...f.plan, maxAmount: "59" },
      600,
    ),
  ).rejects.toThrow("changed its delegation intent");
  await expect(
    service.enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 601),
  ).rejects.toThrow("changed its delegation intent");
  await expect(
    service.enqueueForWorkflow(receiver, f.lease, "remote", f.invocation, f.plan, 600),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(service.enqueue(actor, (await row(first.operationId)).request)).rejects.toThrow(
    "POLICY_DENIED",
  );
  const run = await f.registry.getById(f.runId);
  if (!run?.input) throw new Error("Missing input");
  await db
    .update(workflowRuns)
    .set({ input: { ...run.input, federationReservationId: crypto.randomUUID() } })
    .where(eq(workflowRuns.id, f.runId));
  await expect(
    service.enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600),
  ).rejects.toThrow("POLICY_DENIED");
  await db.update(workflowRuns).set({ input: run.input }).where(eq(workflowRuns.id, f.runId));
  await f.lease.release();
  await expect(
    service.enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
});

test("workflow delegation cancellation between binding and outbox commit prevents every late enqueue", async () => {
  const f = await workflowDelegationFixture();
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class PausedAssets extends FederationAssetService {
    override async resolveForDelegation(who: typeof actor, reference: FederationAssetRef) {
      const result = await super.resolveForDelegation(who, reference);
      entered();
      await gate;
      return result;
    }
  }
  const service = new FederationOutboundService(
    db,
    a.signing,
    f.receive,
    new PausedAssets(db, { authorizeSoftware: async () => {} }),
    clock,
  );
  const submission = service
    .enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600)
    .then(
      () => null,
      (error: unknown) => error,
    );
  try {
    await reached;
    expect(await f.registry.requestCancel(f.runId)).toBe("cancelling");
    await service.cancelWorkflow(f.runId);
    expect(await f.registry.cancelRun(f.runId)).toBe(true);
  } finally {
    release();
  }
  expect(await submission).toBeInstanceOf(Error);
  const [binding] = await db
    .select()
    .from(workflowExecutionDelegations)
    .where(eq(workflowExecutionDelegations.runId, f.runId));
  if (!binding) throw new Error("Missing durable binding");
  expect(
    await db
      .select()
      .from(federationOutbound)
      .where(eq(federationOutbound.operationId, binding.operationId)),
  ).toHaveLength(0);
  await expect(service.enqueue(actor, binding.request)).rejects.toThrow("POLICY_DENIED");
  expect(f.sent).toHaveLength(0);
  await f.lease.release();
});

test("workflow delegation recovers a bound intent without an outbox and never extends an expired admission window", async () => {
  const f = await workflowDelegationFixture();
  const request = await bindWorkflowDelegation(
    f.lease,
    actor,
    "remote",
    f.invocation,
    f.plan,
    600,
    clock,
  );
  await f.lease.release();
  const lease = await f.journal.acquire(f.runId);
  if (!lease) throw new Error("Missing recovery lease");
  expect(
    (await f.service().enqueueForWorkflow(actor, lease, "remote", f.invocation, f.plan, 600))
      .operationId,
  ).toBe(request.operationId);
  const next = { path: JSON.stringify(["node", "expired"]) };
  const plan: WorkflowDelegationPlan = { ...f.plan, maxAmount: "10" };
  const expired = await bindWorkflowDelegation(lease, actor, "expired", next, plan, 1, clock);
  time = new Date(time.getTime() + 2000);
  await expect(
    f.service().enqueueForWorkflow(actor, lease, "expired", next, plan, 1),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect(
    await db
      .select()
      .from(federationOutbound)
      .where(eq(federationOutbound.operationId, expired.operationId)),
  ).toHaveLength(0);
  expect(
    (await bindWorkflowDelegation(lease, actor, "expired", next, plan, 1, clock)).expiresAt,
  ).toBe(expired.expiresAt);
  await lease.release();
});

test("workflow delegation cancellation survives submitter revocation and requires signed remote stop confirmation", async () => {
  const f = await workflowDelegationFixture();
  const receiver = new FederationCancellationReceiver(db, b.signing, clock);
  const transmit: FederationSend = (endpoint, jws, path) =>
    path === "/federation/v1/cancellations"
      ? receiver.receive(jws, sourceFingerprint)
      : f.receive(endpoint, jws);
  const service = f.service(transmit);
  const submitted = await service.enqueueForWorkflow(
    actor,
    f.lease,
    "remote",
    f.invocation,
    f.plan,
    600,
  );
  await service.deliverNext();
  expect((await row(submitted.operationId)).state).toBe("accepted");
  await expect(
    service.cancellations.requestForWorkflow(f.runId, submitted.operationId),
  ).rejects.toThrow("POLICY_DENIED");
  await f.registry.requestCancel(f.runId);
  await permission.set({ ...actor, capability: "delegation.submit", enabled: false }, actor.userId);
  try {
    await expect(service.cancelWorkflow(f.runId)).rejects.toThrow("awaiting stop confirmation");
    expect(await f.registry.cancelRun(f.runId)).toBe(false);
    await service.cancellations.deliverNext();
    const monitor = new FederationCancellationMonitor(
      db,
      {
        cancel: async () => {
          throw new Error("No receiver run expected");
        },
      },
      async () => {},
      clock,
    );
    await monitor.tick();
    time = new Date(time.getTime() + 11_000);
    await f.service(transmit).cancellations.deliverNext();
    await f.service(transmit).cancelWorkflow(f.runId);
    expect(await f.registry.cancelRun(f.runId)).toBe(true);
    expect((await f.registry.getById(f.runId))?.status).toBe("cancelled");
  } finally {
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: true },
      actor.userId,
    );
    await f.lease.release();
  }
});

test("workflow delegation prevents success or failure from abandoning an unconfirmed remote task", async () => {
  const f = await workflowDelegationFixture();
  const submitted = await f
    .service()
    .enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600);
  expect(
    await f.registry.completeRun(
      f.runId,
      { status: { remote: "Succeeded" }, values: { remote: { status: "Succeeded", values: {} } } },
      f.lease,
    ),
  ).toBe(false);
  expect((await f.registry.getById(f.runId))?.status).toBe("cancelling");
  expect(await f.registry.cancelRun(f.runId)).toBe(false);
  await f.service().deliverNext();
  expect(f.sent).toHaveLength(0);
  expect((await row(submitted.operationId)).lastError).toBe("CANCELLATION_REQUESTED");
  await f.lease.release();
  const g = await workflowDelegationFixture();
  await g.service().enqueueForWorkflow(actor, g.lease, "remote", g.invocation, g.plan, 600);
  expect(await g.registry.failRun(g.runId, new Error("Source execution failed"))).toBe(false);
  expect(await g.registry.getById(g.runId)).toMatchObject({
    status: "cancelling",
    completedAt: null,
    result: { status: { __run__: "Failed" } },
  });
  await db
    .update(workflowRuns)
    .set({ errorCode: "WORKFLOW_INTERRUPTED" })
    .where(eq(workflowRuns.id, g.runId));
  expect(await g.registry.failInterruptedRun(g.runId)).toBe(false);
  await g.lease.release();
});

test("concurrent submission is durable, scoped and idempotent; one task attempt cannot be renamed", async () => {
  const f = await fixture();
  const service = f.service();
  const submissions = await Promise.all([
    service.enqueue(actor, f.request),
    service.enqueue(actor, f.request),
  ]);
  expect(submissions[0]).toEqual(submissions[1]);
  expect(submissions[0]?.state).toBe("queued");
  expect(f.sent).toHaveLength(0);
  await expect(
    service.enqueue(actor, { ...f.request, mode: "ledger_coordinated" }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(service.enqueue(actor, { ...f.request, maxAmount: "59" })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(
    service.enqueue(actor, { ...f.request, operationId: crypto.randomUUID(), maxAmount: "1" }),
  ).rejects.toThrow();
  await Promise.all([service.deliverNext(), service.deliverNext()]);
  expect(f.sent).toHaveLength(1);
  expect((await row(f.request.operationId)).state).toBe("accepted");
  expect(await service.list(receiver)).toEqual([]);
  expect(JSON.stringify(await service.list(actor))).not.toContain("requestJws");
});

test("response loss and worker restart recover the original receipt even after admission expiry", async () => {
  const f = await fixture();
  const service = f.service(async (endpoint, jws) => {
    await f.receive(endpoint, jws);
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  });
  await service.enqueue(actor, f.request);
  await service.deliverNext();
  expect((await row(f.request.operationId)).state).toBe("queued");
  time = new Date(testNow.getTime() + 11 * 60000);
  await f.service().deliverNext();
  const saved = await row(f.request.operationId);
  expect(saved.state).toBe("accepted");
  expect(f.sent).toHaveLength(2);
  expect(f.sent[0]).toBe(f.sent[1]);
  const reservations = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.agreementRevisionId, f.terms.agreementRevisionId));
  expect(reservations).toHaveLength(1);
  expect(saved.receipt?.reservationId).toBe(reservations[0]?.id);
});

test("a forged acceptance cannot free budget or report accepted", async () => {
  const f = await fixture();
  const service = f.service(async (_endpoint, requestJws) => {
    await f.receive(_endpoint, requestJws);
    const [reserved] = await db
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.agreementRevisionId, f.terms.agreementRevisionId));
    if (!reserved) throw new Error("Missing receipt");
    return signFederationMessage(
      FederationAcceptanceSchema,
      { ...reserved.receipt, reservedAmount: "0" },
      b.signing,
    );
  });
  await service.enqueue(actor, f.request);
  await service.deliverNext();
  expect(await row(f.request.operationId)).toMatchObject({
    state: "needs_review",
    lastError: "INVALID_MESSAGE",
    receiptJws: null,
  });
  await expect(
    service.enqueue(actor, {
      ...f.request,
      operationId: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("BUDGET_EXHAUSTED");
  await service.retry(actor, f.request.operationId);
  await f.service().deliverNext();
  expect((await row(f.request.operationId)).state).toBe("accepted");
});

test("revoked source permission blocks unattended delivery and cannot be bypassed with a route header", async () => {
  const f = await fixture();
  const service = f.service();
  await service.enqueue(actor, f.request);
  await permission.set({ ...actor, capability: "delegation.submit", enabled: false }, actor.userId);
  try {
    await service.deliverNext();
    expect(f.sent).toHaveLength(0);
    expect(await row(f.request.operationId)).toMatchObject({
      state: "needs_review",
      lastError: "POLICY_DENIED",
    });
    const app = new Hono();
    app.onError((_error, c) => c.json({ error: "forbidden" }, 403));
    app.route("/", createFederationOutboundRoutes(service));
    expect(
      (
        await app.request("/federation/outbound", {
          method: "POST",
          headers: { "content-type": "application/json", "x-kq-active-organization": actor.orgId },
          body: JSON.stringify(f.request),
        })
      ).status,
    ).toBe(403);
  } finally {
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: true },
      actor.userId,
    );
  }
  await service.retry(actor, f.request.operationId);
  await service.deliverNext();
  expect((await row(f.request.operationId)).state).toBe("accepted");
});

test("endpoint changes require review and a dead sender lease resumes the original message", async () => {
  const f = await fixture();
  const service = f.service();
  await service.enqueue(actor, f.request);
  await db
    .update(federationOutbound)
    .set({
      state: "sending",
      leaseOwner: crypto.randomUUID(),
      leaseUntil: new Date(testNow.getTime() - 1),
    })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  await trust.updateSite(
    b.signing.siteId,
    { name: "Test peer", endpoint: "https://changed.test.invalid" },
    actor.userId,
  );
  try {
    await service.deliverNext();
    expect(f.sent).toHaveLength(0);
    expect((await row(f.request.operationId)).state).toBe("needs_review");
    await service.retry(actor, f.request.operationId);
    expect((await row(f.request.operationId)).endpoint).toBe("https://changed.test.invalid");
    await service.deliverNext();
    expect((await row(f.request.operationId)).state).toBe("accepted");
  } finally {
    await trust.updateSite(
      b.signing.siteId,
      { name: "Test peer", endpoint: "https://peer.test.invalid" },
      actor.userId,
    );
  }
});

test("source asset revocation and missing manifests stop sending before the network call", async () => {
  const f = await fixture();
  const service = f.service();
  await expect(
    service.enqueue(actor, { ...f.request, inputManifestDigest: `sha256:${"b".repeat(64)}` }),
  ).rejects.toThrow("DATA_WAITING");
  await service.enqueue(actor, f.request);
  const [mapping] = await db
    .select()
    .from(federationAssetMappings)
    .where(eq(federationAssetMappings.originId, f.request.template.id));
  if (!mapping) throw new Error("Missing mapping");
  await assets.revoke(actor, mapping.id);
  await service.deliverNext();
  expect(f.sent).toHaveLength(0);
  expect((await row(f.request.operationId)).state).toBe("needs_review");
});

test("source budget cannot be copied into another signed agreement or overbooked concurrently", async () => {
  const f = await fixture();
  const service = f.service();
  const attempted = await Promise.allSettled([
    service.enqueue(actor, f.request),
    service.enqueue(actor, {
      ...f.request,
      operationId: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
    }),
  ]);
  expect(attempted.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  await service.deliverNext();
  const terms = { ...f.terms, agreementRevisionId: crypto.randomUUID() };
  if (resultPolicy) terms.resultPolicy = resultPolicy;
  if (inputPolicy) terms.inputPolicy = inputPolicy;
  agreements.push(terms);
  await aService.approve(actor, { terms });
  await aService.attachCounterparty(
    actor,
    terms.agreementRevisionId,
    await signFederationMessage(FederationAgreementSchema, terms, b.signing),
  );
  await expect(
    service.enqueue(actor, {
      ...f.request,
      agreementRevisionId: terms.agreementRevisionId,
      operationId: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      maxAmount: "1",
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("network delivery releases DB grants and retains an acceptance observed during source revocation", async () => {
  const f = await fixture();
  const service = f.service(async (endpoint, jws) => {
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: false },
      actor.userId,
    );
    return f.receive(endpoint, jws);
  });
  await service.enqueue(actor, f.request);
  try {
    await service.deliverNext();
    expect((await row(f.request.operationId)).state).toBe("accepted");
    await expect(
      service.enqueue(actor, { ...f.request, operationId: crypto.randomUUID() }),
    ).rejects.toThrow("POLICY_DENIED");
  } finally {
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: true },
      actor.userId,
    );
  }
});

test("a stale sender cannot replace the newer worker's accepted receipt", async () => {
  const f = await fixture();
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = f.service(async () => {
    entered();
    await blocked;
    return "invalid-late-response";
  });
  await slow.enqueue(actor, f.request);
  const sending = slow.deliverNext();
  try {
    await started;
    time = new Date(testNow.getTime() + 61000);
    await f.service().deliverNext();
    expect((await row(f.request.operationId)).state).toBe("accepted");
  } finally {
    release();
    await sending;
  }
  expect(await row(f.request.operationId)).toMatchObject({ state: "accepted", lastError: null });
});

test("remote status is scoped, signed and read-only after admission and agreement expiry", async () => {
  const f = await fixture();
  const responder = new FederationStatusResponder(db, b.signing, clock);
  let queries = 0;
  const service = f.service(async (endpoint, jws, path) => {
    if (path !== "/federation/v1/status") return f.receive(endpoint, jws);
    queries++;
    return responder.receive(jws, sourceFingerprint);
  });
  await service.enqueue(actor, f.request);
  await expect(service.remoteStatus(actor, f.request.operationId)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await service.deliverNext();
  await expect(service.remoteStatus(receiver, f.request.operationId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  expect(queries).toBe(0);
  const saved = await row(f.request.operationId);
  const first = await service.remoteStatus(actor, f.request.operationId);
  expect(first.report).toMatchObject({
    preparation: null,
    workflow: null,
    requestDigest: saved.requestDigest,
  });
  if (!saved.receipt) throw new Error("Expected receipt");
  await db.insert(federationPreparations).values({
    reservationId: saved.receipt.reservationId,
    state: "waiting",
    blocker: "DATA_WAITING",
    updatedAt: clock(),
  });
  time = new Date("2026-01-03T00:00:00.000Z");
  const second = await service.remoteStatus(actor, f.request.operationId);
  expect(second.report.preparation?.state).toBe("waiting");
  expect(second.report.queryId).not.toBe(first.report.queryId);
  expect(JSON.stringify(second.report)).not.toContain("blocker");
  expect(await row(f.request.operationId)).toEqual(saved);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    await next();
  });
  app.route("/api", createFederationOutboundRoutes(service));
  const response = await app.request(
    `/api/federation/outbound/${f.request.operationId}/remote-status`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("remote status rejects replayed, mismatched and forged reports without altering acceptance", async () => {
  const f = await fixture();
  const responder = new FederationStatusResponder(db, b.signing, clock);
  await f.service().enqueue(actor, f.request);
  await f.service().deliverNext();
  const saved = await row(f.request.operationId);
  let previous = "";
  const replay = f.service(async (_endpoint, jws) => {
    if (!previous) previous = await responder.receive(jws, sourceFingerprint);
    return previous;
  });
  await replay.remoteStatus(actor, f.request.operationId);
  await expect(replay.remoteStatus(actor, f.request.operationId)).rejects.toThrow(
    "INVALID_MESSAGE",
  );
  const bad = f.service(async (_endpoint, jws) => {
    const reportJws = await responder.receive(jws, sourceFingerprint);
    const key = await trust.resolveKey(b.signing.siteId, b.signing.keyId, clock());
    const { payload } = await verifyFederationMessage(
      FederationStatusReportSchema,
      reportJws,
      key,
      clock(),
    );
    return signFederationMessage(
      FederationStatusReportSchema,
      { ...payload, taskId: crypto.randomUUID() },
      b.signing,
    );
  });
  await expect(bad.remoteStatus(actor, f.request.operationId)).rejects.toThrow("INVALID_MESSAGE");
  await expect(
    f.service(async () => "forged").remoteStatus(actor, f.request.operationId),
  ).rejects.toThrow("INVALID_MESSAGE");
  expect(await row(f.request.operationId)).toEqual(saved);
});

test("remote status rejects wrong TLS peer, altered request identity and expired challenges", async () => {
  const f = await fixture();
  const responder = new FederationStatusResponder(db, b.signing, clock);
  await f.service().enqueue(actor, f.request);
  await f.service().deliverNext();
  const service = f.service(async (_endpoint, jws) => {
    await expect(responder.receive(jws, targetFingerprint)).rejects.toThrow("UNTRUSTED_IDENTITY");
    const key = await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock());
    const { payload } = await verifyFederationMessage(
      FederationStatusQuerySchema,
      jws,
      key,
      clock(),
    );
    for (const change of [
      { requestDigest: `sha256:${"0".repeat(64)}` },
      { reservationId: crypto.randomUUID() },
      { taskId: crypto.randomUUID() },
    ]) {
      const altered = await signFederationMessage(
        FederationStatusQuerySchema,
        { ...payload, ...change },
        a.signing,
      );
      await expect(responder.receive(altered, sourceFingerprint)).rejects.toThrow("POLICY_DENIED");
    }
    time = new Date(time.getTime() + 60_000);
    await expect(responder.receive(jws, sourceFingerprint)).rejects.toThrow(
      "AUTHORIZATION_EXPIRED",
    );
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  });
  await expect(service.remoteStatus(actor, f.request.operationId)).rejects.toThrow(
    "DELIVERY_UNAVAILABLE",
  );
});

test("remote status rechecks reader authorization after network I/O and preserves accepted fact", async () => {
  const f = await fixture();
  const responder = new FederationStatusResponder(db, b.signing, clock);
  await f.service().enqueue(actor, f.request);
  await f.service().deliverNext();
  const saved = await row(f.request.operationId);
  const service = f.service(async (_endpoint, jws) => {
    const result = await responder.receive(jws, sourceFingerprint);
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: false },
      actor.userId,
    );
    return result;
  });
  try {
    await expect(service.remoteStatus(actor, f.request.operationId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    expect(await row(f.request.operationId)).toEqual(saved);
    await permission.set({ ...actor, capability: "delegation.read", enabled: true }, actor.userId);
    const readOnly = f.service((_endpoint, jws) => responder.receive(jws, sourceFingerprint));
    expect((await readOnly.remoteStatus(actor, f.request.operationId)).report.workflow).toBeNull();
  } finally {
    await permission.set({ ...actor, capability: "delegation.read", enabled: false }, actor.userId);
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: true },
      actor.userId,
    );
  }
});

async function cancellationFixture() {
  const f = await fixture();
  const receiver = new FederationCancellationReceiver(db, b.signing, clock);
  const transmit: FederationSend = async (endpoint, jws, path) =>
    path === "/federation/v1/cancellations"
      ? receiver.receive(jws, sourceFingerprint)
      : f.receive(endpoint, jws);
  const service = f.service(transmit);
  const monitor = new FederationCancellationMonitor(
    db,
    {
      cancel: async () => {
        throw new Error("No bound run expected");
      },
    },
    async () => {},
    clock,
  );
  await service.enqueue(actor, f.request);
  return { ...f, source: service, receiver, transmit, monitor };
}

test("cancellation before admission fences late delivery and survives restart without releasing budget", async () => {
  const f = await cancellationFixture();
  const results = await Promise.all([
    f.source.cancellations.request(actor, f.request.operationId),
    f.source.cancellations.request(actor, f.request.operationId),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(await f.source.deliverNext()).toBe(false);
  await f.source.cancellations.deliverNext();
  expect((await row(f.request.operationId)).cancelState).toBe("pending");
  await f.monitor.tick();
  time = new Date(time.getTime() + 11_000);
  await f.service(f.transmit).cancellations.deliverNext();
  const saved = await row(f.request.operationId);
  expect(saved).toMatchObject({
    state: "queued",
    amount: "60",
    cancelState: "stopped",
    cancelReceipt: { reservationId: null, workflow: null },
  });
  await expect(f.receive(saved.endpoint, saved.requestJws)).rejects.toThrow(
    "CANCELLATION_REQUESTED",
  );
  await expect(f.source.retry(actor, f.request.operationId)).rejects.toThrow("OPERATION_CONFLICT");
  expect(
    (await f.source.list(actor)).find((v) => v.operationId === f.request.operationId)?.cancellation
      ?.state,
  ).toBe("stopped");
});

test("cancellation recovers a lost admission response and denies preparation of the accepted reservation", async () => {
  const f = await cancellationFixture();
  await f
    .service(async (endpoint, jws) => {
      await f.receive(endpoint, jws);
      throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
    })
    .deliverNext();
  expect((await row(f.request.operationId)).state).toBe("queued");
  await f.source.cancellations.request(actor, f.request.operationId);
  await f.source.cancellations.deliverNext();
  const pending = await row(f.request.operationId);
  const reservationId = pending.cancelReceipt?.reservationId;
  if (!reservationId) throw new Error("Remote accepted reservation was not found");
  await expect(
    new FederationPreparationService(db, b.signing.siteId, assets, clock).executionSnapshot(
      reservationId,
    ),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
  await f.monitor.tick();
  time = new Date(time.getTime() + 11_000);
  await f.source.cancellations.deliverNext();
  expect((await row(f.request.operationId)).cancelState).toBe("stopped");
  expect((await row(f.request.operationId)).amount).toBe("60");
});

test("cancellation does not confirm a failed workflow while stopping or cleanup is unresolved", async () => {
  const f = await cancellationFixture();
  await f.source.deliverNext();
  const accepted = await row(f.request.operationId);
  if (!accepted.receipt) throw new Error("Expected acceptance");
  const runId = crypto.randomUUID();
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Cancellation recovery",
    submittedBy: executionUserId,
    status: "failed",
    input: {
      yaml: "",
      role: "user",
      executionModel: "durable-v2",
      federationReservationId: accepted.receipt.reservationId,
    },
  });
  await f.source.cancellations.request(actor, f.request.operationId);
  await f.source.cancellations.deliverNext();
  const runner = new WorkflowAsyncRunner({
    registry: new WorkflowRunRegistry(db),
    makeRunner: () => {
      throw new Error("No execution expected");
    },
  });
  let stops = 0;
  try {
    const monitor = new FederationCancellationMonitor(
      db,
      runner,
      async () => {
        stops++;
        throw new Error("Installer stop not confirmed");
      },
      clock,
    );
    await monitor.tick();
    time = new Date(time.getTime() + 31_000);
    await f.source.cancellations.deliverNext();
    expect((await row(f.request.operationId)).cancelState).toBe("pending");
    await new FederationCancellationMonitor(
      db,
      runner,
      async () => {
        stops++;
      },
      clock,
    ).tick();
    time = new Date(time.getTime() + 11_000);
    await f.source.cancellations.deliverNext();
    expect((await row(f.request.operationId)).cancelReceipt).toMatchObject({
      state: "stopped",
      workflow: { status: "failed" },
    });
    expect(stops).toBe(2);
    expect((await row(f.request.operationId)).receipt).toEqual(accepted.receipt);
  } finally {
    await runner.stop();
  }
});

test("cancellation validates institutional identity and immutable task intent", async () => {
  const f = await cancellationFixture();
  await f.source.deliverNext();
  await expect(f.source.cancellations.request(receiver, f.request.operationId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await f.source.cancellations.request(actor, f.request.operationId);
  const saved = await row(f.request.operationId);
  if (!saved.cancelJws || !saved.cancelRequest) throw new Error("Expected stop intent");
  await expect(f.receiver.receive(saved.cancelJws, targetFingerprint)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  const altered = await signFederationMessage(
    FederationCancellationSchema,
    { ...saved.cancelRequest, taskId: crypto.randomUUID() },
    a.signing,
  );
  await expect(f.receiver.receive(altered, sourceFingerprint)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await f.source.cancellations.deliverNext();
  const changed = await signFederationMessage(
    FederationCancellationSchema,
    { ...saved.cancelRequest, issuedAt: new Date(time.getTime() + 1).toISOString() },
    a.signing,
  );
  await expect(f.receiver.receive(changed, sourceFingerprint)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await f.monitor.tick();
  time = new Date(time.getTime() + 11_000);
  await f.source.cancellations.deliverNext();
});

test("cancellation remains durable after initiator revocation and a lost response", async () => {
  const f = await cancellationFixture();
  await f.source.deliverNext();
  await f.source.cancellations.request(actor, f.request.operationId);
  const original = await row(f.request.operationId);
  await permission.set({ ...actor, capability: "delegation.submit", enabled: false }, actor.userId);
  try {
    await f
      .service(async (endpoint, jws, path) => {
        await f.transmit(endpoint, jws, path);
        throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
      })
      .cancellations.deliverNext();
    await f.monitor.tick();
    time = new Date(time.getTime() + 31_000);
    await f.source.cancellations.deliverNext();
    expect(await row(f.request.operationId)).toMatchObject({
      cancelState: "stopped",
      cancelJws: original.cancelJws,
      cancelDigest: original.cancelDigest,
    });
  } finally {
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: true },
      actor.userId,
    );
  }
});

test("cancellation rejects a mismatched signed receipt and retries only the same intent", async () => {
  const f = await cancellationFixture();
  await f.source.deliverNext();
  await f.source.cancellations.request(actor, f.request.operationId);
  const original = await row(f.request.operationId);
  const bad = f.service(async (_endpoint, jws) => {
    const receipt = await f.receiver.receive(jws, sourceFingerprint);
    const key = await trust.resolveKey(b.signing.siteId, b.signing.keyId, clock());
    const { payload } = await verifyFederationMessage(
      FederationCancellationReceiptSchema,
      receipt,
      key,
      clock(),
    );
    return signFederationMessage(
      FederationCancellationReceiptSchema,
      { ...payload, taskId: crypto.randomUUID() },
      b.signing,
    );
  });
  await bad.cancellations.deliverNext();
  expect((await row(f.request.operationId)).cancelState).toBe("needs_review");
  await f.source.cancellations.request(actor, f.request.operationId, true);
  expect((await row(f.request.operationId)).cancelDigest).toBe(original.cancelDigest);
  await f.monitor.tick();
  await f.source.cancellations.deliverNext();
  expect((await row(f.request.operationId)).cancelState).toBe("stopped");
});

test("cancellation late worker cannot overwrite recovered stop confirmation", async () => {
  const f = await cancellationFixture();
  await f.source.cancellations.request(actor, f.request.operationId);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slow = f.service(async (endpoint, jws, path) => {
    await f.transmit(endpoint, jws, path);
    entered();
    await blocked;
    return "late-invalid-receipt";
  });
  const sending = slow.cancellations.deliverNext();
  try {
    await started;
    await f.monitor.tick();
    time = new Date(time.getTime() + 61_000);
    await f.source.cancellations.deliverNext();
    expect((await row(f.request.operationId)).cancelState).toBe("stopped");
  } finally {
    release();
    await sending;
  }
  expect(await row(f.request.operationId)).toMatchObject({
    cancelState: "stopped",
    cancelLastError: null,
  });
});

test.each([
  false,
  true,
])("cancellation preserves late acceptance without restarting refunded status polling (refunded=%s)", async (refunded) => {
  const f = await cancellationFixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slow = f.service(async (endpoint, jws) => {
    const receipt = await f.receive(endpoint, jws);
    entered();
    await blocked;
    return receipt;
  });
  const sending = slow.deliverNext();
  try {
    await started;
    await f.source.cancellations.request(actor, f.request.operationId);
    await f.source.cancellations.deliverNext();
    await f.monitor.tick();
    time = new Date(time.getTime() + 11_000);
    await f.source.cancellations.deliverNext();
    if (refunded) {
      // Model the local refund checkpoint; financial approval/application is covered by refund tests.
      await db
        .update(federationOutbound)
        .set({ settledAmount: "0", statusClaim: null, statusNextAttemptAt: null })
        .where(eq(federationOutbound.operationId, f.request.operationId));
    }
  } finally {
    release();
    await sending;
  }
  const saved = await row(f.request.operationId);
  expect(saved).toMatchObject({ state: "accepted", cancelState: "stopped", amount: "60" });
  if (!saved.receipt || !saved.cancelReceipt?.reservationId)
    throw new Error("Missing matching remote receipts");
  expect(saved.receipt.reservationId).toBe(saved.cancelReceipt.reservationId);
  expect(saved.statusNextAttemptAt === null).toBe(refunded);
});

const resultPolicy: NonNullable<FederationAgreement["resultPolicy"]> = {
  scope: "persistent-files",
  maxFiles: 4,
  maxBytes: 20,
  availableUntil: "2026-01-04T00:00:00.000Z",
};
async function resultFixture(policy = resultPolicy, workflowSource = false) {
  const sourceWorkflow = workflowSource ? await workflowDelegationFixture(policy) : null;
  const f = sourceWorkflow ?? (await fixture(policy));
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  if (sourceWorkflow) {
    const queued = await f
      .service()
      .enqueueForWorkflow(
        actor,
        sourceWorkflow.lease,
        "remote",
        sourceWorkflow.invocation,
        { ...sourceWorkflow.plan, executionExpiresAt: f.terms.validUntil },
        600,
      );
    f.request = (await row(queued.operationId)).request;
  } else await f.service().enqueue(actor, f.request);
  await f.service().deliverNext();
  const saved = await row(f.request.operationId);
  if (!saved.receipt) throw new Error("Expected acceptance");
  const runId = crypto.randomUUID(),
    jobId = crypto.randomUUID(),
    artifactId = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  await db.insert(jobs).values({
    id: jobId,
    name: "Result producer",
    submittedBy: executionUserId,
    orgId: receiver.orgId,
    status: "completed",
    command: "true",
    cpus: 1,
    memoryMb: 128,
  });
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Results",
    submittedBy: executionUserId,
    status: "completed",
    completedAt: clock(),
    stepJobs: { producer: jobId },
    result: {
      status: { producer: "Succeeded" },
      values: {
        producer: { status: "Succeeded", values: { result: { type: "File", artifactId } } },
      },
    },
    input: {
      yaml: "",
      role: "user",
      executionModel: "durable-v2",
      federationReservationId: saved.receipt.reservationId,
    },
  });
  const snapshot: typeof federationWorkflowBindings.$inferInsert.snapshot = {
    request: f.request,
    requestDigest: saved.requestDigest,
    identity: { orgId: receiver.orgId, userId: executionUserId },
    workflow: workflowDsl.WorkflowSchema.parse({
      name: "Result fixture",
      spec: { nodeDrafts: [], nodeRelations: [] },
    }),
    workflowVersions: {},
    inputs: { protocolVersion: 1, kind: "inputs", parameters: {}, datasets: [], bindings: [] },
    environment: {
      protocolVersion: 1,
      kind: "environment-lock",
      target: { platform: "linux", architecture: "x86_64" },
      nativeLockDigest: f.terms.termsDigest,
      software: [],
    },
    mappings: [],
  };
  await db.insert(federationWorkflowBindings).values({
    reservationId: saved.receipt.reservationId,
    workflowRunId: runId,
    snapshot,
    snapshotDigest: federationMaterialDigest(snapshot),
  });
  await db.insert(netdriveFiles).values({
    id: fileId,
    ownerId: executionUserId,
    path: "private/local/result",
    storageKey: "private/object/key",
    size: 3,
    sha256: "a".repeat(64),
    contentType: "application/octet-stream",
  });
  await db.insert(workflowArtifacts).values({
    id: artifactId,
    workflowRunId: runId,
    producerJobId: jobId,
    producerNodeId: "producer",
    descriptor: "result",
    ioType: "File",
    contentHash: "a".repeat(64),
    sizeBytes: 3,
    durability: "Persistent",
    persistentAt: clock(),
    netdriveFileId: fileId,
  });
  const responder = new FederationResultResponder(db, b.signing, clock);
  const send: FederationSend = (_endpoint, jws) => responder.receive(jws, sourceFingerprint);
  const read = () => f.service(send).results.read(actor, f.request.operationId);
  return { ...f, sourceWorkflow, saved, runId, jobId, artifactId, fileId, responder, send, read };
}

test("result inventory requires explicit bilateral scope and independent current source permission", async () => {
  const legacy = await fixture();
  await legacy.service().enqueue(actor, legacy.request);
  await legacy.service().deliverNext();
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  await expect(legacy.service().results.read(actor, legacy.request.operationId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  const f = await resultFixture();
  await permission.set({ ...actor, capability: "result.read", enabled: false }, actor.userId);
  await expect(f.read()).rejects.toThrow("POLICY_DENIED");
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  const result = await f.read();
  expect(result.report.manifest.outputs).toHaveLength(1);
  expect(result.report.manifest.outputs[0]?.files).toEqual([
    { path: "result", sizeBytes: 3, sha256: "a".repeat(64) },
  ]);
  for (const secret of [
    executionUserId,
    f.fileId,
    f.runId,
    f.jobId,
    f.artifactId,
    "private/object/key",
    "private/local/result",
  ])
    expect(JSON.stringify(result)).not.toContain(secret);
  expect(await row(f.request.operationId)).toEqual(f.saved);
  await permission.set({ ...receiver, capability: "result.read", enabled: true }, actor.userId);
  await expect(f.service(f.send).results.read(receiver, f.request.operationId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  time = new Date("2026-01-03T00:00:00.000Z");
  expect((await f.read()).report.manifestDigest).toBe(result.report.manifestDigest);
  time = new Date(resultPolicy.availableUntil);
  await expect(f.read()).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("result inventory rejects unavailable, foreign and prohibited artifacts instead of dropping entries", async () => {
  const f = await resultFixture();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await expect(f.read()).rejects.toThrow("DATA_WAITING");
  await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, f.runId));
  await db.update(jobs).set({ restrictedNoEgress: true }).where(eq(jobs.id, f.jobId));
  await expect(f.read()).rejects.toThrow("POLICY_DENIED");
  await db.update(jobs).set({ restrictedNoEgress: false }).where(eq(jobs.id, f.jobId));
  await db
    .update(netdriveFiles)
    .set({ sha256: "b".repeat(64) })
    .where(eq(netdriveFiles.id, f.fileId));
  await expect(f.read()).rejects.toThrow("ASSET_UNAVAILABLE");
  await db
    .update(netdriveFiles)
    .set({ sha256: "a".repeat(64), deletedAt: clock() })
    .where(eq(netdriveFiles.id, f.fileId));
  await expect(f.read()).rejects.toThrow("ASSET_UNAVAILABLE");
  await db
    .update(netdriveFiles)
    .set({ deletedAt: null, ownerId: actor.userId })
    .where(eq(netdriveFiles.id, f.fileId));
  try {
    await expect(f.read()).rejects.toThrow("ASSET_UNAVAILABLE");
  } finally {
    await db
      .update(netdriveFiles)
      .set({ ownerId: executionUserId })
      .where(eq(netdriveFiles.id, f.fileId));
  }
  await db.update(workflowRuns).set({ stepJobs: {} }).where(eq(workflowRuns.id, f.runId));
  await expect(f.read()).rejects.toThrow("POLICY_DENIED");
  await db
    .update(workflowRuns)
    .set({ stepJobs: { producer: f.jobId } })
    .where(eq(workflowRuns.id, f.runId));
  await db.delete(workflowArtifacts).where(eq(workflowArtifacts.id, f.artifactId));
  await expect(f.read()).rejects.toThrow("ASSET_UNAVAILABLE");
});

test("result FileBatch inventories verify every published member and enforce signed limits", async () => {
  const f = await resultFixture({ ...resultPolicy, maxFiles: 1, maxBytes: 3 });
  const members = [{ relativePath: "nested/result.dat", sizeBytes: 3, sha256: "a".repeat(64) }];
  await db
    .update(workflowArtifacts)
    .set({
      ioType: "FileBatch",
      contentHash: artifactBatchHash(members),
      fileMembers: members,
      netdriveFileId: null,
    })
    .where(eq(workflowArtifacts.id, f.artifactId));
  await expect(f.read()).rejects.toThrow("ASSET_UNAVAILABLE");
  await db.insert(workflowArtifactFiles).values({
    artifactId: f.artifactId,
    relativePath: "nested/result.dat",
    netdriveFileId: f.fileId,
  });
  expect((await f.read()).report.manifest.outputs[0]?.files[0]?.path).toBe("nested/result.dat");
  const extra = [...members, { relativePath: "extra.dat", sizeBytes: 3, sha256: "a".repeat(64) }];
  await db
    .update(workflowArtifacts)
    .set({ contentHash: artifactBatchHash(extra), fileMembers: extra, sizeBytes: 6 })
    .where(eq(workflowArtifacts.id, f.artifactId));
  await expect(f.read()).rejects.toThrow("POLICY_DENIED");
});

test("result reports reject replay, changed provenance, foreign peer and revoked authorization", async () => {
  const f = await resultFixture();
  let previous = "";
  const replay = f.service(
    async (_endpoint, jws) => (previous ||= await f.responder.receive(jws, sourceFingerprint)),
  );
  await replay.results.read(actor, f.request.operationId);
  await expect(replay.results.read(actor, f.request.operationId)).rejects.toThrow(
    "INVALID_MESSAGE",
  );
  const bad = f.service(async (_endpoint, jws) => {
    await expect(f.responder.receive(jws, targetFingerprint)).rejects.toThrow("UNTRUSTED_IDENTITY");
    const key = await trust.resolveKey(b.signing.siteId, b.signing.keyId, clock());
    const { payload } = await verifyFederationMessage(
      FederationResultReportSchema,
      await f.responder.receive(jws, sourceFingerprint),
      key,
      clock(),
    );
    const manifest = { ...payload.manifest, environmentLockDigest: `sha256:${"0".repeat(64)}` };
    return signFederationMessage(
      FederationResultReportSchema,
      { ...payload, manifest, manifestDigest: federationMaterialDigest(manifest) },
      b.signing,
    );
  });
  await expect(bad.results.read(actor, f.request.operationId)).rejects.toThrow("INVALID_MESSAGE");
  const revoke = f.service(async (_endpoint, jws) => {
    const response = await f.responder.receive(jws, sourceFingerprint);
    await permission.set({ ...actor, capability: "result.read", enabled: false }, actor.userId);
    return response;
  });
  await expect(revoke.results.read(actor, f.request.operationId)).rejects.toThrow("POLICY_DENIED");
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  await db
    .update(federationAgreements)
    .set({ state: "suspended" })
    .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
  await expect(f.read()).rejects.toThrow("POLICY_DENIED");
  expect(await row(f.request.operationId)).toEqual(f.saved);
});

test("result queries cannot change task identity or bypass receiver agreement and execution ownership", async () => {
  const f = await resultFixture();
  const probe = f.service(async (_endpoint, jws) => {
    const key = await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock());
    const { payload } = await verifyFederationMessage(
      FederationResultQuerySchema,
      jws,
      key,
      clock(),
    );
    for (const change of [
      { taskId: crypto.randomUUID() },
      { requestDigest: `sha256:${"0".repeat(64)}` },
      { reservationId: crypto.randomUUID() },
    ]) {
      const altered = await signFederationMessage(
        FederationResultQuerySchema,
        { ...payload, ...change },
        a.signing,
      );
      await expect(f.responder.receive(altered, sourceFingerprint)).rejects.toThrow(
        "POLICY_DENIED",
      );
    }
    return f.responder.receive(jws, sourceFingerprint);
  });
  await probe.results.read(actor, f.request.operationId);
  await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
  try {
    await expect(f.read()).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
  }
  await db
    .update(federationAgreements)
    .set({ terms: { ...f.terms, resultPolicy: { ...resultPolicy, maxBytes: 100 } } })
    .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
  await expect(f.read()).rejects.toThrow("OPERATION_CONFLICT");
});

async function resultDownloadFixture() {
  const f = await resultFixture();
  const { report } = await f.read();
  const output = report.manifest.outputs[0];
  const member = output?.files[0];
  if (!output || !member) throw new Error("Expected file member");
  const binding = {
    transferId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    operationId: f.request.operationId,
    manifestDigest: report.manifestDigest,
    outputId: output.outputId,
    ...member,
    partSize: 5 * 1024 * 1024,
  };
  const calls: { key: string; seconds: number; version?: string }[] = [];
  const downloads: FederationResultDownloadStorage = {
    allowedOrigins: ["https://storage.test.invalid"],
    storage: {
      head: async () => ({
        size: member.sizeBytes,
        etag: "object-etag",
        versionId: "version-one",
        contentType: "application/octet-stream",
        lastModified: clock(),
      }),
      presignDownload: async (key, seconds, _filename, version) => {
        calls.push({ key, seconds, version });
        const url = new URL("https://storage.test.invalid/opaque-object");
        url.searchParams.set(
          "X-Amz-Date",
          clock()
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(/\.\d{3}/, ""),
        );
        url.searchParams.set("X-Amz-Expires", String(seconds));
        url.searchParams.set("X-Amz-Signature", "private-ticket");
        url.searchParams.set("versionId", version ?? "");
        return url.toString();
      },
    },
  };
  const send: FederationSend = (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/result-downloads");
    return f.responder.receiveDownload(jws, sourceFingerprint, downloads);
  };
  const read = (sender = send, value = binding, origins = downloads.allowedOrigins) =>
    f.service(sender).results.downloadGrant(actor, value, origins);
  return { ...f, binding, calls, downloads, sendDownload: send, download: read };
}

test("result downloads issue a version-pinned, signed short-lived grant only for the selected manifest member", async () => {
  const f = await resultDownloadFixture();
  const grant = await f.download();
  expect(grant.binding).toEqual(f.binding);
  expect(grant.direction).toBe("download");
  expect(Date.parse(grant.expiresAt) - clock().getTime()).toBe(30_000);
  expect(new URL(grant.url).searchParams.get("versionId")).toBe("version-one");
  expect(f.calls).toEqual([{ key: "private/object/key", seconds: 30, version: "version-one" }]);
  expect(await row(f.request.operationId)).toEqual(f.saved);
  // The last release window cannot be enlarged by rounding or by the actual S3 credential.
  time = new Date(Date.parse(resultPolicy.availableUntil) - 2_500);
  const last = await f.download();
  expect(Date.parse(last.expiresAt)).toBeLessThanOrEqual(Date.parse(resultPolicy.availableUntil));
  expect(f.calls.at(-1)?.seconds).toBe(2);
  time = new Date(Date.parse(resultPolicy.availableUntil) - 500);
  await expect(f.download()).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect(f.calls).toHaveLength(2);
});

test("result downloads reject changed manifests, wrong files, foreign peers and unavailable storage before releasing a URL", async () => {
  const f = await resultDownloadFixture();
  for (const change of [
    { path: "another-file" },
    { sha256: "b".repeat(64) },
    { manifestDigest: `sha256:${"b".repeat(64)}` },
  ])
    await expect(f.download(f.sendDownload, { ...f.binding, ...change })).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
  expect(f.calls).toHaveLength(0);
  await expect(
    f.download((_endpoint, jws) =>
      f.responder.receiveDownload(jws, targetFingerprint, f.downloads),
    ),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  const head = f.downloads.storage.head;
  f.downloads.storage.head = async () => null;
  await expect(f.download()).rejects.toThrow("ASSET_UNAVAILABLE");
  f.downloads.storage.head = head;
  await db.update(jobs).set({ restrictedNoEgress: true }).where(eq(jobs.id, f.jobId));
  await expect(f.download()).rejects.toThrow("POLICY_DENIED");
  expect(f.calls).toHaveLength(0);
});

test("result downloads recheck both authorities and file mapping after presigning or network delay", async () => {
  const f = await resultDownloadFixture();
  const presign = f.downloads.storage.presignDownload;
  f.downloads.storage.presignDownload = async (...args) => {
    const url = await presign(...args);
    await db
      .update(netdriveFiles)
      .set({ storageKey: "changed/object" })
      .where(eq(netdriveFiles.id, f.fileId));
    return url;
  };
  await expect(f.download()).rejects.toThrow("OPERATION_CONFLICT");
  f.downloads.storage.presignDownload = presign;
  await db
    .update(netdriveFiles)
    .set({ storageKey: "private/object/key" })
    .where(eq(netdriveFiles.id, f.fileId));
  await expect(
    f.download(async (...args) => {
      const grant = await f.sendDownload(...args);
      await permission.set({ ...actor, capability: "result.read", enabled: false }, actor.userId);
      return grant;
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  f.downloads.storage.presignDownload = async (...args) => {
    const url = await presign(...args);
    await db
      .update(federationAgreements)
      .set({ state: "suspended" })
      .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
    return url;
  };
  await expect(f.download()).rejects.toThrow("POLICY_DENIED");
});

test("result downloads reject replay, mismatched attempts, untrusted origins and credentials longer than their envelope", async () => {
  const f = await resultDownloadFixture();
  let old: string | undefined;
  await f.download(async (...args) => {
    old = await f.sendDownload(...args);
    return old;
  });
  await expect(
    f.download(async () => {
      if (!old) throw new Error("Missing grant");
      return old;
    }),
  ).rejects.toThrow("INVALID_MESSAGE");
  const mutate =
    (edit: (grant: typeof FederationResultDownloadGrantSchema._output) => void): FederationSend =>
    async (...args) => {
      const signed = await f.sendDownload(...args);
      const key = await trust.resolveKey(b.signing.siteId, b.signing.keyId, clock());
      const { payload } = await verifyFederationMessage(
        FederationResultDownloadGrantSchema,
        signed,
        key,
        clock(),
      );
      edit(payload);
      return signFederationMessage(FederationResultDownloadGrantSchema, payload, b.signing);
    };
  await expect(
    f.download(
      mutate((grant) => {
        grant.binding.generation = crypto.randomUUID();
      }),
    ),
  ).rejects.toThrow("INVALID_MESSAGE");
  await expect(
    f.download(
      mutate((grant) => {
        grant.url = grant.url.replace("storage.test.invalid", "foreign.test.invalid");
      }),
    ),
  ).rejects.toThrow("INVALID_MESSAGE");
  await expect(
    f.download(
      mutate((grant) => {
        grant.url = grant.url.replace("X-Amz-Expires=30", "X-Amz-Expires=3600");
      }),
    ),
  ).rejects.toThrow("POLICY_DENIED");
  const presign = f.downloads.storage.presignDownload;
  f.downloads.storage.presignDownload = async (...args) =>
    (await presign(...args)).replace("storage.test.invalid", "foreign.test.invalid");
  await expect(f.download()).rejects.toThrow("POLICY_DENIED");
  f.downloads.storage.presignDownload = async (...args) =>
    (await presign(...args)).replace("X-Amz-Expires=30", "X-Amz-Expires=3600");
  await expect(f.download()).rejects.toThrow("POLICY_DENIED");
  f.downloads.storage.presignDownload = presign;
  await expect(f.download(f.sendDownload, f.binding, [])).rejects.toThrow("POLICY_DENIED");
  expect(await row(f.request.operationId)).toEqual(f.saved);
});

test("result downloads require separately registered key purposes on both sites", async () => {
  const f = await resultDownloadFixture();
  const [key] = await db
    .select()
    .from(federationSigningKeys)
    .where(eq(federationSigningKeys.siteId, b.signing.siteId));
  if (!key) throw new Error("Expected key");
  try {
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: key.allowedKinds.filter((kind) => kind !== "result-download-grant") })
      .where(
        and(
          eq(federationSigningKeys.siteId, key.siteId),
          eq(federationSigningKeys.keyId, key.keyId),
        ),
      );
    await expect(f.download()).rejects.toThrow("UNTRUSTED_IDENTITY");
    expect(f.calls).toHaveLength(0);
  } finally {
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: key.allowedKinds })
      .where(
        and(
          eq(federationSigningKeys.siteId, key.siteId),
          eq(federationSigningKeys.keyId, key.keyId),
        ),
      );
  }
  await expect(
    f.download(async (_endpoint, jws) => {
      const peer = await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock());
      const { payload } = await verifyFederationMessage(
        FederationResultDownloadQuerySchema,
        jws,
        peer,
        clock(),
      );
      const { binding: _binding, ...identity } = payload;
      const signed = await signFederationMessage(
        FederationResultQuerySchema,
        { ...identity, kind: "result-query" },
        a.signing,
      );
      return f.responder.receiveDownload(signed, sourceFingerprint, f.downloads);
    }),
  ).rejects.toThrow();
});

async function resultImportFixture(fileCount = 1, workflowSource = false) {
  const f = await resultFixture(resultPolicy, workflowSource);
  if (fileCount === 2) {
    const secondId = crypto.randomUUID();
    await db.insert(netdriveFiles).values({
      id: secondId,
      ownerId: executionUserId,
      path: `private/${secondId}`,
      storageKey: `private/${secondId}`,
      size: 3,
      sha256: "b".repeat(64),
    });
    const members = [
      { relativePath: "one.dat", sizeBytes: 3, sha256: "a".repeat(64) },
      { relativePath: "nested/two.dat", sizeBytes: 3, sha256: "b".repeat(64) },
    ];
    await db
      .update(workflowArtifacts)
      .set({
        ioType: "FileBatch",
        contentHash: artifactBatchHash(members),
        fileMembers: members,
        sizeBytes: 6,
        netdriveFileId: null,
      })
      .where(eq(workflowArtifacts.id, f.artifactId));
    await db.insert(workflowArtifactFiles).values(
      members.map((member, i) => ({
        artifactId: f.artifactId,
        relativePath: member.relativePath,
        netdriveFileId: i === 0 ? f.fileId : secondId,
      })),
    );
  }
  const service = () =>
    new FederationResultImports(db, a.signing.siteId, f.service(f.send).results, clock);
  const imports = service();
  const imported = await imports.enqueue(actor, f.request.operationId, crypto.randomUUID());
  const member = imported.members[0];
  if (!member) throw new Error("Expected result member");
  const agentId = `result-copy-${crypto.randomUUID()}`;
  transferAgentIds.push(agentId);
  await db.insert(agents).values({
    agentId,
    providerOrgId: actor.orgId,
    siteName: "Source storage node",
    schedulerType: "kubernetes",
    schedulerVersion: "test",
    status: "online",
  });
  const bindingFor = (generation: string) => ({
    transferId: member.id,
    generation,
    operationId: f.request.operationId,
    manifestDigest: imported.manifestDigest,
    outputId: member.outputId,
    path: member.path,
    sizeBytes: member.sizeBytes,
    sha256: member.sha256,
    partSize: 8 * 1024 * 1024,
  });
  return { ...f, serviceImports: service, imports, imported, member, agentId, bindingFor };
}

test("result imports persist one manifest and deduplicate concurrent submissions without exposing storage credentials", async () => {
  const f = await resultImportFixture();
  const repeated = await Promise.all([
    f.imports.enqueue(actor, f.request.operationId, f.imported.id),
    f.imports.enqueue(actor, f.request.operationId, crypto.randomUUID()),
  ]);
  expect(repeated.map((row) => row.id)).toEqual([f.imported.id, f.imported.id]);
  expect((await f.serviceImports().get(actor, f.imported.id)).members).toEqual(f.imported.members);
  const rows = await db
    .select()
    .from(federationResultImports)
    .where(eq(federationResultImports.operationId, f.request.operationId));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.reportJws).toBeString();
  const summary = JSON.stringify(await f.imports.get(actor, f.imported.id));
  for (const privateField of [
    "reportJws",
    "storageKey",
    "uploadId",
    "private/object/key",
    "downloadUrl",
  ])
    expect(summary).not.toContain(privateField);
  await permission.set({ ...receiver, capability: "result.read", enabled: true }, actor.userId);
  await expect(f.imports.get(receiver, f.imported.id)).rejects.toThrow("POLICY_DENIED");
  await expect(f.imports.enqueue(receiver, f.request.operationId, f.imported.id)).rejects.toThrow(
    "POLICY_DENIED",
  );
});

test("result imports fence concurrent copies, bind the Agent and survive service reconstruction", async () => {
  const f = await resultImportFixture();
  const raced = await Promise.allSettled([
    f.imports.begin(f.member.id, f.agentId),
    f.imports.begin(f.member.id, f.agentId),
  ]);
  expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const winner = raced.find((result) => result.status === "fulfilled");
  if (!winner || winner.status !== "fulfilled") throw new Error("Expected attempt");
  const { attempt } = winner.value;
  expect(await f.imports.allocated(attempt.generation, "upload-one")).toBe(true);
  const restarted = f.serviceImports();
  const binding = f.bindingFor(attempt.generation);
  expect((await restarted.assertCopyLease(f.agentId, binding)).uploadId).toBe("upload-one");
  await expect(restarted.assertCopyLease("foreign-agent", binding)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(
    restarted.assertCopyLease(f.agentId, { ...binding, sha256: "b".repeat(64) }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  const before = await db
    .select()
    .from(netdriveFiles)
    .where(eq(netdriveFiles.ownerId, actor.userId));
  await expect(
    restarted.copied(f.agentId, {
      binding,
      sizeBytes: 3,
      sha256: binding.sha256,
      parts: [{ partNumber: 2, etag: "wrong-part" }],
    }),
  ).rejects.toThrow("INVALID_MESSAGE");
  expect(
    await restarted.copied(f.agentId, {
      binding,
      sizeBytes: 3,
      sha256: binding.sha256,
      parts: [{ partNumber: 1, etag: "uploaded-part" }],
    }),
  ).toEqual({ state: "assembling" });
  expect((await restarted.get(actor, f.imported.id)).members[0]?.state).toBe("assembling");
  expect(
    await db.select().from(netdriveFiles).where(eq(netdriveFiles.ownerId, actor.userId)),
  ).toEqual(before);
  await expect(restarted.assertCopyLease(f.agentId, binding)).rejects.toThrow("OPERATION_CONFLICT");
});

test("result imports quarantine expired allocation and retain late storage IDs without corrupting a newer attempt", async () => {
  const f = await resultImportFixture();
  const first = await f.imports.begin(f.member.id, f.agentId);
  time = new Date(time.getTime() + 120_001);
  expect(await f.imports.expire()).toBeGreaterThanOrEqual(1);
  await expect(f.imports.begin(f.member.id, f.agentId)).rejects.toThrow("OPERATION_CONFLICT");
  await f.imports.storageCleaned(first.attempt.generation);
  const next = await f.imports.begin(f.member.id, f.agentId);
  expect(next.attempt.generation).not.toBe(first.attempt.generation);
  expect(next.attempt.storageKey).not.toBe(first.attempt.storageKey);
  expect(await f.imports.allocated(next.attempt.generation, "upload-new")).toBe(true);
  // An old S3 creation response may arrive even after cleanup and a new claim.
  expect(await f.imports.allocated(first.attempt.generation, "late-upload-old")).toBe(false);
  const [old] = await db
    .select()
    .from(federationResultAttempts)
    .where(eq(federationResultAttempts.generation, first.attempt.generation));
  expect(old).toMatchObject({ state: "cleanup_pending", uploadId: "late-upload-old" });
  await f.imports.storageCleaned(first.attempt.generation);
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("copying");
  expect(
    (await f.imports.assertCopyLease(f.agentId, f.bindingFor(next.attempt.generation))).uploadId,
  ).toBe("upload-new");
  await expect(
    f.imports.copied(f.agentId, {
      binding: f.bindingFor(first.attempt.generation),
      sha256: f.member.sha256,
      sizeBytes: 3,
      parts: [{ partNumber: 1, etag: "late-part" }],
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("result imports revoke grants immediately, keep cleanup possible, and enforce Agent ownership", async () => {
  const f = await resultImportFixture();
  await db
    .update(agents)
    .set({ providerOrgId: receiver.orgId })
    .where(eq(agents.agentId, f.agentId));
  await expect(f.imports.begin(f.member.id, f.agentId)).rejects.toThrow("POLICY_DENIED");
  await db.update(agents).set({ providerOrgId: actor.orgId }).where(eq(agents.agentId, f.agentId));
  const { attempt } = await f.imports.begin(f.member.id, f.agentId);
  await f.imports.allocated(attempt.generation, "upload-revoked");
  await permission.set({ ...actor, capability: "result.read", enabled: false }, actor.userId);
  await expect(f.imports.renew(f.agentId, attempt.generation)).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.imports.assertCopyLease(f.agentId, f.bindingFor(attempt.generation)),
  ).rejects.toThrow("POLICY_DENIED");
  await f.imports.failed(f.agentId, attempt.generation, "COPY_FAILED");
  await expect(f.imports.storageCleaned(attempt.generation)).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.imports.cancel(receiver, f.imported.id)).rejects.toThrow("POLICY_DENIED");
  expect(await f.imports.cancel(actor, f.imported.id)).toEqual({
    id: f.imported.id,
    state: "cancelled",
  });
  time = new Date(time.getTime() + 120_001);
  await f.imports.storageCleaned(attempt.generation);
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("cancelled");
  await expect(f.imports.begin(f.member.id, f.agentId)).rejects.toThrow("POLICY_DENIED");
});

test("result import HTTP API persists intent, enforces operation scope, and requires a new ID after cancellation", async () => {
  const f = await resultFixture();
  const app = new Hono();
  let principal = actor;
  app.use("*", async (c, next) => {
    c.set("principal" as never, principal as never);
    await next();
  });
  app.route("/api", createFederationOutboundRoutes(f.service(f.send)));
  const base = `/api/federation/outbound/${f.request.operationId}/result-imports`;
  const importId = crypto.randomUUID();
  const post = (id: string) =>
    app.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ importId: id }),
    });
  const replies = await Promise.all([post(importId), post(importId)]);
  for (const reply of replies) {
    expect(reply.status).toBe(202);
    expect(await reply.json()).toMatchObject({ data: { id: importId, state: "pending" } });
  }
  const detail = await app.request(`${base}/${importId}`);
  expect(detail.status).toBe(200);
  expect(detail.headers.get("cache-control")).toBe("no-store");
  expect(
    (
      await app.request(
        `/api/federation/outbound/${crypto.randomUUID()}/result-imports/${importId}`,
      )
    ).status,
  ).toBe(403);
  await permission.set({ ...receiver, capability: "result.read", enabled: true }, actor.userId);
  principal = receiver;
  expect((await app.request(`${base}/${importId}`)).status).toBe(403);
  expect((await app.request(`${base}/${importId}/cancel`, { method: "POST" })).status).toBe(403);
  principal = actor;
  await permission.set({ ...actor, capability: "result.read", enabled: false }, actor.userId);
  expect((await app.request(`${base}/${importId}/cancel`, { method: "POST" })).status).toBe(202);
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  expect(await (await post(importId)).json()).toMatchObject({
    data: { id: importId, state: "cancelled" },
  });
  const fresh = crypto.randomUUID();
  expect(await (await post(fresh)).json()).toMatchObject({ data: { id: fresh, state: "pending" } });
  const attempts = await db
    .select()
    .from(federationResultAttempts)
    .innerJoin(
      federationResultTransfers,
      eq(federationResultTransfers.id, federationResultAttempts.transferId),
    )
    .where(eq(federationResultTransfers.importId, fresh));
  expect(attempts).toEqual([]);
});

test("result imports accept only an identical copied receipt replay and cap each Agent at one active copy", async () => {
  const f = await resultImportFixture();
  const second = await resultImportFixture();
  const first = await f.imports.begin(f.member.id, f.agentId);
  await expect(second.imports.begin(second.member.id, f.agentId)).rejects.toThrow();
  expect((await second.imports.get(actor, second.imported.id)).members[0]?.state).toBe("pending");
  await f.imports.allocated(first.attempt.generation, "upload-idempotent");
  const receipt = {
    binding: f.bindingFor(first.attempt.generation),
    sizeBytes: 3,
    sha256: f.member.sha256,
    parts: [{ partNumber: 1, etag: "part-one" }],
  };
  await f.imports.copied(f.agentId, receipt);
  expect(await f.serviceImports().copied(f.agentId, receipt)).toEqual({ state: "assembling" });
  await expect(
    f.imports.copied(f.agentId, { ...receipt, parts: [{ partNumber: 1, etag: "changed-part" }] }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect((await f.imports.get(actor, f.imported.id)).state).not.toBe("available");
  await f.imports.cancel(actor, f.imported.id);
  await expect(second.imports.begin(second.member.id, f.agentId)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  time = new Date(time.getTime() + 120_001);
  await f.imports.storageCleaned(first.attempt.generation);
  expect((await second.imports.begin(second.member.id, f.agentId)).attempt.agentId).toBe(f.agentId);
});

async function resultStorageFixture(fileCount = 1, workflowSource = false) {
  const f = await resultImportFixture(fileCount, workflowSource);
  const signedUrl = (origin: string, seconds: number) => {
    const url = new URL(`${origin}/opaque-object`);
    url.searchParams.set(
      "X-Amz-Date",
      clock()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, ""),
    );
    url.searchParams.set("X-Amz-Expires", String(seconds));
    url.searchParams.set("X-Amz-Signature", "private-storage-ticket");
    return url;
  };
  const downloads: FederationResultDownloadStorage = {
    allowedOrigins: ["https://source-storage.test.invalid"],
    storage: {
      head: async () => ({
        size: 3,
        etag: "source-etag",
        versionId: "one",
        contentType: "text/plain",
        lastModified: clock(),
      }),
      presignDownload: async (_key, seconds) =>
        signedUrl("https://source-storage.test.invalid", seconds).toString(),
    },
  };
  const reader = f.service((_endpoint, jws, path) =>
    path === "/federation/v1/results"
      ? f.responder.receive(jws, sourceFingerprint)
      : f.responder.receiveDownload(jws, sourceFingerprint, downloads),
  ).results;
  const uploads = new Map<string, string>();
  const objects = new Map<string, ObjectStat>();
  const purged: string[] = [];
  const storage = {
    head: async (key: string, _versionId?: string): Promise<ObjectStat | null> =>
      objects.get(key) ?? null,
    completeMultipartUpload: async (
      key: string,
      _uploadId: string,
      _parts: Array<{ partNumber: number; etag: string }>,
    ) => {
      objects.set(key, {
        size: 3,
        etag: "completed",
        versionId: "v1",
        contentType: "text/plain",
        lastModified: clock(),
      });
      return { etag: "completed", versionId: "v1" };
    },
    presignDownload: async (
      _key: string,
      seconds: number,
      _filename?: string,
      versionId?: string,
    ) => {
      const url = signedUrl("https://destination-storage.test.invalid", seconds);
      if (versionId) url.searchParams.set("versionId", versionId);
      return url.toString();
    },
    createMultipartUpload: async (key: string, _contentType: string) => {
      const uploadId = crypto.randomUUID();
      uploads.set(key, uploadId);
      return { uploadId };
    },
    presignUploadPart: async (
      _key: string,
      uploadId: string,
      partNumber: number,
      seconds: number,
    ) => {
      const url = signedUrl("https://destination-storage.test.invalid", seconds);
      url.searchParams.set("uploadId", uploadId);
      url.searchParams.set("partNumber", String(partNumber));
      return url.toString();
    },
    cleanupFederationResult: async (key: string) => {
      purged.push(key);
      uploads.delete(key);
      objects.delete(key);
    },
  };
  const options = {
    sourceOrigins: downloads.allowedOrigins,
    destinationOrigins: ["https://destination-storage.test.invalid"],
    clock,
    timeoutMs: 5000,
  };
  const bridge = new FederationResultStorage(f.imports, reader, storage, options);
  return { ...f, storage, bridge, uploads, objects, purged, options, reader };
}

test("result storage binds both credentials to the current copy and preserves cleanup after failure", async () => {
  const f = await resultStorageFixture();
  const allocated = await f.bridge.allocate(f.member.id, f.agentId);
  const binding = f.bindingFor(allocated.task.generation);
  const [reserved] = await db
    .select()
    .from(federationResultImports)
    .where(eq(federationResultImports.id, f.imported.id));
  expect(reserved?.reservedBytes).toBe(3);
  const download = await f.bridge.grant(f.agentId, binding, "download");
  expect(download.grant).toMatchObject({ binding, direction: "download" });
  const upload = await f.bridge.grant(f.agentId, binding, "upload", 1);
  expect(upload.grant).toMatchObject({ binding, direction: "upload", partNumber: 1 });
  expect(new URL(upload.grant.url).searchParams.get("uploadId")).toBe(
    [...f.uploads.values()][0] ?? null,
  );
  await expect(f.bridge.grant(f.agentId, binding, "upload", 2)).rejects.toThrow("INVALID_MESSAGE");
  await expect(f.bridge.grant("other-agent", binding, "download")).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await f.imports.failed(f.agentId, binding.generation, "COPY_FAILED");
  expect(await f.bridge.cleanup()).toBe(0);
  time = new Date(time.getTime() + 120_001);
  expect(await f.bridge.cleanup()).toBeGreaterThanOrEqual(1);
  expect(f.uploads.size).toBe(0);
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("pending");
  expect(f.purged.some((key) => key.endsWith(binding.generation))).toBe(true);
});

test("result storage does not release credentials after cancellation or for another S3 multipart target", async () => {
  const f = await resultStorageFixture();
  const allocated = await f.bridge.allocate(f.member.id, f.agentId);
  const binding = f.bindingFor(allocated.task.generation);
  const presign = f.storage.presignUploadPart;
  f.storage.presignUploadPart = async (...args) =>
    (await presign(...args)).replace("partNumber=1", "partNumber=2");
  await expect(f.bridge.grant(f.agentId, binding, "upload", 1)).rejects.toThrow("INVALID_MESSAGE");
  f.storage.presignUploadPart = async (...args) => {
    const url = await presign(...args);
    await f.imports.cancel(actor, f.imported.id);
    return url;
  };
  await expect(f.bridge.grant(f.agentId, binding, "upload", 1)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect(f.uploads.size).toBe(1);
});

test("result storage keeps late allocation IDs after timeout and rechecks cleaned keys for lost side effects", async () => {
  const f = await resultStorageFixture();
  f.options.timeoutMs = 50;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const allocate = f.storage.createMultipartUpload;
  f.storage.createMultipartUpload = async (...args) => {
    await waiting;
    return allocate(...args);
  };
  await expect(f.bridge.allocate(f.member.id, f.agentId)).rejects.toThrow(
    "FEDERATION_RESULT_STORAGE_UNAVAILABLE",
  );
  const [attempt] = await db
    .select()
    .from(federationResultAttempts)
    .where(eq(federationResultAttempts.transferId, f.member.id));
  if (!attempt) throw new Error("Expected durable cleanup identity");
  expect(attempt.state).toBe("cleanup_pending");
  release();
  for (let i = 0; i < 50; i++) {
    const [saved] = await db
      .select()
      .from(federationResultAttempts)
      .where(eq(federationResultAttempts.generation, attempt.generation));
    if (saved?.uploadId) break;
    await Bun.sleep(5);
  }
  const [late] = await db
    .select()
    .from(federationResultAttempts)
    .where(eq(federationResultAttempts.generation, attempt.generation));
  expect(late?.uploadId).toBe([...f.uploads.values()][0] ?? null);
  expect(late?.state).toBe("cleanup_pending");
  time = new Date(time.getTime() + 120_001);
  await f.bridge.cleanup();
  expect(f.uploads.size).toBe(0);
  f.uploads.set(attempt.storageKey, "orphan-from-a-lost-response");
  time = new Date(time.getTime() + 24 * 60 * 60_000 + 1);
  await f.bridge.cleanup();
  expect(f.uploads.size).toBe(0);
  expect(f.purged.filter((key) => key === attempt.storageKey)).toHaveLength(2);
});

test("result storage failed allocation and cleanup cannot release retry eligibility", async () => {
  const f = await resultStorageFixture();
  const bridge = f.bridge;
  f.storage.createMultipartUpload = async () => {
    throw new Error("Storage unavailable");
  };
  await expect(bridge.allocate(f.member.id, f.agentId)).rejects.toThrow(
    "FEDERATION_RESULT_STORAGE_UNAVAILABLE",
  );
  expect(f.uploads.size).toBe(0);
  time = new Date(time.getTime() + 120_001);
  f.storage.cleanupFederationResult = async () => {
    throw new Error("https://private.test/?secret=credential");
  };
  expect(await bridge.cleanup()).toBe(0);
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("cleanup_pending");
  await expect(f.imports.begin(f.member.id, f.agentId)).rejects.toThrow("OPERATION_CONFLICT");
});

test("result transport dispatches only to authenticated capable Agents and binds grants and reports to the leased file", async () => {
  const f = await resultStorageFixture();
  const dispatcher = new AgentDispatcher();
  const messages: ServerMessage[] = [];
  const channel = {
    push: (message: ServerMessage) => {
      messages.push(message);
    },
    close: () => {},
    federationResultCopyV1: false,
    federationResultVerifyV1: false,
    verifiedCertFingerprint: undefined as string | undefined,
  };
  dispatcher.register(f.agentId, channel);
  const transport = new FederationResultTransport(f.imports, f.bridge, dispatcher);
  expect(await transport.dispatch(f.member.id, f.agentId)).toBe(false);
  channel.federationResultCopyV1 = true;
  expect(await transport.dispatch(f.member.id, f.agentId)).toBe(false);
  expect(f.uploads.size).toBe(0);
  channel.verifiedCertFingerprint = "verified";
  expect(await transport.dispatch(f.member.id, f.agentId)).toBe(false);
  channel.federationResultVerifyV1 = true;
  expect(await transport.dispatch(f.member.id, f.agentId)).toBe(true);
  const message = messages[0];
  if (message?.payload.case !== "federationResultCopy") throw new Error("Missing copy dispatch");
  const task = JSON.parse(message.payload.value.taskJson);
  const binding = f.bindingFor(task.generation);
  const request = create(FederationResultGrantRequestSchema, {
    requestId: crypto.randomUUID(),
    bindingJson: JSON.stringify(binding),
    upload: true,
    partNumber: 1,
  });
  await expect(transport.grant("other-agent", request)).rejects.toThrow("OPERATION_CONFLICT");
  expect(JSON.parse((await transport.grant(f.agentId, request)).grantJson)).toMatchObject({
    binding,
    direction: "upload",
    partNumber: 1,
  });
  const copied = {
    binding,
    sizeBytes: 3,
    sha256: binding.sha256,
    parts: [{ partNumber: 1, etag: "copied-part" }],
  };
  await expect(
    transport.report(
      f.agentId,
      create(FederationResultCopyReportSchema, {
        generation: crypto.randomUUID(),
        copiedJson: JSON.stringify(copied),
      }),
    ),
  ).rejects.toThrow("INVALID_MESSAGE");
  await transport.report(
    f.agentId,
    create(FederationResultCopyReportSchema, {
      generation: task.generation,
      copiedJson: JSON.stringify(copied),
    }),
  );
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("verifying");
  const verify = messages[1];
  if (verify?.payload.case !== "federationResultVerify")
    throw new Error("Missing verification dispatch");
  const verification = FederationResultVerifyTaskSchema.parse(
    JSON.parse(verify.payload.value.taskJson),
  );
  await transport.report(
    f.agentId,
    create(FederationResultCopyReportSchema, {
      generation: task.generation,
      copiedJson: JSON.stringify(copied),
    }),
  );
  expect(messages.filter((item) => item.payload.case === "federationResultVerify")).toHaveLength(2);
  const read = await transport.grant(
    f.agentId,
    create(FederationResultGrantRequestSchema, {
      requestId: crypto.randomUUID(),
      verificationJson: JSON.stringify(verification),
    }),
  );
  expect(JSON.parse(read.grantJson)).toMatchObject({ ...verification, direction: "verify" });
  await expect(transport.grant(f.agentId, request)).rejects.toThrow("OPERATION_CONFLICT");
  await transport.report(
    f.agentId,
    create(FederationResultCopyReportSchema, {
      generation: task.generation,
      verifiedJson: JSON.stringify({ ...verification, sizeBytes: 3, sha256: binding.sha256 }),
    }),
  );
  await transport.report(
    f.agentId,
    create(FederationResultCopyReportSchema, {
      generation: task.generation,
      verifiedJson: JSON.stringify({ ...verification, sizeBytes: 3, sha256: binding.sha256 }),
    }),
  );
  await transport.report(
    f.agentId,
    create(FederationResultCopyReportSchema, {
      generation: task.generation,
      copiedJson: JSON.stringify(copied),
    }),
  );
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("verified");
  expect((await f.imports.get(actor, f.imported.id)).state).not.toBe("available");
});

test("result transport retains cleanup if the Agent reconnects during upload allocation", async () => {
  const f = await resultStorageFixture();
  const dispatcher = new AgentDispatcher();
  let pushes = 0;
  const channel = {
    push: () => {
      pushes++;
    },
    close: () => {},
    federationResultCopyV1: true,
    federationResultVerifyV1: true,
    verifiedCertFingerprint: "verified",
  };
  dispatcher.register(f.agentId, channel);
  const allocate = f.storage.createMultipartUpload;
  f.storage.createMultipartUpload = async (...args) => {
    dispatcher.register(f.agentId, { ...channel });
    return allocate(...args);
  };
  const transport = new FederationResultTransport(f.imports, f.bridge, dispatcher);
  expect(await transport.dispatch(f.member.id, f.agentId)).toBe(false);
  expect(pushes).toBe(0);
  expect(f.uploads.size).toBe(1);
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("cleanup_pending");
});

async function assemblingResultFixture() {
  const f = await resultStorageFixture();
  const allocation = await f.bridge.allocate(f.member.id, f.agentId);
  const binding = f.bindingFor(allocation.task.generation);
  await f.imports.copied(f.agentId, {
    binding,
    sizeBytes: 3,
    sha256: binding.sha256,
    parts: [{ partNumber: 1, etag: "copied" }],
  });
  const [attempt] = await db
    .select()
    .from(federationResultAttempts)
    .where(eq(federationResultAttempts.generation, binding.generation));
  if (!attempt) throw new Error("Missing copy attempt");
  return { ...f, binding, attempt };
}

test("result verification recovers an already completed object without trusting its HEAD as a byte hash", async () => {
  const f = await assemblingResultFixture();
  await f.storage.completeMultipartUpload(f.attempt.storageKey, "unknown-response", [
    { partNumber: 1, etag: "copied" },
  ]);
  f.storage.completeMultipartUpload = async () => {
    throw new Error("Do not complete a consumed upload twice");
  };
  const assembled = await f.bridge.assemble(f.agentId, f.binding.generation);
  expect(assembled.task.object).toEqual({ versionId: "v1", etag: "completed" });
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("verifying");
  await expect(f.bridge.verificationGrant("other-agent", assembled.task)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(
    f.bridge.verificationGrant(f.agentId, {
      ...assembled.task,
      object: { versionId: "other", etag: "completed" },
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.bridge.verified(f.agentId, { ...assembled.task, sizeBytes: 3, sha256: "0".repeat(64) }),
  ).rejects.toThrow("INVALID_MESSAGE");
  const before = f.objects.get(f.attempt.storageKey);
  if (!before) throw new Error("Missing completed object");
  f.objects.set(f.attempt.storageKey, { ...before, etag: "replaced" });
  await expect(
    f.bridge.verified(f.agentId, { ...assembled.task, sizeBytes: 3, sha256: f.binding.sha256 }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("verifying");
});

test("result verification rechecks cancellation during completion and grant signing", async () => {
  for (const boundary of ["complete", "presign"] as const) {
    const f = await assemblingResultFixture();
    if (boundary === "complete") {
      const complete = f.storage.completeMultipartUpload;
      f.storage.completeMultipartUpload = async (...args) => {
        const result = await complete(...args);
        await f.imports.cancel(actor, f.imported.id);
        return result;
      };
      await expect(f.bridge.assemble(f.agentId, f.binding.generation)).rejects.toThrow();
    } else {
      const assembled = await f.bridge.assemble(f.agentId, f.binding.generation);
      const presign = f.storage.presignDownload;
      f.storage.presignDownload = async (...args) => {
        const url = await presign(...args);
        await f.imports.cancel(actor, f.imported.id);
        return url;
      };
      await expect(f.bridge.verificationGrant(f.agentId, assembled.task)).rejects.toThrow(
        "OPERATION_CONFLICT",
      );
    }
    expect((await f.imports.get(actor, f.imported.id)).state).toBe("cancelled");
    expect(f.objects.size).toBe(1);
    time = new Date(time.getTime() + 120_001);
    await f.bridge.cleanup();
    expect(f.objects.size).toBe(0);
  }
});

test("result verification retains cleanup for a completion that finishes after timeout and an earlier cleanup", async () => {
  const f = await assemblingResultFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const complete = f.storage.completeMultipartUpload;
  f.storage.completeMultipartUpload = async (...args) => {
    entered.resolve();
    await release.promise;
    const result = await complete(...args);
    finished.resolve();
    return result;
  };
  const bridge = new FederationResultStorage(f.imports, f.reader, f.storage, {
    ...f.options,
    timeoutMs: 50,
  });
  const assembly = bridge.assemble(f.agentId, f.binding.generation);
  const failure = expect(assembly).rejects.toThrow("FEDERATION_RESULT_STORAGE_UNAVAILABLE");
  await entered.promise;
  await failure;
  time = new Date(time.getTime() + 120_001);
  await bridge.cleanup();
  release.resolve();
  await finished.promise;
  expect(f.objects.size).toBe(1);
  time = new Date(time.getTime() + 24 * 60 * 60_000 + 1);
  await bridge.cleanup();
  expect(f.objects.size).toBe(0);
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("pending");
});

test("concurrent result completions cannot mark a successfully assembled object for cleanup", async () => {
  const f = await assemblingResultFixture();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const complete = f.storage.completeMultipartUpload;
  f.storage.completeMultipartUpload = async (...args) => {
    if (++calls === 2) entered.resolve();
    await entered.promise;
    return complete(...args);
  };
  const results = await Promise.allSettled([
    f.bridge.assemble(f.agentId, f.binding.generation),
    f.bridge.assemble(f.agentId, f.binding.generation),
  ]);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect((await f.imports.get(actor, f.imported.id)).members[0]?.state).toBe("verifying");
  expect(await f.bridge.cleanup()).toBe(0);
  expect(f.objects.size).toBe(1);
});

test.each([
  "import",
  "ordinary-upload",
] as const)("result quota serializes remaining capacity against %s", async (competitor) => {
  const first = await resultImportFixture();
  const second = await resultImportFixture();
  await first.imports.cancel(actor, first.imported.id);
  await second.imports.cancel(actor, second.imported.id);
  const quota = new StorageQuotaService(db, clock);
  const before = await quota.getSummary(actor.userId);
  const limit = before.usedBytes + (before.reservedBytes ?? 0) + 3;
  const [policy] = await db
    .insert(storageQuotaPolicies)
    .values({ scope: "cloud", scopeId: "global", defaultQuotaBytes: limit })
    .returning();
  if (!policy) throw new Error("Missing quota policy");
  const firstId = crypto.randomUUID(),
    secondId = crypto.randomUUID();
  try {
    const backend = new FakeMinioBackend();
    const service = new NetDriveService(db, backend, {
      commitSecret: "result-quota-test-commit-secret-for-isolated-fixture",
    });
    const path = `result-quota/${crypto.randomUUID()}`;
    const minted = await service.mintUploadUrl(actor.userId, { path, size: 3 });
    await backend.putBlob(minted.storageKey, Buffer.from("abc"), "text/plain");
    const results = await Promise.allSettled([
      first.imports.enqueue(actor, first.imported.operationId, firstId),
      competitor === "import"
        ? second.imports.enqueue(actor, second.imported.operationId, secondId)
        : service.commitFile(actor.userId, {
            path,
            size: 3,
            sha256: new Bun.CryptoHasher("sha256").update("abc").digest("hex"),
            storageKey: minted.storageKey,
            commitToken: minted.commitToken,
          }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("Expected quota conflict");
    expect(rejected.reason).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
    const after = await quota.getSummary(actor.userId);
    expect(after.usedBytes + (after.reservedBytes ?? 0)).toBe(limit);
    expect(after.availableBytes).toBe(0);
    for (const [index, result] of results.entries())
      if (result.status === "fulfilled") {
        if (competitor === "ordinary-upload" && index === 1)
          await service.deleteFile(actor.userId, result.value.id);
        else await first.imports.cancel(actor, result.value.id);
      }
  } finally {
    await db.delete(storageQuotaPolicies).where(eq(storageQuotaPolicies.id, policy.id));
  }
});

test("result quota stays reserved until cancelled attempts are actually cleaned", async () => {
  const f = await resultStorageFixture();
  const quota = new StorageQuotaService(db, clock);
  const before = await quota.getSummary(actor.userId);
  await f.bridge.allocate(f.member.id, f.agentId);
  await f.imports.cancel(actor, f.imported.id);
  expect((await quota.getSummary(actor.userId)).reservedBytes).toBe(before.reservedBytes);
  time = new Date(time.getTime() + 120_001);
  const cleanup = f.storage.cleanupFederationResult;
  f.storage.cleanupFederationResult = async () => {
    throw new Error("storage offline");
  };
  expect(await f.bridge.cleanup()).toBe(0);
  expect((await quota.getSummary(actor.userId)).reservedBytes).toBe(before.reservedBytes);
  f.storage.cleanupFederationResult = cleanup;
  await f.bridge.cleanup();
  expect((await quota.getSummary(actor.userId)).reservedBytes).toBe(
    (before.reservedBytes ?? 0) - 3,
  );
});

test("result downloads honor the committed file version and reject a changed pin before releasing credentials", async () => {
  const f = await resultDownloadFixture();
  await db
    .update(netdriveFiles)
    .set({ storageVersionId: "committed-old", etag: '"object-etag"' })
    .where(eq(netdriveFiles.id, f.fileId));
  const head = f.downloads.storage.head;
  let observedVersion: string | undefined;
  f.downloads.storage.head = async (key, version) => {
    observedVersion = version;
    const stat = await head(key, version);
    if (!stat) throw new Error("Missing fixture object");
    return { ...stat, versionId: "committed-old" };
  };
  expect(new URL((await f.download()).url).searchParams.get("versionId")).toBe("committed-old");
  expect(observedVersion).toBe("committed-old");
  const pinnedHead = f.downloads.storage.head;
  f.downloads.storage.head = async (...args) => {
    const stat = await pinnedHead(...args);
    return stat ? { ...stat, versionId: "unexpected-latest" } : null;
  };
  await expect(f.download()).rejects.toThrow("ASSET_UNAVAILABLE");
  expect(f.calls).toHaveLength(1);
  f.downloads.storage.head = pinnedHead;
  const presign = f.downloads.storage.presignDownload;
  f.downloads.storage.presignDownload = async (...args) => {
    const url = await presign(...args);
    await db
      .update(netdriveFiles)
      .set({ storageVersionId: "changed-during-signing" })
      .where(eq(netdriveFiles.id, f.fileId));
    return url;
  };
  await expect(f.download()).rejects.toThrow("OPERATION_CONFLICT");
});

async function publishableResults(fileCount = 1, workflowSource = false) {
  const f = await resultStorageFixture(fileCount, workflowSource);
  for (const member of f.imported.members) {
    const allocated = await f.bridge.allocate(member.id, f.agentId);
    const binding = {
      ...f.bindingFor(allocated.task.generation),
      transferId: member.id,
      outputId: member.outputId,
      path: member.path,
      sha256: member.sha256,
      sizeBytes: member.sizeBytes,
    };
    await f.imports.copied(f.agentId, {
      binding,
      sizeBytes: member.sizeBytes,
      sha256: member.sha256,
      parts: [{ partNumber: 1, etag: "copied" }],
    });
    const assembled = await f.bridge.assemble(f.agentId, binding.generation);
    await f.bridge.verified(f.agentId, {
      ...assembled.task,
      sizeBytes: member.sizeBytes,
      sha256: member.sha256,
    });
  }
  const publishedFiles = () =>
    db
      .select()
      .from(netdriveFiles)
      .where(
        inArray(
          netdriveFiles.id,
          f.imported.members.map((member) => member.id),
        ),
      );
  return { ...f, publishedFiles };
}

async function workflowResultExecutor(f: Awaited<ReturnType<typeof resultFixture>>, batch = false) {
  const source = f.sourceWorkflow;
  if (!source) throw new Error("Missing source Workflow fixture");
  const status = new FederationStatusResponder(db, b.signing, clock);
  const cancellation = new FederationCancellationReceiver(db, b.signing, clock);
  const send: FederationSend = (endpoint, jws, path) =>
    path === "/federation/v1/status"
      ? status.receive(jws, sourceFingerprint)
      : path === "/federation/v1/cancellations"
        ? cancellation.receive(jws, sourceFingerprint)
        : f.send(endpoint, jws, path);
  const service = f.service(send);
  const executor = new FederationWorkflowExecutor(db, a.signing.siteId, service, clock);
  const node = workflowDsl.WorkflowNodeSchema.parse({
    id: "remote",
    name: "Remote task",
    type: "Federation",
    agreementRevisionId: f.terms.agreementRevisionId,
    template: f.reference,
    inputManifestDigest: f.request.inputManifestDigest,
    environmentLockDigest: f.request.environmentLockDigest,
    resources: f.request.resources,
    maxAmount: f.request.maxAmount,
    outputs: [
      {
        descriptor: "result",
        from: { nodeId: "producer", descriptor: "result" },
        type: batch ? "FileBatch" : "File",
      },
    ],
  });
  if (node.type !== "Federation") throw new Error("Missing federation node");
  const refresh = async () => {
    await db
      .update(federationOutbound)
      .set({ statusNextAttemptAt: new Date("2030-01-01T00:00:00Z") })
      .where(ne(federationOutbound.operationId, f.request.operationId));
    await db
      .update(federationOutbound)
      .set({ statusNextAttemptAt: clock() })
      .where(eq(federationOutbound.operationId, f.request.operationId));
    expect(await service.refreshStatusNext()).toBe(true);
  };
  return { source, service, executor, node, refresh };
}

test("federation Workflow node resumes remote and result waiting, then supplies verified local files to its downstream Script", async () => {
  const f = await publishableResults(2, true);
  const e = await workflowResultExecutor(f, true);
  const script = (id: string) => ({
    id,
    name: id,
    type: "Script",
    source: { type: "Inline", language: "bash", content: "true" },
    runtimeProfileId: crypto.randomUUID(),
  });
  const yaml = stringify({
    name: "Ordinary federated workflow",
    spec: {
      nodeDrafts: [
        e.node,
        script("independent"),
        {
          ...script("consume"),
          inputs: { files: { type: "FileBatch", required: true } },
          inputSlots: [
            {
              descriptor: "files",
              type: "File",
              isBatch: true,
              from: { node: "remote", output: "result" },
            },
          ],
        },
      ],
      nodeRelations: [{ fromId: "remote", toId: "consume", slotRelations: [] }],
    },
  });
  const executed: string[] = [];
  let received: unknown;
  const runner = (lease: typeof e.source.lease) =>
    createWorkflowRunner({
      journal: lease,
      resolvePackage: async () => {
        throw new Error("No local usecase expected");
      },
      submitJob: async () => {
        throw new Error("No local Job expected");
      },
      executeFederation: (node, invocation) => {
        if (!invocation) throw new Error("Missing invocation");
        return e.executor.execute(actor, lease, node, invocation);
      },
      executeScript: async (node, ctx) => {
        executed.push(node.id);
        if (node.id === "consume") received = ctx.nodes;
        return { status: "Succeeded", values: {} };
      },
    });
  await expect(runner(e.source.lease)(yaml)).rejects.toBeInstanceOf(WorkflowExecutionWaiting);
  expect(executed).toEqual(["independent"]);
  await e.refresh();
  await expect(runner(e.source.lease)(yaml)).rejects.toBeInstanceOf(WorkflowExecutionWaiting);
  expect(executed).toEqual(["independent"]);
  await f.bridge.publish(actor, f.imported.id);
  await e.source.lease.release();
  const lease = await e.source.journal.acquire(e.source.runId);
  if (!lease) throw new Error("Missing restored source lease");
  const result = await runner(lease)(yaml);
  expect(result.status).toEqual({
    remote: "Succeeded",
    independent: "Succeeded",
    consume: "Succeeded",
  });
  expect(executed).toEqual(["independent", "consume"]);
  const expected = f.imported.members.map((member) => ({
    fileMetadataId: member.id,
    fileMetadataName: member.path,
  }));
  expect(received).toMatchObject({ remote: { values: { result: expected } } });
  expect(expected.every((file) => file.fileMetadataId !== f.fileId)).toBe(true);
  expect(await e.source.registry.completeRun(e.source.runId, result, lease)).toBe(true);
  await lease.release();
});

test("federation Workflow node rejects missing output bindings, overwritten versions and deleted local result files", async () => {
  const f = await publishableResults(1, true);
  const e = await workflowResultExecutor(f);
  await e.refresh();
  await f.bridge.publish(actor, f.imported.id);
  const execute = (node = e.node) =>
    e.executor.execute(actor, e.source.lease, node, e.source.invocation);
  expect((await execute()).status).toBe("Succeeded");
  const output = e.node.outputs[0];
  if (!output) throw new Error("Missing output mapping");
  expect(
    (
      await execute({
        ...e.node,
        outputs: [
          { ...output, descriptor: "missing", from: { nodeId: "other", descriptor: "result" } },
        ],
      })
    ).status,
  ).toBe("Failed");
  const [file] = await f.publishedFiles();
  if (!file) throw new Error("Missing local result file");
  await db
    .update(netdriveFiles)
    .set({ storageVersionId: "replaced-version" })
    .where(eq(netdriveFiles.id, file.id));
  expect((await execute()).status).toBe("Failed");
  await db
    .update(netdriveFiles)
    .set({ storageVersionId: file.storageVersionId, deletedAt: clock() })
    .where(eq(netdriveFiles.id, file.id));
  expect((await execute()).status).toBe("Failed");
  await db.update(netdriveFiles).set({ deletedAt: null }).where(eq(netdriveFiles.id, file.id));
  await permission.set({ ...actor, capability: "result.read", enabled: false }, actor.userId);
  try {
    expect((await execute()).status).toBe("Failed");
  } finally {
    await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  }
  await e.source.lease.release();
});

test("federation Workflow cancellation waits for result-copy cleanup after remote stop and fences late result imports", async () => {
  const f = await resultStorageFixture(1, true);
  const e = await workflowResultExecutor(f);
  await e.refresh();
  await f.bridge.allocate(f.member.id, f.agentId);
  const [originalImport] = await db
    .select()
    .from(federationResultImports)
    .where(eq(federationResultImports.id, f.imported.id));
  if (!originalImport) throw new Error("Missing original import");
  const otherImportId = crypto.randomUUID();
  await db.insert(federationResultImports).values({
    ...originalImport,
    id: otherImportId,
    requestedBy: receiver.userId,
    reservedBytes: 0,
  });
  await e.source.registry.requestCancel(e.source.runId);
  await expect(
    e.service.resultImports.enqueue(
      actor,
      f.request.operationId,
      crypto.randomUUID(),
      e.source.lease,
    ),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  await expect(e.service.cancelWorkflow(e.source.runId)).rejects.toThrow(
    "awaiting stop confirmation",
  );
  expect((await f.imports.get(actor, f.imported.id)).state).toBe("cancelled");
  expect(
    (
      await db
        .select()
        .from(federationResultImports)
        .where(eq(federationResultImports.id, otherImportId))
    )[0]?.state,
  ).toBe(originalImport.state);
  await e.service.cancellations.deliverNext();
  const monitor = new FederationCancellationMonitor(
    db,
    { cancel: async () => "completed" },
    async () => {},
    clock,
  );
  await monitor.tick();
  time = new Date(time.getTime() + 11_000);
  await e.service.cancellations.deliverNext();
  expect((await row(f.request.operationId)).cancelState).toBe("stopped");
  expect(await e.source.registry.cancelRun(e.source.runId)).toBe(false);
  expect(await f.bridge.cleanup()).toBe(0);
  time = new Date(time.getTime() + 120_001);
  await f.bridge.cleanup();
  expect(await e.source.registry.cancelRun(e.source.runId)).toBe(true);
  await e.source.lease.release();
});

test("federation Workflow queues its result import automatically and deduplicates recovery", async () => {
  const f = await resultFixture(resultPolicy, true);
  const e = await workflowResultExecutor(f);
  await e.refresh();
  for (let i = 0; i < 2; i++)
    await expect(
      e.executor.execute(actor, e.source.lease, e.node, e.source.invocation),
    ).rejects.toThrow("RESULT_WAITING");
  const imports = await db
    .select()
    .from(federationResultImports)
    .where(eq(federationResultImports.operationId, f.request.operationId));
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({
    id: f.request.operationId,
    state: "pending",
    requestedBy: actor.userId,
    reservedBytes: 3,
  });
  await e.source.lease.release();
});

test("federation Workflow cancellation during result inventory retrieval prevents late copy enqueue", async () => {
  const f = await resultFixture(resultPolicy, true);
  const e = await workflowResultExecutor(f);
  await e.refresh();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const delayed = f.service(async (endpoint, jws, path) => {
    const response = await f.send(endpoint, jws, path);
    entered.resolve();
    await release.promise;
    return response;
  });
  const executor = new FederationWorkflowExecutor(db, a.signing.siteId, delayed, clock);
  const execution = executor.execute(actor, e.source.lease, e.node, e.source.invocation).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    await e.source.registry.requestCancel(e.source.runId);
  } finally {
    release.resolve();
  }
  expect(await execution).toBeInstanceOf(WorkflowExecutionInterrupted);
  expect(
    await db
      .select()
      .from(federationResultImports)
      .where(eq(federationResultImports.operationId, f.request.operationId)),
  ).toHaveLength(0);
  await e.source.lease.release();
});

test("federation Workflow remote failure enters cancellation until cleanup is confirmed", async () => {
  const f = await resultFixture(resultPolicy, true);
  const e = await workflowResultExecutor(f);
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, f.runId));
  await e.refresh();
  const result = await e.executor.execute(actor, e.source.lease, e.node, e.source.invocation);
  expect(result.status).toBe("Failed");
  expect(
    await e.source.registry.completeRun(
      e.source.runId,
      {
        status: { remote: result.status },
        values: {
          remote: { status: result.status, values: result.values ?? {}, failure: result.failure },
        },
      },
      e.source.lease,
    ),
  ).toBe(false);
  expect((await e.source.registry.getById(e.source.runId))?.status).toBe("cancelling");
  expect(await e.source.registry.cancelRun(e.source.runId)).toBe(false);
  await e.source.lease.release();
});

test("result publication commits the whole batch once with provenance, pinned versions and quota conversion", async () => {
  const f = await publishableResults(2);
  const quota = new StorageQuotaService(db, clock);
  const before = await quota.getSummary(actor.userId);
  expect(await f.publishedFiles()).toHaveLength(0);
  const responses = await Promise.all([
    f.bridge.publish(actor, f.imported.id),
    f.bridge.publish(actor, f.imported.id),
  ]);
  expect(responses.every((response) => response.state === "available")).toBe(true);
  const files = await f.publishedFiles();
  expect(files).toHaveLength(2);
  for (const member of responses[0]?.members ?? []) {
    const file = files.find((row) => row.id === member.fileId);
    expect(file).toMatchObject({
      ownerId: actor.userId,
      size: member.sizeBytes,
      sha256: member.sha256,
      storageVersionId: "v1",
      etag: "completed",
    });
    expect(file?.path).toBe(
      `federation-results/${f.imported.id}/${member.outputId.replace("sha256:", "")}/${member.path}`,
    );
  }
  const after = await quota.getSummary(actor.userId);
  expect(after.usedBytes - before.usedBytes).toBe(6);
  expect((before.reservedBytes ?? 0) - (after.reservedBytes ?? 0)).toBe(6);
  expect(after.availableBytes).toBe(before.availableBytes);
  await expect(f.imports.cancel(actor, f.imported.id)).rejects.toThrow("OPERATION_CONFLICT");
  time = new Date(time.getTime() + 24 * 60 * 60_000);
  await f.bridge.cleanup();
  expect(f.objects.size).toBe(2);
  expect((await f.serviceImports().get(actor, f.imported.id)).members).toEqual(
    responses[0]?.members ?? [],
  );
});

test("result publication keeps every file hidden when a member, object or destination path conflicts", async () => {
  const pending = await resultStorageFixture(2);
  await expect(pending.bridge.publish(actor, pending.imported.id)).rejects.toThrow("DATA_WAITING");
  const f = await publishableResults(2);
  const snapshot = await f.imports.publication(actor, f.imported.id);
  if (snapshot.state !== "ready") throw new Error("Missing publication snapshot");
  const file = snapshot.files[1];
  if (!file) throw new Error("Missing second member");
  const original = f.objects.get(file.storageKey);
  if (!original) throw new Error("Missing stored object");
  f.objects.set(file.storageKey, { ...original, etag: "changed" });
  await expect(f.bridge.publish(actor, f.imported.id)).rejects.toThrow("OPERATION_CONFLICT");
  expect(await f.publishedFiles()).toHaveLength(0);
  f.objects.set(file.storageKey, original);
  const collisionId = crypto.randomUUID();
  await db.insert(netdriveFiles).values({
    id: collisionId,
    ownerId: actor.userId,
    path: file.path,
    storageKey: "user-existing",
    size: 1,
    sha256: "c".repeat(64),
  });
  await expect(f.bridge.publish(actor, f.imported.id)).rejects.toThrow("OPERATION_CONFLICT");
  expect(await f.publishedFiles()).toHaveLength(0);
  const [parent] = await db
    .select()
    .from(federationResultImports)
    .where(eq(federationResultImports.id, f.imported.id));
  expect(parent?.reservedBytes).toBe(6);
  await db.delete(netdriveFiles).where(eq(netdriveFiles.id, collisionId));
  expect((await f.bridge.publish(actor, f.imported.id)).state).toBe("available");
});

test("result publication rejects cancellation and revoked remote authority during storage checks", async () => {
  for (const boundary of ["cancel", "revoke"] as const) {
    const f = await publishableResults();
    const head = f.storage.head;
    f.storage.head = async (...args) => {
      const stat = await head(...args);
      if (boundary === "cancel") await f.imports.cancel(actor, f.imported.id);
      else
        await db
          .update(federationAgreements)
          .set({ state: "revoked" })
          .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
      return stat;
    };
    await expect(f.bridge.publish(actor, f.imported.id)).rejects.toThrow();
    expect(await f.publishedFiles()).toHaveLength(0);
  }
});

test("result publication rejects foreign owners, changed manifests and unversioned destinations", async () => {
  const f = await publishableResults();
  await expect(f.bridge.publish(receiver, f.imported.id)).rejects.toThrow("POLICY_DENIED");
  await db.update(netdriveFiles).set({ deletedAt: clock() }).where(eq(netdriveFiles.id, f.fileId));
  await expect(f.bridge.publish(actor, f.imported.id)).rejects.toThrow();
  expect(await f.publishedFiles()).toHaveLength(0);
  await db.update(netdriveFiles).set({ deletedAt: null }).where(eq(netdriveFiles.id, f.fileId));
  await db
    .update(federationResultAttempts)
    .set({ destinationVersionId: null })
    .where(eq(federationResultAttempts.transferId, f.member.id));
  await expect(f.bridge.publish(actor, f.imported.id)).rejects.toThrow("POLICY_DENIED");
  expect(await f.publishedFiles()).toHaveLength(0);
});

test("result publication rolls back quota conversion when policy shrinks and handles an empty manifest", async () => {
  const f = await publishableResults(2);
  const quota = new StorageQuotaService(db, clock);
  const before = await quota.getSummary(actor.userId);
  await db
    .insert(storageQuotaPolicies)
    .values({ scope: "cloud", scopeId: "global", defaultQuotaBytes: 0 });
  try {
    await expect(f.bridge.publish(actor, f.imported.id)).rejects.toThrow();
    expect(await f.publishedFiles()).toHaveLength(0);
    const [parent] = await db
      .select()
      .from(federationResultImports)
      .where(eq(federationResultImports.id, f.imported.id));
    expect(parent?.reservedBytes).toBe(6);
    expect(parent?.state).not.toBe("available");
  } finally {
    await db
      .delete(storageQuotaPolicies)
      .where(
        and(eq(storageQuotaPolicies.scope, "cloud"), eq(storageQuotaPolicies.scopeId, "global")),
      );
  }
  expect((await quota.getSummary(actor.userId)).usedBytes).toBe(before.usedBytes);
  await f.imports.cancel(actor, f.imported.id);
  await db
    .update(workflowRuns)
    .set({
      result: {
        status: { producer: "Succeeded" },
        values: { producer: { status: "Succeeded", values: {} } },
      },
    })
    .where(eq(workflowRuns.id, f.runId));
  await db.delete(workflowArtifactFiles).where(eq(workflowArtifactFiles.artifactId, f.artifactId));
  await db.delete(workflowArtifacts).where(eq(workflowArtifacts.id, f.artifactId));
  const empty = await f.imports.enqueue(actor, f.request.operationId, crypto.randomUUID());
  expect(empty.members).toHaveLength(0);
  const published = await f.bridge.publish(actor, empty.id);
  expect(published.state).toBe("available");
  expect(published.members).toHaveLength(0);
});

test("result publication fences stale verification snapshots and expired peer authorization", async () => {
  const f = await publishableResults();
  const snapshot = await f.imports.publication(actor, f.imported.id);
  if (snapshot.state !== "ready") throw new Error("Missing publication snapshot");
  const verified = await f.service(f.send).results.read(actor, f.request.operationId);
  await db
    .update(federationResultAttempts)
    .set({ destinationEtag: "changed-after-head" })
    .where(eq(federationResultAttempts.transferId, f.member.id));
  await expect(f.imports.publish(actor, f.imported.id, snapshot, verified)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await db
    .update(federationResultAttempts)
    .set({ destinationEtag: "completed" })
    .where(eq(federationResultAttempts.transferId, f.member.id));
  time = new Date(time.getTime() + 30_001);
  await expect(f.imports.publish(actor, f.imported.id, snapshot, verified)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  expect(await f.publishedFiles()).toHaveLength(0);
  const [parent] = await db
    .select()
    .from(federationResultImports)
    .where(eq(federationResultImports.id, f.imported.id));
  expect(parent?.reservedBytes).toBe(3);
});

async function receiptFixture() {
  await db
    .update(federationResultImports)
    .set({ receiptNextAttemptAt: new Date("2027-01-01") })
    .where(eq(federationResultImports.localSiteId, a.signing.siteId));
  const f = await publishableResults();
  await f.bridge.publish(actor, f.imported.id);
  const receiver = new FederationResultReceiptReceiver(db, b.signing, clock);
  const sender = (
    send: FederationSend = (_endpoint, jws) => receiver.receive(jws, sourceFingerprint),
  ) => new FederationResultReceiptSender(db, a.signing, send, clock);
  const state = async () => {
    const [row] = await db
      .select()
      .from(federationResultImports)
      .where(eq(federationResultImports.id, f.imported.id));
    if (!row?.receipt) throw new Error("Missing durable publication statement");
    return row;
  };
  return { ...f, receiver, sender, state };
}

test("result receipts recover a lost acknowledgement without republishing or changing the signed statement", async () => {
  const f = await receiptFixture();
  const before = await f.state();
  const sender = f.sender(async (endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/result-receipts");
    expect(endpoint).toBe("https://peer.test.invalid");
    await f.receiver.receive(jws, sourceFingerprint);
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  });
  expect(await sender.deliverNext()).toBe(true);
  const lost = await f.state();
  expect(lost.receiptAck).toBeNull();
  expect(lost.receiptLastError).toBe("DELIVERY_UNAVAILABLE");
  expect(await f.sender().deliverNext()).toBe(false);
  time = new Date(time.getTime() + 30_001);
  expect(await f.sender().deliverNext()).toBe(true);
  const delivered = await f.state();
  expect(delivered.receiptJws).toBe(lost.receiptJws);
  expect(delivered.receipt).toEqual(before.receipt);
  expect(delivered.receiptAck?.receiptId).toBe(f.imported.id);
  expect(delivered.state).toBe("available");
  expect(await f.publishedFiles()).toHaveLength(1);
  expect((await f.imports.get(actor, f.imported.id)).receipt?.state).toBe("recorded");
  const records = await db
    .select()
    .from(federationResultReceipts)
    .where(eq(federationResultReceipts.receiptId, f.imported.id));
  expect(records).toHaveLength(1);
  expect(delivered.receiptAckJws).toBe(records[0]?.acknowledgementJws ?? null);
});

test("result receipts reject changed replay, foreign TLS identity and mismatched task binding", async () => {
  const f = await receiptFixture();
  await f.sender().deliverNext();
  const row = await f.state();
  if (!row.receiptJws || !row.receipt) throw new Error("Missing signed statement");
  await expect(f.receiver.receive(row.receiptJws, targetFingerprint)).rejects.toThrow();
  const changed = await signFederationMessage(
    FederationResultReceiptSchema,
    { ...row.receipt, sizeBytes: row.receipt.sizeBytes + 1 },
    a.signing,
  );
  await expect(f.receiver.receive(changed, sourceFingerprint)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  const wrong = await signFederationMessage(
    FederationResultReceiptSchema,
    { ...row.receipt, receiptId: crypto.randomUUID(), operationId: crypto.randomUUID() },
    a.signing,
  );
  await expect(f.receiver.receive(wrong, sourceFingerprint)).rejects.toThrow("OPERATION_CONFLICT");
});

test("result receipts reject forged acknowledgements and recheck source trust after the network response", async () => {
  const f = await receiptFixture();
  const sender = f.sender(async (_endpoint, jws) => {
    const signed = await f.receiver.receive(jws, sourceFingerprint);
    const peer = await trust.resolveKey(b.signing.siteId, b.signing.keyId, clock());
    const { payload } = await verifyFederationMessage(
      FederationResultReceiptAckSchema,
      signed,
      peer,
      clock(),
    );
    return signFederationMessage(
      FederationResultReceiptAckSchema,
      { ...payload, receiptDigest: `sha256:${"0".repeat(64)}` },
      b.signing,
    );
  });
  await sender.deliverNext();
  expect((await f.state()).receiptLastError).toBe("INVALID_MESSAGE");
  expect((await f.state()).receiptAck).toBeNull();
  time = new Date(time.getTime() + 30_001);
  const revoke = f.sender(async (_endpoint, jws) => {
    const ack = await f.receiver.receive(jws, sourceFingerprint);
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: clock() })
      .where(
        and(
          eq(federationSigningKeys.siteId, b.signing.siteId),
          eq(federationSigningKeys.keyId, b.signing.keyId),
        ),
      );
    return ack;
  });
  try {
    await revoke.deliverNext();
    expect((await f.state()).receiptAck).toBeNull();
    expect((await f.state()).receiptLastError).toBe("UNTRUSTED_IDENTITY");
  } finally {
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: null })
      .where(
        and(
          eq(federationSigningKeys.siteId, b.signing.siteId),
          eq(federationSigningKeys.keyId, b.signing.keyId),
        ),
      );
  }
});

test("result receipts require explicit signing purposes but survive later data deletion and disclosure expiry", async () => {
  const f = await receiptFixture();
  const [key] = await db
    .select()
    .from(federationSigningKeys)
    .where(
      and(
        eq(federationSigningKeys.siteId, a.signing.siteId),
        eq(federationSigningKeys.keyId, a.signing.keyId),
      ),
    );
  if (!key) throw new Error("Missing key");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: key.allowedKinds.filter((kind) => kind !== "result-receipt") })
    .where(
      and(
        eq(federationSigningKeys.siteId, a.signing.siteId),
        eq(federationSigningKeys.keyId, a.signing.keyId),
      ),
    );
  try {
    await f.sender().deliverNext();
    expect((await f.state()).receiptJws).toBeNull();
    expect((await f.state()).receiptLastError).toBe("UNTRUSTED_IDENTITY");
  } finally {
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: key.allowedKinds })
      .where(
        and(
          eq(federationSigningKeys.siteId, a.signing.siteId),
          eq(federationSigningKeys.keyId, a.signing.keyId),
        ),
      );
  }
  time = new Date(resultPolicy.availableUntil);
  await permission.set({ ...actor, capability: "result.read", enabled: false }, actor.userId);
  await db
    .update(federationAgreements)
    .set({ state: "revoked" })
    .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
  await db
    .update(netdriveFiles)
    .set({ deletedAt: clock() })
    .where(inArray(netdriveFiles.id, [f.fileId, f.member.id]));
  expect(await f.sender().deliverNext()).toBe(true);
  expect((await f.state()).receiptAck).not.toBeNull();
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
});

test("result worker dispatches capable Agents, publishes after verification and recovers durable attempts", async () => {
  const f = await resultStorageFixture();
  const pending = f.imports.pending.bind(f.imports);
  // Other tests retain attempts for recovery; this storage fixture only owns its own objects.
  f.imports.pending = async (...args) =>
    (await pending(...args)).filter((candidate) => candidate.importId === f.imported.id);
  const dispatcher = new AgentDispatcher();
  const messages: ServerMessage[] = [];
  const channel = {
    push: (message: ServerMessage) => {
      messages.push(message);
    },
    close: () => {},
    federationResultCopyV1: true,
    federationResultVerifyV1: false,
    verifiedCertFingerprint: "verified",
  };
  dispatcher.register(f.agentId, channel);
  const transport = new FederationResultTransport(f.imports, f.bridge, dispatcher);
  const worker = () => new FederationResultWorker(f.imports, f.bridge, transport);
  await worker().tick();
  expect(messages).toHaveLength(0);
  channel.federationResultVerifyV1 = true;
  await Promise.all([worker().tick(), worker().tick()]);
  expect(messages).toHaveLength(1);
  time = new Date(time.getTime() + 120_001);
  await worker().tick();
  expect(messages).toHaveLength(2);
  expect(
    f.purged.filter((key) => key.startsWith(`federation-results/${f.imported.id}/`)),
  ).toHaveLength(1);
  const message = messages[1];
  if (message?.payload.case !== "federationResultCopy") throw new Error("Missing retry dispatch");
  const task = JSON.parse(message.payload.value.taskJson);
  const binding = f.bindingFor(task.generation);
  await transport.report(
    f.agentId,
    create(FederationResultCopyReportSchema, {
      generation: task.generation,
      copiedJson: JSON.stringify({
        binding,
        sizeBytes: 3,
        sha256: binding.sha256,
        parts: [{ partNumber: 1, etag: "copied" }],
      }),
    }),
  );
  const verify = messages[2];
  if (verify?.payload.case !== "federationResultVerify")
    throw new Error("Missing verification dispatch");
  const verification = FederationResultVerifyTaskSchema.parse(
    JSON.parse(verify.payload.value.taskJson),
  );
  await transport.report(
    f.agentId,
    create(FederationResultCopyReportSchema, {
      generation: task.generation,
      verifiedJson: JSON.stringify({ ...verification, sizeBytes: 3, sha256: binding.sha256 }),
    }),
  );
  await worker().tick();
  const result = await f.imports.get(actor, f.imported.id);
  expect(result.state).toBe("available");
  expect(result.receipt?.state).toBe("pending");
  expect(result.members[0]?.fileId).toBe(f.member.id);
  expect(messages).toHaveLength(3);
  const stopped = worker();
  await stopped.stop();
  await stopped.tick();
  expect(messages).toHaveLength(3);
});

test("result receipts explicitly re-sign after key rotation without changing the publication fact", async () => {
  const f = await receiptFixture();
  await f
    .sender(async () => {
      throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
    })
    .deliverNext();
  const original = await f.state();
  const rotated = await testKeys(a.signing.siteId);
  rotated.signing.keyId = `receipt-${crypto.randomUUID()}`;
  await trust.addKey(
    a.signing.siteId,
    {
      keyId: rotated.signing.keyId,
      publicKeyPem: await exportSPKI(rotated.verification.publicKey),
      allowedKinds: ["result-receipt"],
      validFrom: a.verification.validFrom.toISOString(),
      validUntil: a.verification.validUntil.toISOString(),
    },
    actor.userId,
  );
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: clock() })
    .where(
      and(
        eq(federationSigningKeys.siteId, a.signing.siteId),
        eq(federationSigningKeys.keyId, a.signing.keyId),
      ),
    );
  try {
    const app = new Hono();
    let principal = receiver;
    app.use("*", async (c, next) => {
      c.set("principal" as never, principal as never);
      await next();
    });
    app.route("/api", createFederationOutboundRoutes(f.service(f.send)));
    const path = `/api/federation/outbound/${f.request.operationId}/result-imports/${f.imported.id}/receipt-retry`;
    expect((await app.request(path, { method: "POST" })).status).toBe(403);
    principal = actor;
    expect((await app.request(path, { method: "POST" })).status).toBe(202);
    expect((await f.state()).receiptJws).toBeNull();
    const sender = new FederationResultReceiptSender(
      db,
      rotated.signing,
      (_endpoint, jws) => f.receiver.receive(jws, sourceFingerprint),
      clock,
    );
    expect(await sender.deliverNext()).toBe(true);
    const current = await f.state();
    expect(current.receipt).toEqual(original.receipt);
    expect(current.receiptJws).not.toBe(original.receiptJws);
    expect(current.receiptAck).not.toBeNull();
    expect(await f.publishedFiles()).toHaveLength(1);
  } finally {
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: null })
      .where(
        and(
          eq(federationSigningKeys.siteId, a.signing.siteId),
          eq(federationSigningKeys.keyId, a.signing.keyId),
        ),
      );
  }
});

test("result receipts re-sign a stored peer acknowledgement after receiver key rotation", async () => {
  const f = await receiptFixture();
  await f
    .sender(async (_endpoint, jws) => {
      await f.receiver.receive(jws, sourceFingerprint);
      throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
    })
    .deliverNext();
  const [old] = await db
    .select()
    .from(federationResultReceipts)
    .where(eq(federationResultReceipts.receiptId, f.imported.id));
  if (!old) throw new Error("Missing receiver record");
  const rotated = await testKeys(b.signing.siteId);
  rotated.signing.keyId = `receipt-ack-${crypto.randomUUID()}`;
  await trust.addKey(
    b.signing.siteId,
    {
      keyId: rotated.signing.keyId,
      publicKeyPem: await exportSPKI(rotated.verification.publicKey),
      allowedKinds: ["result-receipt-ack"],
      validFrom: b.verification.validFrom.toISOString(),
      validUntil: b.verification.validUntil.toISOString(),
    },
    actor.userId,
  );
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: clock() })
    .where(
      and(
        eq(federationSigningKeys.siteId, b.signing.siteId),
        eq(federationSigningKeys.keyId, b.signing.keyId),
      ),
    );
  try {
    const receiver = new FederationResultReceiptReceiver(db, rotated.signing, clock);
    time = new Date(time.getTime() + 30_001);
    await f.sender((_endpoint, jws) => receiver.receive(jws, sourceFingerprint)).deliverNext();
    const current = await f.state();
    expect(current.receiptAck).toEqual(old.acknowledgement);
    expect(current.receiptAckJws).not.toBe(old.acknowledgementJws);
    expect(current.receiptLastError).toBeNull();
    const records = await db
      .select()
      .from(federationResultReceipts)
      .where(eq(federationResultReceipts.receiptId, f.imported.id));
    expect(records).toHaveLength(1);
  } finally {
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: null })
      .where(
        and(
          eq(federationSigningKeys.siteId, b.signing.siteId),
          eq(federationSigningKeys.keyId, b.signing.keyId),
        ),
      );
  }
});

async function statusSyncFixture() {
  // Other fixtures share this isolated database; only this operation is due for polling.
  await db.update(federationOutbound).set({ statusNextAttemptAt: null });
  const f = await resultFixture();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  const responder = new FederationStatusResponder(db, b.signing, clock);
  const send: FederationSend = (endpoint, jws, path) =>
    path === "/federation/v1/status"
      ? responder.receive(jws, sourceFingerprint)
      : f.receive(endpoint, jws, path);
  return { ...f, send };
}

test("status sync worker persists signed observations, retains them offline and resumes after reconstruction", async () => {
  const f = await statusSyncFixture();
  const worker = new FederationOutboundWorker(f.service(f.send));
  await worker.tick();
  await worker.stop();
  const first = await row(f.request.operationId);
  expect(first.statusReport?.workflow?.status).toBe("running");
  expect(first.statusVerifiedAt).toEqual(clock());
  expect(first.statusClaim).toBeNull();
  expect(first.statusReportJws).toBeString();
  expect(await f.service(f.send).refreshStatusNext()).toBe(false);
  const listed = (await f.service().list(actor)).find(
    (v) => v.operationId === f.request.operationId,
  );
  expect(listed?.remoteStatus).toMatchObject({ workflow: { status: "running" }, lastError: null });
  expect(JSON.stringify(listed?.remoteStatus)).not.toContain(first.statusReportJws ?? "missing");
  expect(JSON.stringify(listed?.remoteStatus)).not.toContain(executionUserId);
  expect(await f.service().list(receiver)).toHaveLength(0);
  time = new Date(time.getTime() + 30_000);
  await f
    .service(async () => {
      throw new Error("private-storage-secret");
    })
    .refreshStatusNext();
  const offline = await row(f.request.operationId);
  expect(offline).toMatchObject({
    state: "accepted",
    amount: first.amount,
    statusLastError: "DELIVERY_UNAVAILABLE",
  });
  expect(offline.statusReport).toEqual(first.statusReport);
  expect(offline.statusReportJws).toBe(first.statusReportJws);
  expect(offline.statusVerifiedAt).toEqual(first.statusVerifiedAt);
  time = new Date(time.getTime() + 30_000);
  await f.service(f.send).refreshStatusNext();
  const resumed = await row(f.request.operationId);
  expect(resumed.statusLastError).toBeNull();
  expect(resumed.statusVerifiedAt).toEqual(clock());
  expect(resumed.statusReport?.queryId).not.toBe(first.statusReport?.queryId);
});

test("status sync fences late successes and failures from an expired claim", async () => {
  for (const fail of [false, true]) {
    const f = await statusSyncFixture();
    let release!: () => void, signal!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const slow = f.service(async (endpoint, jws, path) => {
      const report = await f.send(endpoint, jws, path);
      signal();
      await waiting;
      if (fail) throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
      return report;
    });
    const old = slow.refreshStatusNext();
    let latest: Awaited<ReturnType<typeof row>>;
    try {
      await started;
      expect(await f.service(f.send).refreshStatusNext()).toBe(false);
      time = new Date(time.getTime() + 30_001);
      await db
        .update(workflowRuns)
        .set({ status: "completed" })
        .where(eq(workflowRuns.id, f.runId));
      expect(await f.service(f.send).refreshStatusNext()).toBe(true);
      latest = await row(f.request.operationId);
      expect(latest.statusReport?.workflow?.status).toBe("completed");
      expect(latest.statusNextAttemptAt).toBeNull();
    } finally {
      release();
      await old;
    }
    expect(await row(f.request.operationId)).toEqual(latest);
  }
});

test("status sync stops only for signed terminal workflows and recovers an abandoned claim", async () => {
  const f = await statusSyncFixture();
  for (const status of [
    "submitted",
    "queued",
    "awaiting_approval",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ] as const) {
    await db.update(workflowRuns).set({ status }).where(eq(workflowRuns.id, f.runId));
    await db
      .update(federationOutbound)
      .set({ statusNextAttemptAt: clock(), statusClaim: crypto.randomUUID() })
      .where(eq(federationOutbound.operationId, f.request.operationId));
    await f.service(f.send).refreshStatusNext();
    const saved = await row(f.request.operationId);
    expect(saved.statusReport?.workflow?.status).toBe(status);
    expect(saved.statusClaim).toBeNull();
    expect(saved.statusNextAttemptAt === null).toBe(
      ["completed", "failed", "cancelled"].includes(status),
    );
    expect(await f.service(f.send).refreshStatusNext()).toBe(false);
  }
  // No bound Workflow, even with waiting/blocked preparation, is not a terminal result.
  if (!f.saved.receipt) throw new Error("Expected receipt");
  const reservationId = f.saved.receipt.reservationId;
  await db
    .delete(federationWorkflowBindings)
    .where(eq(federationWorkflowBindings.workflowRunId, f.runId));
  for (const state of [null, "waiting", "blocked", "resolved"] as const) {
    if (state) {
      const blocker = state === "resolved" ? null : "DATA_WAITING";
      await db
        .insert(federationPreparations)
        .values({ reservationId, state, blocker })
        .onConflictDoUpdate({
          target: federationPreparations.reservationId,
          set: { state, blocker },
        });
    }
    await db
      .update(federationOutbound)
      .set({ statusNextAttemptAt: clock() })
      .where(eq(federationOutbound.operationId, f.request.operationId));
    await f.service(f.send).refreshStatusNext();
    const saved = await row(f.request.operationId);
    expect(saved.statusReport?.workflow).toBeNull();
    expect(saved.statusNextAttemptAt).not.toBeNull();
    expect(saved.statusLastError).toBeNull();
  }
});

test("status sync rejects invalid reports and authority revoked during I/O without replacing trusted state", async () => {
  const f = await statusSyncFixture();
  await f.service(f.send).refreshStatusNext();
  const first = await row(f.request.operationId);
  const revoked = f.service(async (endpoint, jws, path) => {
    const response = await f.send(endpoint, jws, path);
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: false },
      actor.userId,
    );
    return response;
  });
  try {
    time = new Date(time.getTime() + 30_000);
    await revoked.refreshStatusNext();
    const denied = await row(f.request.operationId);
    expect(denied.statusLastError).toBe("POLICY_DENIED");
    expect(denied.statusReport).toEqual(first.statusReport);
    expect(denied.statusVerifiedAt).toEqual(first.statusVerifiedAt);
  } finally {
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: true },
      actor.userId,
    );
  }
  time = new Date(time.getTime() + 30_000);
  await f.service(async () => "forged").refreshStatusNext();
  expect(await row(f.request.operationId)).toMatchObject({
    state: "accepted",
    statusLastError: "INVALID_MESSAGE",
    statusReport: first.statusReport,
  });
  time = new Date(time.getTime() + 30_000);
  const expired = f.service(async (endpoint, jws, path) => {
    const response = await f.send(endpoint, jws, path);
    time = new Date(time.getTime() + 60_000);
    return response;
  });
  await expired.refreshStatusNext();
  const saved = await row(f.request.operationId);
  expect(saved.statusLastError).toBe("AUTHORIZATION_EXPIRED");
  expect(saved.statusVerifiedAt).toEqual(first.statusVerifiedAt);
  expect(saved.statusReportJws).toBe(first.statusReportJws);
});

test("status sync leaves unknown state on first failure and rejects revoked peer keys", async () => {
  const f = await statusSyncFixture();
  await f.service(async () => "forged").refreshStatusNext();
  const unknown = await row(f.request.operationId);
  expect(unknown).toMatchObject({
    state: "accepted",
    statusReport: null,
    statusReportJws: null,
    statusVerifiedAt: null,
    statusLastError: "INVALID_MESSAGE",
  });
  time = new Date(time.getTime() + 30_000);
  await f.service(f.send).refreshStatusNext();
  const first = await row(f.request.operationId);
  time = new Date(time.getTime() + 30_000);
  const peerKey = and(
    eq(federationSigningKeys.siteId, b.signing.siteId),
    eq(federationSigningKeys.keyId, b.signing.keyId),
  );
  try {
    await f
      .service(async (endpoint, jws, path) => {
        const response = await f.send(endpoint, jws, path);
        await db.update(federationSigningKeys).set({ revokedAt: clock() }).where(peerKey);
        return response;
      })
      .refreshStatusNext();
    const saved = await row(f.request.operationId);
    expect(saved.statusLastError).toBe("UNTRUSTED_IDENTITY");
    expect(saved.statusReport).toEqual(first.statusReport);
    expect(saved.statusVerifiedAt).toEqual(first.statusVerifiedAt);
  } finally {
    await db.update(federationSigningKeys).set({ revokedAt: null }).where(peerKey);
  }
});

async function materialExchangeFixture(parameters: Record<string, string | number> = {}) {
  const f = await fixture(undefined, parameters);
  await db.delete(federationMaterials).where(eq(federationMaterials.localOrgId, receiver.orgId));
  const source = f.service();
  await source.enqueue(actor, f.request);
  await source.deliverNext();
  const saved = await row(f.request.operationId);
  if (!saved.receipt) throw new Error("Expected receipt");
  const preparation = new FederationPreparationService(db, b.signing.siteId, assets, clock);
  const calls: string[] = [];
  const ingress = createFederationIngress(db, a.signing, undefined, source);
  const send: FederationSend = async (_endpoint, jws, path) => {
    if (path !== "/federation/v1/materials") throw new Error("Expected material route");
    calls.push(jws);
    const response = await ingress.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/jose",
        "x-kq-federation-cert": targetFingerprint,
      },
      body: jws,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (response.status !== 200)
      throw new Error(`Material response ${response.status}: ${await response.text()}`);
    return response.text();
  };
  const exchange = (sender: FederationSend = send) =>
    new FederationMaterialExchange(db, b.signing, sender, preparation, assets, clock);
  return {
    ...f,
    source,
    preparation,
    exchange,
    calls,
    send,
    reservationId: saved.receipt.reservationId,
    saved,
  };
}

async function receivedMaterials() {
  return db
    .select()
    .from(federationMaterials)
    .where(eq(federationMaterials.localOrgId, receiver.orgId));
}

test("material exchange worker retrieves large unicode manifests atomically and reuses their digests", async () => {
  const parameters = { message: "参数测试".repeat(48_000), count: 3 };
  const f = await materialExchangeFixture(parameters);
  const resolved = await assets.resolveForDelegation(actor, f.reference);
  if (!resolved.mapping.softwareRevisionId) throw new Error("Expected revision");
  await assets.register(receiver, {
    reference: f.reference,
    localRevisionId: resolved.mapping.softwareRevisionId,
  });
  const exchange = f.exchange();
  // Other tests leave reservations at this shared site; only this fixture owns its transport.
  const worker = new FederationPreparationWorker(
    db,
    f.preparation,
    undefined,
    undefined,
    async (id) => {
      if (id === f.reservationId) await exchange.ensure(id);
    },
  );
  await worker.tick();
  await worker.stop();
  expect(f.calls.length).toBeGreaterThan(8);
  const stored = await assets.getMaterial(
    receiver,
    a.signing.siteId,
    f.request.inputManifestDigest,
  );
  expect(stored).toMatchObject({ kind: "inputs", parameters });
  expect(
    (await receivedMaterials()).filter((material) =>
      [f.request.inputManifestDigest, f.request.environmentLockDigest].includes(material.digest),
    ),
  ).toHaveLength(2);
  expect(await f.preparation.prepare(f.reservationId)).toMatchObject({ state: "resolved" });
  const callCount = f.calls.length;
  await Promise.all([f.exchange().ensure(f.reservationId), f.exchange().ensure(f.reservationId)]);
  expect(f.calls.length).toBe(callCount);
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.orgId, receiver.orgId), eq(auditLog.action, "federation.material.receive")),
    );
  expect(
    audits.filter(
      (v) => (v.diff?.after as { operationId?: string })?.operationId === f.request.operationId,
    ),
  ).toHaveLength(2);
}, 20_000);

test("material exchange interruption stores no partial manifests and restart requires original mappings", async () => {
  const f = await materialExchangeFixture({ message: "a".repeat(90_000) });
  let count = 0;
  await expect(
    f
      .exchange(async (endpoint, jws, path) => {
        if (++count === 2) throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
        return f.send(endpoint, jws, path);
      })
      .ensure(f.reservationId),
  ).rejects.toThrow("DATA_WAITING");
  expect(await receivedMaterials()).toHaveLength(0);
  await Promise.all([f.exchange().ensure(f.reservationId), f.exchange().ensure(f.reservationId)]);
  expect(await receivedMaterials()).toHaveLength(2);
  // Receiving manifests does not create asset mappings or authorize execution.
  expect(await f.preparation.prepare(f.reservationId)).toMatchObject({
    state: "waiting",
    blocker: "ASSET_UNAVAILABLE",
  });
});

test("material exchange rejects wrong peer, task and unselected digest before disclosure", async () => {
  const f = await materialExchangeFixture();
  await f.exchange().ensure(f.reservationId);
  const jws = f.calls[0];
  if (!jws) throw new Error("Expected query");
  await expect(f.source.materialChunk(jws, sourceFingerprint)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  const key = await trust.resolveKey(b.signing.siteId, b.signing.keyId, clock());
  const { payload } = await verifyFederationMessage(
    FederationMaterialQuerySchema,
    jws,
    key,
    clock(),
  );
  for (const change of [
    { taskId: crypto.randomUUID() },
    { reservationId: crypto.randomUUID() },
    { materialDigest: `sha256:${"f".repeat(64)}` },
    { requestDigest: `sha256:${"e".repeat(64)}` },
  ]) {
    const altered = await signFederationMessage(
      FederationMaterialQuerySchema,
      { ...payload, ...change },
      b.signing,
    );
    await expect(f.source.materialChunk(altered, targetFingerprint)).rejects.toThrow(
      "POLICY_DENIED",
    );
  }
  await f.source.cancellations.request(actor, f.request.operationId);
  await expect(f.source.materialChunk(jws, targetFingerprint)).rejects.toThrow("POLICY_DENIED");
  time = new Date(time.getTime() + 60_000);
  await expect(f.source.materialChunk(jws, targetFingerprint)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
});

test("material exchange rejects signed corrupt, reordered, replayed and oversized chunks", async () => {
  const f = await materialExchangeFixture({ message: "a".repeat(90_000) });
  const key = await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock());
  for (const change of ["corrupt", "offset", "total", "replay"]) {
    let first = "";
    await expect(
      f
        .exchange(async (endpoint, jws, path) => {
          const response = await f.send(endpoint, jws, path);
          if (change === "replay") {
            if (first) return first;
            first = response;
            return response;
          }
          const { payload } = await verifyFederationMessage(
            FederationMaterialChunkSchema,
            response,
            key,
            clock(),
          );
          const bytes = Buffer.from(payload.bytes, "base64");
          bytes[0] = (bytes[0] ?? 0) ^ 1;
          return signFederationMessage(
            FederationMaterialChunkSchema,
            {
              ...payload,
              ...(change === "corrupt"
                ? { bytes: bytes.toString("base64") }
                : change === "offset"
                  ? { offset: 65_536 }
                  : { totalBytes: payload.totalBytes - 1 }),
            },
            a.signing,
          );
        })
        .ensure(f.reservationId),
    ).rejects.toThrow("INVALID_MESSAGE");
    expect(await receivedMaterials()).toHaveLength(0);
  }
});

test("material exchange rechecks receiver and source authority after network I/O", async () => {
  const f = await materialExchangeFixture();
  await expect(
    f
      .exchange(async (endpoint, jws, path) => {
        const response = await f.send(endpoint, jws, path);
        await db
          .update(federationAgreements)
          .set({ state: "revoked" })
          .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
        return response;
      })
      .ensure(f.reservationId),
  ).rejects.toThrow("AGREEMENT_UNAVAILABLE");
  expect(await receivedMaterials()).toHaveLength(0);
  await db
    .update(federationAgreements)
    .set({ state: "active" })
    .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
  await permission.set({ ...actor, capability: "delegation.submit", enabled: false }, actor.userId);
  try {
    await expect(
      f
        .exchange((_endpoint, jws) => f.source.materialChunk(jws, targetFingerprint))
        .ensure(f.reservationId),
    ).rejects.toThrow("POLICY_DENIED");
    expect(await receivedMaterials()).toHaveLength(0);
  } finally {
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: true },
      actor.userId,
    );
  }
  time = new Date(f.request.expiresAt);
  await expect(f.exchange().ensure(f.reservationId)).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("material exchange supports the exact one MiB limit and requires separate signing purposes", async () => {
  const base = {
    protocolVersion: 1,
    kind: "inputs",
    parameters: { message: "" },
    datasets: [],
    bindings: [],
  };
  const message = "a".repeat(1_048_576 - Buffer.byteLength(federationCanonicalJson(base)));
  const f = await materialExchangeFixture({ message });
  for (const [siteId, keyId, kind] of [
    [a.signing.siteId, a.signing.keyId, "material-chunk"],
    [b.signing.siteId, b.signing.keyId, "material-query"],
  ]) {
    if (!siteId || !keyId) throw new Error("Expected key");
    const condition = and(
      eq(federationSigningKeys.siteId, siteId),
      eq(federationSigningKeys.keyId, keyId),
    );
    const [key] = await db.select().from(federationSigningKeys).where(condition);
    if (!key) throw new Error("Expected key");
    try {
      await db
        .update(federationSigningKeys)
        .set({ allowedKinds: key.allowedKinds.filter((value) => value !== kind) })
        .where(condition);
      await expect(
        f
          .exchange((_endpoint, jws) => f.source.materialChunk(jws, targetFingerprint))
          .ensure(f.reservationId),
      ).rejects.toThrow("UNTRUSTED_IDENTITY");
      expect(await receivedMaterials()).toHaveLength(0);
    } finally {
      await db
        .update(federationSigningKeys)
        .set({ allowedKinds: key.allowedKinds })
        .where(condition);
    }
  }
  await f.exchange().ensure(f.reservationId);
  expect(f.calls).toHaveLength(17);
  const stored = (await receivedMaterials()).find(
    (value) => value.digest === f.request.inputManifestDigest,
  );
  expect(Buffer.byteLength(stored?.content ?? "")).toBe(1_048_576);
  const first = f.calls[0];
  if (!first) throw new Error("Expected query");
  const chunkJws = await f.source.materialChunk(first, targetFingerprint);
  const key = await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock());
  const { payload } = await verifyFederationMessage(
    FederationMaterialChunkSchema,
    chunkJws,
    key,
    clock(),
  );
  expect(
    FederationMaterialChunkSchema.safeParse({ ...payload, totalBytes: 1_048_577 }).success,
  ).toBe(false);
}, 20_000);

const inputPolicy: NonNullable<FederationAgreement["inputPolicy"]> = {
  scope: "workflow-input-files",
  maxFiles: 4,
  maxBytes: 16,
};
async function inputInventoryFixture(
  policy: FederationAgreement["inputPolicy"] | null = inputPolicy,
  longExecution = false,
  batch = false,
) {
  const f = await workflowDelegationFixture(undefined, {}, policy ?? undefined, {
    input: { type: batch ? "FileBatch" : "File", required: true },
  });
  const fileId = crypto.randomUUID();
  sourceInputFileIds.push(fileId);
  await db.insert(netdriveFiles).values({
    id: fileId,
    ownerId: actor.userId,
    path: "private/source.dat",
    size: 4,
    sha256: "a".repeat(64),
    storageKey: `netdrive/objects/${crypto.randomUUID()}`,
    storageVersionId: "original-version",
  });
  const files = [{ descriptor: "input", type: "File", files: [{ fileId, path: "input.dat" }] }];
  const source = f.service();
  const enqueue = (invocation = f.invocation) =>
    source.enqueueForWorkflow(
      actor,
      f.lease,
      "remote",
      invocation,
      longExecution ? { ...f.plan, executionExpiresAt: f.terms.validUntil } : f.plan,
      60,
      {},
      files,
    );
  return { ...f, fileId, files, source, enqueue };
}
async function acceptedInputInventory(longExecution = false, batch = false) {
  const f = await inputInventoryFixture(inputPolicy, longExecution, batch);
  if (batch)
    f.files.splice(0, 1, {
      descriptor: "input",
      type: "FileBatch",
      files: [
        { fileId: f.fileId, path: "first.dat" },
        { fileId: f.fileId, path: "second.dat" },
      ],
    });
  const operation = await f.enqueue();
  await f.source.deliverNext();
  const saved = await row(operation.operationId);
  if (!saved.receipt || !saved.request.inputFilesDigest)
    throw new Error("Missing input acceptance");
  const query = FederationMaterialQuerySchema.parse({
    protocolVersion: 1,
    kind: "material-query",
    queryId: crypto.randomUUID(),
    senderSiteId: b.signing.siteId,
    recipientSiteId: a.signing.siteId,
    operationId: saved.operationId,
    agreementRevisionId: saved.agreementRevisionId,
    taskId: saved.taskId,
    attempt: saved.attempt,
    reservationId: saved.receipt.reservationId,
    requestDigest: saved.requestDigest,
    materialDigest: saved.request.inputFilesDigest,
    offset: 0,
    issuedAt: clock().toISOString(),
    expiresAt: new Date(clock().getTime() + 30_000).toISOString(),
  });
  const jws = await signFederationMessage(FederationMaterialQuerySchema, query, b.signing);
  return { ...f, saved, query, jws, reservationId: saved.receipt.reservationId };
}

test("input inventory is signed and invocation-bound, and receiver waits for actual managed copies", async () => {
  const f = await acceptedInputInventory();
  try {
    const query = await verifyFederationMessage(
      FederationMaterialQuerySchema,
      f.jws,
      await trust.resolveKey(b.signing.siteId, b.signing.keyId, clock()),
      clock(),
    );
    const chunk = await verifyFederationMessage(
      FederationMaterialChunkSchema,
      await f.source.materialChunk(f.jws, targetFingerprint),
      await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock()),
      clock(),
    );
    expect(chunk.payload.queryDigest).toBe(query.digest);
    const portable = JSON.parse(Buffer.from(chunk.payload.bytes, "base64").toString("utf8"));
    expect(federationMaterialDigest(portable)).toBe(f.query.materialDigest);
    expect(portable.inputs).toEqual([
      {
        descriptor: "input",
        type: "File",
        files: [{ path: "input.dat", sha256: "a".repeat(64), sizeBytes: 4 }],
      },
    ]);
    for (const privateValue of [f.fileId, "private/", "original-version", actor.userId])
      expect(JSON.stringify(portable)).not.toContain(privateValue);
    expect((await f.enqueue()).operationId).toBe(f.saved.operationId);
    const prep = new FederationPreparationService(db, b.signing.siteId, assets, clock);
    expect(await prep.prepare(f.reservationId)).toMatchObject({
      state: "waiting",
      blocker: "DATA_WAITING",
    });
    await expect(prep.executionSnapshot(f.reservationId)).rejects.toThrow("DATA_WAITING");
    expect(
      await db
        .select()
        .from(federationWorkflowBindings)
        .where(eq(federationWorkflowBindings.reservationId, f.reservationId)),
    ).toHaveLength(0);
    await db
      .update(federationWorkflowInputExports)
      .set({ nodeId: "different" })
      .where(eq(federationWorkflowInputExports.runId, f.runId));
    await expect(f.source.materialChunk(f.jws, targetFingerprint)).rejects.toThrow("POLICY_DENIED");
  } finally {
    await f.lease.release();
  }
});

test("input inventory requires bilateral consent and signed size limits before outbox creation", async () => {
  for (const policy of [null, { ...inputPolicy, maxBytes: 3 }, { ...inputPolicy, maxFiles: 1 }]) {
    const f = await inputInventoryFixture(policy);
    try {
      const selected =
        policy?.maxFiles === 1
          ? [
              {
                ...f.files[0],
                type: "FileBatch",
                files: [
                  { fileId: f.fileId, path: "a" },
                  { fileId: f.fileId, path: "b" },
                ],
              },
            ]
          : f.files;
      await expect(
        f.source.enqueueForWorkflow(
          actor,
          f.lease,
          "remote",
          f.invocation,
          f.plan,
          60,
          {},
          selected,
        ),
      ).rejects.toThrow("POLICY_DENIED");
      const [binding] = await db
        .select()
        .from(workflowExecutionDelegations)
        .where(eq(workflowExecutionDelegations.runId, f.runId));
      if (!binding) throw new Error("Missing durable intent");
      expect(
        await db
          .select()
          .from(federationOutbound)
          .where(eq(federationOutbound.operationId, binding.operationId)),
      ).toHaveLength(0);
    } finally {
      await f.lease.release();
    }
  }
});

test("input inventory disclosure rechecks task, file versions, ownership, cancellation and current authority", async () => {
  const f = await acceptedInputInventory();
  try {
    await expect(f.source.materialChunk(f.jws, sourceFingerprint)).rejects.toThrow(
      "UNTRUSTED_IDENTITY",
    );
    for (const change of [
      { taskId: crypto.randomUUID() },
      { materialDigest: `sha256:${"f".repeat(64)}` },
      { reservationId: crypto.randomUUID() },
    ]) {
      const wrong = await signFederationMessage(
        FederationMaterialQuerySchema,
        { ...f.query, ...change },
        b.signing,
      );
      await expect(f.source.materialChunk(wrong, targetFingerprint)).rejects.toThrow(
        "POLICY_DENIED",
      );
    }
    for (const change of [
      { storageVersionId: "replaced" },
      { deletedAt: new Date() },
      { ownerId: receiver.userId },
    ]) {
      await db.update(netdriveFiles).set(change).where(eq(netdriveFiles.id, f.fileId));
      await expect(f.source.materialChunk(f.jws, targetFingerprint)).rejects.toThrow();
      await db
        .update(netdriveFiles)
        .set({ storageVersionId: "original-version", deletedAt: null, ownerId: actor.userId })
        .where(eq(netdriveFiles.id, f.fileId));
    }
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: false },
      actor.userId,
    );
    try {
      await expect(f.source.materialChunk(f.jws, targetFingerprint)).rejects.toThrow(
        "POLICY_DENIED",
      );
    } finally {
      await permission.set(
        { ...actor, capability: "delegation.submit", enabled: true },
        actor.userId,
      );
    }
    await f.registry.requestCancel(f.runId);
    await expect(f.source.materialChunk(f.jws, targetFingerprint)).rejects.toThrow(
      "CANCELLATION_REQUESTED",
    );
  } finally {
    await f.lease.release();
  }
});

test("input inventory cannot be borrowed from a different invocation or an unbound API request", async () => {
  const f = await inputInventoryFixture();
  try {
    const accepted = await f.enqueue();
    const saved = await row(accepted.operationId);
    const digest = saved.request.inputFilesDigest;
    if (!digest) throw new Error("Missing file digest");
    await expect(
      f.source.enqueue(actor, {
        ...f.request,
        operationId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        inputFilesDigest: digest,
      }),
    ).rejects.toThrow("POLICY_DENIED");
    await expect(
      f.source.enqueueForWorkflow(
        actor,
        f.lease,
        "remote",
        { path: "another-invocation" },
        { ...f.plan, inputFilesDigest: digest },
        60,
      ),
    ).rejects.toThrow("POLICY_DENIED");
    await expect(
      f.source.enqueueForWorkflow(
        actor,
        f.lease,
        "remote",
        f.invocation,
        { ...f.plan, inputFilesDigest: `sha256:${"f".repeat(64)}` },
        60,
        {},
        f.files,
      ),
    ).rejects.toThrow("OPERATION_CONFLICT");
    expect(
      await db
        .select()
        .from(federationOutbound)
        .where(eq(federationOutbound.agreementRevisionId, f.terms.agreementRevisionId)),
    ).toHaveLength(1);
  } finally {
    await f.lease.release();
  }
});

function inputDownloadStorage() {
  const calls: Array<{ key: string; seconds?: number; version?: string }> = [];
  const downloads: FederationDownloadStorage = {
    allowedOrigins: ["https://storage.test.invalid"],
    storage: {
      head: async (key, version) => {
        calls.push({ key, version });
        return {
          size: 4,
          etag: "input-etag",
          versionId: "original-version",
          contentType: "application/octet-stream",
          lastModified: clock(),
        };
      },
      presignDownload: async (key, seconds, _name, version) => {
        calls.push({ key, seconds, version });
        const url = new URL(`https://storage.test.invalid/${key}`);
        url.searchParams.set("versionId", version ?? "");
        url.searchParams.set(
          "X-Amz-Date",
          clock()
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(/\.\d{3}/, ""),
        );
        url.searchParams.set("X-Amz-Expires", String(seconds));
        url.searchParams.set("X-Amz-Signature", "private-input-ticket");
        return url.toString();
      },
    },
  };
  return { calls, downloads };
}

async function inputDownloadFixture() {
  const f = await acceptedInputInventory();
  const { kind: _kind, materialDigest, offset: _offset, ...identity } = f.query;
  const query = FederationInputDownloadQuerySchema.parse({
    ...identity,
    kind: "input-download-query",
    binding: {
      transferId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      operationId: f.saved.operationId,
      manifestDigest: materialDigest,
      descriptor: "input",
      path: "input.dat",
      sha256: "a".repeat(64),
      sizeBytes: 4,
    },
  });
  const jws = await signFederationMessage(FederationInputDownloadQuerySchema, query, b.signing);
  const { calls, downloads } = inputDownloadStorage();
  const read = async () =>
    (
      await verifyFederationMessage(
        FederationInputDownloadGrantSchema,
        await f.source.inputDownload(jws, targetFingerprint, downloads),
        await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock()),
        clock(),
      )
    ).payload;
  return { ...f, query, jws, calls, downloads, read };
}

test("input downloads bind signed grants to an exact private file version through the isolated ingress", async () => {
  const f = await inputDownloadFixture();
  try {
    const ingress = createFederationIngress(db, a.signing, undefined, f.source, f.downloads);
    const response = await ingress.request("/federation/v1/input-downloads", {
      method: "POST",
      headers: { "content-type": "application/jose", "x-kq-federation-cert": targetFingerprint },
      body: f.jws,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const grant = (
      await verifyFederationMessage(
        FederationInputDownloadGrantSchema,
        await response.text(),
        await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock()),
        clock(),
      )
    ).payload;
    expect(grant.binding).toEqual(f.query.binding);
    expect(grant.queryDigest).toBe(
      (
        await verifyFederationMessage(
          FederationInputDownloadQuerySchema,
          f.jws,
          await trust.resolveKey(b.signing.siteId, b.signing.keyId, clock()),
          clock(),
        )
      ).digest,
    );
    expect(grant.expiresAt).toBe(f.query.expiresAt);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map((call) => call.version)).toEqual(["original-version", "original-version"]);
    expect(f.calls[1]?.seconds).toBe(30);
    expect(f.calls[0]?.key).toMatch(/^netdrive\/objects\//);
    for (const secret of [actor.userId, f.fileId, "private/source.dat"])
      expect(JSON.stringify(grant)).not.toContain(secret);
    expect(
      JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, actor.orgId))),
    ).not.toContain("private-input-ticket");
    const disabled = createFederationIngress(db, a.signing, f.downloads, f.source);
    expect(
      (
        await disabled.request("/federation/v1/input-downloads", {
          method: "POST",
          headers: { "content-type": "application/jose" },
          body: f.jws,
        })
      ).status,
    ).toBe(409);
  } finally {
    await f.lease.release();
  }
});

test("input downloads reject unselected members, wrong tasks, expired queries and legacy identifying keys", async () => {
  const f = await inputDownloadFixture();
  try {
    for (const binding of [
      { ...f.query.binding, descriptor: "other" },
      { ...f.query.binding, path: "other.dat" },
      { ...f.query.binding, sizeBytes: 5 },
      { ...f.query.binding, sha256: "b".repeat(64) },
      { ...f.query.binding, manifestDigest: f.saved.request.environmentLockDigest },
    ]) {
      const jws = await signFederationMessage(
        FederationInputDownloadQuerySchema,
        { ...f.query, binding },
        b.signing,
      );
      await expect(f.source.inputDownload(jws, targetFingerprint, f.downloads)).rejects.toThrow(
        "OPERATION_CONFLICT",
      );
    }
    const wrongTask = await signFederationMessage(
      FederationInputDownloadQuerySchema,
      { ...f.query, taskId: crypto.randomUUID() },
      b.signing,
    );
    await expect(f.source.inputDownload(wrongTask, targetFingerprint, f.downloads)).rejects.toThrow(
      "POLICY_DENIED",
    );
    await expect(f.source.inputDownload(f.jws, sourceFingerprint, f.downloads)).rejects.toThrow(
      "UNTRUSTED_IDENTITY",
    );
    expect(f.calls).toHaveLength(0);
    time = new Date(time.getTime() + 31_000);
    await expect(f.read()).rejects.toThrow("AUTHORIZATION_EXPIRED");
  } finally {
    await f.lease.release();
  }
  const legacy = await inputInventoryFixture();
  try {
    await db
      .update(netdriveFiles)
      .set({ storageKey: `netdrive/${actor.userId}/${crypto.randomUUID()}` })
      .where(eq(netdriveFiles.id, legacy.fileId));
    const operation = await legacy.enqueue();
    await legacy.source.deliverNext();
    const saved = await row(operation.operationId);
    if (!saved.receipt || !saved.request.inputFilesDigest)
      throw new Error("Missing legacy acceptance");
    const jws = await signFederationMessage(
      FederationInputDownloadQuerySchema,
      {
        ...f.query,
        queryId: crypto.randomUUID(),
        operationId: saved.operationId,
        taskId: saved.taskId,
        agreementRevisionId: saved.agreementRevisionId,
        reservationId: saved.receipt.reservationId,
        requestDigest: saved.requestDigest,
        binding: {
          ...f.query.binding,
          operationId: saved.operationId,
          manifestDigest: saved.request.inputFilesDigest,
        },
        issuedAt: clock().toISOString(),
        expiresAt: new Date(clock().getTime() + 30_000).toISOString(),
      },
      b.signing,
    );
    await expect(legacy.source.inputDownload(jws, targetFingerprint, f.downloads)).rejects.toThrow(
      "POLICY_DENIED",
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    await legacy.lease.release();
  }
});

test("input downloads refuse missing storage, substituted versions, untrusted origins and overlong bearer credentials", async () => {
  const f = await inputDownloadFixture();
  try {
    const head = f.downloads.storage.head;
    const presign = f.downloads.storage.presignDownload;
    const original = await head("test", "original-version");
    if (!original) throw new Error("Missing storage fixture");
    for (const stat of [
      null,
      { ...original, size: 5 },
      { ...original, versionId: "different-version" },
    ]) {
      f.downloads.storage.head = async () => stat;
      await expect(f.read()).rejects.toThrow("ASSET_UNAVAILABLE");
    }
    f.downloads.storage.head = head;
    for (const [field, value] of [
      ["X-Amz-Expires", "31"],
      ["versionId", "other"],
      ["host", "elsewhere.test.invalid"],
    ]) {
      f.downloads.storage.presignDownload = async (...args) => {
        const url = new URL(await presign(...args));
        if (field === "host") url.hostname = value ?? "";
        else url.searchParams.set(field ?? "", value ?? "");
        return url.toString();
      };
      await expect(f.read()).rejects.toThrow();
    }
    f.downloads.storage.presignDownload = presign;
    await expect(
      f.source.inputDownload(f.jws, targetFingerprint, { ...f.downloads, allowedOrigins: [] }),
    ).rejects.toThrow("POLICY_DENIED");
    time = new Date(time.getTime() + 25_000);
    expect((await f.read()).expiresAt).toBe(f.query.expiresAt);
    expect(f.calls.at(-1)?.seconds).toBe(5);
  } finally {
    await f.lease.release();
  }
});

test("input downloads recheck current permissions and both signing purposes after storage I/O", async () => {
  const f = await inputDownloadFixture();
  try {
    const presign = f.downloads.storage.presignDownload;
    for (const [siteId, keyId, kind] of [
      [a.signing.siteId, a.signing.keyId, "input-download-grant"],
      [b.signing.siteId, b.signing.keyId, "input-download-query"],
    ] as const) {
      const [key] = await db
        .select()
        .from(federationSigningKeys)
        .where(
          and(eq(federationSigningKeys.siteId, siteId), eq(federationSigningKeys.keyId, keyId)),
        );
      if (!key) throw new Error("Missing signing key");
      f.downloads.storage.presignDownload = async (...args) => {
        const url = await presign(...args);
        await db
          .update(federationSigningKeys)
          .set({ allowedKinds: key.allowedKinds.filter((value) => value !== kind) })
          .where(
            and(eq(federationSigningKeys.siteId, siteId), eq(federationSigningKeys.keyId, keyId)),
          );
        return url;
      };
      try {
        await expect(f.read()).rejects.toThrow("UNTRUSTED_IDENTITY");
      } finally {
        await db
          .update(federationSigningKeys)
          .set({ allowedKinds: key.allowedKinds })
          .where(
            and(eq(federationSigningKeys.siteId, siteId), eq(federationSigningKeys.keyId, keyId)),
          );
      }
    }
    f.downloads.storage.presignDownload = async (...args) => {
      const url = await presign(...args);
      await db
        .update(netdriveFiles)
        .set({ storageVersionId: "replaced-during-signing" })
        .where(eq(netdriveFiles.id, f.fileId));
      return url;
    };
    try {
      await expect(f.read()).rejects.toThrow("OPERATION_CONFLICT");
    } finally {
      await db
        .update(netdriveFiles)
        .set({ storageVersionId: "original-version" })
        .where(eq(netdriveFiles.id, f.fileId));
    }
    f.downloads.storage.presignDownload = async (...args) => {
      const url = await presign(...args);
      await permission.set(
        { ...actor, capability: "delegation.submit", enabled: false },
        actor.userId,
      );
      return url;
    };
    try {
      await expect(f.read()).rejects.toThrow("POLICY_DENIED");
    } finally {
      await permission.set(
        { ...actor, capability: "delegation.submit", enabled: true },
        actor.userId,
      );
    }
    f.downloads.storage.presignDownload = async (...args) => {
      const url = await presign(...args);
      await f.registry.requestCancel(f.runId);
      return url;
    };
    await expect(f.read()).rejects.toThrow("CANCELLATION_REQUESTED");
  } finally {
    await f.lease.release();
  }
});

async function inputImportFixture(longExecution = false, batch = false) {
  const f = await acceptedInputInventory(longExecution, batch);
  const preparation = new FederationPreparationService(db, b.signing.siteId, assets, clock);
  let calls = 0;
  const transport: FederationSend = async (_endpoint, jws, path) => {
    if (path !== "/federation/v1/materials") throw new Error("Expected materials route");
    calls++;
    return f.source.materialChunk(jws, targetFingerprint);
  };
  const exchange = new FederationMaterialExchange(
    db,
    b.signing,
    transport,
    preparation,
    assets,
    clock,
  );
  const imports = new FederationInputImports(db, preparation, exchange, clock);
  const inventory = async () =>
    db
      .select()
      .from(federationInputImports)
      .where(eq(federationInputImports.reservationId, f.reservationId));
  return { ...f, preparation, transport, exchange, imports, inventory, calls: () => calls };
}

test("input imports persist a private task-owned inventory through the preparation worker and recover idempotently", async () => {
  const f = await inputImportFixture();
  try {
    const worker = new FederationPreparationWorker(
      db,
      f.preparation,
      undefined,
      undefined,
      async (id) => {
        if (id !== f.reservationId) return;
        await f.exchange.ensure(id);
        await f.imports.ensure(id);
      },
      () => f.imports.sweep(),
    );
    await worker.tick();
    await worker.stop();
    const [saved] = await f.inventory();
    if (!saved) throw new Error("Missing input import");
    expect(saved).toMatchObject({
      ownerId: executionUserId,
      localOrgId: receiver.orgId,
      manifestDigest: f.saved.request.inputFilesDigest,
      state: "pending",
      reservedBytes: 4,
    });
    for (const privateValue of [
      actor.userId,
      f.fileId,
      "storageKey",
      "versionId",
      "private/source.dat",
    ])
      expect(JSON.stringify(saved.manifest)).not.toContain(privateValue);
    const beforeCalls = f.calls();
    const repeats = await Promise.all([
      f.imports.ensure(f.reservationId),
      new FederationInputImports(db, f.preparation, f.exchange, clock).ensure(f.reservationId),
    ]);
    expect(repeats.map((row) => row?.importId)).toEqual([saved.id, saved.id]);
    expect(f.calls()).toBe(beforeCalls);
    expect(
      (await new StorageQuotaService(db, clock).getSummary(executionUserId)).reservedBytes,
    ).toBe(4);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.target, saved.id), eq(auditLog.action, "federation.input.receive"))),
    ).toHaveLength(1);
    expect(await f.preparation.prepare(f.reservationId)).toMatchObject({
      state: "waiting",
      blocker: "DATA_WAITING",
    });
    expect(
      await db
        .select()
        .from(federationWorkflowBindings)
        .where(eq(federationWorkflowBindings.reservationId, f.reservationId)),
    ).toHaveLength(0);
  } finally {
    await f.lease.release();
  }
});

test("input imports reserve shared cloud quota atomically across concurrent tasks and ordinary uploads", async () => {
  const first = await inputImportFixture(),
    second = await inputImportFixture();
  const quota = new StorageQuotaService(db, clock);
  const before = await quota.getSummary(executionUserId);
  const [policy] = await db
    .insert(storageQuotaPolicies)
    .values({
      scope: "cloud",
      scopeId: "global",
      defaultQuotaBytes: before.usedBytes + (before.reservedBytes ?? 0) + 6,
    })
    .returning();
  if (!policy) throw new Error("Missing quota policy");
  try {
    const results = await Promise.allSettled([
      first.imports.ensure(first.reservationId),
      second.imports.ensure(second.reservationId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("STORAGE_QUOTA_EXCEEDED");
    expect((await quota.getSummary(executionUserId)).reservedBytes).toBe(4);
    await expect(
      quota.assertCloudWriteAllowed(executionUserId, "normal.dat", 3),
    ).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
    expect((await first.inventory()).length + (await second.inventory()).length).toBe(1);
  } finally {
    await db.delete(storageQuotaPolicies).where(eq(storageQuotaPolicies.id, policy.id));
    await first.lease.release();
    await second.lease.release();
  }
});

test("input imports cancel without a bound workflow and release quota before a stopped acknowledgement", async () => {
  const f = await inputImportFixture();
  try {
    await f.imports.ensure(f.reservationId);
    const target = new FederationCancellationReceiver(db, b.signing, clock);
    const source = f.service(async (endpoint, jws, path) =>
      path === "/federation/v1/cancellations"
        ? target.receive(jws, sourceFingerprint)
        : f.receive(endpoint, jws),
    );
    await source.cancellations.request(actor, f.saved.operationId);
    await source.cancellations.deliverNext();
    expect((await readFederationCancellationState(db, f.saved.request)).stopped).toBe(false);
    const monitor = new FederationCancellationMonitor(
      db,
      {
        cancel: async () => {
          throw new Error("No run expected");
        },
      },
      async () => {},
      clock,
    );
    await monitor.tick();
    await monitor.stop();
    expect((await f.inventory())[0]).toMatchObject({
      state: "cancelled",
      reservedBytes: 0,
      lastError: "CANCELLATION_REQUESTED",
    });
    expect((await readFederationCancellationState(db, f.saved.request)).stopped).toBe(true);
    expect(
      (await new StorageQuotaService(db, clock).getSummary(executionUserId)).reservedBytes,
    ).toBe(0);
    await expect(f.imports.ensure(f.reservationId)).rejects.toThrow("CANCELLATION_REQUESTED");
    expect((await row(f.saved.operationId)).state).toBe("accepted");
  } finally {
    await f.lease.release();
  }
});

test("input imports reject corrupted or no-longer-authorized inventory before reserving space", async () => {
  const f = await inputImportFixture();
  try {
    const corrupt = new FederationMaterialExchange(
      db,
      b.signing,
      async (...args) => {
        const jws = await f.transport(...args);
        const key = await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock());
        const { payload } = await verifyFederationMessage(
          FederationMaterialChunkSchema,
          jws,
          key,
          clock(),
        );
        return signFederationMessage(
          FederationMaterialChunkSchema,
          {
            ...payload,
            bytes: Buffer.alloc(Buffer.from(payload.bytes, "base64").length, 97).toString("base64"),
          },
          a.signing,
        );
      },
      f.preparation,
      assets,
      clock,
    );
    await expect(
      new FederationInputImports(db, f.preparation, corrupt, clock).ensure(f.reservationId),
    ).rejects.toThrow("INVALID_MESSAGE");
    const revoked = new FederationMaterialExchange(
      db,
      b.signing,
      async (...args) => {
        const response = await f.transport(...args);
        await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
        return response;
      },
      f.preparation,
      assets,
      clock,
    );
    try {
      await expect(
        new FederationInputImports(db, f.preparation, revoked, clock).ensure(f.reservationId),
      ).rejects.toThrow("POLICY_DENIED");
    } finally {
      await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    }
    expect(await f.inventory()).toHaveLength(0);
    expect(
      (await new StorageQuotaService(db, clock).getSummary(executionUserId)).reservedBytes,
    ).toBe(0);
  } finally {
    await f.lease.release();
  }
});

test("input imports reconcile expiry and revoked execution identity without reopening a cancelled intent", async () => {
  const f = await inputImportFixture();
  try {
    await f.imports.ensure(f.reservationId);
    await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
    try {
      await f.imports.sweep();
    } finally {
      await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    }
    expect((await f.inventory())[0]).toMatchObject({
      state: "cancelled",
      reservedBytes: 0,
      lastError: "POLICY_DENIED",
    });
    await expect(f.imports.ensure(f.reservationId)).rejects.toThrow("CANCELLATION_REQUESTED");
    expect(await f.preparation.prepare(f.reservationId)).toMatchObject({
      state: "blocked",
      blocker: "CANCELLATION_REQUESTED",
    });
  } finally {
    await f.lease.release();
  }
  const expired = await inputImportFixture();
  try {
    await expired.imports.ensure(expired.reservationId);
    time = new Date(time.getTime() + 61_000);
    await expired.imports.sweep();
    expect((await expired.inventory())[0]).toMatchObject({
      state: "cancelled",
      reservedBytes: 0,
      lastError: "AUTHORIZATION_EXPIRED",
    });
  } finally {
    await expired.lease.release();
  }
});

test("input imports preserve quota on temporary authority failure, recover, and reject damaged reservation metadata", async () => {
  const f = await inputImportFixture();
  try {
    await f.imports.ensure(f.reservationId);
    class UnavailablePreparation extends FederationPreparationService {
      override async materialScope(): Promise<never> {
        throw new Error("Temporary backend failure");
      }
    }
    const unavailable = new UnavailablePreparation(db, b.signing.siteId, assets, clock);
    await new FederationInputImports(db, unavailable, f.exchange, clock).sweep();
    expect((await f.inventory())[0]).toMatchObject({
      state: "pending",
      reservedBytes: 4,
      lastError: "AUTHORIZATION_UNAVAILABLE",
    });
    time = new Date(time.getTime() + 31_000);
    await f.imports.sweep();
    expect((await f.inventory())[0]).toMatchObject({
      state: "pending",
      reservedBytes: 4,
      lastError: null,
    });
    await db
      .update(federationInputImports)
      .set({ reservedBytes: 0 })
      .where(eq(federationInputImports.reservationId, f.reservationId));
    await expect(f.imports.ensure(f.reservationId)).rejects.toThrow("OPERATION_CONFLICT");
  } finally {
    await f.lease.release();
  }
});

test("input imports keep empty batches explicit and reject a changed manifest on recovery", async () => {
  const f = await inputInventoryFixture({ ...inputPolicy, maxBytes: 0 }, false, true);
  try {
    f.files.splice(0, 1, { descriptor: "input", type: "FileBatch", files: [] });
    const operation = await f.enqueue();
    await f.source.deliverNext();
    const saved = await row(operation.operationId);
    if (!saved.receipt) throw new Error("Missing empty-input acceptance");
    const preparation = new FederationPreparationService(db, b.signing.siteId, assets, clock);
    const exchange = new FederationMaterialExchange(
      db,
      b.signing,
      (_endpoint, jws) => f.source.materialChunk(jws, targetFingerprint),
      preparation,
      assets,
      clock,
    );
    const imports = new FederationInputImports(db, preparation, exchange, clock);
    expect(await imports.ensure(saved.receipt.reservationId)).toMatchObject({
      state: "pending",
      reservedBytes: 0,
    });
    const [received] = await db
      .select()
      .from(federationInputImports)
      .where(eq(federationInputImports.reservationId, saved.receipt.reservationId));
    if (!received) throw new Error("Missing empty input inventory");
    expect(received.manifest.inputs).toEqual([
      { descriptor: "input", type: "FileBatch", files: [] },
    ]);
    expect(
      await new FederationInputPublication(
        db,
        preparation,
        imports,
        exchange,
        {
          head: async () => {
            throw new Error("Empty batch must not read storage");
          },
        },
        clock,
      ).publish(saved.receipt.reservationId),
    ).toMatchObject({ state: "available" });
    await prepareInputExecution({
      exchange,
      reference: f.reference,
      reservationId: saved.receipt.reservationId,
    });
    const execution = await preparation.executionSnapshot(saved.receipt.reservationId);
    expect(execution.projection.workflow.spec.nodeDrafts[0]).toMatchObject({
      inputSlots: [{ type: "File", isBatch: true, contents: [] }],
    });
    await db
      .update(federationInputImports)
      .set({
        manifest: {
          ...received.manifest,
          inputs: [{ descriptor: "changed", type: "FileBatch", files: [] }],
        },
      })
      .where(eq(federationInputImports.id, received.id));
    await expect(imports.ensure(saved.receipt.reservationId)).rejects.toThrow("OPERATION_CONFLICT");
  } finally {
    await f.lease.release();
  }
});

test("input imports reject transport signing purposes revoked while receiving a manifest", async () => {
  const f = await inputImportFixture();
  try {
    for (const [siteId, keyId, purpose] of [
      [a.signing.siteId, a.signing.keyId, "material-chunk"],
      [b.signing.siteId, b.signing.keyId, "material-query"],
    ] as const) {
      const where = and(
        eq(federationSigningKeys.siteId, siteId),
        eq(federationSigningKeys.keyId, keyId),
      );
      const [key] = await db.select().from(federationSigningKeys).where(where);
      if (!key) throw new Error("Missing material signing key");
      const exchange = new FederationMaterialExchange(
        db,
        b.signing,
        async (...args) => {
          const response = await f.transport(...args);
          await db
            .update(federationSigningKeys)
            .set({ allowedKinds: key.allowedKinds.filter((kind) => kind !== purpose) })
            .where(where);
          return response;
        },
        f.preparation,
        assets,
        clock,
      );
      try {
        await expect(
          new FederationInputImports(db, f.preparation, exchange, clock).ensure(f.reservationId),
        ).rejects.toThrow("UNTRUSTED_IDENTITY");
      } finally {
        await db.update(federationSigningKeys).set({ allowedKinds: key.allowedKinds }).where(where);
      }
    }
    expect(await f.inventory()).toHaveLength(0);
  } finally {
    await f.lease.release();
  }
});

async function inputTransferFixture(batch = false) {
  const f = await inputImportFixture(true, batch);
  const imported = await f.imports.ensure(f.reservationId);
  if (!imported) throw new Error("Expected input inventory");
  const [member] = await db
    .select()
    .from(federationInputTransfers)
    .where(eq(federationInputTransfers.importId, imported.importId));
  if (!member) throw new Error("Expected input member");
  const agentId = `input-copy-${crypto.randomUUID()}`;
  transferAgentIds.push(agentId);
  await db.insert(agents).values({
    agentId,
    providerOrgId: receiver.orgId,
    siteName: "Input storage",
    schedulerType: "kubernetes",
    schedulerVersion: "test",
    status: "online",
  });
  const service = () => new FederationInputTransfers(db, f.preparation, f.imports, clock);
  return { ...f, imported, member, agentId, transfers: service(), transferService: service };
}

test("input transfers initialize stable members and recover the same authorized attempt after service recreation", async () => {
  const f = await inputTransferFixture();
  try {
    await Promise.all([f.imports.ensure(f.reservationId), f.imports.ensure(f.reservationId)]);
    expect(
      await db
        .select()
        .from(federationInputTransfers)
        .where(eq(federationInputTransfers.importId, f.imported.importId)),
    ).toEqual([f.member]);
    const started = await f.transfers.begin(f.member.id, f.agentId);
    expect(started.task.binding).toMatchObject({
      transferId: f.member.id,
      manifestDigest: f.imported.manifestDigest,
      descriptor: f.member.descriptor,
      path: f.member.path,
      sha256: f.member.sha256,
    });
    expect(started.attempt.storageKey).toBe(
      `federation-inputs/${f.imported.importId}/${started.attempt.generation}`,
    );
    await expect(f.transfers.begin(f.member.id, f.agentId)).rejects.toThrow("OPERATION_CONFLICT");
    await expect(
      f.transfers.allocated(started.attempt.generation, "upload-before-permit"),
    ).rejects.toThrow("OPERATION_CONFLICT");
    const permit = await f.transfers.preparing(f.agentId, started.attempt.generation);
    expect(permit.storageKey).toBe(started.attempt.storageKey);
    await expect(
      f.transferService().preparing(f.agentId, started.attempt.generation),
    ).rejects.toThrow("OPERATION_CONFLICT");
    expect(await f.transferService().allocated(started.attempt.generation, "input-upload")).toBe(
      true,
    );
    const grant = await f.transferService().assertCopyLease(f.agentId, started.task.binding, true);
    expect(grant).toMatchObject({
      storageKey: permit.storageKey,
      uploadId: "input-upload",
      reservationId: f.reservationId,
    });
    for (const altered of [
      { ...started.task.binding, path: "wrong" },
      { ...started.task.binding, manifestDigest: `sha256:${"f".repeat(64)}` },
    ])
      await expect(f.transfers.assertCopyLease(f.agentId, altered)).rejects.toThrow(
        "OPERATION_CONFLICT",
      );
    await expect(f.transfers.assertCopyLease("wrong-agent", started.task.binding)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    expect((await f.inventory())[0]).toMatchObject({
      state: "transferring",
      reservedBytes: f.member.sizeBytes,
    });
    expect(JSON.stringify(started.task)).not.toMatch(
      /uploadId|storageKey|ownerId|outputId|result-report/,
    );
  } finally {
    await f.lease.release();
  }
});

test("input transfers serialize concurrent Agent claims across separate task inventories", async () => {
  const first = await inputTransferFixture(),
    second = await inputTransferFixture();
  try {
    const claims = await Promise.allSettled([
      first.transfers.begin(first.member.id, first.agentId),
      second.transfers.begin(second.member.id, first.agentId),
    ]);
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const denied = claims.find((r) => r.status === "rejected");
    expect(denied?.status === "rejected" && String(denied.reason)).toContain("OPERATION_CONFLICT");
    expect(
      await db
        .select()
        .from(federationInputAttempts)
        .where(eq(federationInputAttempts.agentId, first.agentId)),
    ).toHaveLength(1);
  } finally {
    await first.lease.release();
    await second.lease.release();
  }
});

test("input transfers and result copies share the same durable Agent slot in both directions", async () => {
  const input = await inputTransferFixture(),
    result = await resultImportFixture(),
    waitingResult = await resultImportFixture();
  try {
    const started = await result.imports.begin(result.member.id, result.agentId);
    time = new Date(time.getTime() + 31_000);
    expect(await input.transfers.pending([input.agentId])).toHaveLength(1);
    // Even moving the Agent between orgs cannot erase a previously issued transfer lease.
    await db
      .update(agents)
      .set({ providerOrgId: receiver.orgId })
      .where(eq(agents.agentId, result.agentId));
    expect(await input.transfers.pending([result.agentId])).toHaveLength(0);
    await expect(input.transfers.begin(input.member.id, result.agentId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await result.imports.failed(result.agentId, started.attempt.generation, "COPY_FAILED");
    await expect(input.transfers.begin(input.member.id, result.agentId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    time = new Date(started.attempt.leaseUntil.getTime() + 1);
    await input.transfers.begin(input.member.id, result.agentId);
    await db
      .update(agents)
      .set({ providerOrgId: actor.orgId })
      .where(eq(agents.agentId, result.agentId));
    expect(await waitingResult.imports.pending([result.agentId])).toHaveLength(0);
    await expect(result.imports.begin(result.member.id, result.agentId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
  } finally {
    await input.lease.release();
  }
});

test("input transfers retain quota and cancellation acknowledgement until confirmed cleanup after grant expiry", async () => {
  const f = await inputTransferFixture();
  try {
    const started = await f.transfers.begin(f.member.id, f.agentId);
    await f.transfers.preparing(f.agentId, started.attempt.generation);
    await f.transfers.allocated(started.attempt.generation, "input-upload");
    const target = new FederationCancellationReceiver(db, b.signing, clock);
    const source = f.service(async (endpoint, jws, path) =>
      path === "/federation/v1/cancellations"
        ? target.receive(jws, sourceFingerprint)
        : f.receive(endpoint, jws),
    );
    await source.cancellations.request(actor, f.saved.operationId);
    await source.cancellations.deliverNext();
    const monitor = new FederationCancellationMonitor(
      db,
      {
        cancel: async () => {
          throw new Error("No run expected");
        },
      },
      async () => {},
      clock,
    );
    await monitor.tick();
    expect((await f.inventory())[0]).toMatchObject({
      state: "cancelling",
      reservedBytes: f.member.sizeBytes,
    });
    expect((await readFederationCancellationState(db, f.saved.request)).stopped).toBe(false);
    await expect(f.transfers.assertCopyLease(f.agentId, started.task.binding)).rejects.toThrow(
      "CANCELLATION_REQUESTED",
    );
    await expect(f.transfers.beginCleanup(started.attempt.generation)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    time = new Date(started.attempt.leaseUntil.getTime() + 1);
    const obsolete = await f.transfers.beginCleanup(started.attempt.generation);
    const current = await f.transferService().beginCleanup(started.attempt.generation);
    await expect(
      f.transfers.storageCleaned(started.attempt.generation, obsolete.token),
    ).rejects.toThrow("OPERATION_CONFLICT");
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
    await f.transfers.storageCleaned(started.attempt.generation, current.token);
    await f.transfers.storageCleaned(started.attempt.generation, current.token);
    await monitor.tick();
    await monitor.stop();
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
    expect((await readFederationCancellationState(db, f.saved.request)).stopped).toBe(true);
    expect(
      (await new StorageQuotaService(db, clock).getSummary(executionUserId)).reservedBytes,
    ).toBe(0);
    expect(await f.transfers.allocated(started.attempt.generation, "input-upload")).toBe(false);
    expect((await f.inventory())[0]?.state).toBe("cancelled");
  } finally {
    await f.lease.release();
  }
});

test("input transfers fence unknown allocations and preserve quota until a late upload ID is reconciled", async () => {
  const f = await inputTransferFixture();
  try {
    const started = await f.transfers.begin(f.member.id, f.agentId);
    await f.transfers.preparing(f.agentId, started.attempt.generation);
    time = new Date(started.attempt.leaseUntil.getTime() + 1);
    await f.transfers.expire();
    expect(await f.transfers.cleanupCandidates()).toEqual([]);
    await expect(f.transferService().beginCleanup(started.attempt.generation)).rejects.toThrow(
      "DATA_WAITING",
    );
    await expect(f.transfers.begin(f.member.id, f.agentId)).rejects.toThrow("OPERATION_CONFLICT");
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
    expect(await f.transfers.allocated(started.attempt.generation, "late-upload")).toBe(false);
    await expect(
      f.transfers.allocated(started.attempt.generation, "different-upload"),
    ).rejects.toThrow("OPERATION_CONFLICT");
    expect(await f.transfers.cleanupCandidates()).toEqual([
      { generation: started.attempt.generation },
    ]);
    const cleanup = await f.transfers.beginCleanup(started.attempt.generation);
    expect(cleanup.uploadId).toBe("late-upload");
    await f.transfers.storageCleaned(started.attempt.generation, cleanup.token);
    const retried = await f.transferService().begin(f.member.id, f.agentId);
    expect(retried.attempt.generation).not.toBe(started.attempt.generation);
    expect(retried.attempt.storageKey).not.toBe(started.attempt.storageKey);
    expect(retried.task.binding.transferId).toBe(started.task.binding.transferId);
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
  } finally {
    await f.lease.release();
  }
});

test("input transfers expire unused permits without allocating storage and reject stale cleanup after retry", async () => {
  const f = await inputTransferFixture();
  try {
    const started = await f.transfers.begin(f.member.id, f.agentId);
    time = new Date(started.attempt.leaseUntil.getTime() + 1);
    await f.transfers.expire();
    const cleanup = await f.transfers.beginCleanup(started.attempt.generation);
    expect(cleanup.allocationStarted).toBe(false);
    await f.transfers.storageCleaned(started.attempt.generation, cleanup.token);
    const retried = await f.transferService().begin(f.member.id, f.agentId);
    await f.transfers.storageCleaned(started.attempt.generation, cleanup.token);
    await expect(
      f.transfers.allocated(started.attempt.generation, "unissued-upload"),
    ).rejects.toThrow("OPERATION_CONFLICT");
    expect(
      (
        await db
          .select()
          .from(federationInputAttempts)
          .where(eq(federationInputAttempts.generation, retried.attempt.generation))
      )[0]?.state,
    ).toBe("preparing");
    expect(
      (
        await db
          .select()
          .from(federationInputTransfers)
          .where(eq(federationInputTransfers.id, f.member.id))
      )[0]?.state,
    ).toBe("copying");
  } finally {
    await f.lease.release();
  }
});

test("input transfers recheck identity, Agent ownership and manifest before each permit", async () => {
  const f = await inputTransferFixture();
  try {
    await db
      .update(agents)
      .set({ providerOrgId: actor.orgId })
      .where(eq(agents.agentId, f.agentId));
    await expect(f.transfers.begin(f.member.id, f.agentId)).rejects.toThrow("POLICY_DENIED");
    await db
      .update(agents)
      .set({ providerOrgId: receiver.orgId })
      .where(eq(agents.agentId, f.agentId));
    const started = await f.transfers.begin(f.member.id, f.agentId);
    await f.transfers.preparing(f.agentId, started.attempt.generation);
    await f.transfers.allocated(started.attempt.generation, "input-upload");
    await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
    try {
      await expect(
        f.transfers.assertCopyLease(f.agentId, started.task.binding, true),
      ).rejects.toThrow("POLICY_DENIED");
      await f.imports.sweep();
      expect((await f.inventory())[0]).toMatchObject({
        state: "cancelling",
        reservedBytes: f.member.sizeBytes,
      });
    } finally {
      await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    }
    await expect(f.transfers.assertCopyLease(f.agentId, started.task.binding)).rejects.toThrow(
      "CANCELLATION_REQUESTED",
    );
  } finally {
    await f.lease.release();
  }
  const damaged = await inputTransferFixture();
  try {
    await db
      .update(federationInputTransfers)
      .set({ path: "replaced" })
      .where(eq(federationInputTransfers.id, damaged.member.id));
    await expect(damaged.transfers.begin(damaged.member.id, damaged.agentId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    expect(
      await db
        .select()
        .from(federationInputAttempts)
        .where(eq(federationInputAttempts.transferId, damaged.member.id)),
    ).toEqual([]);
  } finally {
    await damaged.lease.release();
  }
});

const unassembledInputStorage: Pick<
  FederationInputStorageBackend,
  "head" | "completeMultipartUpload" | "presignDownload"
> = {
  head: async () => {
    throw new Error("No completed object expected");
  },
  completeMultipartUpload: async () => {
    throw new Error("No completion expected");
  },
  presignDownload: async () => {
    throw new Error("No verification expected");
  },
};

test("input storage allocates outside locks, fences late revocation and releases nothing after a failed purge", async () => {
  const f = await inputTransferFixture();
  let created = 0,
    purged = 0,
    failPurge = true;
  try {
    const storage = new FederationInputStorage(f.transfers, {
      presignUploadPart: async () => {
        throw new Error("No grant expected");
      },
      ...unassembledInputStorage,
      createMultipartUpload: async () => {
        created++;
        // This would deadlock if storage I/O ran under the execution identity locks.
        await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
        return { uploadId: "created-before-revocation" };
      },
      cleanupFederationInput: async () => {
        purged++;
        if (failPurge) throw new Error("https://private.invalid/?secret=do-not-log");
      },
    });
    await expect(storage.allocate(f.member.id, f.agentId)).rejects.toThrow("POLICY_DENIED");
    expect(created).toBe(1);
    await f.imports.sweep();
    expect((await f.inventory())[0]?.state).toBe("cancelling");
    const [attempt] = await db
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.transferId, f.member.id));
    if (!attempt) throw new Error("Missing attempt");
    expect(await storage.cleanup()).toBe(0);
    time = new Date(attempt.leaseUntil.getTime() + 1);
    expect(await storage.cleanup()).toBe(0);
    expect(purged).toBe(1);
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
    failPurge = false;
    expect(await storage.cleanup()).toBe(1);
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    await f.lease.release();
  }
});

test("input storage keeps timed-out allocation ownership and cleans a late response without re-creating uploads", async () => {
  const f = await inputTransferFixture();
  const allocated = Promise.withResolvers<{ uploadId: string }>();
  const recorded = Promise.withResolvers<void>();
  const record = f.transfers.allocated.bind(f.transfers);
  f.transfers.allocated = async (...args) => {
    const result = await record(...args);
    recorded.resolve();
    return result;
  };
  let creates = 0,
    deletes = 0;
  const storage = new FederationInputStorage(
    f.transfers,
    {
      presignUploadPart: async () => {
        throw new Error("No grant expected");
      },
      ...unassembledInputStorage,
      createMultipartUpload: async () => {
        creates++;
        return allocated.promise;
      },
      cleanupFederationInput: async () => {
        deletes++;
      },
    },
    { timeoutMs: 10 },
  );
  try {
    await expect(storage.allocate(f.member.id, f.agentId)).rejects.toThrow(
      "FEDERATION_INPUT_STORAGE_UNAVAILABLE",
    );
    const [attempt] = await db
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.transferId, f.member.id));
    if (!attempt) throw new Error("Missing attempt");
    expect(attempt.lastError).toBe("ALLOCATION_UNCONFIRMED");
    time = new Date(attempt.leaseUntil.getTime() + 1);
    expect(await storage.cleanup()).toBe(0);
    expect(deletes).toBe(0);
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
    await expect(storage.allocate(f.member.id, f.agentId)).rejects.toThrow("OPERATION_CONFLICT");
    allocated.resolve({ uploadId: "late-storage-response" });
    await recorded.promise;
    expect(await storage.cleanup()).toBe(1);
    expect(creates).toBe(1);
    expect(deletes).toBe(1);
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
  } finally {
    allocated.resolve({ uploadId: "late-storage-response" });
    await recorded.promise;
    await f.lease.release();
  }
});

test("input storage cleans an unissued allocation permit without storage effects and then retries under a new generation", async () => {
  const f = await inputTransferFixture();
  const preparing = f.transfers.preparing.bind(f.transfers);
  let creates = 0,
    deletes = 0;
  const storage = new FederationInputStorage(f.transfers, {
    presignUploadPart: async () => {
      throw new Error("No grant expected");
    },
    ...unassembledInputStorage,
    createMultipartUpload: async () => {
      creates++;
      return { uploadId: "retry-upload" };
    },
    cleanupFederationInput: async () => {
      deletes++;
    },
  });
  f.transfers.preparing = async (...args) => {
    await db.update(agents).set({ status: "offline" }).where(eq(agents.agentId, f.agentId));
    return preparing(...args);
  };
  try {
    await expect(storage.allocate(f.member.id, f.agentId)).rejects.toThrow("POLICY_DENIED");
    expect(creates).toBe(0);
    const [old] = await db
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.transferId, f.member.id));
    if (!old) throw new Error("Missing attempt");
    time = new Date(old.leaseUntil.getTime() + 1);
    expect(await storage.cleanup()).toBe(1);
    expect(deletes).toBe(0);
    f.transfers.preparing = preparing;
    await db.update(agents).set({ status: "online" }).where(eq(agents.agentId, f.agentId));
    const retried = await storage.allocate(f.member.id, f.agentId);
    expect(retried.task.binding.generation).not.toBe(old.generation);
    expect(creates).toBe(1);
    expect(await f.transfers.assertCopyLease(f.agentId, retried.task.binding)).toMatchObject({
      uploadId: "retry-upload",
    });
  } finally {
    f.transfers.preparing = preparing;
    await f.lease.release();
  }
});

test("transfer renewals serialize with Agent acquisition and cannot revive an expired lease while waiting", async () => {
  const input = await inputTransferFixture();
  const result = await resultImportFixture();
  try {
    const incoming = await input.transfers.begin(input.member.id, input.agentId);
    await input.transfers.preparing(input.agentId, incoming.attempt.generation);
    await input.transfers.allocated(incoming.attempt.generation, "input-upload");
    const outgoing = await result.imports.begin(result.member.id, result.agentId);
    await result.imports.allocated(outgoing.attempt.generation, "result-upload");
    const initialTime = time;
    for (const direction of ["input", "result"] as const) {
      time = initialTime;
      const agentId = direction === "input" ? input.agentId : result.agentId;
      const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const holder = db.transaction(async (tx) => {
        await lockFederationTransferSlot(tx, agentId);
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const renewal = (
        direction === "input"
          ? input.transfers.assertCopyLease(agentId, incoming.task.binding, true)
          : result.imports.renew(agentId, outgoing.attempt.generation)
      ).then(
        () => "unexpected-success",
        (error) => String(error),
      );
      try {
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const locks = await db.execute(
            sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
          );
          if (locks.length) {
            waiting = true;
            break;
          }
          await Bun.sleep(5);
        }
        expect(waiting).toBe(true);
        time = new Date(
          (direction === "input" ? incoming : outgoing).attempt.leaseUntil.getTime() + 1,
        );
      } finally {
        release.resolve();
        await holder;
      }
      expect(await renewal).toContain("OPERATION_CONFLICT");
    }
    expect(
      (
        await db
          .select()
          .from(federationInputAttempts)
          .where(eq(federationInputAttempts.generation, incoming.attempt.generation))
      )[0]?.leaseUntil,
    ).toEqual(incoming.attempt.leaseUntil);
    expect(
      (
        await db
          .select()
          .from(federationResultAttempts)
          .where(eq(federationResultAttempts.generation, outgoing.attempt.generation))
      )[0]?.leaseUntil,
    ).toEqual(outgoing.attempt.leaseUntil);
  } finally {
    await input.lease.release();
  }
});

async function inputGrantFixture(batch = false) {
  const f = await inputTransferFixture(batch);
  const sourceStorage = inputDownloadStorage();
  let sends = 0,
    uploads = 0;
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/input-downloads");
    sends++;
    return f.source.inputDownload(jws, targetFingerprint, sourceStorage.downloads);
  };
  const reader = (transport = send) =>
    new FederationInputReader(db, b.signing, transport, f.transfers, clock);
  const backend: FederationInputStorageBackend = {
    ...unassembledInputStorage,
    createMultipartUpload: async () => ({ uploadId: "receiver-upload" }),
    cleanupFederationInput: async () => {},
    presignUploadPart: async (
      key: string,
      uploadId: string,
      partNumber: number,
      seconds: number,
    ) => {
      uploads++;
      const url = new URL(`https://destination.test.invalid/${key}`);
      url.searchParams.set("uploadId", uploadId);
      url.searchParams.set("partNumber", String(partNumber));
      url.searchParams.set(
        "X-Amz-Date",
        clock()
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}/, ""),
      );
      url.searchParams.set("X-Amz-Expires", String(seconds));
      url.searchParams.set("X-Amz-Signature", "private-upload-ticket");
      return url.toString();
    },
  };
  const storage = new FederationInputStorage(f.transfers, backend, {
    clock,
    grants: {
      reader: reader(),
      sourceOrigins: sourceStorage.downloads.allowedOrigins,
      destinationOrigins: ["https://destination.test.invalid"],
    },
  });
  const allocated = await storage.allocate(f.member.id, f.agentId);
  return {
    ...f,
    ...sourceStorage,
    reader,
    backend,
    storage,
    binding: allocated.task.binding,
    send,
    sends: () => sends,
    uploads: () => uploads,
  };
}

test("input grants verify source signatures against the active attempt and issue separately bounded multipart credentials", async () => {
  const f = await inputGrantFixture();
  try {
    const downloaded = await f.storage.grant(f.agentId, f.binding, "download");
    expect(downloaded.grant).toMatchObject({ binding: f.binding, direction: "download" });
    expect(Date.parse(downloaded.grant.expiresAt) - clock().getTime()).toBe(30_000);
    expect(new URL(downloaded.grant.url).searchParams.get("versionId")).toBe("original-version");
    expect(f.sends()).toBe(1);
    const uploaded = await f.storage.grant(f.agentId, f.binding, "upload", 1);
    expect(uploaded.grant).toMatchObject({
      binding: f.binding,
      direction: "upload",
      partNumber: 1,
    });
    expect(new URL(uploaded.grant.url).searchParams.get("uploadId")).toBe("receiver-upload");
    expect(Date.parse(uploaded.grant.expiresAt) - clock().getTime()).toBe(30_000);
    expect(f.uploads()).toBe(1);
    expect(f.sends()).toBe(1);
    const stored = await db
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.generation, f.binding.generation));
    const audit = await db.select().from(auditLog).where(eq(auditLog.target, f.imported.importId));
    expect(JSON.stringify({ stored, audit, inventory: await f.inventory() })).not.toMatch(
      /private-input-ticket|private-upload-ticket|X-Amz-Signature/,
    );
  } finally {
    await f.lease.release();
  }
});

test("input grants reject signed replay, member substitution, unsafe versions and mismatched credential lifetimes", async () => {
  const f = await inputGrantFixture();
  try {
    let previous: string | undefined;
    const replay = f.reader(async (...args) => {
      if (previous) return previous;
      previous = await f.send(...args);
      return previous;
    });
    await replay.downloadGrant(f.agentId, f.binding, f.downloads.allowedOrigins);
    await expect(
      replay.downloadGrant(f.agentId, f.binding, f.downloads.allowedOrigins),
    ).rejects.toThrow("INVALID_MESSAGE");
    for (const failure of [
      "generation",
      "descriptor",
      "manifest",
      "request",
      "recipient",
      "origin",
      "no-version",
      "null-version",
      "duplicate-version",
      "long-credential",
      "envelope",
    ] as const) {
      const reader = f.reader(async (...args) => {
        const response = await f.send(...args);
        const { payload } = await verifyFederationMessage(
          FederationInputDownloadGrantSchema,
          response,
          await trust.resolveKey(a.signing.siteId, a.signing.keyId, clock()),
          clock(),
        );
        if (failure === "generation") payload.binding.generation = crypto.randomUUID();
        if (failure === "descriptor") payload.binding.descriptor = "another";
        if (failure === "manifest") payload.binding.manifestDigest = `sha256:${"b".repeat(64)}`;
        if (failure === "request") payload.requestDigest = `sha256:${"b".repeat(64)}`;
        if (failure === "recipient") payload.recipientSiteId = crypto.randomUUID();
        const url = new URL(payload.url);
        if (failure === "origin") url.hostname = "foreign.invalid";
        if (failure === "no-version") url.searchParams.delete("versionId");
        if (failure === "null-version") url.searchParams.set("versionId", "null");
        if (failure === "duplicate-version") url.searchParams.append("versionId", "another");
        if (failure === "long-credential") url.searchParams.set("X-Amz-Expires", "60");
        if (failure === "envelope")
          payload.expiresAt = new Date(clock().getTime() + 20_000).toISOString();
        payload.url = url.toString();
        return signFederationMessage(FederationInputDownloadGrantSchema, payload, a.signing);
      });
      let rejected: unknown;
      try {
        await reader.downloadGrant(f.agentId, f.binding, f.downloads.allowedOrigins);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(FederationError);
      expect(String(rejected)).toContain(
        failure === "long-credential" ? "POLICY_DENIED" : "INVALID_MESSAGE",
      );
      expect(String(rejected)).not.toContain("private-input-ticket");
    }
  } finally {
    await f.lease.release();
  }
}, 20_000);

test("input grants recheck local identity, Agent, endpoint and signing purposes after the source response", async () => {
  const f = await inputGrantFixture();
  try {
    for (const failure of [
      "query-purpose",
      "grant-purpose",
      "endpoint",
      "identity",
      "agent",
      "agreement",
    ] as const) {
      const siteId = failure === "query-purpose" ? b.signing.siteId : a.signing.siteId;
      const keyId = failure === "query-purpose" ? b.signing.keyId : a.signing.keyId;
      const keyFilter = and(
        eq(federationSigningKeys.siteId, siteId),
        eq(federationSigningKeys.keyId, keyId),
      );
      const [key] = await db.select().from(federationSigningKeys).where(keyFilter);
      const [site] = await db
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, a.signing.siteId));
      if (!key || !site) throw new Error("Missing trust fixture");
      const reader = f.reader(async (...args) => {
        const response = await f.send(...args);
        if (failure === "query-purpose" || failure === "grant-purpose")
          await db
            .update(federationSigningKeys)
            .set({
              allowedKinds: key.allowedKinds.filter(
                (k) =>
                  k !==
                  (failure === "query-purpose" ? "input-download-query" : "input-download-grant"),
              ),
            })
            .where(keyFilter);
        if (failure === "endpoint")
          await db
            .update(federationSites)
            .set({ endpoint: "https://changed.test.invalid" })
            .where(eq(federationSites.id, a.signing.siteId));
        if (failure === "identity")
          await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
        if (failure === "agent")
          await db
            .update(agents)
            .set({ providerOrgId: actor.orgId })
            .where(eq(agents.agentId, f.agentId));
        if (failure === "agreement")
          await db
            .update(federationAgreements)
            .set({ state: "suspended" })
            .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
        return response;
      });
      try {
        const expected =
          failure === "identity" || failure === "agent"
            ? "POLICY_DENIED"
            : failure === "agreement"
              ? "AGREEMENT_UNAVAILABLE"
              : "UNTRUSTED_IDENTITY";
        await expect(
          reader.downloadGrant(f.agentId, f.binding, f.downloads.allowedOrigins),
        ).rejects.toThrow(expected);
      } finally {
        await db
          .update(federationSigningKeys)
          .set({ allowedKinds: key.allowedKinds })
          .where(keyFilter);
        await db
          .update(federationSites)
          .set({ endpoint: site.endpoint })
          .where(eq(federationSites.id, a.signing.siteId));
        await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
        await db
          .update(agents)
          .set({ providerOrgId: receiver.orgId })
          .where(eq(agents.agentId, f.agentId));
        await db
          .update(federationAgreements)
          .set({ state: "active" })
          .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
      }
    }
    const stopped = f.reader(async (...args) => {
      const response = await f.send(...args);
      await f.transfers.failed(f.agentId, f.binding.generation);
      return response;
    });
    await expect(
      stopped.downloadGrant(f.agentId, f.binding, f.downloads.allowedOrigins),
    ).rejects.toThrow("OPERATION_CONFLICT");
  } finally {
    await f.lease.release();
  }
}, 20_000);

test("input grants bound downloads to current signing key expiry and reject a key shortened during transport", async () => {
  const f = await inputGrantFixture();
  const localFilter = and(
    eq(federationSigningKeys.siteId, b.signing.siteId),
    eq(federationSigningKeys.keyId, b.signing.keyId),
  );
  const peerFilter = and(
    eq(federationSigningKeys.siteId, a.signing.siteId),
    eq(federationSigningKeys.keyId, a.signing.keyId),
  );
  const [local] = await db.select().from(federationSigningKeys).where(localFilter);
  const [peer] = await db.select().from(federationSigningKeys).where(peerFilter);
  if (!local || !peer) throw new Error("Missing signing keys");
  try {
    await db
      .update(federationSigningKeys)
      .set({ validUntil: new Date(clock().getTime() + 5_000) })
      .where(localFilter);
    const bounded = await f.storage.grant(f.agentId, f.binding, "download");
    expect(Date.parse(bounded.grant.expiresAt) - clock().getTime()).toBe(5_000);
    await db.update(federationSigningKeys).set({ validUntil: local.validUntil }).where(localFilter);
    const shortened = f.reader(async (...args) => {
      const response = await f.send(...args);
      await db
        .update(federationSigningKeys)
        .set({ validUntil: new Date(clock().getTime() + 5_000) })
        .where(peerFilter);
      return response;
    });
    await expect(
      shortened.downloadGrant(f.agentId, f.binding, f.downloads.allowedOrigins),
    ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  } finally {
    await db.update(federationSigningKeys).set({ validUntil: local.validUntil }).where(localFilter);
    await db.update(federationSigningKeys).set({ validUntil: peer.validUntil }).where(peerFilter);
    await f.lease.release();
  }
});

test("input grants refuse unconfigured, stale, wrong-Agent and out-of-range requests without storage credentials", async () => {
  const f = await inputGrantFixture();
  try {
    const closed = new FederationInputStorage(f.transfers, f.backend, { clock });
    await expect(closed.grant(f.agentId, f.binding, "download")).rejects.toThrow("POLICY_DENIED");
    await expect(f.storage.grant("other-agent", f.binding, "download")).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await expect(
      f.storage.grant(f.agentId, { ...f.binding, path: "other-file" }, "download"),
    ).rejects.toThrow("OPERATION_CONFLICT");
    await expect(f.storage.grant(f.agentId, f.binding, "download", 1)).rejects.toThrow(
      "INVALID_MESSAGE",
    );
    for (const part of [undefined, 0, 2, 1.5, 10_001])
      await expect(f.storage.grant(f.agentId, f.binding, "upload", part)).rejects.toThrow(
        "INVALID_MESSAGE",
      );
    expect(f.sends()).toBe(0);
    expect(f.uploads()).toBe(0);
    await f.transfers.failed(f.agentId, f.binding.generation);
    await expect(f.storage.grant(f.agentId, f.binding, "download")).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    expect(f.sends()).toBe(0);
  } finally {
    await f.lease.release();
  }
});

test("input grants pin multipart target and reject long-lived URLs, late revocation and raw storage errors", async () => {
  const f = await inputGrantFixture();
  const presign = f.backend.presignUploadPart;
  try {
    for (const failure of [
      "upload",
      "part",
      "duplicate",
      "origin",
      "lifetime",
      "identity",
      "sdk",
    ] as const) {
      f.backend.presignUploadPart = async (...args) => {
        const url = new URL(await presign(...args));
        if (failure === "upload") url.searchParams.set("uploadId", "different-upload");
        if (failure === "part") url.searchParams.set("partNumber", "2");
        if (failure === "duplicate") url.searchParams.append("uploadId", "receiver-upload");
        if (failure === "origin") url.hostname = "foreign.invalid";
        if (failure === "lifetime") url.searchParams.set("X-Amz-Expires", "60");
        if (failure === "identity")
          await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
        if (failure === "sdk")
          throw new Error("https://private.invalid/?secret=private-upload-ticket");
        return url.toString();
      };
      let rejected: unknown;
      try {
        await f.storage.grant(f.agentId, f.binding, "upload", 1);
      } catch (error) {
        rejected = error;
      } finally {
        await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
      }
      expect(rejected).toBeInstanceOf(Error);
      const expected =
        failure === "sdk"
          ? "FEDERATION_INPUT_STORAGE_UNAVAILABLE"
          : failure === "origin" || failure === "lifetime" || failure === "identity"
            ? "POLICY_DENIED"
            : "INVALID_MESSAGE";
      expect(String(rejected)).toContain(expected);
      expect(String(rejected)).not.toContain("private-upload-ticket");
    }
  } finally {
    f.backend.presignUploadPart = presign;
    await f.lease.release();
  }
});

async function inputVerificationFixture(batch = false) {
  const f = await inputGrantFixture(batch);
  let object: ObjectStat | null = null,
    completions = 0,
    cleanups = 0;
  f.backend.completeMultipartUpload = async (_key, uploadId, parts) => {
    expect(uploadId).toBe("receiver-upload");
    expect(parts).toEqual([{ partNumber: 1, etag: "input-part" }]);
    completions++;
    object = {
      size: f.binding.sizeBytes,
      etag: "input-object",
      versionId: "input-version",
      contentType: "application/octet-stream",
      lastModified: clock(),
    };
    return { etag: object.etag, versionId: object.versionId };
  };
  f.backend.head = async (_key, version) =>
    !object || (version && version !== object.versionId) ? null : { ...object };
  f.backend.cleanupFederationInput = async () => {
    cleanups++;
    object = null;
  };
  f.backend.presignDownload = async (key, seconds, _filename, version) => {
    const url = new URL(`https://destination.test.invalid/${key}`);
    url.searchParams.set("versionId", version ?? "");
    url.searchParams.set(
      "X-Amz-Date",
      clock()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, ""),
    );
    url.searchParams.set("X-Amz-Expires", String(seconds));
    url.searchParams.set("X-Amz-Signature", "private-verification-ticket");
    return url.toString();
  };
  const copied = {
    binding: f.binding,
    sizeBytes: f.binding.sizeBytes,
    sha256: f.binding.sha256,
    parts: [{ partNumber: 1, etag: "input-part" }],
  };
  const attempt = async () =>
    (
      await db
        .select()
        .from(federationInputAttempts)
        .where(eq(federationInputAttempts.generation, f.binding.generation))
    )[0];
  const storage = (timeoutMs = 10_000) =>
    new FederationInputStorage(f.transferService(), f.backend, {
      clock,
      timeoutMs,
      grants: {
        reader: f.reader(),
        sourceOrigins: f.downloads.allowedOrigins,
        destinationOrigins: ["https://destination.test.invalid"],
      },
    });
  return {
    ...f,
    copied,
    attempt,
    recoverStorage: storage,
    object: () => object,
    setObject: (value: ObjectStat | null) => {
      object = value;
    },
    completions: () => completions,
    cleanups: () => cleanups,
  };
}

test("input verification persists copied parts and independently pinned verification without publishing a file", async () => {
  const f = await inputVerificationFixture();
  try {
    const beforeFiles = await db
      .select()
      .from(netdriveFiles)
      .where(eq(netdriveFiles.ownerId, executionUserId))
      .orderBy(netdriveFiles.id);
    expect(await f.transfers.copied(f.agentId, f.copied)).toEqual({ state: "assembling" });
    expect(await f.transfers.copied(f.agentId, f.copied)).toEqual({ state: "assembling" });
    expect(f.completions()).toBe(0);
    await expect(f.storage.grant(f.agentId, f.binding, "upload", 1)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    const assembled = await f.storage.assemble(f.agentId, f.binding.generation);
    expect(f.completions()).toBe(1);
    expect((await f.attempt())?.verifiedAt).toBeNull();
    expect((await f.attempt())?.state).toBe("verifying");
    expect(await f.recoverStorage().assemble(f.agentId, f.binding.generation)).toEqual(assembled);
    expect(f.completions()).toBe(1);
    const grant = await f.storage.verificationGrant(f.agentId, assembled.task);
    expect(grant.grant).toMatchObject({ ...assembled.task, direction: "verify" });
    expect(new URL(grant.grant.url).searchParams.get("versionId")).toBe("input-version");
    expect(Date.parse(grant.grant.expiresAt) - clock().getTime()).toBe(30_000);
    const receipt = { ...assembled.task, sizeBytes: f.binding.sizeBytes, sha256: f.binding.sha256 };
    await f.storage.verified(f.agentId, receipt);
    await f.recoverStorage().verified(f.agentId, receipt);
    expect((await f.attempt())?.state).toBe("verified");
    expect((await f.attempt())?.verifiedAt).toBeInstanceOf(Date);
    await expect(f.transfers.failed(f.agentId, f.binding.generation)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    expect((await f.inventory())[0]).toMatchObject({
      state: "transferring",
      reservedBytes: f.binding.sizeBytes,
    });
    expect(
      await db
        .select()
        .from(netdriveFiles)
        .where(eq(netdriveFiles.ownerId, executionUserId))
        .orderBy(netdriveFiles.id),
    ).toEqual(beforeFiles);
    expect(JSON.stringify(await f.attempt())).not.toContain("private-verification-ticket");
  } finally {
    await f.lease.release();
  }
});

test("input verification refuses changed multipart reports and verification receipts", async () => {
  const f = await inputVerificationFixture();
  try {
    for (const receipt of [
      { ...f.copied, sha256: "b".repeat(64) },
      { ...f.copied, sizeBytes: f.binding.sizeBytes + 1 },
      { ...f.copied, binding: { ...f.binding, descriptor: "other" } },
      { ...f.copied, parts: [{ partNumber: 2, etag: "input-part" }] },
    ])
      await expect(f.transfers.copied(f.agentId, receipt)).rejects.toThrow("INVALID_MESSAGE");
    await f.transfers.copied(f.agentId, f.copied);
    await expect(
      f.transfers.copied(f.agentId, { ...f.copied, parts: [{ partNumber: 1, etag: "changed" }] }),
    ).rejects.toThrow("OPERATION_CONFLICT");
    const { task } = await f.storage.assemble(f.agentId, f.binding.generation);
    const receipt = { ...task, sizeBytes: f.binding.sizeBytes, sha256: f.binding.sha256 };
    for (const changed of [
      { ...receipt, sha256: "b".repeat(64) },
      { ...receipt, sizeBytes: receipt.sizeBytes + 1 },
      { ...receipt, object: { ...receipt.object, versionId: "changed" } },
      { ...receipt, binding: { ...receipt.binding, manifestDigest: `sha256:${"b".repeat(64)}` } },
    ])
      await expect(f.storage.verified(f.agentId, changed)).rejects.toThrow("OPERATION_CONFLICT");
    await expect(f.storage.verified("another-agent", receipt)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    expect((await f.attempt())?.state).toBe("verifying");
    expect((await f.attempt())?.verifiedAt).toBeNull();
  } finally {
    await f.lease.release();
  }
});

test("input verification issues only one completion request and retains cancelled quota across a late response", async () => {
  const f = await inputVerificationFixture();
  const release = Promise.withResolvers<void>(),
    issued = Promise.withResolvers<void>(),
    recorded = Promise.withResolvers<void>();
  const complete = f.backend.completeMultipartUpload;
  f.backend.completeMultipartUpload = async (...args) => {
    issued.resolve();
    await release.promise;
    return complete(...args);
  };
  const transfers = f.transferService();
  const record = transfers.completed.bind(transfers);
  transfers.completed = async (...args) => {
    await record(...args);
    recorded.resolve();
  };
  const storage = new FederationInputStorage(transfers, f.backend, { clock, timeoutMs: 20 });
  try {
    await f.transfers.copied(f.agentId, f.copied);
    const first = storage.assemble(f.agentId, f.binding.generation).then(
      () => "unexpected",
      (error) => String(error),
    );
    await issued.promise;
    await expect(storage.assemble(f.agentId, f.binding.generation)).rejects.toThrow("DATA_WAITING");
    expect(await first).toBe("Error: FEDERATION_INPUT_STORAGE_UNAVAILABLE");
    await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
    await f.imports.sweep();
    const attempt = await f.attempt();
    if (!attempt) throw new Error("Missing completion attempt");
    time = new Date(attempt.leaseUntil.getTime() + 1);
    expect(await storage.cleanup()).toBe(0);
    expect(f.cleanups()).toBe(0);
    expect((await f.inventory())[0]).toMatchObject({
      state: "cancelling",
      reservedBytes: f.binding.sizeBytes,
    });
    await expect(f.transfers.beginCleanup(f.binding.generation)).rejects.toThrow("DATA_WAITING");
    release.resolve();
    await recorded.promise;
    expect(f.completions()).toBe(1);
    expect(await storage.cleanup()).toBe(1);
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
    expect((await f.attempt())?.state).toBe("cleaned");
    await f.transfers.completed(f.binding.generation, {
      etag: "input-object",
      versionId: "input-version",
    });
    expect((await f.attempt())?.state).toBe("cleaned");
  } finally {
    release.resolve();
    await recorded.promise;
    await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    await f.lease.release();
  }
});

test("input verification recovers a completed object after a lost response without reissuing completion", async () => {
  const f = await inputVerificationFixture();
  try {
    await f.transfers.copied(f.agentId, f.copied);
    expect(await f.transfers.startCompletion(f.agentId, f.binding.generation)).toBe(true);
    const attempt = await f.attempt();
    if (!attempt?.uploadId) throw new Error("Missing upload");
    // Simulate a crash after storage completed, before the process recorded its successful response.
    await f.backend.completeMultipartUpload(attempt.storageKey, attempt.uploadId, f.copied.parts);
    expect((await f.attempt())?.completionSettledAt).toBeNull();
    const recovered = await f.recoverStorage().assemble(f.agentId, f.binding.generation);
    expect(f.completions()).toBe(1);
    expect(recovered.task.object).toEqual({ etag: "input-object", versionId: "input-version" });
    expect((await f.attempt())?.state).toBe("verifying");
    expect((await f.attempt())?.verifiedAt).toBeNull();
  } finally {
    await f.lease.release();
  }
});

test("input verification cleanup reconciles positive completion evidence but never treats missing HEAD as settled", async () => {
  const f = await inputVerificationFixture();
  try {
    await f.transfers.copied(f.agentId, f.copied);
    await f.transfers.startCompletion(f.agentId, f.binding.generation);
    const attempt = await f.attempt();
    if (!attempt?.uploadId) throw new Error("Missing upload");
    time = new Date(attempt.leaseUntil.getTime() + 1);
    expect(await f.storage.cleanup()).toBe(0);
    expect((await f.attempt())?.lastError).toBe("COMPLETION_UNCONFIRMED");
    expect((await f.attempt())?.completionSettledAt).toBeNull();
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.binding.sizeBytes);
    await f.backend.completeMultipartUpload(attempt.storageKey, attempt.uploadId, f.copied.parts);
    expect(await f.recoverStorage().cleanup()).toBe(1);
    expect(f.completions()).toBe(1);
    expect(f.cleanups()).toBe(1);
    expect((await f.attempt())?.state).toBe("cleaned");
    expect((await f.attempt())?.verifiedAt).toBeNull();
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.binding.sizeBytes);
  } finally {
    await f.lease.release();
  }
});

test.each([
  "size",
  "version",
] as const)("input verification quarantines invalid %s on completed objects for cleanup", async (failure) => {
  const f = await inputVerificationFixture();
  try {
    const complete = f.backend.completeMultipartUpload;
    f.backend.completeMultipartUpload = async (...args) => {
      await complete(...args);
      const object = f.object();
      if (!object) throw new Error("Missing completed object");
      if (failure === "size") object.size++;
      else delete object.versionId;
      return { etag: object.etag, versionId: object.versionId };
    };
    await f.transfers.copied(f.agentId, f.copied);
    await expect(f.storage.assemble(f.agentId, f.binding.generation)).rejects.toThrow(
      "POLICY_DENIED",
    );
    const attempt = await f.attempt();
    if (!attempt) throw new Error("Missing attempt");
    expect(attempt.state).toBe("cleanup_pending");
    expect(attempt.verifiedAt).toBeNull();
    expect(attempt.completionSettledAt).toBeInstanceOf(Date);
    time = new Date(attempt.leaseUntil.getTime() + 1);
    expect(await f.storage.cleanup()).toBe(1);
  } finally {
    await f.lease.release();
  }
});

test("input verification retains verified objects until cancellation cleanup is confirmed", async () => {
  const f = await inputVerificationFixture();
  try {
    await f.transfers.copied(f.agentId, f.copied);
    const { task } = await f.storage.assemble(f.agentId, f.binding.generation);
    const receipt = { ...task, sizeBytes: f.binding.sizeBytes, sha256: f.binding.sha256 };
    await f.storage.verified(f.agentId, receipt);
    const attempt = await f.attempt();
    if (!attempt) throw new Error("Missing verified attempt");
    time = new Date(attempt.leaseUntil.getTime() + 1);
    expect(await f.storage.cleanup()).toBe(0);
    expect((await f.attempt())?.state).toBe("verified");
    await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
    await f.imports.sweep();
    expect((await f.attempt())?.state).toBe("cleanup_pending");
    await expect(f.storage.verified(f.agentId, receipt)).rejects.toThrow("POLICY_DENIED");
    const purge = f.backend.cleanupFederationInput;
    f.backend.cleanupFederationInput = async () => {
      throw new Error("Storage temporarily unavailable");
    };
    expect(await f.storage.cleanup()).toBe(0);
    expect((await f.inventory())[0]).toMatchObject({
      state: "cancelling",
      reservedBytes: f.binding.sizeBytes,
    });
    f.backend.cleanupFederationInput = purge;
    expect(await f.recoverStorage().cleanup()).toBe(1);
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
    expect((await f.attempt())?.state).toBe("cleaned");
    expect(f.cleanups()).toBe(1);
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    await f.lease.release();
  }
});

test("input verification grants recheck object versions, URL scope and current authority", async () => {
  const f = await inputVerificationFixture();
  try {
    await f.transfers.copied(f.agentId, f.copied);
    const { task } = await f.storage.assemble(f.agentId, f.binding.generation);
    const original = f.object();
    if (!original) throw new Error("Missing object");
    f.setObject({ ...original, etag: "replaced" });
    await expect(f.storage.verificationGrant(f.agentId, task)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    f.setObject(original);
    const presign = f.backend.presignDownload;
    for (const failure of ["version", "duplicate", "origin", "expiry", "identity"] as const) {
      f.backend.presignDownload = async (...args) => {
        const url = new URL(await presign(...args));
        if (failure === "version") url.searchParams.set("versionId", "changed");
        if (failure === "duplicate") url.searchParams.append("versionId", task.object.versionId);
        if (failure === "origin") url.hostname = "foreign.invalid";
        if (failure === "expiry") url.searchParams.set("X-Amz-Expires", "60");
        if (failure === "identity")
          await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
        return url.toString();
      };
      try {
        await expect(f.storage.verificationGrant(f.agentId, task)).rejects.toThrow(
          failure === "version" || failure === "duplicate" ? "INVALID_MESSAGE" : "POLICY_DENIED",
        );
      } finally {
        await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
      }
    }
    f.backend.presignDownload = presign;
    const head = f.backend.head;
    f.backend.head = async (...args) => {
      const stat = await head(...args);
      await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
      return stat;
    };
    await expect(
      f.storage.verified(f.agentId, {
        ...task,
        sizeBytes: f.binding.sizeBytes,
        sha256: f.binding.sha256,
      }),
    ).rejects.toThrow("POLICY_DENIED");
    expect((await f.attempt())?.verifiedAt).toBeNull();
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    await f.lease.release();
  }
});

test("input allocation recovery retains unknown quota and cleans the discovered original upload after restart", async () => {
  const f = await inputTransferFixture();
  let uploadId: string | undefined;
  let scans = 0;
  let purges = 0;
  const started = await f.transfers.begin(f.member.id, f.agentId);
  const permit = await f.transfers.preparing(f.agentId, started.attempt.generation);
  const backend: FederationInputStorageBackend = {
    ...unassembledInputStorage,
    createMultipartUpload: async () => {
      throw new Error("Recovery must not create an upload");
    },
    presignUploadPart: async () => {
      throw new Error("Recovery must not grant an upload");
    },
    findFederationInputUpload: async (key) => {
      expect(key).toBe(permit.storageKey);
      scans++;
      return uploadId;
    },
    cleanupFederationInput: async (key) => {
      expect(key).toBe(permit.storageKey);
      purges++;
    },
  };
  const storage = () => new FederationInputStorage(f.transferService(), backend, { clock });
  try {
    expect(await storage().cleanup()).toBe(0);
    expect(scans).toBe(0);
    await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
    await f.imports.sweep();
    time = new Date(started.attempt.leaseUntil.getTime() + 1);
    expect(await storage().cleanup()).toBe(0);
    expect(scans).toBe(1);
    expect(purges).toBe(0);
    expect((await f.inventory())[0]).toMatchObject({
      state: "cancelling",
      reservedBytes: f.member.sizeBytes,
    });
    const find = backend.findFederationInputUpload;
    backend.findFederationInputUpload = async () => {
      throw new Error("Storage unavailable");
    };
    expect(await storage().cleanup()).toBe(0);
    expect(purges).toBe(0);
    backend.findFederationInputUpload = find;
    uploadId = "original-upload-found-after-restart";
    expect(await storage().cleanup()).toBe(1);
    expect(purges).toBe(1);
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
    expect(await f.transfers.allocated(started.attempt.generation, uploadId)).toBe(false);
    await expect(
      f.transfers.allocated(started.attempt.generation, "different-upload"),
    ).rejects.toThrow("OPERATION_CONFLICT");
    expect(await storage().cleanup()).toBe(0);
    expect(purges).toBe(1);
    expect(await f.transfers.allocationPending(started.attempt.generation)).toBeUndefined();
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    await f.lease.release();
  }
});

test("input transport binds grants and copy/verification reports to the current Agent attempt", async () => {
  const f = await inputVerificationFixture();
  const filesBefore = await db
    .select({ id: netdriveFiles.id })
    .from(netdriveFiles)
    .where(eq(netdriveFiles.ownerId, executionUserId))
    .orderBy(netdriveFiles.id);
  const dispatcher = new AgentDispatcher();
  const messages: ServerMessage[] = [];
  dispatcher.register(f.agentId, {
    push: (message) => {
      messages.push(message);
    },
    close: () => {},
    federationInputCopyV1: true,
    federationInputVerifyV1: true,
    verifiedCertFingerprint: "verified",
  });
  const transport = new FederationInputTransport(f.transfers, f.storage, dispatcher);
  try {
    const request = create(FederationInputGrantRequestSchema, {
      requestId: crypto.randomUUID(),
      bindingJson: JSON.stringify(f.binding),
      upload: true,
      partNumber: 1,
    });
    expect(JSON.parse((await transport.grant(f.agentId, request)).grantJson)).toMatchObject({
      binding: f.binding,
      direction: "upload",
      partNumber: 1,
    });
    await expect(transport.grant("other-agent", request)).rejects.toThrow("OPERATION_CONFLICT");
    const copied = create(FederationInputCopyReportSchema, {
      generation: f.binding.generation,
      copiedJson: JSON.stringify(f.copied),
    });
    await expect(
      transport.report(f.agentId, { ...copied, generation: crypto.randomUUID() }),
    ).rejects.toThrow("INVALID_MESSAGE");
    await expect(transport.report(f.agentId, { ...copied, failed: true })).rejects.toThrow(
      "INVALID_MESSAGE",
    );
    await transport.report(f.agentId, copied);
    await transport.report(f.agentId, copied);
    expect(f.completions()).toBe(1);
    expect(messages).toHaveLength(2);
    const verification = messages[0];
    if (verification?.payload.case !== "federationInputVerify")
      throw new Error("Missing input verification");
    const task = JSON.parse(verification.payload.value.taskJson);
    const check = create(FederationInputGrantRequestSchema, {
      requestId: crypto.randomUUID(),
      verificationJson: JSON.stringify(task),
    });
    await expect(
      transport.grant(f.agentId, { ...check, bindingJson: request.bindingJson }),
    ).rejects.toThrow("INVALID_MESSAGE");
    expect(JSON.parse((await transport.grant(f.agentId, check)).grantJson)).toMatchObject({
      ...task,
      direction: "verify",
    });
    const receipt = create(FederationInputCopyReportSchema, {
      generation: f.binding.generation,
      verifiedJson: JSON.stringify({
        ...task,
        sizeBytes: f.binding.sizeBytes,
        sha256: f.binding.sha256,
      }),
    });
    await transport.report(f.agentId, receipt);
    await transport.report(f.agentId, receipt);
    await transport.report(f.agentId, copied);
    expect((await f.attempt())?.state).toBe("verified");
    expect((await f.inventory())[0]?.state).toBe("transferring");
    expect(messages).toHaveLength(2);
    expect(
      await db
        .select({ id: netdriveFiles.id })
        .from(netdriveFiles)
        .where(eq(netdriveFiles.ownerId, executionUserId))
        .orderBy(netdriveFiles.id),
    ).toEqual(filesBefore);
  } finally {
    await f.lease.release();
  }
});

test("input worker negotiates capabilities, serializes concurrent scans and recovers expired disconnected transfers", async () => {
  const f = await inputTransferFixture();
  const dispatcher = new AgentDispatcher();
  const messages: ServerMessage[] = [];
  let creates = 0,
    purges = 0;
  const channel = {
    push: (message: ServerMessage) => {
      messages.push(message);
    },
    close: () => {},
    federationInputCopyV1: false,
    federationInputVerifyV1: false,
    verifiedCertFingerprint: undefined as string | undefined,
  };
  dispatcher.register(f.agentId, channel);
  const backend: FederationInputStorageBackend = {
    ...unassembledInputStorage,
    createMultipartUpload: async () => ({ uploadId: `worker-${++creates}` }),
    cleanupFederationInput: async () => {
      purges++;
    },
    presignUploadPart: async () => {
      throw new Error("No grant expected");
    },
  };
  const storage = new FederationInputStorage(f.transfers, backend, { clock });
  const transport = new FederationInputTransport(f.transfers, storage, dispatcher);
  const worker = () => new FederationInputWorker(f.transfers, transport);
  try {
    time = new Date(time.getTime() + 31_000);
    for (const change of [
      () => {},
      () => {
        channel.federationInputCopyV1 = true;
      },
      () => {
        channel.federationInputVerifyV1 = true;
      },
    ]) {
      change();
      await worker().tick();
      expect(creates).toBe(0);
    }
    channel.verifiedCertFingerprint = "verified";
    await Promise.all([worker().tick(), worker().tick()]);
    expect(creates).toBe(1);
    expect(messages).toHaveLength(1);
    const first = messages[0];
    if (first?.payload.case !== "federationInputCopy") throw new Error("Missing input copy");
    const task = JSON.parse(first.payload.value.taskJson);
    expect(task.binding.descriptor).toBe(f.member.descriptor);
    expect(first.payload.value.taskJson).not.toMatch(/storageKey|uploadId|ownerId/);
    await worker().tick();
    expect(creates).toBe(1);
    time = new Date(Number(first.payload.value.leaseExpiresAtUnixMs) + 1);
    expect(await storage.cleanup()).toBe(1);
    time = new Date(time.getTime() + 31_000);
    await worker().tick();
    expect(creates).toBe(2);
    expect(purges).toBe(1);
    expect(messages).toHaveLength(2);
    const second = messages[1];
    if (second?.payload.case !== "federationInputCopy") throw new Error("Missing resumed input");
    expect(JSON.parse(second.payload.value.taskJson).binding.generation).not.toBe(
      task.binding.generation,
    );
  } finally {
    await f.lease.release();
  }
});

test("input transport fences allocations if the authenticated channel is replaced", async () => {
  const f = await inputTransferFixture();
  const dispatcher = new AgentDispatcher();
  let pushes = 0;
  const channel = {
    push: () => {
      pushes++;
    },
    close: () => {},
    federationInputCopyV1: true,
    federationInputVerifyV1: true,
    verifiedCertFingerprint: "verified",
  };
  dispatcher.register(f.agentId, channel);
  const storage = new FederationInputStorage(
    f.transfers,
    {
      ...unassembledInputStorage,
      createMultipartUpload: async () => {
        dispatcher.register(f.agentId, { ...channel });
        return { uploadId: "old-channel-upload" };
      },
      cleanupFederationInput: async () => {},
      presignUploadPart: async () => {
        throw new Error("No grant expected");
      },
    },
    { clock },
  );
  try {
    expect(
      await new FederationInputTransport(f.transfers, storage, dispatcher).dispatch(
        f.member.id,
        f.agentId,
      ),
    ).toBe(false);
    expect(pushes).toBe(0);
    const [attempt] = await db
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.transferId, f.member.id));
    expect(attempt?.state).toBe("cleanup_pending");
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
  } finally {
    await f.lease.release();
  }
});

test("input worker backs off denied transfers and does not recreate a cancelled inventory", async () => {
  const f = await inputTransferFixture();
  const dispatcher = new AgentDispatcher();
  dispatcher.register(f.agentId, {
    push: () => {
      throw new Error("No dispatch expected");
    },
    close: () => {},
    federationInputCopyV1: true,
    federationInputVerifyV1: true,
    verifiedCertFingerprint: "verified",
  });
  let creates = 0;
  const storage = new FederationInputStorage(
    f.transfers,
    {
      ...unassembledInputStorage,
      createMultipartUpload: async () => {
        creates++;
        return { uploadId: "unexpected" };
      },
      cleanupFederationInput: async () => {},
      presignUploadPart: async () => {
        throw new Error("No grant expected");
      },
    },
    { clock },
  );
  const worker = new FederationInputWorker(
    f.transfers,
    new FederationInputTransport(f.transfers, storage, dispatcher),
  );
  try {
    time = new Date(time.getTime() + 31_000);
    await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
    await worker.tick();
    expect(creates).toBe(0);
    expect((await f.inventory())[0]?.lastError).toBe("POLICY_DENIED");
    expect(await f.transfers.pending([f.agentId])).toHaveLength(0);
    await f.imports.sweep();
    await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    time = new Date(time.getTime() + 31_000);
    await worker.tick();
    expect(creates).toBe(0);
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
  } finally {
    await worker.stop();
    await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
    await f.lease.release();
  }
});

async function inputPublicationFixture(batch = false) {
  const f = await inputVerificationFixture(batch);
  const publisher = () =>
    new FederationInputPublication(db, f.preparation, f.imports, f.exchange, f.backend, clock);
  const verify = async () => {
    await f.transfers.copied(f.agentId, f.copied);
    const { task } = await f.storage.assemble(f.agentId, f.binding.generation);
    const receipt = { ...task, sizeBytes: f.binding.sizeBytes, sha256: f.binding.sha256 };
    await f.storage.verified(f.agentId, receipt);
    return receipt;
  };
  const published = () => db.select().from(netdriveFiles).where(eq(netdriveFiles.id, f.member.id));
  return { ...f, publisher, verify, published };
}

test("input publication atomically converts reserved quota to pinned files exactly once across concurrent restarts", async () => {
  const f = await inputPublicationFixture();
  try {
    await expect(f.publisher().publish(f.reservationId)).rejects.toThrow("DATA_WAITING");
    expect(await f.published()).toHaveLength(0);
    const before = await new StorageQuotaService(db, clock).getSummary(executionUserId);
    const receipt = await f.verify();
    const results = await Promise.all([
      f.publisher().publish(f.reservationId),
      f.publisher().publish(f.reservationId),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.state).toBe("available");
    expect(await f.published()).toMatchObject([
      {
        id: f.member.id,
        ownerId: executionUserId,
        size: 4,
        sha256: f.binding.sha256,
        storageVersionId: "input-version",
        etag: "input-object",
        deletedAt: null,
        path: `federation-inputs/${f.imported.importId}/input/input.dat`,
      },
    ]);
    const after = await new StorageQuotaService(db, clock).getSummary(executionUserId);
    expect(after.usedBytes - before.usedBytes).toBe(4);
    expect((before.reservedBytes ?? 0) - (after.reservedBytes ?? 0)).toBe(4);
    expect(after.availableBytes).toBe(before.availableBytes);
    await f.storage.verified(f.agentId, receipt);
    expect(await f.transfers.copied(f.agentId, f.copied)).toEqual({ state: "available" });
    expect((await f.attempt())?.state).toBe("available");
    expect((await f.inventory())[0]?.publishedAt).toBeInstanceOf(Date);
    expect(await f.publisher().publish(f.reservationId)).toEqual(results[0]);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.target, f.imported.importId),
            eq(auditLog.action, "federation.input.published"),
          ),
        ),
    ).toHaveLength(1);
    // Publication does not itself stage a receiver Workflow.
    expect(
      await db
        .select()
        .from(federationWorkflowBindings)
        .where(eq(federationWorkflowBindings.reservationId, f.reservationId)),
    ).toHaveLength(0);
  } finally {
    await f.lease.release();
  }
});

test("input publication refuses storage drift and source or receiver revocation during external checks", async () => {
  for (const failure of ["version", "source", "receiver", "cancel", "member"] as const) {
    const f = await inputPublicationFixture();
    try {
      await f.verify();
      const head = f.backend.head;
      f.backend.head = async (...args) => {
        const stat = await head(...args);
        if (failure === "version") return stat && { ...stat, versionId: "replaced" };
        if (failure === "source") await f.registry.requestCancel(f.runId);
        if (failure === "receiver")
          await db.update(users).set({ suspended: true }).where(eq(users.id, executionUserId));
        if (failure === "cancel")
          await db.transaction((tx) =>
            cancelFederationInputImport(tx, f.reservationId, "CANCELLATION_REQUESTED", clock()),
          );
        if (failure === "member")
          await db
            .update(federationInputTransfers)
            .set({ sha256: "b".repeat(64) })
            .where(eq(federationInputTransfers.id, f.member.id));
        return stat;
      };
      await expect(f.publisher().publish(f.reservationId)).rejects.toThrow();
      expect(await f.published()).toHaveLength(0);
      expect((await f.inventory())[0]?.reservedBytes).toBe(4);
    } finally {
      await db.update(users).set({ suspended: false }).where(eq(users.id, executionUserId));
      await f.lease.release();
    }
  }
});

test("input publication rolls back on path collision and retries through the worker", async () => {
  const f = await inputPublicationFixture();
  const collisionId = crypto.randomUUID();
  try {
    await f.verify();
    await db.insert(netdriveFiles).values({
      id: collisionId,
      ownerId: executionUserId,
      path: `federation-inputs/${f.imported.importId}/input/input.dat`,
      size: 1,
      sha256: "b".repeat(64),
      storageKey: `netdrive/objects/${collisionId}`,
    });
    const transport = new FederationInputTransport(f.transfers, f.storage, new AgentDispatcher());
    const worker = () => new FederationInputWorker(f.transfers, transport, f.publisher());
    time = new Date(time.getTime() + 31_000);
    await worker().tick();
    expect((await f.inventory())[0]).toMatchObject({
      lastError: "OPERATION_CONFLICT",
      reservedBytes: 4,
      state: "transferring",
    });
    expect(await f.published()).toHaveLength(0);
    await db.delete(netdriveFiles).where(eq(netdriveFiles.id, collisionId));
    await worker().tick();
    expect(await f.published()).toHaveLength(0);
    time = new Date(time.getTime() + 31_000);
    await worker().tick();
    expect((await f.inventory())[0]).toMatchObject({
      lastError: null,
      reservedBytes: 0,
      state: "available",
    });
    expect(await f.published()).toHaveLength(1);
  } finally {
    await db.delete(netdriveFiles).where(eq(netdriveFiles.id, collisionId));
    await f.lease.release();
  }
});

test("input publication cancellation hides files and retains cleanup quota until execution and storage stop", async () => {
  const f = await inputPublicationFixture();
  const runId = crypto.randomUUID();
  sourceRunIds.push(runId);
  try {
    await f.verify();
    await f.publisher().publish(f.reservationId);
    await db.insert(workflowRuns).values({
      id: runId,
      name: "Receiver input consumer",
      status: "running",
      submittedBy: executionUserId,
      input: {
        federationReservationId: f.reservationId,
        yaml: "",
        role: "user",
        orgId: receiver.orgId,
      },
    });
    const cancel = () =>
      db.transaction((tx) =>
        cancelFederationInputImport(tx, f.reservationId, "CANCELLATION_REQUESTED", clock()),
      );
    await cancel();
    await cancel();
    expect((await f.published())[0]?.deletedAt).toBeInstanceOf(Date);
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelling", reservedBytes: 4 });
    const attempt = await f.attempt();
    if (!attempt) throw new Error("Missing attempt");
    time = new Date(attempt.leaseUntil.getTime() + 1);
    expect(await f.storage.cleanup()).toBe(0);
    expect(f.cleanups()).toBe(0);
    await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, runId));
    const purge = f.backend.cleanupFederationInput;
    f.backend.cleanupFederationInput = async () => {
      throw new Error("Storage unavailable");
    };
    expect(await f.storage.cleanup()).toBe(0);
    expect((await f.inventory())[0]?.reservedBytes).toBe(4);
    f.backend.cleanupFederationInput = purge;
    expect(await f.storage.cleanup()).toBe(1);
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
    expect(f.cleanups()).toBe(1);
  } finally {
    await f.lease.release();
  }
});

test("input publication rolls back all files and quota if source disclosure expires before commit", async () => {
  const f = await inputPublicationFixture();
  try {
    await f.verify();
    const receive = f.exchange.inputFiles.bind(f.exchange);
    f.exchange.inputFiles = async (...args) => {
      const received = await receive(...args);
      let checks = 0;
      return {
        ...received,
        authorize: async (tx) => {
          if (++checks === 2) time = new Date(time.getTime() + 61_000);
          await received.authorize(tx);
        },
      };
    };
    await expect(f.publisher().publish(f.reservationId)).rejects.toThrow();
    expect(await f.published()).toHaveLength(0);
    expect((await f.inventory())[0]).toMatchObject({
      state: "transferring",
      reservedBytes: 4,
      publishedAt: null,
    });
    expect((await f.attempt())?.state).toBe("verified");
  } finally {
    await f.lease.release();
  }
});

test("input publication rechecks reduced quota and cancellation preserves a replacement file", async () => {
  const f = await inputPublicationFixture();
  let policyId: string | undefined;
  try {
    await f.verify();
    const before = await new StorageQuotaService(db, clock).getSummary(executionUserId);
    const [policy] = await db
      .insert(storageQuotaPolicies)
      .values({
        scope: "cloud",
        scopeId: "global",
        defaultQuotaBytes: before.usedBytes + (before.reservedBytes ?? 0) - 1,
      })
      .returning();
    if (!policy) throw new Error("Missing quota policy");
    policyId = policy.id;
    await expect(f.publisher().publish(f.reservationId)).rejects.toThrow();
    expect(await f.published()).toHaveLength(0);
    expect((await f.inventory())[0]?.reservedBytes).toBe(4);
    await db.delete(storageQuotaPolicies).where(eq(storageQuotaPolicies.id, policyId));
    policyId = undefined;
    await f.publisher().publish(f.reservationId);
    await db
      .update(netdriveFiles)
      .set({ storageKey: "netdrive/objects/replacement", storageVersionId: "replacement" })
      .where(eq(netdriveFiles.id, f.member.id));
    await db.transaction((tx) =>
      cancelFederationInputImport(tx, f.reservationId, "CANCELLATION_REQUESTED", clock()),
    );
    expect((await f.published())[0]?.deletedAt).toBeNull();
    const after = await new StorageQuotaService(db, clock).getSummary(executionUserId);
    expect(after.usedBytes - before.usedBytes).toBe(4);
    expect(after.reservedBytes).toBe(before.reservedBytes);
  } finally {
    if (policyId)
      await db.delete(storageQuotaPolicies).where(eq(storageQuotaPolicies.id, policyId));
    await f.lease.release();
  }
});

test("input publication waits for every FileBatch member and publishes the complete inventory together", async () => {
  const f = await inputPublicationFixture(true);
  try {
    await f.verify();
    await expect(f.publisher().publish(f.reservationId)).rejects.toThrow("DATA_WAITING");
    expect(await f.published()).toHaveLength(0);
    expect((await f.inventory())[0]?.reservedBytes).toBe(8);
    const [second] = await db
      .select()
      .from(federationInputTransfers)
      .where(
        and(
          eq(federationInputTransfers.importId, f.imported.importId),
          ne(federationInputTransfers.id, f.member.id),
        ),
      );
    if (!second) throw new Error("Missing second member");
    const { task: copy } = await f.storage.allocate(second.id, f.agentId);
    await f.transfers.copied(f.agentId, { ...f.copied, binding: copy.binding });
    const { task } = await f.storage.assemble(f.agentId, copy.binding.generation);
    await f.storage.verified(f.agentId, {
      ...task,
      sizeBytes: second.sizeBytes,
      sha256: second.sha256,
    });
    await f.publisher().publish(f.reservationId);
    const files = await db
      .select()
      .from(netdriveFiles)
      .where(inArray(netdriveFiles.id, [f.member.id, second.id]));
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.path).sort()).toEqual([
      `federation-inputs/${f.imported.importId}/input/first.dat`,
      `federation-inputs/${f.imported.importId}/input/second.dat`,
    ]);
    expect((await f.inventory())[0]).toMatchObject({ state: "available", reservedBytes: 0 });
    await prepareInputExecution(f);
    const execution = await f.preparation.executionSnapshot(f.reservationId);
    expect(execution.projection.workflow.spec.nodeDrafts[0]).toMatchObject({
      inputSlots: [
        {
          type: "File",
          isBatch: true,
          contents: [{ relativePath: "first.dat" }, { relativePath: "second.dat" }],
        },
      ],
    });
  } finally {
    await f.lease.release();
  }
});

test("workflow file slots create signed source snapshots through the ordinary Federation executor", async () => {
  const f = await inputInventoryFixture();
  try {
    const remote = new FederationWorkflowExecutor(db, a.signing.siteId, f.source, clock);
    const execute = createUsecaseExecutor({
      resolvePackage: async () => {
        throw new Error("No local package expected");
      },
      submitJob: async () => {
        throw new Error("No local job expected");
      },
      executeFederation: (node, invocation, parameters, files) =>
        remote.execute(actor, f.lease, node, invocation ?? f.invocation, parameters, files),
    });
    const node = workflowDsl.WorkflowNodeSchema.parse({
      id: "remote",
      name: "Remote files",
      type: "Federation",
      agreementRevisionId: f.terms.agreementRevisionId,
      template: f.request.template,
      inputManifestDigest: f.request.inputManifestDigest,
      environmentLockDigest: f.request.environmentLockDigest,
      resources: f.request.resources,
      maxAmount: "1",
      inputSlots: [
        {
          descriptor: "input",
          type: "File",
          from: { param: "file" },
          expectedFileName: "input.dat",
        },
      ],
    });
    const context = {
      params: { file: { fileMetadataId: f.fileId, fileMetadataName: "private/source.dat" } },
    };
    for (let i = 0; i < 2; i++)
      await expect(execute(node, context, f.invocation)).rejects.toThrow("REMOTE_WAITING");
    const snapshots = await db
      .select()
      .from(federationWorkflowInputExports)
      .where(eq(federationWorkflowInputExports.runId, f.runId));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.manifest.inputs).toEqual([
      {
        descriptor: "input",
        type: "File",
        files: [{ path: "input.dat", sizeBytes: 4, sha256: "a".repeat(64) }],
      },
    ]);
    expect(JSON.stringify(snapshots[0]?.manifest)).not.toContain(f.fileId);
    expect(JSON.stringify(snapshots[0]?.manifest)).not.toContain("private/");
    await f.source.deliverNext();
    const [sent] = await db
      .select()
      .from(federationOutbound)
      .where(eq(federationOutbound.agreementRevisionId, f.terms.agreementRevisionId));
    expect(sent?.receipt?.status).toBe("RESERVED");
    expect(sent?.request.inputFilesDigest).toBe(snapshots[0]?.manifestDigest);
    await db
      .update(netdriveFiles)
      .set({ storageVersionId: "replaced" })
      .where(eq(netdriveFiles.id, f.fileId));
    expect(await execute(node, context, f.invocation)).toMatchObject({
      status: "Failed",
      failure: { message: "Federation execution refused: OPERATION_CONFLICT" },
    });
  } finally {
    await f.lease.release();
  }
});

async function prepareInputExecution(
  f: Pick<
    Awaited<ReturnType<typeof inputPublicationFixture>>,
    "exchange" | "reference" | "reservationId"
  >,
) {
  await f.exchange.ensure(f.reservationId);
  const resolved = await assets.resolveForDelegation(actor, f.reference);
  if (!resolved.mapping.softwareRevisionId) throw new Error("Missing script revision");
  await assets.register(receiver, {
    reference: f.reference,
    localRevisionId: resolved.mapping.softwareRevisionId,
  });
}

test("published inputs bind the receiver workflow to the original identity and immutable file snapshot", async () => {
  const f = await inputPublicationFixture();
  try {
    await prepareInputExecution(f);
    await expect(f.preparation.executionSnapshot(f.reservationId)).rejects.toThrow("DATA_WAITING");
    await f.verify();
    await f.publisher().publish(f.reservationId);
    expect(await f.preparation.prepare(f.reservationId)).toMatchObject({
      state: "resolved",
      blocker: null,
    });
    const prepared = await f.preparation.executionSnapshot(f.reservationId);
    expect(prepared.material.receivedInputs?.inputs[0]?.files[0]).toMatchObject({
      fileId: f.member.id,
      versionId: "input-version",
      sha256: f.member.sha256,
    });
    expect(prepared.projection.workflow.spec.nodeDrafts[0]).toMatchObject({
      type: "Script",
      inputSlots: [
        {
          type: "File",
          contents: [
            {
              fileMetadataId: f.member.id,
              fileMetadataName: "input.dat",
              hash: f.member.sha256,
              size: 4,
            },
          ],
        },
      ],
    });
    const binding = await new FederationExecutionBindingService(db, f.preparation).stage(
      f.reservationId,
    );
    expect(binding?.snapshot.identity).toEqual({ userId: executionUserId, orgId: receiver.orgId });
    expect(binding?.snapshot.receivedInputs).toEqual(prepared.material.receivedInputs);
    await db
      .update(netdriveFiles)
      .set({ storageVersionId: "replaced" })
      .where(eq(netdriveFiles.id, f.member.id));
    await expect(f.preparation.executionSnapshot(f.reservationId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await expect(
      db.transaction((tx) => f.preparation.lockExecutionSnapshot(tx, prepared)),
    ).rejects.toThrow("OPERATION_CONFLICT");
    await db
      .update(netdriveFiles)
      .set({ storageVersionId: "input-version" })
      .where(eq(netdriveFiles.id, f.member.id));
    await db.transaction(async (tx) => {
      await f.preparation.lockExecutionSnapshot(tx, prepared);
      await expect(
        db.transaction((other) =>
          other
            .select()
            .from(federationInputImports)
            .where(eq(federationInputImports.id, f.imported.importId))
            .for("update", { noWait: true }),
        ),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
    });
    await db.transaction((tx) =>
      cancelFederationInputImport(tx, f.reservationId, "CANCELLATION_REQUESTED", clock()),
    );
    await expect(
      db.transaction((tx) => f.preparation.lockExecutionSnapshot(tx, prepared)),
    ).rejects.toThrow("CANCELLATION_REQUESTED");
    expect(await f.preparation.prepare(f.reservationId)).toMatchObject({
      state: "blocked",
      blocker: "CANCELLATION_REQUESTED",
    });
  } finally {
    await f.lease.release();
  }
});

test("published input execution rejects changed ownership, deleted files and mismatched verification facts", async () => {
  const f = await inputPublicationFixture();
  try {
    await prepareInputExecution(f);
    await f.verify();
    await f.publisher().publish(f.reservationId);
    await db
      .update(netdriveFiles)
      .set({ ownerId: receiver.userId })
      .where(eq(netdriveFiles.id, f.member.id));
    await expect(f.preparation.executionSnapshot(f.reservationId)).rejects.toThrow("POLICY_DENIED");
    await db
      .update(netdriveFiles)
      .set({ ownerId: executionUserId, deletedAt: clock() })
      .where(eq(netdriveFiles.id, f.member.id));
    await expect(f.preparation.executionSnapshot(f.reservationId)).rejects.toThrow("POLICY_DENIED");
    await db
      .update(netdriveFiles)
      .set({ deletedAt: null })
      .where(eq(netdriveFiles.id, f.member.id));
    await db
      .update(federationInputTransfers)
      .set({ sha256: "b".repeat(64) })
      .where(eq(federationInputTransfers.id, f.member.id));
    await expect(f.preparation.executionSnapshot(f.reservationId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await db
      .update(federationInputTransfers)
      .set({ sha256: f.member.sha256 })
      .where(eq(federationInputTransfers.id, f.member.id));
    await db
      .update(federationInputAttempts)
      .set({ destinationEtag: "changed" })
      .where(eq(federationInputAttempts.generation, f.binding.generation));
    await expect(f.preparation.executionSnapshot(f.reservationId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
  } finally {
    await f.lease.release();
  }
});

async function inputReconciliationDecision(
  transfers: FederationInputTransfers,
  generation: string,
) {
  const plan = await transfers.reconciliationPlan(generation);
  return {
    snapshotDigest: plan.snapshotDigest,
    stoppedAt: clock().toISOString(),
    incidentId: "storage-maintenance-42",
    evidenceDigest: `sha256:${"e".repeat(64)}`,
    allWritersStopped: true as const,
    storageRequestsDrained: true as const,
  };
}

test("input reconciliation retains unknown allocation quota until attested drain and successful storage cleanup", async () => {
  const f = await inputTransferFixture();
  try {
    const started = await f.transfers.begin(f.member.id, f.agentId);
    const generation = started.attempt.generation;
    await f.transfers.preparing(f.agentId, generation);
    time = new Date(started.attempt.leaseUntil.getTime() + 1);
    await f.transfers.expire();
    const decision = await inputReconciliationDecision(f.transfers, generation);
    await expect(f.transfers.reconcile(generation, decision, actor.userId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await db.transaction((tx) =>
      cancelFederationInputImport(tx, f.reservationId, "CANCELLATION_REQUESTED", clock()),
    );
    expect(await f.transfers.reconciliationCandidates()).toContainEqual(
      expect.objectContaining({ generation }),
    );
    expect((await f.transfers.reconciliationPlan(generation)).executionStopped).toBe(true);
    for (const invalid of [
      { ...decision, snapshotDigest: `sha256:${"f".repeat(64)}` },
      { ...decision, stoppedAt: new Date(started.attempt.leaseUntil.getTime() - 1).toISOString() },
      { ...decision, stoppedAt: new Date(time.getTime() + 1).toISOString() },
    ])
      await expect(f.transfers.reconcile(generation, invalid, actor.userId)).rejects.toThrow(
        "OPERATION_CONFLICT",
      );
    let purges = 0,
      fail = true;
    const storage = new FederationInputStorage(
      f.transferService(),
      {
        ...unassembledInputStorage,
        createMultipartUpload: async () => {
          throw Error("Must not allocate again");
        },
        presignUploadPart: async () => {
          throw Error("Must not grant again");
        },
        findFederationInputUpload: async () => undefined,
        cleanupFederationInput: async (key) => {
          expect(key).toBe(started.attempt.storageKey);
          purges++;
          if (fail) throw Error("Storage unavailable");
        },
      },
      { clock },
    );
    expect(await storage.cleanup()).toBe(0);
    expect(purges).toBe(0);
    const [first, replay] = await Promise.all([
      f.transfers.reconcile(generation, decision, actor.userId),
      f.transferService().reconcile(generation, decision, actor.userId),
    ]);
    expect(replay).toEqual(first);
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
    expect(await storage.cleanup()).toBe(0);
    expect(purges).toBe(1);
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
    fail = false;
    expect(await storage.cleanup()).toBe(1);
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
    expect(await f.transferService().reconcile(generation, decision, actor.userId)).toEqual(first);
    await expect(
      f.transfers.reconcile(generation, { ...decision, incidentId: "changed" }, actor.userId),
    ).rejects.toThrow("OPERATION_CONFLICT");
    const events = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, generation),
          eq(auditLog.action, "federation.input.storage_reconciled"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe(actor.userId);
    const [attempt] = await db
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.generation, generation));
    expect(attempt).toMatchObject({
      state: "cleaned",
      uploadId: null,
      completionSettledAt: null,
      reconciliation: first,
    });
  } finally {
    await f.lease.release();
  }
});

test("input reconciliation handles absent completion without inventing an object or publishing files", async () => {
  const f = await inputVerificationFixture();
  try {
    const generation = f.binding.generation;
    await f.transfers.copied(f.agentId, f.copied);
    expect(await f.transfers.startCompletion(f.agentId, generation)).toBe(true);
    await db.transaction((tx) =>
      cancelFederationInputImport(tx, f.reservationId, "CANCELLATION_REQUESTED", clock()),
    );
    const attempt = await f.attempt();
    if (!attempt) throw Error("Missing attempt");
    const early = await inputReconciliationDecision(f.transfers, generation);
    await expect(f.transfers.reconcile(generation, early, actor.userId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    time = new Date(attempt.leaseUntil.getTime() + 1);
    const decision = await inputReconciliationDecision(f.transfers, generation);
    await expect(f.transfers.reconcile(generation, decision, executionUserId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    await f.transfers.reconcile(generation, decision, actor.userId);
    f.backend.head = async () => {
      throw Error("Attested drain must not need invented HEAD success");
    };
    expect(await f.recoverStorage().cleanup()).toBe(1);
    expect(f.cleanups()).toBe(1);
    expect(await f.attempt()).toMatchObject({
      state: "cleaned",
      completionSettledAt: null,
      destinationVersionId: null,
      verifiedAt: null,
    });
    expect((await f.inventory())[0]).toMatchObject({ state: "cancelled", reservedBytes: 0 });
  } finally {
    await f.lease.release();
  }
});

test("input reconciliation rejects stale snapshots and invalidates cleanup tokens after late allocation facts", async () => {
  const f = await inputTransferFixture();
  try {
    const started = await f.transfers.begin(f.member.id, f.agentId);
    const generation = started.attempt.generation;
    await f.transfers.preparing(f.agentId, generation);
    await db.transaction((tx) =>
      cancelFederationInputImport(tx, f.reservationId, "CANCELLATION_REQUESTED", clock()),
    );
    time = new Date(started.attempt.leaseUntil.getTime() + 1);
    const decision = await inputReconciliationDecision(f.transfers, generation);
    await f.transfers.reconcile(generation, decision, actor.userId);
    const oldCleanup = await f.transfers.beginCleanup(generation);
    expect(await f.transfers.allocated(generation, "late-upload")).toBe(false);
    expect((await f.transfers.reconciliationPlan(generation)).reconciliation).toBeNull();
    await expect(f.transfers.storageCleaned(generation, oldCleanup.token)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await expect(f.transfers.reconcile(generation, decision, actor.userId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
    const cleanup = await f.transfers.beginCleanup(generation);
    await f.transfers.storageCleaned(generation, cleanup.token);
    expect((await f.inventory())[0]?.reservedBytes).toBe(0);
  } finally {
    await f.lease.release();
  }
});

test("input reconciliation refuses a live receiver workflow and enforces platform browser permissions", async () => {
  const f = await inputTransferFixture();
  let runId: string | undefined;
  try {
    const started = await f.transfers.begin(f.member.id, f.agentId);
    const generation = started.attempt.generation;
    await f.transfers.preparing(f.agentId, generation);
    await db.transaction((tx) =>
      cancelFederationInputImport(tx, f.reservationId, "CANCELLATION_REQUESTED", clock()),
    );
    time = new Date(started.attempt.leaseUntil.getTime() + 1);
    const decision = await inputReconciliationDecision(f.transfers, generation);
    runId = crypto.randomUUID();
    await db.insert(workflowRuns).values({
      id: runId,
      name: "Waiting receiver",
      status: "running",
      submittedBy: executionUserId,
      input: {
        yaml: "name: waiting",
        role: "user",
        orgId: receiver.orgId,
        federationReservationId: f.reservationId,
      },
    });
    expect((await f.transfers.reconciliationPlan(generation)).executionStopped).toBe(false);
    await expect(f.transfers.reconcile(generation, decision, actor.userId)).rejects.toThrow(
      "DATA_WAITING",
    );
    function app(role: string, bound = true) {
      const h = new Hono();
      h.onError(createErrorHandler(pino({ level: "silent" })));
      h.use("*", async (c, next) => {
        c.set("principal" as never, { role, userId: bound ? actor.userId : null });
        await next();
      });
      h.route("/api", createAdminFederationStorageRoutes(f.transfers));
      return h;
    }
    const path = "/api/admin/federation/input-reconciliation";
    for (const role of ["user", "operator", "compute_provider", "guest"]) {
      expect((await app(role).request(path)).status).toBe(403);
      expect((await app(role).request(`${path}/${generation}`)).status).toBe(403);
      expect(
        (
          await app(role).request(`${path}/${generation}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(decision),
          })
        ).status,
      ).toBe(403);
    }
    expect((await app("platform_admin", false).request(path)).status).toBe(403);
    expect((await app("platform_admin").request(path)).status).toBe(200);
    expect((await app("platform_admin").request(`${path}/${generation}`)).status).toBe(200);
    await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, runId));
    const invalid = await app("platform_admin").request(`${path}/${generation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...decision, storageRequestsDrained: false }),
    });
    expect(invalid.status).toBe(400);
    const accepted = await app("platform_admin").request(`${path}/${generation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    expect(accepted.status).toBe(202);
    expect((await f.inventory())[0]?.reservedBytes).toBe(f.member.sizeBytes);
  } finally {
    if (runId) await db.delete(workflowRuns).where(eq(workflowRuns.id, runId));
    await f.lease.release();
  }
});

test("settlement projection frees source concurrency without restoring consumed credit", async () => {
  const f = await fixture(undefined, {}, undefined, {}, 1),
    service = f.service();
  await service.enqueue(actor, f.request);
  await service.deliverNext();
  // Seed only the already-settled projection; settlement service tests own authorization and balance writes.
  await db
    .update(federationOutbound)
    .set({ settledAmount: "53" })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  await service.enqueue(actor, f.request);
  const next = (amount: string) => ({
    ...f.request,
    operationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    maxAmount: amount,
  });
  await expect(service.enqueue(actor, next("48"))).rejects.toThrow("BUDGET_EXHAUSTED");
  await service.enqueue(actor, next("47"));
  await expect(service.enqueue(actor, next("0"))).rejects.toThrow("BUDGET_EXHAUSTED");
  expect((await row(f.request.operationId)).amount).toBe("60");
});

test("adjustment debit holds are included in new source admission without consuming task slots", async () => {
  const f = await fixture(undefined, {}, undefined, {}, 1),
    service = f.service();
  await service.enqueue(actor, f.request);
  await service.deliverNext();
  await db
    .update(federationOutbound)
    .set({ settledAmount: "40", adjustmentHeldAmount: "15" })
    .where(eq(federationOutbound.operationId, f.request.operationId));
  const next = (amount: string) => ({
    ...f.request,
    operationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    maxAmount: amount,
  });
  await expect(service.enqueue(actor, next("46"))).rejects.toThrow("BUDGET_EXHAUSTED");
  await service.enqueue(actor, next("45"));
  expect((await row(f.request.operationId)).settledAmount).toBe("40");
});

test("completion pool bootstraps existing source work and deduplicates workflow binding through outbound handoff", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims, federationCompletionPools: pools } = await import(
    "@kuintessence/db"
  );
  const storage = testCompletionStorage(),
    f = await workflowDelegationFixture();
  const original = await fixture();
  await original.service().enqueue(actor, original.request);
  const siteId = a.signing.siteId,
    capacity = new FederationCompletionCapacity(db, siteId, storage.guard);
  const config = {
    reserveId: storage.reserveId,
    capacityBytes: "10000",
    taskBytes: "60",
    marketBytes: "20",
  };
  try {
    await capacity.configure(config, actor.userId);
    const initial = await capacity.inspect();
    expect(initial.obligations).toBeGreaterThan(0);
    expect(
      await db
        .select()
        .from(claims)
        .where(
          eq(
            claims.intentId,
            `${original.request.agreementRevisionId}:${original.request.taskId}:1`,
          ),
        ),
    ).toHaveLength(1);
    await capacity.configure(
      { ...config, capacityBytes: (BigInt(initial.allocatedBytes) + 60n).toString() },
      actor.userId,
    );
    const bound = await bindWorkflowDelegation(
      f.lease,
      actor,
      "remote",
      f.invocation,
      f.plan,
      600,
      clock,
      undefined,
      storage.guard,
    );
    expect((await capacity.inspect()).obligations).toBe(initial.obligations + 1);
    storage.pressure();
    const accepted = await f
      .service(undefined, storage.guard)
      .enqueueForWorkflow(actor, f.lease, "remote", f.invocation, f.plan, 600);
    expect(accepted.operationId).toBe(bound.operationId);
    expect((await capacity.inspect()).obligations).toBe(initial.obligations + 1);
    expect((await original.service().enqueue(actor, original.request)).operationId).toBe(
      original.request.operationId,
    );
    const fresh = await fixture();
    await expect(fresh.service().enqueue(actor, fresh.request)).rejects.toThrow("STORAGE_PRESSURE");
  } finally {
    await db.delete(claims).where(eq(claims.localSiteId, siteId));
    await db.delete(pools).where(eq(pools.localSiteId, siteId));
  }
});

test("completion pool observation cannot extend source authorization and a failed recheck rolls back the charge", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims, federationCompletionPools: pools } = await import(
    "@kuintessence/db"
  );
  const storage = testCompletionStorage(),
    f = await fixture();
  let expire = false;
  const guard = {
    ...storage.guard,
    async inspect() {
      const value = await storage.guard.inspect();
      if (expire) time = new Date(Date.parse(f.request.expiresAt) + 1);
      return value;
    },
  };
  const siteId = a.signing.siteId,
    capacity = new FederationCompletionCapacity(db, siteId, guard);
  try {
    await capacity.configure(
      { reserveId: storage.reserveId, capacityBytes: "10000", taskBytes: "60", marketBytes: "20" },
      actor.userId,
    );
    const before = await capacity.inspect();
    expire = true;
    await expect(f.service(undefined, guard).enqueue(actor, f.request)).rejects.toThrow(
      "AUTHORIZATION_EXPIRED",
    );
    expect((await capacity.inspect()).allocatedBytes).toBe(before.allocatedBytes);
    expect(
      await db
        .select()
        .from(federationOutbound)
        .where(eq(federationOutbound.operationId, f.request.operationId)),
    ).toHaveLength(0);
  } finally {
    await db.delete(claims).where(eq(claims.localSiteId, siteId));
    await db.delete(pools).where(eq(pools.localSiteId, siteId));
  }
});

test("completion renewal gates a fresh result import but preserves original import replay", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims, federationCompletionPools: pools } = await import(
    "@kuintessence/db"
  );
  const f = await resultImportFixture(),
    storage = testCompletionStorage();
  await f.imports.cancel(actor, f.imported.id);
  const siteId = a.signing.siteId,
    cap = new FederationCompletionCapacity(db, siteId, storage.guard);
  const policy = {
    reserveId: storage.reserveId,
    capacityBytes: "10000",
    taskBytes: "60",
    marketBytes: "20",
  };
  const id = crypto.randomUUID();
  try {
    await cap.configure(policy, actor.userId);
    await db
      .update(claims)
      .set({ releasedAt: new Date() })
      .where(
        and(
          eq(claims.localSiteId, siteId),
          eq(claims.intentId, `${f.request.agreementRevisionId}:${f.request.taskId}:1`),
        ),
      );
    const before = await cap.inspect();
    await cap.configure(
      {
        ...policy,
        capacityBytes: (BigInt(before.allocatedBytes) + 50n).toString(),
        taskBytes: "10",
      },
      actor.userId,
    );
    const imports = new FederationResultImports(
      db,
      siteId,
      f.service(f.send).results,
      clock,
      storage.guard,
    );
    await expect(imports.enqueue(actor, f.request.operationId, id)).rejects.toThrow(
      "STORAGE_PRESSURE",
    );
    expect((await cap.inspect()).allocatedBytes).toBe(before.allocatedBytes);
    expect((await imports.enqueue(actor, f.request.operationId, f.imported.id)).state).toBe(
      "cancelled",
    );
    await cap.configure(policy, actor.userId);
    expect((await imports.enqueue(actor, f.request.operationId, id)).id).toBe(id);
    expect((await cap.inspect()).allocatedBytes).toBe(
      (BigInt(before.allocatedBytes) + 60n).toString(),
    );
  } finally {
    await db.delete(claims).where(eq(claims.localSiteId, siteId));
    await db.delete(pools).where(eq(pools.localSiteId, siteId));
  }
});

test("completion renewal preserves an accepted intent cancellation under physical storage pressure", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims, federationCompletionPools: pools } = await import(
    "@kuintessence/db"
  );
  const f = await fixture(),
    storage = testCompletionStorage(),
    siteId = a.signing.siteId;
  const service = f.service(undefined, storage.guard);
  await service.enqueue(actor, f.request);
  const cap = new FederationCompletionCapacity(db, siteId, storage.guard);
  try {
    await cap.configure(
      { reserveId: storage.reserveId, capacityBytes: "10000", taskBytes: "60", marketBytes: "20" },
      actor.userId,
    );
    const initial = await cap.inspect();
    storage.pressure();
    expect(await service.cancellations.request(actor, f.request.operationId)).toMatchObject({
      state: "queued",
    });
    expect((await cap.inspect()).allocatedBytes).toBe(initial.allocatedBytes);
  } finally {
    await db.delete(claims).where(eq(claims.localSiteId, siteId));
    await db.delete(pools).where(eq(pools.localSiteId, siteId));
  }
});

const taskMediaTest = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;

async function taskMediaFixture(kind: "task-input" | "task-result" = "task-input") {
  const f =
    kind === "task-input" ? await acceptedInputInventory(true, true) : await resultFixture();
  const local = kind === "task-input" ? actor : receiver;
  const signing = kind === "task-input" ? a.signing : b.signing;
  await permission.set({ ...local, capability: "media.export", enabled: true }, actor.userId);
  await permission.set({ ...local, capability: "asset.read", enabled: true }, actor.userId);
  const agentId = `media-object-${crypto.randomUUID()}`;
  transferAgentIds.push(agentId);
  await db.insert(agents).values({
    agentId,
    providerOrgId: local.orgId,
    siteName: "Task storage",
    schedulerType: "kubernetes",
    schedulerVersion: "test",
    status: "online",
  });
  if (kind === "task-result")
    await db
      .update(netdriveFiles)
      .set({ storageVersionId: "original-version" })
      .where(eq(netdriveFiles.id, f.fileId));
  const ageDirectory = process.env.KQ_MEDIA_AGE_TEST_BIN;
  if (!ageDirectory) throw new Error("Real age required for task media tests");
  const age = new MediaAge(ageDirectory);
  const sources = new FederationTaskMediaSources(
    db,
    signing.siteId,
    f.service(),
    new FederationResultResponder(db, signing, clock),
  );
  const service = (keygen: Pick<MediaAge, "generateIdentity"> = age) =>
    new FederationMediaExportService(
      db,
      signing,
      keygen,
      "task-media-test-wrapping-key-not-for-deployment",
      clock,
      sources,
    );
  const input = {
    kind,
    packageId: crypto.randomUUID(),
    operationId: f.saved.operationId,
    agreementRevisionId: f.terms.agreementRevisionId,
    recipientSiteId: kind === "task-input" ? b.signing.siteId : a.signing.siteId,
    agentId,
    expiresAt: new Date(clock().getTime() + 300_000).toISOString(),
  };
  const release = async () => {
    if ("lease" in f) await f.lease.release();
  };
  const authorize = async () => {
    const reader = await service().reader(input.packageId, { actor: local });
    return db.transaction((tx) =>
      service().assertExportAuthorized(tx, local.orgId, input.packageId, reader),
    );
  };
  return { f, local, signing, input, service, age, sources, authorize, release };
}

taskMediaTest.each(["task-input", "task-result"] as const)(
  "task media %s prepares original signed inventory without exposing object keys",
  async (kind) => {
    const t = await taskMediaFixture(kind);
    try {
      const app = new Hono();
      app.onError(createErrorHandler(pino({ level: "silent" })));
      app.use("*", async (c, next) => {
        c.set("principal" as never, t.local as never);
        await next();
      });
      app.route(
        "/api",
        createFederationMediaRoutes(
          new FederationMediaPackageService(db, t.signing.siteId, clock),
          t.service(),
        ),
      );
      const post = (body: unknown) =>
        app.request("/api/federation/media/exports", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const response = await post(t.input);
      expect(response.status).toBe(201);
      const body = await response.text();
      const saved = await t.authorize();
      expect(saved.taskSelection).toEqual({
        kind,
        operationId: t.input.operationId,
        agentId: t.input.agentId,
      });
      expect(saved.versionId).toBeNull();
      expect(saved.locationId).toBeNull();
      const signed = await verifyFederationMessage(
        FederationMediaManifestSchema,
        saved.manifestJws,
        await trust.resolveKey(t.signing.siteId, t.signing.keyId, clock()),
        clock(),
      );
      expect(signed.digest).toBe(saved.manifestDigest);
      expect(signed.payload.subject).toMatchObject({
        kind,
        operationId: t.f.saved.operationId,
        taskId: t.f.saved.taskId,
        attempt: t.f.saved.attempt,
        requestDigest: t.f.saved.requestDigest,
      });
      expect(saved.manifest.files.map((file) => file.path)).toEqual(
        kind === "task-input" ? ["objects/000000", "objects/000001"] : ["objects/000000"],
      );
      expect(
        saved.manifest.files.every((file) => file.license === null && file.provenance === null),
      ).toBe(true);
      if (!("objects" in saved.source)) throw new Error("Expected object source");
      for (const secret of [
        saved.identityEncrypted,
        t.f.fileId,
        "AGE-SECRET-KEY",
        "original-version",
        ...saved.source.objects.map((file) => file.storageKey),
      ])
        expect(body).not.toContain(secret);
      expect(await t.service().prepare(t.local, t.input)).toEqual(
        await t.service().details(t.local, t.input.packageId),
      );
      expect(
        (await t.service().list(t.local)).some((row) => row.packageId === t.input.packageId),
      ).toBe(true);
      for (const extra of [
        { taskId: crypto.randomUUID() },
        { files: [] },
        { url: "https://storage.invalid" },
        { versionId: crypto.randomUUID() },
      ])
        expect((await post({ ...t.input, ...extra })).status).toBe(400);
      // An unconfigured object storage backend must still keep task dispatch closed.
      await expect(
        new FederationMediaExportOperations(db, t.signing.siteId, t.service(), clock).start(
          t.local,
          t.input.packageId,
        ),
      ).rejects.toThrow("POLICY_DENIED");
      await expect(
        db.transaction((tx) =>
          t.service().assertExportAuthorized(tx, t.local.orgId, t.input.packageId),
        ),
      ).rejects.toThrow("POLICY_DENIED");
      await expect(
        t.service().prepare(t.local, {
          ...t.input,
          expiresAt: new Date(Date.parse(t.input.expiresAt) + 1000).toISOString(),
        }),
      ).rejects.toThrow("OPERATION_CONFLICT");
    } finally {
      await t.release();
    }
  },
);

taskMediaTest.each(["task-input", "task-result"] as const)(
  "task media %s rejects foreign scope and changed file versions",
  async (kind) => {
    const t = await taskMediaFixture(kind);
    try {
      for (const patch of [
        { recipientSiteId: crypto.randomUUID() },
        { agreementRevisionId: crypto.randomUUID() },
        { operationId: crypto.randomUUID() },
        { agentId: "unregistered" },
      ])
        await expect(t.service().prepare(t.local, { ...t.input, ...patch })).rejects.toThrow();
      await expect(
        t.service().prepare(kind === "task-input" ? receiver : actor, t.input),
      ).rejects.toThrow("POLICY_DENIED");
      await t.service().prepare(t.local, t.input);
      const [original] = await db
        .select()
        .from(netdriveFiles)
        .where(eq(netdriveFiles.id, t.f.fileId));
      if (!original) throw new Error("Missing source");
      for (const patch of [
        { storageVersionId: "replacement" },
        { storageKey: "another-key" },
        { deletedAt: clock() },
        { ownerId: kind === "task-input" ? receiver.userId : actor.userId },
        { sha256: "f".repeat(64) },
      ]) {
        try {
          await db.update(netdriveFiles).set(patch).where(eq(netdriveFiles.id, t.f.fileId));
          await expect(t.authorize()).rejects.toThrow();
          await expect(t.service().prepare(t.local, t.input)).rejects.toThrow();
        } finally {
          await db.update(netdriveFiles).set(original).where(eq(netdriveFiles.id, original.id));
        }
      }
      await permission.set(
        { ...t.local, capability: "media.export", enabled: false },
        actor.userId,
      );
      await expect(t.authorize()).rejects.toThrow("POLICY_DENIED");
      await permission.set({ ...t.local, capability: "media.export", enabled: true }, actor.userId);
      expect((await t.authorize()).packageId).toBe(t.input.packageId);
      await t.service().revoke(t.local, t.input.packageId, { reason: "Withdraw export" });
      await expect(t.authorize()).rejects.toThrow("POLICY_DENIED");
    } finally {
      await permission.set({ ...t.local, capability: "media.export", enabled: true }, actor.userId);
      await t.release();
    }
  },
);

taskMediaTest(
  "task media input requires original human owner and a live original workflow after preflight",
  async () => {
    const t = await taskMediaFixture();
    try {
      const read = await t.sources.authorize(t.local, t.input);
      const saved = await db.transaction(read);
      expect(saved.subject).toMatchObject({ contentDigest: t.f.saved.request.inputFilesDigest });
      const binding = await db
        .select()
        .from(workflowExecutionDelegations)
        .where(eq(workflowExecutionDelegations.operationId, t.input.operationId));
      const runId = binding[0]?.runId;
      if (!runId) throw new Error("Missing original workflow");
      await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, runId));
      await expect(db.transaction(read)).rejects.toThrow("CANCELLATION_REQUESTED");
      await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, runId));
      const [owner] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      await db
        .update(workflowRuns)
        .set({ submittedBy: receiver.userId })
        .where(eq(workflowRuns.id, runId));
      await expect(db.transaction(read)).rejects.toThrow("POLICY_DENIED");
      await db
        .update(workflowRuns)
        .set({ submittedBy: owner?.submittedBy })
        .where(eq(workflowRuns.id, runId));
      const receipt = t.f.saved.receipt;
      if (!receipt) throw new Error("Missing acceptance");
      await db
        .update(federationOutbound)
        .set({ receipt: { ...receipt, taskId: crypto.randomUUID() } })
        .where(eq(federationOutbound.operationId, t.input.operationId));
      await expect(db.transaction(read)).rejects.toThrow("OPERATION_CONFLICT");
      await db
        .update(federationOutbound)
        .set({ receipt })
        .where(eq(federationOutbound.operationId, t.input.operationId));
      await t.f.service().cancellations.request(t.local, t.input.operationId);
      await expect(db.transaction(read)).rejects.toThrow();
    } finally {
      await t.release();
    }
  },
);

taskMediaTest(
  "task media result keeps its independent disclosure window and requires pinned completed artifacts",
  async () => {
    const t = await taskMediaFixture("task-result");
    try {
      time = new Date("2026-01-03T00:00:00.000Z");
      t.input.expiresAt = new Date(clock().getTime() + 300_000).toISOString();
      await t.service().prepare(t.local, t.input);
      expect((await t.authorize()).manifest.subject.kind).toBe("task-result");
      for (const storageVersionId of [null, "null", "", "a".repeat(1025)]) {
        await db
          .update(netdriveFiles)
          .set({ storageVersionId })
          .where(eq(netdriveFiles.id, t.f.fileId));
        await expect(t.authorize()).rejects.toThrow("ASSET_UNAVAILABLE");
      }
      await db
        .update(netdriveFiles)
        .set({ storageVersionId: "original-version" })
        .where(eq(netdriveFiles.id, t.f.fileId));
      const [binding] = await db
        .select()
        .from(federationWorkflowBindings)
        .where(
          eq(federationWorkflowBindings.reservationId, t.f.saved.receipt?.reservationId ?? ""),
        );
      if (!binding) throw new Error("Missing binding");
      await db
        .update(workflowRuns)
        .set({ status: "running" })
        .where(eq(workflowRuns.id, binding.workflowRunId));
      await expect(t.authorize()).rejects.toThrow("DATA_WAITING");
      await db
        .update(workflowRuns)
        .set({ status: "completed" })
        .where(eq(workflowRuns.id, binding.workflowRunId));
      await db
        .delete(workflowArtifacts)
        .where(eq(workflowArtifacts.workflowRunId, binding.workflowRunId));
      await expect(t.authorize()).rejects.toThrow("ASSET_UNAVAILABLE");
    } finally {
      await t.release();
    }
  },
);

taskMediaTest.each(["task-input", "task-result"] as const)(
  "task media %s rechecks after real key generation and rolls back stale snapshots",
  async (kind) => {
    const t = await taskMediaFixture(kind);
    let identity: Buffer | undefined;
    try {
      const changing = t.service({
        async generateIdentity(signal) {
          const result = await t.age.generateIdentity(signal);
          identity = result.identity;
          await db
            .update(netdriveFiles)
            .set({ storageVersionId: "changed-during-generation" })
            .where(eq(netdriveFiles.id, t.f.fileId));
          return result;
        },
      });
      await expect(changing.prepare(t.local, t.input)).rejects.toThrow();
      expect(identity?.every((byte) => byte === 0)).toBe(true);
      expect(
        await db
          .select()
          .from(federationMediaExports)
          .where(eq(federationMediaExports.packageId, t.input.packageId)),
      ).toHaveLength(0);
    } finally {
      await t.release();
    }
  },
);

taskMediaTest(
  "task media database rejects mixed selectors and mismatched task identity",
  async () => {
    const t = await taskMediaFixture();
    try {
      await t.service().prepare(t.local, t.input);
      const saved = await t.authorize();
      if (!saved.taskSelection) throw new Error("Missing selector");
      for (const patch of [
        { taskSelection: null },
        { taskSelection: { ...saved.taskSelection, operationId: crypto.randomUUID() } },
        { taskSelection: { ...saved.taskSelection, kind: "task-result" as const } },
        {
          source: {
            agentId: t.input.agentId,
            managedRootId: crypto.randomUUID(),
            relativePath: "fake",
          },
        },
      ])
        await expect(
          db.transaction((tx) =>
            tx
              .update(federationMediaExports)
              .set(patch)
              .where(eq(federationMediaExports.packageId, t.input.packageId)),
          ),
        ).rejects.toThrow();
      expect((await t.authorize()).manifestDigest).toBe(saved.manifestDigest);
    } finally {
      await t.release();
    }
  },
);

taskMediaTest.each(["task-input", "task-result"] as const)(
  "task media %s key grants are peer bound, deadline capped and rechecked on replay",
  async (kind) => {
    const t = await taskMediaFixture(kind);
    const peer = kind === "task-input" ? b : a;
    const fingerprint = kind === "task-input" ? targetFingerprint : sourceFingerprint;
    const condition = and(
      eq(federationSigningKeys.siteId, peer.signing.siteId),
      eq(federationSigningKeys.keyId, peer.signing.keyId),
    );
    try {
      const prepared = await t.service().prepare(t.local, t.input);
      const pair = await generateKeyPair("RSA-OAEP-256", { extractable: true });
      const jwk = await exportJWK(pair.publicKey);
      const query = FederationMediaKeyQuerySchema.parse({
        protocolVersion: 1,
        kind: "media-key-query",
        queryId: crypto.randomUUID(),
        senderSiteId: peer.signing.siteId,
        recipientSiteId: t.signing.siteId,
        packageId: t.input.packageId,
        agreementRevisionId: t.input.agreementRevisionId,
        manifestDigest: prepared.manifestDigest,
        authorizationId: crypto.randomUUID(),
        agentId: "target-media-node",
        managedRootId: crypto.randomUUID(),
        recipientKey: { kty: jwk.kty, n: jwk.n, e: jwk.e },
        maxBytes: 32,
        authorizationExpiresAt: t.input.expiresAt,
        issuedAt: clock().toISOString(),
        expiresAt: new Date(clock().getTime() + 30_000).toISOString(),
      });
      const jws = await signFederationMessage(FederationMediaKeyQuerySchema, query, peer.signing);
      const responder = new FederationMediaKeyResponder(db, t.signing, t.service(), clock);
      await expect(responder.respond(jws, "ee".repeat(32))).rejects.toThrow();
      await db
        .update(federationSigningKeys)
        .set({ validUntil: new Date(clock().getTime() + 10_000) })
        .where(condition);
      const first = await responder.respond(jws, fingerprint);
      const grant = await verifyFederationMessage(
        FederationMediaKeyGrantSchema,
        first,
        await trust.resolveKey(t.signing.siteId, t.signing.keyId, clock()),
        clock(),
      );
      expect(Date.parse(grant.payload.expiresAt)).toBe(clock().getTime() + 10_000);
      expect(await responder.respond(jws, fingerprint)).toBe(first);
      await db
        .update(netdriveFiles)
        .set({ storageVersionId: "changed-after-key" })
        .where(eq(netdriveFiles.id, t.f.fileId));
      await expect(responder.respond(jws, fingerprint)).rejects.toThrow();
      await expect(
        responder.respond(
          await signFederationMessage(
            FederationMediaKeyQuerySchema,
            { ...query, agreementRevisionId: crypto.randomUUID() },
            peer.signing,
          ),
          fingerprint,
        ),
      ).rejects.toThrow("POLICY_DENIED");
    } finally {
      await db
        .update(federationSigningKeys)
        .set({ validUntil: peer.verification.validUntil })
        .where(condition);
      await t.release();
    }
  },
);

async function taskObjectExportFixture() {
  const t = await taskMediaFixture();
  await t.service().prepare(t.local, t.input);
  const saved = await t.authorize();
  if (!("objects" in saved.source) || !saved.source.objects[0]) throw new Error("Missing source");
  const object = saved.source.objects[0];
  const calls: string[] = [];
  const backend: FederationDownloadStorage = {
    allowedOrigins: ["https://local-storage.invalid"],
    storage: {
      async head(key, version) {
        calls.push("head");
        expect(key).toBe(object.storageKey);
        expect(version).toBe(object.versionId);
        return {
          size: object.sizeBytes,
          versionId: object.versionId,
          etag: "test",
          contentType: "application/octet-stream",
          lastModified: clock(),
        };
      },
      async presignDownload(key, seconds, _filename, version) {
        calls.push("presign");
        expect(key).toBe(object.storageKey);
        expect(version).toBe(object.versionId);
        const params = new URLSearchParams({
          versionId: version ?? "",
          "X-Amz-Date": clock()
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(/\.\d{3}Z$/, "Z"),
          "X-Amz-Expires": String(seconds),
          "X-Amz-Signature": "test-not-real-storage-signature",
        });
        return `https://local-storage.invalid/object?${params}`;
      },
    },
  };
  const operations = new FederationMediaExportOperations(
    db,
    t.signing.siteId,
    t.service(),
    clock,
    () => backend,
  );
  const operation = await operations.start(t.local, t.input.packageId);
  const { task } = await operations.task(t.input.agentId, t.input.packageId);
  const binding = {
    generation: operation.generation,
    packageId: t.input.packageId,
    manifestDigest: saved.manifestDigest,
    fileIndex: 0,
    path: object.path,
    sizeBytes: object.sizeBytes,
    sha256: object.sha256,
    versionId: object.versionId,
  };
  return { ...t, saved, object, calls, backend, operations, operation, task, binding };
}

taskMediaTest(
  "task object export pins members, keeps keys private and fences retry generations",
  async () => {
    const f = await taskObjectExportFixture();
    try {
      expect("objects" in f.task).toBe(true);
      for (const secret of [f.object.storageKey, f.object.fileId, f.saved.identityEncrypted])
        expect(JSON.stringify(f.task)).not.toContain(secret);
      expect(await f.operations.start(f.local, f.input.packageId)).toEqual(f.operation);
      const grant = await f.operations.objectGrant(f.input.agentId, f.binding);
      expect(grant.binding).toEqual(f.binding);
      expect(Date.parse(grant.expiresAt)).toBe(clock().getTime() + 30_000);
      expect(f.calls).toEqual(["head", "presign"]);
      f.calls.length = 0;
      for (const change of [
        { generation: crypto.randomUUID() },
        { fileIndex: 3 },
        { versionId: "other" },
        { path: "objects/000001" },
        { sha256: "b".repeat(64) },
      ])
        await expect(
          f.operations.objectGrant(f.input.agentId, { ...f.binding, ...change }),
        ).rejects.toThrow("OPERATION_CONFLICT");
      await expect(f.operations.objectGrant("foreign-agent", f.binding)).rejects.toThrow(
        "POLICY_DENIED",
      );
      expect(f.calls).toEqual([]);
      const report = {
        generation: f.operation.generation,
        packageId: f.input.packageId,
        manifestDigest: f.saved.manifestDigest,
        state: "failed",
      };
      await f.operations.report(f.input.agentId, report);
      const retry = await f.operations.start(f.local, f.input.packageId);
      expect(retry.generation).not.toBe(f.operation.generation);
      await expect(f.operations.objectGrant(f.input.agentId, f.binding)).rejects.toThrow(
        "OPERATION_CONFLICT",
      );
      await f.operations.report(f.input.agentId, {
        ...report,
        state: "exported",
        generation: retry.generation,
        sha256: "c".repeat(64),
        sizeBytes: 123,
      });
      await expect(
        f.operations.objectGrant(f.input.agentId, { ...f.binding, generation: retry.generation }),
      ).rejects.toThrow("OPERATION_CONFLICT");
    } finally {
      await f.release();
    }
  },
);

taskMediaTest.each([
  "head-version",
  "head-size",
  "no-version-url",
  "foreign-origin",
  "overlong-url",
  "revoked",
  "file-changed",
] as const)("task object export denies storage or authorization change: %s", async (mode) => {
  const f = await taskObjectExportFixture();
  try {
    const head = f.backend.storage.head.bind(f.backend.storage),
      presign = f.backend.storage.presignDownload.bind(f.backend.storage);
    f.backend.storage.head = async (...args) => {
      const stat = await head(...args);
      return (
        stat && {
          ...stat,
          ...(mode === "head-version"
            ? { versionId: "wrong" }
            : mode === "head-size"
              ? { size: 88 }
              : {}),
        }
      );
    };
    f.backend.storage.presignDownload = async (...args) => {
      if (mode === "revoked")
        await f
          .service()
          .revoke(f.local, f.input.packageId, { reason: "Withdraw while presigning" });
      if (mode === "file-changed")
        await db
          .update(netdriveFiles)
          .set({ storageVersionId: "changed" })
          .where(eq(netdriveFiles.id, f.f.fileId));
      const url = new URL(await presign(...args));
      if (mode === "no-version-url") url.searchParams.delete("versionId");
      if (mode === "foreign-origin") url.hostname = "elsewhere.invalid";
      if (mode === "overlong-url") url.searchParams.set("X-Amz-Expires", "31");
      return url.href;
    };
    await expect(f.operations.objectGrant(f.input.agentId, f.binding)).rejects.toThrow();
    if (mode.startsWith("head-")) expect(f.calls).toEqual(["head"]);
  } finally {
    await f.release();
  }
});

taskMediaTest(
  "task object transport requires new authenticated capability and drops disconnected grants",
  async () => {
    const f = await taskObjectExportFixture();
    try {
      const dispatcher = new AgentDispatcher();
      const sent: ServerMessage[] = [];
      const channel = {
        push: (message: ServerMessage) => {
          sent.push(message);
        },
        close: () => {},
        federationMediaExportV1: true,
        federationMediaObjectExportV1: false,
        verifiedCertFingerprint: "fixture",
      };
      dispatcher.register(f.input.agentId, channel);
      const transport = new FederationMediaExportTransport(f.operations, dispatcher);
      expect(await transport.dispatch(f.input.agentId, f.input.packageId)).toBe(false);
      expect(sent).toHaveLength(0);
      const request = create(FederationMediaExportLeaseRequestSchema, {
        requestId: crypto.randomUUID(),
        bindingJson: JSON.stringify(f.binding),
      });
      await expect(transport.grant(f.input.agentId, request)).rejects.toThrow("POLICY_DENIED");
      expect(f.calls).toEqual([]);
      channel.federationMediaObjectExportV1 = true;
      expect(await transport.dispatch(f.input.agentId, f.input.packageId)).toBe(true);
      expect(sent[0]?.payload.case).toBe("federationMediaExport");
      expect(
        JSON.parse((await transport.grant(f.input.agentId, request)).grantJson).binding,
      ).toEqual(f.binding);
      const presign = f.backend.storage.presignDownload.bind(f.backend.storage);
      f.backend.storage.presignDownload = async (...args) => {
        dispatcher.register(f.input.agentId, { ...channel });
        return presign(...args);
      };
      await expect(transport.grant(f.input.agentId, request)).rejects.toThrow("POLICY_DENIED");
    } finally {
      await f.release();
    }
  },
);
