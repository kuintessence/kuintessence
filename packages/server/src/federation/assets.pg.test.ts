import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  agents,
  auditLog,
  createPgDb,
  dataAssets,
  dataAssetVersions,
  dataLocations,
  federationAgreements,
  federationAssetMappings,
  federationAttestationOutbox,
  federationBudgets,
  federationCapabilities,
  federationEvidence,
  federationMaterials,
  federationPreparations,
  federationReservations,
  federationSigningKeys,
  federationSites,
  federationWorkflowBindings,
  jobDispatchOutbox,
  jobs,
  orgs,
  schedulerQueues,
  softwareAssetRevisions,
  softwareAssets,
  softwareOperations,
  userOrgMemberships,
  users,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import {
  FederationExecutionDecision,
  FederationExecutionRequestSchema,
  type FederationExecutionResponse,
} from "@kuintessence/proto";
import {
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  type FederationAssetRef,
  FederationDelegationSchema,
  type FederationEnvironmentLock,
  FederationError,
  type FederationInputManifest,
  federationCanonicalJson,
  federationExecutionDeadline,
} from "@kuintessence/shared/federation";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { AgentDispatcher } from "../grpc/dispatcher";
import { JobDispatchOutbox } from "../grpc/job-dispatch-outbox";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationAssetRoutes } from "../routes/federation-assets";
import { QueueRegistryService } from "../services/queue-registry";
import { SoftwareAvailabilityService } from "../services/software-availability";
import { InstalledRegistry } from "../software-governance/installed-registry";
import { SoftwareOperationService } from "../software-governance/operation-service";
import { WorkflowAsyncRunner } from "../workflow/async-runner";
import { WorkflowExecutionJournalStore } from "../workflow/execution-journal";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { FederationAdmission } from "./admission";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationDispatchAuthorization } from "./dispatch-authorization";
import {
  FederationExecutionBindingService,
  loadFederationWorkflowBinding,
} from "./execution-binding";
import { FederationExecutionMonitor } from "./execution-monitor";
import { FederationPermissionService } from "./permissions";
import { FederationPreparationService } from "./preparation";
import { FederationPreparationWorker } from "./preparation-worker";
import { signFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys, testNow } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Federation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const actor = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const identity = { orgId: actor.orgId, userId: crypto.randomUUID() };
const approvedTarget = {
  providerOrgId: actor.orgId,
  clusterId: "federation-test-cluster",
  agentId: `federation-target-${crypto.randomUUID()}`,
  queueId: `federation-queue-${crypto.randomUUID()}`,
};
const outsider = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const assetId = crypto.randomUUID(),
  revisionId = crypto.randomUUID(),
  datasetId = crypto.randomUUID(),
  versionId = crypto.randomUUID(),
  locationId = crypto.randomUUID();
const content = "printf 'ready\\n'";
const payload = {
  runtimeContractRef: { name: "bash", version: "1" },
  kind: "sandbox-script",
  language: "bash",
  content,
  entrypoint: "main.sh",
  sha256: createHash("sha256").update(content).digest("hex"),
  inputs: { count: { type: "Text", required: true } },
  outputs: {},
};
const availability = new SoftwareAvailabilityService(db);
const assets = new FederationAssetService(db, {
  authorizeSoftware: (id, principal, capability) =>
    availability.assertAssetCapability(id, principal, capability),
});
let source: Awaited<ReturnType<typeof testKeys>>;
let target: Awaited<ReturnType<typeof testKeys>>;
let scriptRef: FederationAssetRef;
let datasetRef: FederationAssetRef;
let agreement: ReturnType<typeof testAgreement>;
let admission: FederationAdmission;
const reservations: string[] = [];

beforeAll(async () => {
  await db.insert(orgs).values([
    { id: actor.orgId, name: "Asset mapping test" },
    { id: outsider.orgId, name: "Other institution scope" },
  ]);
  await db.insert(users).values([
    { id: actor.userId, orgId: actor.orgId, email: `${actor.userId}@test.invalid`, role: "user" },
    {
      id: identity.userId,
      orgId: actor.orgId,
      email: `${identity.userId}@test.invalid`,
      role: "user",
      serviceAccount: true,
    },
    {
      id: outsider.userId,
      orgId: outsider.orgId,
      email: `${outsider.userId}@test.invalid`,
      role: "user",
    },
  ]);
  await db
    .insert(userOrgMemberships)
    .values([actor, identity, outsider].map((v) => ({ ...v, role: "member" })));
  const permissions = new FederationPermissionService(db);
  for (const subject of [actor, outsider])
    await permissions.set({ ...subject, capability: "asset.map", enabled: true }, actor.userId);
  [source, target] = await Promise.all([testKeys(), testKeys()]);
  const trust = new FederationTrustRegistry(db);
  for (const keys of [source, target]) {
    await trust.addSite(
      { id: keys.signing.siteId, name: "Test institution", endpoint: "https://test.invalid" },
      actor.userId,
    );
    await trust.addKey(
      keys.signing.siteId,
      {
        keyId: keys.signing.keyId,
        publicKeyPem: await exportSPKI(keys.verification.publicKey),
        allowedKinds: ["agreement", "delegation", "acceptance"],
        validFrom: keys.verification.validFrom.toISOString(),
        validUntil: keys.verification.validUntil.toISOString(),
      },
      actor.userId,
    );
  }
  scriptRef = {
    originSiteId: source.signing.siteId,
    kind: "script",
    id: crypto.randomUUID(),
    revision: "1",
    digest: federationMaterialDigest(payload),
  };
  datasetRef = {
    originSiteId: source.signing.siteId,
    kind: "dataset",
    id: crypto.randomUUID(),
    revision: "1",
    digest: `sha256:${"b".repeat(64)}`,
  };
  await db.insert(softwareAssets).values({
    id: assetId,
    kind: "sandbox-script",
    name: "Pinned test script",
    version: "1",
    source: "sp-published",
    lifecycle: "published",
    visibility: "platform-public",
    ownerUserId: actor.userId,
    payload,
  });
  await db.insert(softwareAssetRevisions).values({ id: revisionId, assetId, revision: 1, payload });
  await db.insert(dataAssets).values({
    id: datasetId,
    ownerKind: "user",
    ownerUserId: actor.userId,
    kind: "scientific-dataset",
    name: "Pinned input",
    lifecycle: "published",
    visibility: "public",
    accessMode: "open",
    sensitivity: "open",
    createdBy: actor.userId,
  });
  await db.insert(dataAssetVersions).values({
    id: versionId,
    dataAssetId: datasetId,
    version: "1",
    status: "ready",
    manifestDigest: datasetRef.digest,
    immutableAt: testNow,
    createdBy: actor.userId,
  });
  agreement = {
    ...testAgreement(source.signing.siteId, target.signing.siteId),
    templates: [scriptRef],
    executionTargets: [approvedTarget],
  };
  admission = new FederationAdmission(db, target.signing, target.verification, () => testNow);
  await admission.installApprovedAgreement({
    sourceApprovalJws: await signFederationMessage(
      FederationAgreementSchema,
      agreement,
      source.signing,
    ),
    targetApprovalJws: await signFederationMessage(
      FederationAgreementSchema,
      agreement,
      target.signing,
    ),
    sourceKey: source.verification,
    targetKey: target.verification,
    identity,
  });
});

afterAll(async () => {
  await db
    .delete(federationWorkflowBindings)
    .where(inArray(federationWorkflowBindings.reservationId, reservations));
  await db.delete(workflowRuns).where(eq(workflowRuns.submittedBy, identity.userId));
  if (reservations.length) {
    const evidence = db
      .select({ id: federationEvidence.id })
      .from(federationEvidence)
      .where(inArray(federationEvidence.reservationId, reservations));
    await db
      .delete(federationPreparations)
      .where(inArray(federationPreparations.reservationId, reservations));
    await db
      .delete(federationAttestationOutbox)
      .where(inArray(federationAttestationOutbox.evidenceId, evidence));
    await db
      .delete(federationEvidence)
      .where(inArray(federationEvidence.reservationId, reservations));
    await db.delete(federationReservations).where(inArray(federationReservations.id, reservations));
  }
  if (agreement) {
    await db
      .delete(federationAgreements)
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await db
      .delete(federationBudgets)
      .where(
        and(
          eq(federationBudgets.domainId, agreement.budgetDomainId),
          eq(federationBudgets.epoch, agreement.epoch),
        ),
      );
  }
  const orgIds = [actor.orgId, outsider.orgId];
  await db
    .delete(federationAssetMappings)
    .where(inArray(federationAssetMappings.localOrgId, orgIds));
  await db.delete(federationMaterials).where(inArray(federationMaterials.localOrgId, orgIds));
  await db.delete(federationCapabilities).where(inArray(federationCapabilities.orgId, orgIds));
  await db.delete(softwareAssets).where(eq(softwareAssets.id, assetId));
  await db.delete(dataAssets).where(eq(dataAssets.id, datasetId));
  await db.delete(auditLog).where(eq(auditLog.actor, actor.userId));
  if (source && target) {
    await db
      .delete(federationSigningKeys)
      .where(inArray(federationSigningKeys.siteId, [source.signing.siteId, target.signing.siteId]));
    await db
      .delete(federationSites)
      .where(inArray(federationSites.id, [source.signing.siteId, target.signing.siteId]));
  }
  await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.orgId, orgIds));
  await db.delete(users).where(inArray(users.id, [actor.userId, identity.userId, outsider.userId]));
  await db.delete(orgs).where(inArray(orgs.id, orgIds));
});

test("explicit mapping pins one immutable local revision and rejects digest or kind substitution", async () => {
  const first = await assets.register(actor, { reference: scriptRef, localRevisionId: revisionId });
  expect(
    (await assets.register(actor, { reference: scriptRef, localRevisionId: revisionId })).id,
  ).toBe(first.id);
  expect((await assets.resolve(identity, scriptRef)).mapping.id).toBe(first.id);
  await expect(
    assets.register(actor, {
      reference: { ...scriptRef, digest: datasetRef.digest },
      localRevisionId: revisionId,
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    assets.register(actor, {
      reference: { ...scriptRef, kind: "workflow" },
      localRevisionId: revisionId,
    }),
  ).rejects.toThrow("ASSET_UNAVAILABLE");
  await expect(assets.resolve({ ...identity, orgId: outsider.orgId }, scriptRef)).rejects.toThrow(
    "POLICY_DENIED",
  );
});

test("mapping does not grant use permission and detects mutated or revoked local assets", async () => {
  await db
    .update(softwareAssets)
    .set({ visibility: "private" })
    .where(eq(softwareAssets.id, assetId));
  try {
    await expect(assets.resolve(identity, scriptRef)).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await db
      .update(softwareAssets)
      .set({ visibility: "platform-public" })
      .where(eq(softwareAssets.id, assetId));
  }
  await db
    .update(softwareAssetRevisions)
    .set({ payload: { ...payload, content: "changed" } })
    .where(eq(softwareAssetRevisions.id, revisionId));
  try {
    await expect(assets.resolve(identity, scriptRef)).rejects.toThrow("OPERATION_CONFLICT");
  } finally {
    await db
      .update(softwareAssetRevisions)
      .set({ payload })
      .where(eq(softwareAssetRevisions.id, revisionId));
  }
  await db
    .update(softwareAssets)
    .set({ lifecycle: "revoked" })
    .where(eq(softwareAssets.id, assetId));
  try {
    await expect(assets.resolve(identity, scriptRef)).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db
      .update(softwareAssets)
      .set({ lifecycle: "published" })
      .where(eq(softwareAssets.id, assetId));
  }
  const reference = { ...scriptRef, id: crypto.randomUUID() };
  const mapping = await assets.register(actor, { reference, localRevisionId: revisionId });
  await assets.revoke(actor, mapping.id);
  await expect(assets.resolve(identity, reference)).rejects.toThrow("POLICY_DENIED");
  await expect(assets.register(actor, { reference, localRevisionId: revisionId })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

test("dataset mapping waits for a usable location and preserves data authorization", async () => {
  await assets.register(actor, { reference: datasetRef, localRevisionId: versionId });
  await expect(assets.resolve(identity, datasetRef)).rejects.toThrow("DATA_WAITING");
  await addLocation();
  expect((await assets.resolve(identity, datasetRef)).local.kind).toBe("dataset");
  await db.update(dataAssets).set({ visibility: "private" }).where(eq(dataAssets.id, datasetId));
  try {
    await expect(assets.resolve(identity, datasetRef)).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db.update(dataAssets).set({ visibility: "public" }).where(eq(dataAssets.id, datasetId));
  }
  await db.update(dataAssets).set({ lifecycle: "revoked" }).where(eq(dataAssets.id, datasetId));
  try {
    await expect(assets.resolve(identity, datasetRef)).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db.update(dataAssets).set({ lifecycle: "published" }).where(eq(dataAssets.id, datasetId));
  }
  await db.delete(dataLocations).where(eq(dataLocations.id, locationId));
});

function inputs(): FederationInputManifest {
  return {
    protocolVersion: 1,
    kind: "inputs",
    parameters: { count: 2 },
    datasets: [{ descriptor: "reads", asset: datasetRef, selectedEntries: ["reads.txt"] }],
    bindings: [],
  };
}
function environment(): FederationEnvironmentLock {
  return {
    protocolVersion: 1,
    kind: "environment-lock",
    target: { platform: "linux", architecture: "x86_64" },
    nativeLockDigest: `sha256:${"c".repeat(64)}`,
    software: [],
    sandboxRuntime: { kind: "OCI", digest: `sha256:${"d".repeat(64)}` },
  };
}
async function addLocation() {
  await db
    .insert(dataLocations)
    .values({
      id: locationId,
      dataAssetVersionId: versionId,
      kind: "platform-object",
      uri: "s3://test/input",
      status: "available",
    })
    .onConflictDoNothing();
}
async function receive(input = inputs(), lock = environment(), executionExpiresAt?: string) {
  const request = {
    ...testDelegation(agreement),
    ...(executionExpiresAt ? { executionExpiresAt } : {}),
    maxAmount: "1",
    inputManifestDigest: federationMaterialDigest(input),
    environmentLockDigest: federationMaterialDigest(lock),
  };
  const result = await admission.receive({
    requestJws: await signFederationMessage(FederationDelegationSchema, request, source.signing),
    senderKey: source.verification,
    authenticatedPeerSiteId: source.signing.siteId,
  });
  reservations.push(result.reservationId);
  return result.reservationId;
}

test("durable preparation survives missing materials and data, then resolves without creating a job", async () => {
  const id = await receive();
  const preparation = new FederationPreparationService(
    db,
    target.signing.siteId,
    assets,
    () => testNow,
  );
  expect(await preparation.prepare(id)).toMatchObject({
    state: "waiting",
    blocker: "DATA_WAITING",
    mappings: [],
  });
  const material = inputs();
  const saved = await assets.putMaterial(actor, source.signing.siteId, material);
  expect(saved.digest).toBe(federationMaterialDigest(material));
  await assets.putMaterial(actor, source.signing.siteId, environment());
  expect(await preparation.prepare(id)).toMatchObject({
    state: "waiting",
    blocker: "DATA_WAITING",
  });
  await addLocation();
  const restarted = new FederationPreparationService(
    db,
    target.signing.siteId,
    assets,
    () => testNow,
  );
  const resolved = await restarted.prepare(id);
  expect(resolved.state).toBe("resolved");
  expect(resolved.mappings).toHaveLength(2);
  expect(await db.select().from(jobs).where(eq(jobs.submittedBy, identity.userId))).toHaveLength(0);
  const expired = new FederationPreparationService(
    db,
    target.signing.siteId,
    assets,
    () => new Date(testNow.getTime() + 3600001),
  );
  expect(await expired.prepare(id)).toMatchObject({
    state: "blocked",
    blocker: "AUTHORIZATION_EXPIRED",
  });
  await restarted.prepare(id);
  const nextId = await receive();
  const worker = new FederationPreparationWorker(db, restarted);
  await worker.tick();
  await worker.stop();
  const [state] = await db
    .select()
    .from(federationPreparations)
    .where(eq(federationPreparations.reservationId, nextId));
  expect(state?.state).toBe("resolved");
  expect(await db.select().from(jobs).where(eq(jobs.submittedBy, identity.userId))).toHaveLength(0);
});

test("material storage is scoped, content-addressed and rechecks retained bytes", async () => {
  const original = inputs();
  const first = await assets.putMaterial(actor, source.signing.siteId, original);
  const reordered = {
    bindings: original.bindings,
    parameters: original.parameters,
    datasets: original.datasets,
    kind: original.kind,
    protocolVersion: original.protocolVersion,
  };
  expect(await assets.putMaterial(actor, source.signing.siteId, reordered)).toEqual(first);
  expect(await assets.getMaterial(actor, source.signing.siteId, first.digest)).toEqual(original);
  await expect(assets.getMaterial(outsider, source.signing.siteId, first.digest)).rejects.toThrow(
    "DATA_WAITING",
  );
  await db
    .update(federationMaterials)
    .set({ content: federationCanonicalJson({ ...original, parameters: { count: 99 } }) })
    .where(eq(federationMaterials.digest, first.digest));
  try {
    await expect(assets.getMaterial(actor, source.signing.siteId, first.digest)).rejects.toThrow(
      "INVALID_MESSAGE",
    );
  } finally {
    await db
      .update(federationMaterials)
      .set({ content: federationCanonicalJson(original) })
      .where(eq(federationMaterials.digest, first.digest));
  }
});

test("mapping audit failure rolls registration back", async () => {
  const reference = { ...scriptRef, id: crypto.randomUUID() };
  await db.execute(
    sql`CREATE FUNCTION federation_test_mapping_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.asset.map' THEN RAISE EXCEPTION 'injected mapping fault'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER federation_test_mapping_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION federation_test_mapping_fail()`,
  );
  try {
    await expect(
      assets.register(actor, { reference, localRevisionId: revisionId }),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(federationAssetMappings)
        .where(eq(federationAssetMappings.originId, reference.id)),
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`DROP TRIGGER federation_test_mapping_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION federation_test_mapping_fail()`);
  }
});

test("asset API takes organization from the session, refuses automation and validates request fields", async () => {
  const app = (automation = false) => {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ level: "silent" })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, actor);
      if (automation) c.set("automation" as never, { userId: actor.userId });
      await next();
    });
    r.route("/api", createFederationAssetRoutes(assets));
    return r;
  };
  expect((await app().request("/api/federation/assets/mappings")).status).toBe(200);
  expect((await app(true).request("/api/federation/assets/mappings")).status).toBe(403);
  expect(
    (
      await app().request("/api/federation/assets/mappings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reference: scriptRef,
          localRevisionId: revisionId,
          orgId: outsider.orgId,
        }),
      })
    ).status,
  ).toBe(400);
});

test("read-only plan uses the restricted execution identity and requires the reviewer's own view access", async () => {
  const permissions = new FederationPermissionService(db);
  for (const subject of [actor, outsider])
    await permissions.set(
      { ...subject, capability: "agreement.read", enabled: true },
      actor.userId,
    );
  const input: FederationInputManifest = {
    protocolVersion: 1,
    kind: "inputs",
    parameters: { count: "2" },
    datasets: [],
    bindings: [],
  };
  await assets.putMaterial(actor, source.signing.siteId, input);
  const id = await receive(input);
  const preparation = new FederationPreparationService(
    db,
    target.signing.siteId,
    assets,
    () => testNow,
  );
  const plan = await preparation.plan(actor, id);
  expect(plan).toMatchObject({
    reservationId: id,
    executionReady: false,
    workflow: {
      parameters: [{ name: "count", default: "2" }],
      spec: {
        nodeDrafts: [
          {
            type: "Script",
            source: { assetId, assetRevisionId: revisionId },
            runtimeContractRef: { name: "bash", version: "1" },
          },
        ],
      },
    },
  });
  await expect(preparation.plan(outsider, id)).rejects.toThrow("AGREEMENT_UNAVAILABLE");
  await permissions.set({ ...actor, capability: "asset.map", enabled: false }, actor.userId);
  try {
    await expect(preparation.plan(actor, id)).rejects.toThrow("POLICY_DENIED");
  } finally {
    await permissions.set({ ...actor, capability: "asset.map", enabled: true }, actor.userId);
  }
  const guardedAssets = new FederationAssetService(db, {
    authorizeSoftware: async (id, principal, capability) => {
      if (capability === "view") throw new Error("reviewer cannot view code");
      await availability.assertAssetCapability(id, principal, capability);
    },
  });
  const guarded = new FederationPreparationService(
    db,
    target.signing.siteId,
    guardedAssets,
    () => testNow,
  );
  await expect(guarded.plan(actor, id)).rejects.toThrow("reviewer cannot view code");
  expect(await db.select().from(jobs).where(eq(jobs.submittedBy, identity.userId))).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationPreparations)
      .where(eq(federationPreparations.reservationId, id)),
  ).toHaveLength(0);
  const [reservation] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, id));
  expect(reservation?.state).toBe("reserved");
});

test("plan API reports a specific incompatible field and refuses automation and expired delegations", async () => {
  const id = await receive();
  const preparation = new FederationPreparationService(
    db,
    target.signing.siteId,
    assets,
    () => testNow,
  );
  const app = (automation = false) => {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ level: "silent" })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, actor);
      if (automation) c.set("automation" as never, { userId: actor.userId });
      await next();
    });
    r.route("/api", createFederationAssetRoutes(assets, preparation));
    return r;
  };
  const response = await app().request(`/api/federation/assets/reservations/${id}/plan`);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "TEMPLATE_NOT_PORTABLE",
      path: "parameters.count",
      reason: "parameter type mismatch",
    },
  });
  expect((await app(true).request(`/api/federation/assets/reservations/${id}/plan`)).status).toBe(
    403,
  );
  const expired = new FederationPreparationService(
    db,
    target.signing.siteId,
    assets,
    () => new Date(testNow.getTime() + 3600001),
  );
  await expect(expired.plan(actor, id)).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

async function executionFixture(executionExpiresAt?: string) {
  const manifest: FederationInputManifest = {
    protocolVersion: 1,
    kind: "inputs",
    parameters: { count: "3" },
    datasets: [],
    bindings: [],
  };
  await assets.putMaterial(actor, source.signing.siteId, manifest);
  await assets.putMaterial(actor, source.signing.siteId, environment());
  const reservationId = await receive(manifest, environment(), executionExpiresAt);
  let now = testNow;
  const preparation = new FederationPreparationService(
    db,
    target.signing.siteId,
    assets,
    () => now,
  );
  return {
    reservationId,
    preparation,
    bindings: new FederationExecutionBindingService(db, preparation),
    advanceTo: (value: Date) => {
      now = value;
    },
    expire: () => {
      now = new Date(testNow.getTime() + 3600001);
    },
  };
}

test("concurrent federation preparation atomically binds one held run and never spends the reservation twice", async () => {
  const f = await executionFixture();
  const [budget] = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, agreement.budgetDomainId));
  const prepared = await Promise.all(
    Array.from({ length: 8 }, () => f.bindings.stage(f.reservationId)),
  );
  expect(new Set(prepared.map((row) => row.workflowRunId)).size).toBe(1);
  const binding = prepared[0];
  if (!binding) throw new Error("Missing binding");
  expect(binding.snapshot).toMatchObject({
    identity,
    environment: environment(),
    inputs: { parameters: { count: "3" } },
    workflow: { parameters: [{ name: "count", default: "3" }] },
  });
  const registry = new WorkflowRunRegistry(db);
  expect(await registry.getById(binding.workflowRunId)).toMatchObject({
    submittedBy: identity.userId,
    status: "submitted",
    input: {
      executionModel: "durable-v2",
      federationReservationId: f.reservationId,
      role: "user",
      orgId: identity.orgId,
    },
  });
  expect(await registry.queueAuthorizedRun(binding.workflowRunId)).toBe(false);
  const scheduled: Array<() => Promise<void>> = [];
  let executions = 0;
  const runner = new WorkflowAsyncRunner({
    registry,
    journal: new WorkflowExecutionJournalStore(db),
    schedule: (task) => {
      scheduled.push(task);
    },
    makeRunner: () => async () => {
      executions++;
      throw new Error("Unvalidated federation run executed");
    },
  });
  expect((await runner.recoverInterruptedRuns(true)).resumed).toBe(0);
  expect(scheduled).toHaveLength(0);
  // Even an erroneously queued row cannot bypass the receiver-specific execution authorization.
  await db
    .update(workflowRuns)
    .set({ status: "queued" })
    .where(eq(workflowRuns.id, binding.workflowRunId));
  await runner.recoverInterruptedRuns(true);
  for (const task of scheduled) await task();
  expect(executions).toBe(0);
  expect((await registry.getById(binding.workflowRunId))?.errorCode).toBe("WORKFLOW_RECONCILING");
  await runner.stop();
  expect(
    await new FederationExecutionBindingService(db, f.preparation).stage(f.reservationId),
  ).toEqual(binding);
  expect(await db.select().from(jobs).where(eq(jobs.submittedBy, identity.userId))).toHaveLength(0);
  expect(
    (
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, agreement.budgetDomainId))
    )[0],
  ).toEqual(budget);
});

test("failure between run insertion and binding rolls both back, then recovery creates only one run", async () => {
  const f = await executionFixture();
  const registry = new WorkflowRunRegistry(db);
  const create = registry.createRun.bind(registry);
  const before = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.submittedBy, identity.userId));
  const interrupted = spyOn(WorkflowRunRegistry.prototype, "createRun").mockImplementation(
    async (...args) => {
      await create(...args);
      throw new Error("interrupted after run insert");
    },
  );
  try {
    await expect(f.bindings.stage(f.reservationId)).rejects.toThrow("interrupted after run insert");
  } finally {
    interrupted.mockRestore();
  }
  expect(
    await db
      .select()
      .from(federationWorkflowBindings)
      .where(eq(federationWorkflowBindings.reservationId, f.reservationId)),
  ).toHaveLength(0);
  expect(
    await db.select().from(workflowRuns).where(eq(workflowRuns.submittedBy, identity.userId)),
  ).toHaveLength(before.length);
  const binding = await f.bindings.stage(f.reservationId);
  await db
    .update(workflowRuns)
    .set({ status: "cancelled" })
    .where(eq(workflowRuns.id, binding.workflowRunId));
  f.expire();
  expect((await f.bindings.stage(f.reservationId)).workflowRunId).toBe(binding.workflowRunId);
  expect((await registry.getById(binding.workflowRunId))?.status).toBe("cancelled");
  expect(
    await db.select().from(workflowRuns).where(eq(workflowRuns.submittedBy, identity.userId)),
  ).toHaveLength(before.length + 1);
});

test.each([
  "agreement",
  "identity",
  "mapping",
  "expiry",
] as const)("binding rechecks %s after projection and creates no run when authorization changed", async (change) => {
  const f = await executionFixture();
  const snapshot = f.preparation.executionSnapshot.bind(f.preparation);
  const injected = spyOn(f.preparation, "executionSnapshot").mockImplementation(async (...args) => {
    const result = await snapshot(...args);
    if (change === "agreement")
      await db
        .update(federationAgreements)
        .set({ state: "suspended" })
        .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    if (change === "identity")
      await db.update(users).set({ suspended: true }).where(eq(users.id, identity.userId));
    if (change === "mapping")
      await db
        .update(federationAssetMappings)
        .set({ revokedAt: new Date() })
        .where(eq(federationAssetMappings.softwareRevisionId, revisionId));
    if (change === "expiry") f.expire();
    return result;
  });
  const before = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.submittedBy, identity.userId));
  try {
    await expect(f.bindings.stage(f.reservationId)).rejects.toThrow();
    expect(
      await db
        .select()
        .from(federationWorkflowBindings)
        .where(eq(federationWorkflowBindings.reservationId, f.reservationId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(workflowRuns).where(eq(workflowRuns.submittedBy, identity.userId)),
    ).toHaveLength(before.length);
  } finally {
    injected.mockRestore();
    await db
      .update(federationAgreements)
      .set({ state: "active" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await db.update(users).set({ suspended: false }).where(eq(users.id, identity.userId));
    await db
      .update(federationAssetMappings)
      .set({ revokedAt: null })
      .where(eq(federationAssetMappings.softwareRevisionId, revisionId));
  }
});

test("binding refuses an acceptance for a different operation even when the local signature is valid", async () => {
  const f = await executionFixture();
  const [row] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, f.reservationId));
  if (!row) throw new Error("Missing reservation");
  const receipt = { ...row.receipt, operationId: crypto.randomUUID() };
  await db
    .update(federationReservations)
    .set({
      receipt,
      receiptJws: await signFederationMessage(FederationAcceptanceSchema, receipt, target.signing),
    })
    .where(eq(federationReservations.id, f.reservationId));
  await expect(f.bindings.stage(f.reservationId)).rejects.toThrow("OPERATION_CONFLICT");
  expect(
    await db
      .select()
      .from(federationWorkflowBindings)
      .where(eq(federationWorkflowBindings.reservationId, f.reservationId)),
  ).toHaveLength(0);
});

test("recovery detects modified workflow inputs or saved snapshots instead of creating another run", async () => {
  const f = await executionFixture();
  const binding = await f.bindings.stage(f.reservationId);
  expect(await loadFederationWorkflowBinding(db, binding.workflowRunId)).toEqual(binding);
  const registry = new WorkflowRunRegistry(db);
  const run = await registry.getById(binding.workflowRunId);
  if (!run?.input) throw new Error("Missing workflow input");
  await db
    .update(workflowRuns)
    .set({ input: { ...run.input, role: "platform_admin" } })
    .where(eq(workflowRuns.id, run.id));
  await expect(f.bindings.stage(f.reservationId)).rejects.toThrow("OPERATION_CONFLICT");
  await expect(loadFederationWorkflowBinding(db, run.id)).rejects.toThrow("OPERATION_CONFLICT");
  await db.update(workflowRuns).set({ input: run.input }).where(eq(workflowRuns.id, run.id));
  await db
    .update(federationWorkflowBindings)
    .set({
      snapshot: {
        ...binding.snapshot,
        inputs: { ...binding.snapshot.inputs, parameters: { count: "99" } },
      },
    })
    .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
  await expect(f.bindings.stage(f.reservationId)).rejects.toThrow("OPERATION_CONFLICT");
  await expect(loadFederationWorkflowBinding(db, run.id)).rejects.toThrow("OPERATION_CONFLICT");
  expect(
    await db
      .select()
      .from(federationWorkflowBindings)
      .where(eq(federationWorkflowBindings.reservationId, f.reservationId)),
  ).toHaveLength(1);
});

test("a federation marker with a missing binding cannot fall back to ordinary execution", async () => {
  const f = await executionFixture();
  const binding = await f.bindings.stage(f.reservationId);
  await db
    .delete(federationWorkflowBindings)
    .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
  await expect(loadFederationWorkflowBinding(db, binding.workflowRunId)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect(await loadFederationWorkflowBinding(db, crypto.randomUUID())).toBeNull();
});

test("the production preparation worker stages a bound run without invoking the workflow executor", async () => {
  const f = await executionFixture();
  const worker = new FederationPreparationWorker(db, f.preparation, f.bindings);
  let binding: typeof federationWorkflowBindings.$inferSelect | undefined;
  for (let batch = 0; batch <= Math.ceil(reservations.length / 8); batch++) {
    await worker.tick();
    [binding] = await db
      .select()
      .from(federationWorkflowBindings)
      .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
    if (binding) break;
  }
  await worker.stop();
  expect(binding).toBeDefined();
  if (!binding) throw new Error("Missing worker binding");
  expect((await new WorkflowRunRegistry(db).getById(binding.workflowRunId))?.status).toBe(
    "submitted",
  );
  expect(await db.select().from(jobs).where(eq(jobs.submittedBy, identity.userId))).toHaveLength(0);
});

test.each([
  "agreement",
  "identity",
  "mapping",
  "expiry",
  "binding",
] as const)("dispatch fence rechecks %s after external preparation and before channel delivery", async (change) => {
  const f = await executionFixture();
  const binding = await f.bindings.stage(f.reservationId);
  const authorization = new FederationDispatchAuthorization(db, f.preparation);
  const fence = await authorization.prepare(binding.workflowRunId);
  await db.transaction(fence);
  try {
    if (change === "agreement")
      await db
        .update(federationAgreements)
        .set({ state: "suspended" })
        .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    if (change === "identity")
      await db.update(users).set({ suspended: true }).where(eq(users.id, identity.userId));
    if (change === "mapping")
      await db
        .update(federationAssetMappings)
        .set({ revokedAt: new Date() })
        .where(eq(federationAssetMappings.softwareRevisionId, revisionId));
    if (change === "expiry") f.expire();
    if (change === "binding")
      await db
        .delete(federationWorkflowBindings)
        .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
    let delivered = false;
    await expect(
      db.transaction(async (tx) => {
        await fence(tx);
        delivered = true;
      }),
    ).rejects.toThrow();
    expect(delivered).toBe(false);
    await expect(authorization.prepare(binding.workflowRunId)).rejects.toThrow();
  } finally {
    await db
      .update(federationAgreements)
      .set({ state: "active" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await db.update(users).set({ suspended: false }).where(eq(users.id, identity.userId));
    await db
      .update(federationAssetMappings)
      .set({ revokedAt: null })
      .where(eq(federationAssetMappings.softwareRevisionId, revisionId));
  }
});

test.each([
  undefined,
  "2026-01-01T02:00:00.000Z",
])("real federation authorization fences outbox retries with execution deadline %s", async (executionExpiresAt) => {
  const f = await executionFixture(executionExpiresAt);
  const binding = await f.bindings.stage(f.reservationId);
  const agentId = approvedTarget.agentId;
  const jobId = crypto.randomUUID();
  const dispatcher = new AgentDispatcher();
  const authorization = new FederationDispatchAuthorization(
    db,
    f.preparation,
    new QueueRegistryService(db),
  );
  const outbox = new JobDispatchOutbox(db, dispatcher, (runId, target) =>
    authorization.prepare(runId, target),
  );
  await db.insert(agents).values({
    agentId,
    siteName: "Test receiver",
    schedulerType: "slurm",
    schedulerVersion: "test",
    providerOrgId: actor.orgId,
    clusterId: approvedTarget.clusterId,
    status: "online",
  });
  await db.insert(schedulerQueues).values({
    queueId: approvedTarget.queueId,
    agentId,
    name: "Approved test queue",
    providerOrgId: actor.orgId,
    schedulerType: "slurm",
    queueName: "approved",
  });
  await db.insert(jobs).values({
    id: jobId,
    name: "Fence test",
    command: "true",
    cpus: 1,
    memoryMb: 128,
    wallTimeSec: 30,
    queueId: approvedTarget.queueId,
    queueTargetMode: "named",
    schedulerQueueName: "approved",
    agentId,
    dispatchEpoch: 1,
    status: "queued",
    submittedBy: identity.userId,
    orgId: identity.orgId,
  });

  // Exercise the final boundary directly; this does not enable production federation runs.
  await db
    .update(workflowRuns)
    .set({ status: "running" })
    .where(eq(workflowRuns.id, binding.workflowRunId));
  const lease = await new WorkflowExecutionJournalStore(db).acquire(binding.workflowRunId);
  if (!lease) throw new Error("Missing test lease");
  await db.insert(workflowExecutionJobs).values({
    runId: binding.workflowRunId,
    jobId,
    pathHash: "a".repeat(64),
    path: '["node","test"]',
    nodeId: "test",
    intent: {
      nodeId: "test",
      name: "Test",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    },
  });
  let delivered = 0;
  let probe: ReturnType<typeof Bun.spawnSync> | undefined;
  const message = dispatcher.buildDispatchJob(jobId, {
    federationExecution: true,
    jobIdInternal: jobId,
    name: "Fence test",
    command: "true",
    resources: { cpus: 1, memoryMb: 128, wallTimeSec: 30 },
    queueName: "approved",
    queueTargetMode: "named",
    dispatchEpoch: 1,
  });
  try {
    expect(await outbox.enqueue(agentId, message, binding.workflowRunId, lease)).toEqual({
      sent: false,
      pending: true,
    });
    dispatcher.register(agentId, {
      federationExecutionV1: true,
      verifiedCertFingerprint: "test-verified-certificate",
      close: () => {},
      push: () => {
        probe = Bun.spawnSync(
          [
            "bun",
            "-e",
            `import postgres from "postgres";
          const db = postgres(process.env.DATABASE_URL, {max: 1});
          try {
            await db.begin(tx => tx.unsafe('select revision_id from federation_agreements where revision_id=$1 for update nowait', [process.env.PROBE_AGREEMENT]));
            process.stdout.write("unlocked");
          } catch (error) { process.stdout.write(error.code); }
          await db.end();`,
          ],
          {
            env: {
              ...process.env,
              DATABASE_URL: url,
              PROBE_AGREEMENT: agreement.agreementRevisionId,
            },
            timeout: 5000,
          },
        );
        delivered++;
      },
    });
    await outbox.redeliver(agentId);
    expect(delivered).toBe(1);
    expect(probe?.exitCode).toBe(0);
    expect(probe?.stdout?.toString()).toBe("55P03");
    const grantNow = testNow.getTime() + (executionExpiresAt ? 3_600_000 : 0);
    f.advanceTo(new Date(grantNow));
    const clock = spyOn(Date, "now").mockReturnValue(grantNow);
    const request = create(FederationExecutionRequestSchema, {
      requestId: crypto.randomUUID(),
      jobId,
      dispatchEpoch: 1n,
    });
    const grants: FederationExecutionResponse[] = [];
    try {
      await outbox.acknowledge(agentId, jobId);
      expect(await outbox.renewExecution(agentId, request, (grant) => grants.push(grant))).toBe(
        true,
      );
      expect(grants).toHaveLength(1);
      expect(grants[0]?.decision).toBe(FederationExecutionDecision.GRANTED);
      expect(grants[0]?.dispatch?.command).toBe("true");
      expect(grants[0]?.expiresAtUnixMs).toBe(BigInt(grantNow + 10_000));
      dispatcher.register("different-agent", {
        federationExecutionV1: true,
        verifiedCertFingerprint: "other-verified",
        close: () => {},
        push: () => {},
      });
      expect(
        await outbox.renewExecution("different-agent", request, (grant) => grants.push(grant)),
      ).toBe(false);
      expect(
        await outbox.renewExecution(agentId, { ...request, dispatchEpoch: 2n }, (grant) =>
          grants.push(grant),
        ),
      ).toBe(false);
      expect(grants).toHaveLength(1);
      await db.update(jobs).set({ revokedEpoch: 1 }).where(eq(jobs.id, jobId));
      expect(await outbox.renewExecution(agentId, request, (grant) => grants.push(grant))).toBe(
        false,
      );
      expect(grants).toHaveLength(1);
      await db.update(jobs).set({ revokedEpoch: 0 }).where(eq(jobs.id, jobId));
      const snapshot = await loadFederationWorkflowBinding(db, binding.workflowRunId);
      if (!snapshot) throw new Error("Missing binding snapshot");
      const expiresAt = federationExecutionDeadline(snapshot.snapshot.request);
      clock.mockReturnValue(expiresAt - 500);
      expect(await outbox.renewExecution(agentId, request, (grant) => grants.push(grant))).toBe(
        true,
      );
      expect(grants.at(-1)?.expiresAtUnixMs).toBe(BigInt(expiresAt));
      clock.mockReturnValue(expiresAt);
      expect(await outbox.renewExecution(agentId, request, (grant) => grants.push(grant))).toBe(
        false,
      );
      expect(grants).toHaveLength(2);
      grants.pop();
      clock.mockReturnValue(grantNow);
      await db
        .update(federationAgreements)
        .set({ state: "suspended" })
        .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
      await expect(
        outbox.renewExecution(agentId, request, (grant) => grants.push(grant)),
      ).rejects.toThrow();
      expect(grants).toHaveLength(1);
    } finally {
      clock.mockRestore();
      await db
        .update(federationAgreements)
        .set({ state: "active" })
        .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
      await db
        .update(jobDispatchOutbox)
        .set({ acknowledgedAt: null })
        .where(eq(jobDispatchOutbox.jobId, jobId));
    }
    const fence = await authorization.prepare(binding.workflowRunId, {
      kind: "compute",
      jobId,
      agentId,
    });
    const [invocation] = await db
      .select()
      .from(workflowExecutionJobs)
      .where(eq(workflowExecutionJobs.jobId, jobId));
    if (!invocation) throw new Error("Missing test invocation");
    await db
      .update(workflowExecutionJobs)
      .set({ intent: { ...invocation.intent, command: "changed" } })
      .where(eq(workflowExecutionJobs.jobId, jobId));
    await expect(db.transaction(fence)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await db
      .update(workflowExecutionJobs)
      .set({ intent: invocation.intent })
      .where(eq(workflowExecutionJobs.jobId, jobId));
    await db
      .update(federationAgreements)
      .set({ state: "suspended" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await new JobDispatchOutbox(db, dispatcher, (id, target) =>
      authorization.prepare(id, target),
    ).redeliver(agentId);
    expect(delivered).toBe(1);
    await db
      .update(federationAgreements)
      .set({ state: "active" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await db
      .update(schedulerQueues)
      .set({ enabled: false })
      .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    await outbox.redeliver(agentId);
    expect(delivered).toBe(1);
    await db
      .update(schedulerQueues)
      .set({ enabled: true })
      .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, binding.workflowRunId));
    if (!run?.input) throw new Error("Missing test run");
    const { federationReservationId: _removed, ...input } = run.input;
    await db.update(workflowRuns).set({ input }).where(eq(workflowRuns.id, binding.workflowRunId));
    await outbox.redeliver(agentId);
    expect(delivered).toBe(1);
  } finally {
    await lease.release();
    await db
      .update(federationAgreements)
      .set({ state: "active" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await db.delete(workflowExecutionJobs).where(eq(workflowExecutionJobs.jobId, jobId));
    await db.delete(jobs).where(eq(jobs.id, jobId));
    await db.delete(schedulerQueues).where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    await db.delete(agents).where(eq(agents.agentId, agentId));
  }
});

test.each([
  undefined,
  "2026-01-01T02:00:00.000Z",
])("installation renewal uses its signed execution deadline %s and original pending job", async (executionExpiresAt) => {
  const f = await executionFixture(executionExpiresAt);
  const binding = await f.bindings.stage(f.reservationId);
  const jobId = crypto.randomUUID(),
    operationId = crypto.randomUUID();
  const agentId = `grant-${crypto.randomUUID()}`;
  const pin = {
    dagHash: "a".repeat(32),
    manifestDigest: `sha256:${"b".repeat(64)}`,
    lockfileDigest: `sha256:${"c".repeat(64)}`,
    spackVersion: "1.0.0" as const,
    target: "linux-ubuntu24.04-x86_64",
  };
  const dispatcher = new AgentDispatcher();
  const channel = {
    close: () => {},
    push: () => {},
    federationInstallationV1: true,
    softwareOperationReplayV1: true,
    spackMaterialDeliveryV1: true,
    verifiedCertFingerprint: "verified",
  };
  dispatcher.register(agentId, channel);
  dispatcher.register("other", { ...channel });
  let change: "none" | "cancel" | "anchor" | "ticket" = "none";
  const operations = new SoftwareOperationService(
    db,
    dispatcher,
    new InstalledRegistry(db),
    async () => {
      if (change === "cancel")
        await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, jobId));
      if (change === "anchor")
        await db
          .update(softwareOperations)
          .set({ federationJobId: crypto.randomUUID() })
          .where(eq(softwareOperations.id, operationId));
      return {
        spackMaterialTicket: "new-ticket",
        spackManifestDigest: change === "ticket" ? `sha256:${"d".repeat(64)}` : pin.manifestDigest,
      };
    },
    async () => {},
    async () => {
      const snapshot = await f.preparation.executionSnapshot(f.reservationId);
      return (tx) => f.preparation.lockExecutionSnapshot(tx, snapshot);
    },
  );
  await db.insert(agents).values({
    agentId,
    siteName: "Test",
    schedulerType: "slurm",
    schedulerVersion: "test",
    providerOrgId: actor.orgId,
  });
  await db.insert(jobs).values({
    id: jobId,
    name: "Install grant",
    command: "exit 126",
    cpus: 1,
    memoryMb: 128,
    submittedBy: identity.userId,
    orgId: identity.orgId,
    softwareRequirements: [{ name: "hello", spec: "hello@1", installable: true, operationId }],
  });
  await db.insert(softwareOperations).values({
    id: operationId,
    agentId,
    requestedBy: identity.userId,
    action: "install",
    spec: "hello@1",
    replayEnabled: true,
    federationJobId: jobId,
    manifestDigest: pin.manifestDigest,
  });
  await db
    .update(workflowRuns)
    .set({ status: "running" })
    .where(eq(workflowRuns.id, binding.workflowRunId));
  const lease = await new WorkflowExecutionJournalStore(db).acquire(binding.workflowRunId);
  if (!lease) throw new Error("Missing installation lease");
  await db.insert(workflowExecutionJobs).values({
    runId: binding.workflowRunId,
    jobId,
    nodeId: "install",
    pathHash: "a".repeat(64),
    path: '["node","install"]',
    intent: {
      nodeId: "install",
      name: "Install",
      command: "exit 126",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
      spackExecution: { spec: "hello@1", command: "hello", pin },
    },
  });
  const grantNow = testNow.getTime() + (executionExpiresAt ? 3_600_000 : 0);
  f.advanceTo(new Date(grantNow));
  const clock = spyOn(Date, "now").mockReturnValue(grantNow);
  const request = create(FederationExecutionRequestSchema, {
    requestId: crypto.randomUUID(),
    jobId,
    operationId,
  });
  const grants: FederationExecutionResponse[] = [];
  const send = (grant: FederationExecutionResponse) => {
    grants.push(grant);
  };
  try {
    expect(await operations.renewFederationInstallation(agentId, request, send)).toBe(true);
    expect(grants[0]?.installation).toMatchObject({
      operationId,
      federationJobId: jobId,
      durableReplay: true,
      spackMaterialTicket: "new-ticket",
      spackManifestDigest: pin.manifestDigest,
    });
    expect(grants[0]?.expiresAtUnixMs).toBe(BigInt(grantNow + 10_000));
    expect(await operations.renewFederationInstallation("other", request, send)).toBe(false);
    expect(
      await operations.renewFederationInstallation(
        agentId,
        { ...request, dispatchEpoch: 1n },
        send,
      ),
    ).toBe(false);
    for (change of ["cancel", "anchor", "ticket"] as const) {
      expect(await operations.renewFederationInstallation(agentId, request, send)).toBe(false);
      await db.update(jobs).set({ status: "pending" }).where(eq(jobs.id, jobId));
      await db
        .update(softwareOperations)
        .set({ federationJobId: jobId })
        .where(eq(softwareOperations.id, operationId));
    }
    change = "none";
    await db
      .update(federationAgreements)
      .set({ state: "suspended" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await expect(operations.renewFederationInstallation(agentId, request, send)).rejects.toThrow();
    expect(grants).toHaveLength(1);
  } finally {
    clock.mockRestore();
    await lease.release();
    await db
      .update(federationAgreements)
      .set({ state: "active" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await db.delete(softwareOperations).where(eq(softwareOperations.id, operationId));
    await db.delete(workflowExecutionJobs).where(eq(workflowExecutionJobs.jobId, jobId));
    await db.delete(jobs).where(eq(jobs.id, jobId));
    await db.delete(agents).where(eq(agents.agentId, agentId));
  }
});

test("accepted preparation survives its admission window only until the signed execution deadline", async () => {
  const deadline = "2026-01-01T02:00:00.000Z";
  const f = await executionFixture(deadline);
  f.advanceTo(new Date("2026-01-01T01:00:00.000Z"));
  const binding = await f.bindings.stage(f.reservationId);
  expect(binding.snapshot.request.executionExpiresAt).toBe(deadline);
  const snapshot = await f.preparation.executionSnapshot(f.reservationId);
  f.advanceTo(new Date(deadline));
  await expect(
    db.transaction((tx) => f.preparation.lockExecutionSnapshot(tx, snapshot)),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  await expect(f.preparation.executionSnapshot(f.reservationId)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
});

async function scanExecutions(monitor: FederationExecutionMonitor) {
  const [total] = await db.select({ value: count() }).from(workflowRuns);
  for (let page = 0; page <= Math.ceil((total?.value ?? 0) / 25); page++) await monitor.tick();
}

async function monitoredExecution(executionExpiresAt?: string) {
  const f = await executionFixture(executionExpiresAt);
  const binding = await f.bindings.stage(f.reservationId);
  const runId = binding.workflowRunId;
  await db
    .update(workflowRuns)
    .set({ status: "running", startedAt: testNow })
    .where(eq(workflowRuns.id, runId));
  const registry = new WorkflowRunRegistry(db);
  const pending: (() => Promise<void>)[] = [];
  let stopped = false;
  const cancellations: string[] = [];
  const makeRunner = () =>
    new WorkflowAsyncRunner({
      registry,
      schedule: (task) => pending.push(task),
      makeRunner: () => async () => {
        throw new Error("Monitor must never activate federation execution");
      },
      cancelSubmittedJobs: async (id) => {
        if (id !== runId) return;
        cancellations.push(id);
        if (!stopped) throw new Error("Agent stop acknowledgement unavailable");
      },
    });
  const runner = makeRunner();
  const authorization = new FederationDispatchAuthorization(db, f.preparation);
  const monitor = new FederationExecutionMonitor(db, authorization, runner);
  return {
    ...f,
    runId,
    registry,
    runner,
    makeRunner,
    authorization,
    monitor,
    cancellations,
    confirmStopped: () => {
      stopped = true;
    },
    drain: async () => {
      for (const task of pending.splice(0)) await task();
    },
  };
}

test.each([
  ["agreement", "AGREEMENT_UNAVAILABLE"],
  ["source-key", "UNTRUSTED_IDENTITY"],
  ["receipt-key", "UNTRUSTED_IDENTITY"],
  ["site", "UNTRUSTED_IDENTITY"],
  ["identity", "POLICY_DENIED"],
  ["mapping", "POLICY_DENIED"],
  ["software", "POLICY_DENIED"],
  ["software-permission", "POLICY_DENIED"],
  ["binding", "OPERATION_CONFLICT"],
] as const)("execution monitor propagates %s loss to durable cancellation with reason %s", async (change, reason) => {
  const f = await monitoredExecution();
  try {
    if (change === "agreement")
      await db
        .update(federationAgreements)
        .set({ state: "suspended" })
        .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    if (change === "source-key" || change === "receipt-key")
      await new FederationTrustRegistry(db).revoke(
        change === "source-key" ? source.signing.siteId : target.signing.siteId,
        { keyId: change === "source-key" ? source.signing.keyId : target.signing.keyId },
        actor.userId,
      );
    if (change === "site")
      await new FederationTrustRegistry(db).setState(
        source.signing.siteId,
        "suspended",
        actor.userId,
      );
    if (change === "identity")
      await db.update(users).set({ suspended: true }).where(eq(users.id, identity.userId));
    if (change === "mapping")
      await db
        .update(federationAssetMappings)
        .set({ revokedAt: testNow })
        .where(eq(federationAssetMappings.softwareRevisionId, revisionId));
    if (change === "software")
      await db
        .update(softwareAssets)
        .set({ lifecycle: "revoked" })
        .where(eq(softwareAssets.id, assetId));
    if (change === "software-permission")
      await db
        .update(softwareAssets)
        .set({ visibility: "private" })
        .where(eq(softwareAssets.id, assetId));
    if (change === "binding")
      await db
        .delete(federationWorkflowBindings)
        .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
    await scanExecutions(f.monitor);
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorCode: "FEDERATION_AUTHORIZATION_REVOKED",
      errorMessage: reason,
      completedAt: null,
    });
    await f.drain();
    expect(f.cancellations).toContain(f.runId);
    expect((await f.registry.getById(f.runId))?.status).toBe("cancelling");
    // A new runner recovers the persisted intent; restoration never revives the old execution.
    f.confirmStopped();
    await f.makeRunner().recoverInterruptedRuns(true);
    await f.drain();
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "FEDERATION_AUTHORIZATION_REVOKED",
      errorMessage: reason,
    });
  } finally {
    await db
      .update(federationAgreements)
      .set({ state: "active" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: null })
      .where(inArray(federationSigningKeys.siteId, [source.signing.siteId, target.signing.siteId]));
    await db
      .update(federationSites)
      .set({ state: "active" })
      .where(eq(federationSites.id, source.signing.siteId));
    await db.update(users).set({ suspended: false }).where(eq(users.id, identity.userId));
    await db
      .update(federationAssetMappings)
      .set({ revokedAt: null })
      .where(eq(federationAssetMappings.softwareRevisionId, revisionId));
    await db
      .update(softwareAssets)
      .set({ lifecycle: "published", visibility: "platform-public" })
      .where(eq(softwareAssets.id, assetId));
    await f.monitor.stop();
  }
});

test.each([
  undefined,
  "2026-01-01T02:00:00.000Z",
])("execution monitor cancels at signed deadline %s, independent of admission and Fabric", async (deadline) => {
  const f = await monitoredExecution(deadline);
  const expires = deadline ?? "2026-01-01T00:10:00.000Z";
  f.advanceTo(new Date(Date.parse(expires) - 1));
  await scanExecutions(f.monitor);
  expect((await f.registry.getById(f.runId))?.status).toBe("running");
  f.advanceTo(new Date(expires));
  await scanExecutions(f.monitor);
  expect(await f.registry.getById(f.runId)).toMatchObject({
    status: "cancelling",
    errorMessage: "AUTHORIZATION_EXPIRED",
    completedAt: null,
  });
  await f.drain();
  expect((await f.registry.getById(f.runId))?.status).toBe("cancelling");
  f.confirmStopped();
  await f.makeRunner().cancel(f.runId);
  await f.drain();
  expect((await f.registry.getById(f.runId))?.status).toBe("cancelled");
});

test("execution monitor checks the final fence after material resolution", async () => {
  const f = await monitoredExecution();
  const prepare = f.authorization.prepare.bind(f.authorization);
  const injected = spyOn(f.authorization, "prepare").mockImplementation(async (runId) => {
    const fence = await prepare(runId);
    if (runId === f.runId) f.expire();
    return fence;
  });
  try {
    await scanExecutions(f.monitor);
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorMessage: "AUTHORIZATION_EXPIRED",
    });
  } finally {
    injected.mockRestore();
  }
});

test.each([
  new Error("database unavailable"),
  new FederationError("DATA_WAITING"),
  new FederationError("ASSET_UNAVAILABLE"),
])("execution monitor retries %s without cancelling and resumes after recovery", async (error) => {
  const f = await monitoredExecution();
  const injected = spyOn(f.authorization, "prepare").mockRejectedValue(error);
  await scanExecutions(f.monitor);
  expect((await f.registry.getById(f.runId))?.status).toBe("running");
  injected.mockRestore();
  f.expire();
  await scanExecutions(f.monitor);
  expect((await f.registry.getById(f.runId))?.status).toBe("cancelling");
});

test("disabling federation cancels persisted runs instead of disabling their authority monitor", async () => {
  const f = await monitoredExecution();
  await scanExecutions(new FederationExecutionMonitor(db, undefined, f.runner));
  expect(await f.registry.getById(f.runId)).toMatchObject({
    status: "cancelling",
    errorMessage: "POLICY_DENIED",
  });
});

test("monitor pagination skips ordinary and terminal runs, and failures never starve later runs", async () => {
  const registry = new WorkflowRunRegistry(db);
  const runIds: string[] = [];
  const ordinary = await registry.createRun("ordinary", identity.userId, { nodes: [], edges: [] });
  for (let index = 0; index < 27; index++) {
    runIds.push(
      await registry.createRun(
        "monitor pagination",
        identity.userId,
        { nodes: [], edges: [] },
        {
          executionModel: "durable-v2",
          federationReservationId: crypto.randomUUID(),
          yaml: "name: fixture\nspec:\n  nodeDrafts: []\n",
          role: "user",
        },
      ),
    );
  }
  const terminalId = runIds.pop();
  if (!terminalId) throw new Error("Missing terminal fixture");
  await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, terminalId));
  const checked = new Set<string>();
  const cancelled: string[] = [];
  const monitor = new FederationExecutionMonitor(
    db,
    {
      prepare: async (id) => {
        checked.add(id);
        throw new Error("Transient authorization backend failure");
      },
    },
    {
      cancel: async (id) => {
        cancelled.push(id);
        return "cancelling";
      },
    },
  );
  const first = monitor.tick();
  expect(monitor.tick()).toBe(first);
  await first;
  await scanExecutions(monitor);
  expect(runIds.every((id) => checked.has(id))).toBe(true);
  expect(checked.has(ordinary)).toBe(false);
  expect(checked.has(terminalId)).toBe(false);
  expect(cancelled).toEqual([]);
  await db.delete(workflowRuns).where(inArray(workflowRuns.id, [...runIds, terminalId, ordinary]));
});
