import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
  federationSigningKeys,
  federationSites,
  federationWorkflowBindings,
  jobs,
  netdriveFiles,
  orgs,
  softwareAssetRevisions,
  softwareAssets,
  userOrgMemberships,
  users,
  workflowArtifactFiles,
  workflowArtifacts,
  workflowRuns,
} from "@kuintessence/db";
import { workflowDsl } from "@kuintessence/shared";
import {
  FederationAcceptanceSchema,
  type FederationAgreement,
  FederationAgreementSchema,
  FederationCancellationReceiptSchema,
  FederationCancellationSchema,
  FederationResultQuerySchema,
  FederationResultReportSchema,
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
} from "@kuintessence/shared/federation";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import { createFederationOutboundRoutes } from "../routes/federation-outbound";
import { artifactBatchHash } from "../services/artifact-members";
import { WorkflowAsyncRunner } from "../workflow/async-runner";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationCancellationReceiver } from "./cancellation";
import { FederationCancellationMonitor } from "./cancellation-monitor";
import { FederationOutboundService } from "./outbound";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { FederationPermissionService } from "./permissions";
import { FederationPreparationService } from "./preparation";
import { FederationResultResponder } from "./results";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { FederationStatusResponder } from "./status";
import { testAgreement, testDelegation, testKeys, testNow } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

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
const revisions: string[] = [];
const assetIds: string[] = [];
const agreements: FederationAgreement[] = [];
const sourceFingerprint = "ab".repeat(32);
const targetFingerprint = "cd".repeat(32);

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
  await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.orgId, orgIds));
  await db.delete(users).where(inArray(users.id, [actor.userId, receiver.userId, executionUserId]));
  await db.delete(orgs).where(inArray(orgs.id, orgIds));
  await db.$client.end();
});

async function fixture(resultPolicy?: FederationAgreement["resultPolicy"]) {
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
    parameters: {},
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
