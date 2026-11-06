import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  auditLog,
  createPgDb,
  federationAgreementApprovals,
  federationAgreements,
  federationAssetMappings,
  federationBudgets,
  federationCapabilities,
  federationEvidence,
  federationMaterials,
  federationOutbound,
  federationReservations,
  federationSigningKeys,
  federationSites,
  orgs,
  softwareAssetRevisions,
  softwareAssets,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  type FederationAgreement,
  FederationAgreementSchema,
} from "@kuintessence/shared/federation";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import { createFederationOutboundRoutes } from "../routes/federation-outbound";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationOutboundService } from "./outbound";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage } from "./signatures";
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
        allowedKinds: ["agreement", "delegation", "acceptance"],
        validFrom: key.verification.validFrom.toISOString(),
        validUntil: key.verification.validUntil.toISOString(),
      },
      actor.userId,
    );
  }
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
  await db
    .delete(federationReservations)
    .where(inArray(federationReservations.agreementRevisionId, termsIds));
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
    .delete(federationSigningKeys)
    .where(inArray(federationSigningKeys.siteId, [a.signing.siteId, b.signing.siteId]));
  await db
    .delete(federationSites)
    .where(inArray(federationSites.id, [a.signing.siteId, b.signing.siteId]));
  await db.delete(auditLog).where(inArray(auditLog.orgId, orgIds));
  await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.orgId, orgIds));
  await db.delete(users).where(inArray(users.id, [actor.userId, receiver.userId, executionUserId]));
  await db.delete(orgs).where(inArray(orgs.id, orgIds));
  await db.$client.end();
});

async function fixture() {
  time = new Date(testNow);
  const terms = testAgreement(a.signing.siteId, b.signing.siteId);
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
  return { terms, request, receive, sent, service };
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
