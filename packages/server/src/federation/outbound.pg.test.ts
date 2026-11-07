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
  federationMaterials,
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
  FederationResultCopyReportSchema,
  FederationResultGrantRequestSchema,
  type ServerMessage,
} from "@kuintessence/proto";
import { WorkflowExecutionInterrupted, workflowDsl } from "@kuintessence/shared";
import {
  FederationAcceptanceSchema,
  type FederationAgreement,
  FederationAgreementSchema,
  type FederationAssetRef,
  FederationCancellationReceiptSchema,
  FederationCancellationSchema,
  FederationMaterialChunkSchema,
  FederationMaterialQuerySchema,
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
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import { AgentDispatcher } from "../grpc/dispatcher";
import { createFederationOutboundRoutes } from "../routes/federation-outbound";
import { artifactBatchHash } from "../services/artifact-members";
import { NetDriveService } from "../services/netdrive";
import { StorageQuotaService } from "../services/storage-quota";
import type { ObjectStat } from "../storage/minio-client";
import { FakeMinioBackend } from "../storage/minio-client.test";
import { WorkflowAsyncRunner } from "../workflow/async-runner";
import { WorkflowExecutionJournalStore } from "../workflow/execution-journal";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationCancellationReceiver } from "./cancellation";
import { FederationCancellationMonitor } from "./cancellation-monitor";
import { createFederationIngress } from "./ingress";
import { FederationMaterialExchange } from "./material-exchange";
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
import { testAgreement, testDelegation, testKeys, testNow } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";
import { bindWorkflowDelegation, type WorkflowDelegationPlan } from "./workflow-delegations";

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
const revisions: string[] = [];
const transferAgentIds: string[] = [];
const assetIds: string[] = [];
const agreements: FederationAgreement[] = [];
const sourceFingerprint = "ab".repeat(32);
const targetFingerprint = "cd".repeat(32);

afterEach(async () => {
  // Binding tests deliberately leave pending tasks; subsequent fixtures must not dispatch them.
  if (!sourceRunIds.length) return;
  await db
    .update(federationOutbound)
    .set({
      nextAttemptAt: new Date("2030-01-01T00:00:00Z"),
      cancelNextAttemptAt: new Date("2030-01-01T00:00:00Z"),
    })
    .where(
      inArray(
        federationOutbound.operationId,
        db
          .select({ operationId: workflowExecutionDelegations.operationId })
          .from(workflowExecutionDelegations)
          .where(inArray(workflowExecutionDelegations.runId, sourceRunIds)),
      ),
    );
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
  await db.delete(users).where(inArray(users.id, [actor.userId, receiver.userId, executionUserId]));
  await db.delete(orgs).where(inArray(orgs.id, orgIds));
  await db.$client.end();
});

async function fixture(
  resultPolicy?: FederationAgreement["resultPolicy"],
  parameters: Record<string, string | number> = {},
) {
  time = new Date(testNow);
  const terms = testAgreement(a.signing.siteId, b.signing.siteId);
  if (resultPolicy) terms.resultPolicy = resultPolicy;
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
    inputs: {},
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
  const service = (send: FederationSend = receive) =>
    new FederationOutboundService(db, a.signing, send, assets, clock);
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

async function workflowDelegationFixture() {
  const f = await fixture();
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

test("cancellation preserves an acceptance that arrives after the stop intent", async () => {
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
  } finally {
    release();
    await sending;
  }
  const saved = await row(f.request.operationId);
  expect(saved).toMatchObject({ state: "accepted", cancelState: "stopped", amount: "60" });
  if (!saved.receipt || !saved.cancelReceipt?.reservationId)
    throw new Error("Missing matching remote receipts");
  expect(saved.receipt.reservationId).toBe(saved.cancelReceipt.reservationId);
});

const resultPolicy: NonNullable<FederationAgreement["resultPolicy"]> = {
  scope: "persistent-files",
  maxFiles: 4,
  maxBytes: 20,
  availableUntil: "2026-01-04T00:00:00.000Z",
};
async function resultFixture(policy = resultPolicy) {
  const f = await fixture(policy);
  await permission.set({ ...actor, capability: "result.read", enabled: true }, actor.userId);
  await f.service().enqueue(actor, f.request);
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
  return { ...f, saved, runId, jobId, artifactId, fileId, responder, send, read };
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

async function resultImportFixture(fileCount = 1) {
  const f = await resultFixture();
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

async function resultStorageFixture(fileCount = 1) {
  const f = await resultImportFixture(fileCount);
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

async function publishableResults(fileCount = 1) {
  const f = await resultStorageFixture(fileCount);
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
  expect(f.purged).toHaveLength(1);
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
  const worker = new FederationPreparationWorker(db, f.preparation, undefined, undefined, (id) =>
    exchange.ensure(id),
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
  expect(await receivedMaterials()).toHaveLength(2);
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
