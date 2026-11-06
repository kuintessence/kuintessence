import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  agents,
  auditLog,
  clusterExecutionAccounts,
  createPgDb,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  dataLocations,
  ecosystemReleaseAssets,
  ecosystemReleases,
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
  jobDataBindings,
  jobDispatchOutbox,
  jobs,
  licensedMaterialMappings,
  licenseEntitlementClaims,
  orgs,
  sandboxPolicyOverlays,
  sandboxRuntimeContractBindings,
  sandboxRuntimeProfiles,
  schedulerQueues,
  softwareAssetRevisions,
  softwareAssets,
  softwareOperations,
  softwarePolicies,
  userClusterAccountMappings,
  userOrgMemberships,
  users,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import {
  DataDeliveryBindingSchema,
  FederationExecutionDecision,
  FederationExecutionRequestSchema,
  type FederationExecutionResponse,
  LicensedMaterialMountSchema,
  ServerMessageSchema,
} from "@kuintessence/proto";
import {
  AppError,
  canonicalJson,
  ErrorCode,
  WorkflowExecutionInterrupted,
  workflowDsl,
} from "@kuintessence/shared";
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
import { AuthorizationUnavailableError } from "../authz/service";
import { AgentDispatcher } from "../grpc/dispatcher";
import { JobDispatchOutbox } from "../grpc/job-dispatch-outbox";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationAssetRoutes } from "../routes/federation-assets";
import { QueueRegistryService } from "../services/queue-registry";
import { SandboxManifestSigner, sandboxBundleSha256 } from "../services/sandbox-manifest-signer";
import { SandboxPolicyService } from "../services/sandbox-policy";
import { SoftwareAvailabilityService } from "../services/software-availability";
import { InstalledRegistry } from "../software-governance/installed-registry";
import { SoftwareOperationService } from "../software-governance/operation-service";
import { WorkflowAsyncRunner } from "../workflow/async-runner";
import { WorkflowExecutionJournalStore } from "../workflow/execution-journal";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { createWorkflowRunner } from "../workflow/runner";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationDataDispatch } from "./data-dispatch";
import { FederationDispatchAuthorization } from "./dispatch-authorization";
import {
  FederationExecutionBindingService,
  loadFederationWorkflowBinding,
  queueFederationWorkflow,
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
  await assets.register(actor, { reference: scriptRef, localRevisionId: revisionId });
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
      federationComputeLeaseV1: true,
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
        federationComputeLeaseV1: true,
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
  await assets.register(actor, { reference: scriptRef, localRevisionId: revisionId });
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
    federationInstallationLeaseV1: true,
    federationInstallationMaterialLeaseV1: true,
    softwareOperationReplayV1: true,
    spackMaterialDeliveryV1: true,
    verifiedCertFingerprint: "verified",
  };
  dispatcher.register(agentId, channel);
  dispatcher.register("other", { ...channel });
  let change: "none" | "cancel" | "anchor" | "ticket" = "none";
  let localAuthorizationDeadline = Number.POSITIVE_INFINITY;
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
      return async (tx) => {
        await f.preparation.lockExecutionSnapshot(tx, snapshot);
        return localAuthorizationDeadline;
      };
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
    channel.federationInstallationMaterialLeaseV1 = false;
    expect(await operations.renewFederationInstallation(agentId, request, send)).toBe(false);
    expect(grants).toHaveLength(0);
    channel.federationInstallationMaterialLeaseV1 = true;
    expect(await operations.renewFederationInstallation(agentId, request, send)).toBe(true);
    expect(grants[0]?.installation).toMatchObject({
      operationId,
      federationJobId: jobId,
      durableReplay: true,
      spackMaterialTicket: "new-ticket",
      spackManifestDigest: pin.manifestDigest,
    });
    expect(grants[0]?.expiresAtUnixMs).toBe(BigInt(grantNow + 10_000));
    localAuthorizationDeadline = grantNow + 3_000;
    expect(await operations.renewFederationInstallation(agentId, request, send)).toBe(true);
    expect(grants[1]?.expiresAtUnixMs).toBe(BigInt(localAuthorizationDeadline));
    localAuthorizationDeadline = grantNow;
    expect(await operations.renewFederationInstallation(agentId, request, send)).toBe(false);
    localAuthorizationDeadline = Number.POSITIVE_INFINITY;
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
    expect(grants).toHaveLength(2);
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
      checkActiveJobs: async () => {},
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

async function monitoredJob(status: "pending" | "queued" | "running" | "completed" = "running") {
  await assets.register(actor, { reference: scriptRef, localRevisionId: revisionId });
  const f = await monitoredExecution();
  const jobId = crypto.randomUUID();
  const queues = new QueueRegistryService(db);
  const authorization = new FederationDispatchAuthorization(
    db,
    f.preparation,
    queues,
    availability,
  );
  const monitor = new FederationExecutionMonitor(db, authorization, f.runner);
  await db.insert(agents).values({
    agentId: approvedTarget.agentId,
    providerOrgId: approvedTarget.providerOrgId,
    clusterId: approvedTarget.clusterId,
    siteName: "Monitored target",
    schedulerType: "slurm",
    schedulerVersion: "test",
    status: "online",
  });
  await db.insert(schedulerQueues).values({
    queueId: approvedTarget.queueId,
    providerOrgId: approvedTarget.providerOrgId,
    agentId: approvedTarget.agentId,
    name: "Monitored queue",
    schedulerType: "slurm",
    queueName: "approved",
  });
  await db.insert(jobs).values({
    id: jobId,
    name: "Monitored Job",
    command: "true",
    cpus: 1,
    memoryMb: 128,
    wallTimeSec: 30,
    submittedBy: identity.userId,
    orgId: identity.orgId,
    status,
    ...(status !== "pending"
      ? {
          agentId: approvedTarget.agentId,
          queueId: approvedTarget.queueId,
          queueTargetMode: "named",
          schedulerQueueName: "approved",
        }
      : {}),
  });
  const lease = await new WorkflowExecutionJournalStore(db).acquire(f.runId);
  if (!lease) throw new Error("Missing monitor test lease");
  await db.insert(workflowExecutionJobs).values({
    runId: f.runId,
    jobId,
    pathHash: "a".repeat(64),
    path: '["node","monitor"]',
    nodeId: "monitor",
    intent: {
      nodeId: "monitor",
      name: "Monitored",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    },
  });
  await lease.release();
  return {
    ...f,
    jobId,
    queues,
    authorization,
    monitor,
    cleanup: async () => {
      await monitor.stop();
      await db.delete(softwareOperations).where(eq(softwareOperations.federationJobId, jobId));
      await db.delete(workflowExecutionJobs).where(eq(workflowExecutionJobs.jobId, jobId));
      await db.delete(jobs).where(eq(jobs.id, jobId));
      await db.delete(schedulerQueues).where(eq(schedulerQueues.queueId, approvedTarget.queueId));
      await db.delete(agents).where(eq(agents.agentId, approvedTarget.agentId));
    },
  };
}

test.each([
  "offline",
  "queue",
  "cluster",
  "provider",
  "queue-name",
] as const)("active target monitoring handles %s independently of placement readiness", async (change) => {
  const f = await monitoredJob();
  try {
    await scanExecutions(f.monitor);
    expect((await f.registry.getById(f.runId))?.status).toBe("running");
    if (change === "offline")
      await db
        .update(agents)
        .set({ status: "offline" })
        .where(eq(agents.agentId, approvedTarget.agentId));
    if (change === "queue")
      await db
        .update(schedulerQueues)
        .set({ enabled: false })
        .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    if (change === "cluster")
      await db
        .update(agents)
        .set({ clusterId: "unapproved" })
        .where(eq(agents.agentId, approvedTarget.agentId));
    if (change === "provider")
      await db
        .update(agents)
        .set({ providerOrgId: outsider.orgId })
        .where(eq(agents.agentId, approvedTarget.agentId));
    if (change === "queue-name")
      await db
        .update(schedulerQueues)
        .set({ queueName: "replacement" })
        .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    await scanExecutions(f.monitor);
    expect((await f.registry.getById(f.runId))?.status).toBe(
      change === "offline" ? "running" : "cancelling",
    );
    if (change !== "offline") {
      expect((await f.registry.getById(f.runId))?.errorMessage).toBe("POLICY_DENIED");
      await f.drain();
      expect(f.cancellations).toContain(f.runId);
      expect((await f.registry.getById(f.runId))?.status).toBe("cancelling");
    }
  } finally {
    await f.cleanup();
  }
});

test("active queue authorization retries backend failures but persists explicit permission loss", async () => {
  const f = await monitoredJob();
  const access = spyOn(f.queues, "assertExecutionAccess").mockRejectedValue(
    new AuthorizationUnavailableError("Authorization unavailable: authz offline"),
  );
  try {
    await scanExecutions(f.monitor);
    expect((await f.registry.getById(f.runId))?.status).toBe("running");
    access.mockRejectedValue(new AppError(ErrorCode.FORBIDDEN, "Permission removed", 403));
    await scanExecutions(f.monitor);
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorMessage: "POLICY_DENIED",
    });
  } finally {
    access.mockRestore();
    await f.cleanup();
  }
});

test("completed Jobs do not acquire new execution obligations", async () => {
  const f = await monitoredJob("completed");
  try {
    await db
      .update(schedulerQueues)
      .set({ enabled: false })
      .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    await scanExecutions(f.monitor);
    expect((await f.registry.getById(f.runId))?.status).toBe("running");
  } finally {
    await f.cleanup();
  }
});

test("installation target revocation cancels a Job that has no compute Agent yet", async () => {
  const f = await monitoredJob("pending");
  const operationId = crypto.randomUUID();
  try {
    await db.insert(softwareOperations).values({
      id: operationId,
      federationJobId: f.jobId,
      requestedBy: identity.userId,
      agentId: approvedTarget.agentId,
      action: "install",
      spec: "hello@1",
      replayEnabled: true,
      manifestDigest: `sha256:${"a".repeat(64)}`,
      status: "running",
    });
    await db
      .update(jobs)
      .set({ softwareRequirements: [{ name: "hello", spec: "hello@1", operationId }] })
      .where(eq(jobs.id, f.jobId));
    await db
      .update(schedulerQueues)
      .set({ enabled: false })
      .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    await scanExecutions(f.monitor);
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorMessage: "POLICY_DENIED",
    });
    await f.drain();
    expect(f.cancellations).toContain(f.runId);
  } finally {
    await f.cleanup();
  }
});

test.each([
  "expiry",
  "revoke",
  "version",
  "digest",
  "policy",
] as const)("active data %s change stops computation without renewing transport credentials", async (change) => {
  const f = await monitoredJob();
  const dataId = crypto.randomUUID(),
    dataVersionId = crypto.randomUUID(),
    grantId = crypto.randomUUID();
  try {
    await db.insert(dataAssets).values({
      id: dataId,
      ownerKind: "user",
      ownerUserId: actor.userId,
      kind: "scientific-dataset",
      name: "Runtime grant",
      lifecycle: "published",
      visibility: "public",
      accessMode: "request",
      sensitivity: "open",
      createdBy: actor.userId,
    });
    await db.insert(dataAssetVersions).values({
      id: dataVersionId,
      dataAssetId: dataId,
      version: "1",
      status: "ready",
      immutableAt: new Date(),
      manifestDigest: `sha256:${"a".repeat(64)}`,
    });
    await db.insert(dataGrants).values({
      id: grantId,
      dataAssetId: dataId,
      dataAssetVersionId: dataVersionId,
      subjectKind: "user",
      subjectId: identity.userId,
      capabilities: ["use"],
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60_000),
      status: "active",
    });
    await db.insert(jobDataBindings).values({
      jobId: f.jobId,
      inputDescriptor: "input",
      source: "data-market",
      assetId: dataId,
      versionId: dataVersionId,
      manifestDigest: `sha256:${"a".repeat(64)}`,
      assetKind: "scientific-dataset",
      sensitivity: "open",
      egressPolicy: "deny",
      selectedEntries: ["input.txt"],
    });
    await scanExecutions(f.monitor);
    expect((await f.registry.getById(f.runId))?.status).toBe("running");
    if (change === "expiry")
      await db
        .update(dataGrants)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(dataGrants.id, grantId));
    if (change === "revoke")
      await db.update(dataGrants).set({ status: "revoked" }).where(eq(dataGrants.id, grantId));
    if (change === "version")
      await db
        .update(dataAssetVersions)
        .set({ status: "revoked" })
        .where(eq(dataAssetVersions.id, dataVersionId));
    if (change === "digest")
      await db
        .update(dataAssetVersions)
        .set({ manifestDigest: `sha256:${"b".repeat(64)}` })
        .where(eq(dataAssetVersions.id, dataVersionId));
    if (change === "policy")
      await db
        .update(dataAssetVersions)
        .set({ manifest: { deliveryPolicy: { download: "allow" } } })
        .where(eq(dataAssetVersions.id, dataVersionId));
    const unavailable =
      change === "expiry"
        ? spyOn(f.queues, "assertExecutionAccess").mockRejectedValue(
            new AuthorizationUnavailableError("Authorization unavailable"),
          )
        : undefined;
    try {
      await scanExecutions(f.monitor);
    } finally {
      unavailable?.mockRestore();
    }
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorMessage: change === "digest" ? "OPERATION_CONFLICT" : "POLICY_DENIED",
      completedAt: null,
    });
  } finally {
    await f.cleanup();
    await db.delete(dataAssets).where(eq(dataAssets.id, dataId));
  }
});

test.each([
  "license",
  "software-policy",
  "software-permission",
] as const)("active software %s revocation enters durable Workflow cancellation", async (change) => {
  const f = await monitoredJob();
  const softwareId = crypto.randomUUID(),
    releaseId = crypto.randomUUID(),
    claimId = crypto.randomUUID();
  const name = `monitored-${crypto.randomUUID()}`,
    spec = `${name}@1`;
  try {
    const softwarePayload = {
      kind: "spack-package",
      spack: { packageName: name, defaultSpec: spec },
    };
    await db.insert(softwareAssets).values({
      id: softwareId,
      kind: "spack-package",
      name,
      version: "1",
      source: "sp-published",
      lifecycle: "published",
      visibility: "platform-public",
      payload: softwarePayload,
    });
    const [revision] = await db
      .insert(softwareAssetRevisions)
      .values({ assetId: softwareId, revision: 1, payload: softwarePayload })
      .returning();
    if (!revision) throw new Error("Missing test software revision");
    await db.insert(ecosystemReleases).values({
      id: releaseId,
      releaseKey: name,
      version: "1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      manifest: {},
      provenance: {},
      signature: "test",
      signingKeyId: "test",
      status: "active",
      importedBy: actor.userId,
    });
    await db.insert(ecosystemReleaseAssets).values({
      releaseId,
      assetId: softwareId,
      assetRevisionId: revision.id,
      materializedAt: new Date(),
      ecosystemKey: `software/${name}`,
      kind: "spack-package",
      name,
      version: "1",
      payload: softwarePayload,
      provenance: {},
      manifestEntryDigest: `sha256:${"b".repeat(64)}`,
      licensePolicy: {
        classification: "proprietary",
        identifiers: [{ kind: "custom", value: "test-license" }],
        provenance: { source: "sp-published", reference: "test-contract" },
        acceptanceRequired: false,
        providerEntitlements: [],
        consumerEntitlements: ["use"],
        redistribution: "prohibited",
        autoInstall: "allowed",
      },
    });
    await db.insert(licenseEntitlementClaims).values({
      id: claimId,
      assetId: softwareId,
      licenseSubject: "test-license",
      entitlement: "consumer-use",
      claimantKind: "user",
      claimantId: identity.userId,
      evidenceReference: "test-contract",
      evidenceSummary: "Test authorization",
      status: "approved",
      submittedBy: actor.userId,
    });
    const [invocation] = await db
      .select()
      .from(workflowExecutionJobs)
      .where(eq(workflowExecutionJobs.jobId, f.jobId));
    if (!invocation) throw new Error("Missing test invocation");
    const requirements = [{ name, spec, assetId: softwareId, installable: false }];
    await db
      .update(workflowExecutionJobs)
      .set({ intent: { ...invocation.intent, softwareRequirements: requirements } })
      .where(eq(workflowExecutionJobs.jobId, f.jobId));
    await db.update(jobs).set({ softwareRequirements: requirements }).where(eq(jobs.id, f.jobId));
    // Running software does not need a new installation inventory report to retain its permit.
    await db
      .update(agents)
      .set({ status: "offline" })
      .where(eq(agents.agentId, approvedTarget.agentId));
    await scanExecutions(f.monitor);
    expect((await f.registry.getById(f.runId))?.status).toBe("running");
    if (change === "license")
      await db
        .update(licenseEntitlementClaims)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(licenseEntitlementClaims.id, claimId));
    if (change === "software-policy")
      await db
        .insert(softwarePolicies)
        .values({ agentId: approvedTarget.agentId, denyList: [spec], version: "revoked" });
    if (change === "software-permission")
      await db
        .update(softwareAssets)
        .set({ visibility: "private" })
        .where(eq(softwareAssets.id, softwareId));
    const unavailable =
      change === "license"
        ? spyOn(f.queues, "assertExecutionAccess").mockRejectedValue(
            new AuthorizationUnavailableError("Authorization unavailable"),
          )
        : undefined;
    try {
      await scanExecutions(f.monitor);
    } finally {
      unavailable?.mockRestore();
    }
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorCode: "FEDERATION_AUTHORIZATION_REVOKED",
      errorMessage: "POLICY_DENIED",
      completedAt: null,
    });
    await f.drain();
    expect(f.cancellations).toContain(f.runId);
  } finally {
    await f.cleanup();
    await db.delete(licenseEntitlementClaims).where(eq(licenseEntitlementClaims.id, claimId));
    await db.delete(ecosystemReleases).where(eq(ecosystemReleases.id, releaseId));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, softwareId));
  }
});

test("temporary material failure cannot hide active queue revocation", async () => {
  const f = await monitoredJob();
  const unavailable = spyOn(f.authorization, "prepare").mockRejectedValue(
    new FederationError("DATA_WAITING"),
  );
  try {
    await db
      .update(schedulerQueues)
      .set({ enabled: false })
      .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    await scanExecutions(f.monitor);
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorMessage: "POLICY_DENIED",
    });
  } finally {
    unavailable.mockRestore();
    await f.cleanup();
  }
});

test("temporary preparation and queue failures cannot hide a Sandbox script withdrawal", async () => {
  const f = await monitoredJob();
  const unavailable = spyOn(f.authorization, "prepare").mockRejectedValue(
    new FederationError("DATA_WAITING"),
  );
  const queueUnavailable = spyOn(f.queues, "assertExecutionAccess").mockRejectedValue(
    new AuthorizationUnavailableError("Authorization unavailable"),
  );
  try {
    const node = workflowDsl.WorkflowNodeSchema.parse({
      type: "Script",
      id: "monitor",
      name: "Pinned script",
      source: {
        type: "AssetRevision",
        assetId,
        assetRevisionId: revisionId,
        revision: 1,
        sha256: payload.sha256,
      },
      runtimeProfileId: crypto.randomUUID(),
      executionIdentity: { type: "MappedAuto" },
      outputs: {},
    });
    const intent = {
      nodeId: "monitor",
      name: "Monitored",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
      sandbox: {
        node,
        executionIdentity: { type: "MappedAuto" },
        submittedBy: identity.userId,
        orgId: identity.orgId,
      },
    };
    await db
      .update(workflowExecutionJobs)
      .set({ intent })
      .where(eq(workflowExecutionJobs.jobId, f.jobId));
    await db
      .update(softwareAssets)
      .set({ lifecycle: "revoked" })
      .where(eq(softwareAssets.id, assetId));
    await scanExecutions(f.monitor);
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorCode: "FEDERATION_AUTHORIZATION_REVOKED",
      errorMessage: "POLICY_DENIED",
    });
    await f.drain();
    expect(f.cancellations).toContain(f.runId);
  } finally {
    unavailable.mockRestore();
    queueUnavailable.mockRestore();
    await db
      .update(softwareAssets)
      .set({ lifecycle: "published" })
      .where(eq(softwareAssets.id, assetId));
    await f.cleanup();
  }
});

async function runtimeMaterial(f: Awaited<ReturnType<typeof monitoredJob>>) {
  const softwareId = crypto.randomUUID(),
    releaseId = crypto.randomUUID(),
    claimId = crypto.randomUUID();
  const name = `runtime-material-${softwareId}`;
  const softwarePayload = {
    kind: "spack-package",
    spack: { packageName: name, defaultSpec: `${name}@1` },
  };
  await db.insert(softwareAssets).values({
    id: softwareId,
    kind: "spack-package",
    name,
    version: "1",
    source: "sp-published",
    lifecycle: "published",
    visibility: "platform-public",
    payload: softwarePayload,
  });
  const [revision] = await db
    .insert(softwareAssetRevisions)
    .values({ assetId: softwareId, revision: 1, payload: softwarePayload })
    .returning();
  if (!revision) throw new Error("Missing material software revision");
  await db.insert(ecosystemReleases).values({
    id: releaseId,
    releaseKey: name,
    version: "1",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    manifest: {},
    provenance: {},
    signature: "fixture",
    signingKeyId: "fixture",
    status: "active",
    importedBy: actor.userId,
  });
  await db.insert(ecosystemReleaseAssets).values({
    releaseId,
    assetId: softwareId,
    assetRevisionId: revision.id,
    materializedAt: new Date(),
    ecosystemKey: `software/${name}`,
    kind: "spack-package",
    name,
    version: "1",
    payload: softwarePayload,
    provenance: {},
    manifestEntryDigest: `sha256:${"b".repeat(64)}`,
    licensePolicy: {
      classification: "proprietary",
      identifiers: [{ kind: "custom", value: name }],
      provenance: { source: "sp-published", reference: "test-contract" },
      acceptanceRequired: false,
      providerEntitlements: [],
      consumerEntitlements: ["use"],
      redistribution: "prohibited",
      autoInstall: "allowed",
    },
  });
  await db.insert(licenseEntitlementClaims).values({
    id: claimId,
    assetId: softwareId,
    licenseSubject: name,
    entitlement: "consumer-use",
    claimantKind: "user",
    claimantId: identity.userId,
    evidenceReference: "fixture",
    evidenceSummary: "fixture",
    status: "approved",
    submittedBy: identity.userId,
  });
  const request = {
    selector: "potential",
    targetPath: "inputs/potential",
    requiredElements: ["Si"],
  };
  const [mapping] = await db
    .insert(licensedMaterialMappings)
    .values({
      providerOrgId: approvedTarget.providerOrgId,
      agentId: approvedTarget.agentId,
      assetId: softwareId,
      selector: request.selector,
      licenseSubject: name,
      materialName: name,
      materialVersion: "1",
      elementSet: ["Si"],
      fingerprint: `sha256:${"d".repeat(64)}`,
      createdBy: actor.userId,
    })
    .returning();
  if (!mapping) throw new Error("Missing material mapping");
  const [invocation] = await db
    .select()
    .from(workflowExecutionJobs)
    .where(eq(workflowExecutionJobs.jobId, f.jobId));
  if (!invocation) throw new Error("Missing invocation");
  await db
    .update(workflowExecutionJobs)
    .set({ intent: { ...invocation.intent, licensedMaterials: [request] } })
    .where(eq(workflowExecutionJobs.jobId, f.jobId));
  return {
    mappingId: mapping.id,
    claimId,
    mount: {
      ...request,
      mappingId: mapping.id,
      assetId: softwareId,
      licenseSubject: name,
      expectedFingerprint: mapping.fingerprint,
    },
    cleanup: async () => {
      await db.delete(licensedMaterialMappings).where(eq(licensedMaterialMappings.id, mapping.id));
      await db.delete(licenseEntitlementClaims).where(eq(licenseEntitlementClaims.id, claimId));
      await db.delete(ecosystemReleases).where(eq(ecosystemReleases.id, releaseId));
      await db.delete(softwareAssets).where(eq(softwareAssets.id, softwareId));
    },
  };
}

test.each([
  "active",
  "queue-revoked",
  "epoch-revoked",
  "completed",
  "cancel-race",
  "data-active",
  "data-preparation-legacy",
  "data-deadline",
  "data-expired",
  "data-revoked",
  "data-binding",
  "default-queue",
  "material-active",
  "material-deadline",
  "material-revoked",
  "material-remapped",
] as const)("runtime renewal keeps the original acknowledged attempt and checks %s", async (change) => {
  const f = await monitoredJob("queued");
  const dispatcher = new AgentDispatcher();
  const outbox = new JobDispatchOutbox(
    db,
    dispatcher,
    (runId, target) => f.authorization.prepare(runId, target),
    async () => {
      throw new Error("Runtime renewal must not sign download credentials");
    },
  );
  await db.update(jobs).set({ dispatchEpoch: 1 }).where(eq(jobs.id, f.jobId));
  const lease = await new WorkflowExecutionJournalStore(db).acquire(f.runId);
  if (!lease) throw new Error("Missing runtime test lease");
  const message = dispatcher.buildDispatchJob(f.jobId, {
    federationExecution: true,
    jobIdInternal: f.jobId,
    name: "Runtime grant",
    command: "true",
    resources: { cpus: 1, memoryMb: 128, wallTimeSec: 30 },
    queueName: change === "default-queue" ? "resolved-default" : "approved",
    queueTargetMode: change === "default-queue" ? "default" : "named",
    dispatchEpoch: 1,
  });
  const bindingId = crypto.randomUUID();
  const data = change.startsWith("data-");
  const material = change.startsWith("material-") ? await runtimeMaterial(f) : undefined;
  if (material && message.payload.case === "dispatchJob")
    message.payload.value.licensedMaterialMounts.push(
      create(LicensedMaterialMountSchema, material.mount),
    );
  let pushed = 0;
  let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
  let permission: ReturnType<typeof spyOn<typeof f.queues, "assertExecutionAccess">> | undefined;
  try {
    if (change === "default-queue") {
      await db
        .update(schedulerQueues)
        .set({ targetMode: "default", queueName: null })
        .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
      await db
        .update(jobs)
        .set({ queueTargetMode: "default", schedulerQueueName: "resolved-default" })
        .where(eq(jobs.id, f.jobId));
    }
    if (data) {
      await db.insert(jobDataBindings).values({
        id: bindingId,
        jobId: f.jobId,
        inputDescriptor: "reads",
        source: "data-market",
        assetId: datasetId,
        versionId,
        manifestDigest: datasetRef.digest,
        assetKind: "scientific-dataset",
        sensitivity: "open",
        egressPolicy: "allow",
        stagePath: "inputs/reads",
        selectedEntries: ["reads.txt"],
      });
      if (message.payload.case !== "dispatchJob") throw new Error("Missing original dispatch");
      message.payload.value.dataDeliveries.push(
        create(DataDeliveryBindingSchema, {
          bindingId,
          assetId: datasetId,
          versionId,
          manifestDigest: datasetRef.digest,
          stagePath: "inputs/reads",
          leaseExpiresAtUnixMs: 1n,
          selectedEntries: [{ path: "reads.txt", sha256: "a".repeat(64), sizeBytes: 1n }],
        }),
      );
    }
    await outbox.enqueue(approvedTarget.agentId, message, f.runId, lease);
    await lease.release();
    await outbox.acknowledge(approvedTarget.agentId, f.jobId);
    await db
      .update(jobs)
      .set({ status: change === "data-preparation-legacy" ? "queued" : "running" })
      .where(eq(jobs.id, f.jobId));
    await db
      .update(agents)
      .set({ status: "offline" })
      .where(eq(agents.agentId, approvedTarget.agentId));
    dispatcher.register(approvedTarget.agentId, {
      federationComputeLeaseV1: true,
      federationExecutionV1: true,
      verifiedCertFingerprint: "verified",
      close: () => {},
      push: () => {
        pushed++;
      },
    });
    clock = spyOn(Date, "now").mockReturnValue(testNow.getTime());
    if (change === "data-deadline" || change === "data-expired") {
      await db
        .update(dataAssets)
        .set({ accessMode: "request" })
        .where(eq(dataAssets.id, datasetId));
      await db.insert(dataGrants).values({
        dataAssetId: datasetId,
        dataAssetVersionId: versionId,
        subjectKind: "user",
        subjectId: identity.userId,
        capabilities: ["use"],
        startsAt: new Date(testNow.getTime() - 1_000),
        expiresAt: new Date(testNow.getTime() + (change === "data-expired" ? 0 : 5_000)),
        status: "active",
      });
      // The same final authorization also bounds an initial compute permit.
      await db
        .update(agents)
        .set({ status: "online" })
        .where(eq(agents.agentId, approvedTarget.agentId));
      const initial = await f.authorization.prepare(f.runId, {
        kind: "compute",
        jobId: f.jobId,
        agentId: approvedTarget.agentId,
      });
      if (change === "data-deadline")
        expect(await db.transaction(initial)).toBe(testNow.getTime() + 5_000);
      else await expect(db.transaction(initial)).rejects.toThrow("POLICY_DENIED");
    }
    if (material && change === "material-deadline")
      await db
        .update(licenseEntitlementClaims)
        .set({ expiresAt: new Date(testNow.getTime() + 5_000) })
        .where(eq(licenseEntitlementClaims.id, material.claimId));
    if (material && change === "material-revoked")
      await db
        .update(licenseEntitlementClaims)
        .set({ status: "revoked" })
        .where(eq(licenseEntitlementClaims.id, material.claimId));
    if (material && change === "material-remapped")
      await db
        .update(licensedMaterialMappings)
        .set({ fingerprint: `sha256:${"e".repeat(64)}` })
        .where(eq(licensedMaterialMappings.id, material.mappingId));
    if (change === "queue-revoked")
      await db
        .update(schedulerQueues)
        .set({ enabled: false })
        .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    if (change === "epoch-revoked")
      await db.update(jobs).set({ revokedEpoch: 1 }).where(eq(jobs.id, f.jobId));
    if (change === "completed")
      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, f.jobId));
    if (change === "cancel-race") {
      const check = f.queues.assertExecutionAccess.bind(f.queues);
      permission = spyOn(f.queues, "assertExecutionAccess").mockImplementation(async (...args) => {
        await check(...args);
        await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, f.jobId));
      });
    }
    if (change === "data-revoked")
      await db
        .update(dataAssets)
        .set({ accessMode: "request" })
        .where(eq(dataAssets.id, datasetId));
    if (change === "data-binding")
      await db
        .update(jobDataBindings)
        .set({ selectedEntries: ["other.txt"] })
        .where(eq(jobDataBindings.id, bindingId));
    const replies: FederationExecutionResponse[] = [];
    const request = create(FederationExecutionRequestSchema, {
      requestId: crypto.randomUUID(),
      jobId: f.jobId,
      dispatchEpoch: 1n,
      runtimeRenewal: change !== "data-preparation-legacy",
    });
    const result = outbox.renewExecution(approvedTarget.agentId, request, (reply) => {
      if (change === "data-active") {
        const probe = Bun.spawnSync(
          [
            "bun",
            "-e",
            `import postgres from "postgres";
          const db = postgres(process.env.DATABASE_URL, {max: 1});
          try { await db.begin(tx => tx.unsafe('select id from data_assets where id=$1 for update nowait', [process.env.PROBE_ASSET])); process.stdout.write("unlocked"); }
          catch (error) { process.stdout.write(error.code); } await db.end();`,
          ],
          { env: { ...process.env, DATABASE_URL: url, PROBE_ASSET: datasetId }, timeout: 5000 },
        );
        expect(probe.exitCode).toBe(0);
        expect(probe.stdout.toString()).toBe("55P03");
      }
      replies.push(reply);
    });
    const granted = [
      "active",
      "data-active",
      "data-deadline",
      "default-queue",
      "material-active",
      "material-deadline",
    ].includes(change);
    if (change === "data-preparation-legacy")
      await expect(result).rejects.toThrow("does not support Data Market preparation leases");
    else if (
      [
        "queue-revoked",
        "data-revoked",
        "data-expired",
        "data-binding",
        "material-revoked",
        "material-remapped",
      ].includes(change)
    )
      await expect(result).rejects.toThrow();
    else expect(await result).toBe(granted);
    expect(pushed).toBe(0);
    expect(replies).toHaveLength(granted ? 1 : 0);
    if (granted) {
      expect(replies[0]).toMatchObject({
        runtimeRenewal: true,
        expiresAtUnixMs: BigInt(
          testNow.getTime() +
            (["material-deadline", "data-deadline"].includes(change) ? 5_000 : 10_000),
        ),
      });
      expect(replies[0]?.dispatch).toBeUndefined();
      expect(replies[0]?.installation).toBeUndefined();
      const [saved] = await db
        .select()
        .from(jobDispatchOutbox)
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
      expect(saved?.acknowledgedAt).not.toBeNull();
      expect(saved?.dispatchEpoch).toBe(1);
    }
  } finally {
    permission?.mockRestore();
    clock?.mockRestore();
    await lease.release();
    await f.cleanup();
    await material?.cleanup();
    if (data) {
      await db.delete(dataGrants).where(eq(dataGrants.dataAssetId, datasetId));
      await db.update(dataAssets).set({ accessMode: "open" }).where(eq(dataAssets.id, datasetId));
    }
  }
});

test("running mapped data keeps its use authorization after source locations disappear", async () => {
  await assets.register(actor, { reference: datasetRef, localRevisionId: versionId });
  await db.delete(dataLocations).where(eq(dataLocations.dataAssetVersionId, versionId));
  await expect(assets.resolve(identity, datasetRef)).rejects.toThrow("DATA_WAITING");
  expect((await assets.resolve(identity, datasetRef, true)).local.kind).toBe("dataset");
  await db.update(dataAssets).set({ accessMode: "request" }).where(eq(dataAssets.id, datasetId));
  try {
    await expect(assets.resolve(identity, datasetRef, true)).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db.update(dataAssets).set({ accessMode: "open" }).where(eq(dataAssets.id, datasetId));
  }
});

test("licensed material withdrawal cancels an active workflow even with a temporary queue outage", async () => {
  const f = await monitoredJob("queued");
  const material = await runtimeMaterial(f);
  const dispatcher = new AgentDispatcher();
  const outbox = new JobDispatchOutbox(db, dispatcher, (runId, target) =>
    f.authorization.prepare(runId, target),
  );
  const lease = await new WorkflowExecutionJournalStore(db).acquire(f.runId);
  if (!lease) throw new Error("Missing material fixture lease");
  let unavailable: ReturnType<typeof spyOn<typeof f.queues, "assertExecutionAccess">> | undefined;
  try {
    await db.update(jobs).set({ dispatchEpoch: 1 }).where(eq(jobs.id, f.jobId));
    await outbox.enqueue(
      approvedTarget.agentId,
      dispatcher.buildDispatchJob(f.jobId, {
        federationExecution: true,
        jobIdInternal: f.jobId,
        name: "Runtime material",
        command: "true",
        resources: { cpus: 1, memoryMb: 128, wallTimeSec: 30 },
        dispatchEpoch: 1,
        queueName: "approved",
        queueTargetMode: "named",
        licensedMaterialMounts: [material.mount],
      }),
      f.runId,
      lease,
    );
    await lease.release();
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, f.jobId));
    await f.authorization.checkActiveJobs(f.runId);
    unavailable = spyOn(f.queues, "assertExecutionAccess").mockRejectedValue(
      new AuthorizationUnavailableError("Authorization unavailable"),
    );
    await db
      .update(licensedMaterialMappings)
      .set({ revokedAt: new Date() })
      .where(eq(licensedMaterialMappings.id, material.mappingId));
    await scanExecutions(f.monitor);
    expect(await f.registry.getById(f.runId)).toMatchObject({
      status: "cancelling",
      errorCode: "FEDERATION_AUTHORIZATION_REVOKED",
      errorMessage: "POLICY_DENIED",
    });
    await f.drain();
    expect(f.cancellations).toContain(f.runId);
  } finally {
    unavailable?.mockRestore();
    await lease.release();
    await f.cleanup();
    await material.cleanup();
  }
});

test.each([
  "active",
  "startup",
  "startup-policy-revoked",
  "startup-legacy",
  "startup-input-legacy",
  "startup-signer-unavailable",
  "startup-changed",
  "mapping-deadline",
  "account-revoked",
  "policy-revoked",
  "snapshot-changed",
  "environment-lock",
] as const)("Sandbox runtime renewal preserves the original manifest and checks %s", async (change) => {
  const f = await monitoredJob("queued");
  const startup = change.startsWith("startup");
  const profileId = crypto.randomUUID(),
    accountId = crypto.randomUUID();
  const runtime = environment().sandboxRuntime;
  if (!runtime) throw new Error("Missing environment runtime");
  const policies = new SandboxPolicyService(db, {
    sandboxEnabled: true,
    impersonationEnabled: true,
    selfAccountEnabled: false,
    sharedServiceAllowed: false,
    degradedImpersonationAllowed: false,
    runtimePrecacheRequired: true,
    disabledRuntimeProfileIds: [],
    limits: {
      maxCpuCores: 2,
      maxMemoryMb: 256,
      maxWallTimeSec: 60,
      maxPids: 16,
      maxOutputBytes: 256,
      maxLogBytes: 256,
    },
  });
  const authorization = new FederationDispatchAuthorization(
    db,
    f.preparation,
    f.queues,
    availability,
    policies,
  );
  const dispatcher = new AgentDispatcher();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const renewalSigner = new SandboxManifestSigner({
    keyId: "renewed",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    now: () => testNow.getTime(),
  });
  let signatures = 0;
  const data = new FederationDataDispatch(db);
  const outbox = new JobDispatchOutbox(
    db,
    dispatcher,
    (runId, target) => authorization.prepare(runId, target),
    (id, message) => data.prepare(id, message),
    change === "startup-signer-unavailable"
      ? undefined
      : (manifest) => {
          signatures++;
          return renewalSigner.sign(
            change === "startup-changed"
              ? { ...manifest, limits: { ...manifest.limits, pids: 9 } }
              : manifest,
          );
        },
  );
  const lease = await new WorkflowExecutionJournalStore(db).acquire(f.runId);
  if (!lease) throw new Error("Missing Sandbox lease");
  let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
  try {
    await db
      .update(agents)
      .set({
        schedulerType: "kubernetes",
        sandboxCapabilities: { executionMode: "RootImpersonation" },
      })
      .where(eq(agents.agentId, approvedTarget.agentId));
    await db
      .update(schedulerQueues)
      .set({ schedulerType: "kubernetes" })
      .where(eq(schedulerQueues.queueId, approvedTarget.queueId));
    await db.insert(sandboxRuntimeProfiles).values({
      id: profileId,
      name: "Federation runtime",
      language: "bash",
      languageVersion: "5",
      ociDigest: runtime.digest,
      signature: "fixture",
      adapters: ["kubernetes"],
      securityRequirements: {},
      lifecycle: "active",
    });
    await db.insert(sandboxRuntimeContractBindings).values({
      providerOrgId: actor.orgId,
      agentId: approvedTarget.agentId,
      runtimeContractRef: "bash@1",
      runtimeProfileId: profileId,
      runtimeDigest: runtime.digest,
      boundBy: actor.userId,
      attestationKeyId: "fixture",
      attestationSignature: "fixture",
      attestedAt: new Date(),
    });
    await db.insert(clusterExecutionAccounts).values({
      id: accountId,
      providerOrgId: actor.orgId,
      agentId: approvedTarget.agentId,
      displayName: "Sandbox worker",
      backendType: "kubernetes",
      namespace: "science",
      serviceAccount: "worker",
    });
    const [mapping] = await db
      .insert(userClusterAccountMappings)
      .values({ userId: identity.userId, accountId, status: "approved" })
      .returning();
    if (!mapping) throw new Error("Missing identity mapping");
    const node = workflowDsl.WorkflowNodeSchema.parse({
      type: "Script",
      id: "monitor",
      name: "Script",
      source: {
        type: "AssetRevision",
        assetId,
        assetRevisionId: revisionId,
        revision: 1,
        sha256: payload.sha256,
      },
      runtimeProfileId: profileId,
      executionIdentity: { type: "MappedAuto" },
      outputs: {},
    });
    const intent = {
      nodeId: "monitor",
      name: "Sandbox",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
      sandbox: {
        node,
        executionIdentity: { type: "MappedAuto" },
        submittedBy: identity.userId,
        orgId: identity.orgId,
      },
    };
    await db
      .update(workflowExecutionJobs)
      .set({ intent })
      .where(eq(workflowExecutionJobs.jobId, f.jobId));
    const signer = new SandboxManifestSigner({
      keyId: "fixture",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      now: () => testNow.getTime() - 600_000,
    });
    const script = { language: "bash" as const, entrypoint: "main.sh", sha256: payload.sha256 };
    const manifest = signer.sign({
      jobId: f.jobId,
      script: {
        ...script,
        contentBase64: Buffer.from(content).toString("base64"),
        bundleSha256: sandboxBundleSha256(script),
      },
      runtime: { ...runtime, profileId },
      executionMode: "RootImpersonation",
      identity: {
        mode: "MappedAccount",
        accountId,
        backend: "Kubernetes",
        namespace: "science",
        serviceAccount: "worker",
        quotaPolicy: null,
      },
      mounts: [],
      limits: { pids: 8, outputBytes: 128, logBytes: 128 },
      networkDisabled: true,
    });
    await db
      .update(jobs)
      .set({ dispatchEpoch: 1, sandboxExecution: manifest })
      .where(eq(jobs.id, f.jobId));
    const build = () =>
      dispatcher.buildDispatchJob(f.jobId, {
        federationExecution: true,
        jobIdInternal: f.jobId,
        name: "Sandbox",
        command: "true",
        resources: { cpus: 1, memoryMb: 128, wallTimeSec: 30 },
        queueName: "approved",
        queueTargetMode: "named",
        dispatchEpoch: 1,
        sandboxExecution: manifest,
        ...(change === "startup-input-legacy"
          ? {
              inputStaging: [
                {
                  fileMetadataId: "00000000-0000-4000-8000-000000000111",
                  stagePath: "inputs/data",
                  sourceUrl: "https://objects.test/data",
                },
              ],
            }
          : {}),
      });
    await outbox.enqueue(approvedTarget.agentId, build(), f.runId, lease);
    await lease.release();
    await outbox.acknowledge(approvedTarget.agentId, f.jobId);
    await db
      .update(jobs)
      .set({ status: startup ? "queued" : "running" })
      .where(eq(jobs.id, f.jobId));
    dispatcher.register(approvedTarget.agentId, {
      federationComputeLeaseV1: true,
      federationSandboxSignatureRenewalV1: change !== "startup-legacy",
      federationExecutionV1: true,
      verifiedCertFingerprint: "fixture",
      close: () => {},
      push: () => {
        throw new Error("Runtime renewal must not redispatch");
      },
    });
    clock = spyOn(Date, "now").mockReturnValue(testNow.getTime());
    if (change === "mapping-deadline")
      await db
        .update(userClusterAccountMappings)
        .set({ expiresAt: new Date(testNow.getTime() + 5_000) })
        .where(eq(userClusterAccountMappings.id, mapping.id));
    if (change === "account-revoked")
      await db
        .update(clusterExecutionAccounts)
        .set({ enabled: false })
        .where(eq(clusterExecutionAccounts.id, accountId));
    if (change === "policy-revoked" || change === "startup-policy-revoked")
      await db.insert(sandboxPolicyOverlays).values({
        scope: "agent",
        agentId: approvedTarget.agentId,
        policy: { sandboxEnabled: false },
        updatedBy: actor.userId,
      });
    if (change === "snapshot-changed")
      await db
        .update(jobs)
        .set({ sandboxExecution: { ...manifest, networkDisabled: false } })
        .where(eq(jobs.id, f.jobId));
    if (change === "environment-lock") {
      manifest.runtime.digest = `sha256:${"e".repeat(64)}`;
      await db.update(jobs).set({ sandboxExecution: manifest }).where(eq(jobs.id, f.jobId));
      await db
        .update(sandboxRuntimeProfiles)
        .set({ ociDigest: manifest.runtime.digest })
        .where(eq(sandboxRuntimeProfiles.id, profileId));
      await db
        .update(sandboxRuntimeContractBindings)
        .set({ runtimeDigest: manifest.runtime.digest })
        .where(eq(sandboxRuntimeContractBindings.runtimeProfileId, profileId));
      await db
        .update(jobDispatchOutbox)
        .set({
          payloadBase64: Buffer.from(toBinary(ServerMessageSchema, build())).toString("base64"),
        })
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
    }
    const replies: FederationExecutionResponse[] = [];
    const request = create(FederationExecutionRequestSchema, {
      requestId: crypto.randomUUID(),
      jobId: f.jobId,
      dispatchEpoch: 1n,
      runtimeRenewal: !startup,
    });
    const result = outbox.renewExecution(approvedTarget.agentId, request, (reply) =>
      replies.push(reply),
    );
    if (change === "startup") {
      expect(await result).toBe(true);
      const envelope = replies[0]?.dispatch?.sandboxExecution?.envelope;
      expect(envelope?.nonce).not.toBe(manifest.envelope.nonce);
      expect(envelope?.keyId).toBe("renewed");
      expect(envelope?.expiresAtUnixMs).toBe(BigInt(testNow.getTime() + 300_000));
      const { envelope: _original, ...unsigned } = manifest;
      expect(
        verify(
          null,
          Buffer.from(canonicalJson(unsigned)),
          publicKey,
          envelope?.signature ?? new Uint8Array(),
        ),
      ).toBe(true);
      expect(replies[0]?.expiresAtUnixMs).toBe(BigInt(testNow.getTime() + 10_000));
      expect(signatures).toBe(1);
      const [savedJob] = await db.select().from(jobs).where(eq(jobs.id, f.jobId));
      const [savedMessage] = await db
        .select()
        .from(jobDispatchOutbox)
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
      expect(savedJob?.sandboxExecution).toEqual(manifest);
      expect(savedMessage?.payloadBase64).toBe(
        Buffer.from(toBinary(ServerMessageSchema, build())).toString("base64"),
      );
      expect(
        await outbox.renewExecution(approvedTarget.agentId, request, (reply) =>
          replies.push(reply),
        ),
      ).toBe(true);
      expect(replies[1]?.dispatch?.sandboxExecution?.envelope?.nonce).not.toBe(envelope?.nonce);
    } else if (change === "startup-legacy") {
      await expect(result).rejects.toThrow("does not support Sandbox signature renewal");
      expect(signatures).toBe(0);
      expect(replies).toHaveLength(0);
    } else if (change === "startup-input-legacy") {
      await expect(result).rejects.toThrow("does not support Sandbox input leases");
      expect(signatures).toBe(0);
      expect(replies).toHaveLength(0);
    } else if (change === "active" || change === "mapping-deadline") {
      expect(await result).toBe(true);
      expect(replies[0]).toMatchObject({
        runtimeRenewal: true,
        expiresAtUnixMs: BigInt(
          testNow.getTime() + (change === "mapping-deadline" ? 5_000 : 10_000),
        ),
      });
      expect(replies[0]?.dispatch).toBeUndefined();
      expect(signatures).toBe(0);
      expect(manifest.envelope.expiresAtUnixMs).toBeLessThan(testNow.getTime());
    } else {
      await expect(result).rejects.toThrow();
      expect(replies).toHaveLength(0);
      if (change === "startup-policy-revoked") expect(signatures).toBe(0);
    }
  } finally {
    clock?.mockRestore();
    await lease.release();
    await f.cleanup();
    await db.delete(sandboxRuntimeProfiles).where(eq(sandboxRuntimeProfiles.id, profileId));
  }
});

test("federation activation queues one original run and never revives a terminal run", async () => {
  const f = await executionFixture();
  const binding = await f.bindings.stage(f.reservationId);
  const authorization = new FederationDispatchAuthorization(db, f.preparation);
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      queueFederationWorkflow(db, authorization, binding.workflowRunId),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await new WorkflowRunRegistry(db).getById(binding.workflowRunId))?.status).toBe("queued");
  await db
    .update(workflowRuns)
    .set({ status: "cancelled" })
    .where(eq(workflowRuns.id, binding.workflowRunId));
  expect(await queueFederationWorkflow(db, authorization, binding.workflowRunId)).toBe(false);
  expect((await f.bindings.stage(f.reservationId)).workflowRunId).toBe(binding.workflowRunId);
});

test("federation activation rechecks revocation between preparation and the queue transaction", async () => {
  const f = await executionFixture();
  const binding = await f.bindings.stage(f.reservationId);
  const authorization = new FederationDispatchAuthorization(db, f.preparation);
  try {
    await expect(
      queueFederationWorkflow(
        db,
        {
          prepare: async (...args) => {
            const fence = await authorization.prepare(...args);
            await db.update(users).set({ suspended: true }).where(eq(users.id, identity.userId));
            return fence;
          },
        },
        binding.workflowRunId,
      ),
    ).rejects.toThrow();
    expect((await new WorkflowRunRegistry(db).getById(binding.workflowRunId))?.status).toBe(
      "submitted",
    );
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, identity.userId));
  }
});

test.each([
  "granted",
  "revoked",
  "unavailable",
  "checkpoint",
] as const)("federation activation recovery obtains current authority: %s", async (mode) => {
  const f = await executionFixture();
  const binding = await f.bindings.stage(f.reservationId);
  const authorization = new FederationDispatchAuthorization(db, f.preparation);
  await queueFederationWorkflow(db, authorization, binding.workflowRunId);
  const registry = new WorkflowRunRegistry(db);
  let executions = 0;
  const pending: Array<() => Promise<void>> = [];
  let checkpointPending = mode === "checkpoint";
  const makeRunner = () =>
    new WorkflowAsyncRunner({
      registry,
      awaitCheckpointPersistence: async () => {
        if (checkpointPending)
          throw new WorkflowExecutionInterrupted("checkpoint publication pending");
      },
      journal: new WorkflowExecutionJournalStore(db),
      schedule: (task) => {
        pending.push(task);
      },
      authorizeFederationExecution: (id, lease) => authorization.authorizeWorkflow(id, lease),
      makeRunner: (_user, _role, _runId, _placement, _orgId, lease) =>
        createWorkflowRunner({
          journal: lease,
          resolvePackage: async () => {
            throw new Error("Unexpected package");
          },
          submitJob: async () => {
            throw new Error("Unexpected software Job");
          },
          executeScript: async () => {
            executions++;
            return { status: "Succeeded", values: {} };
          },
        }),
    });
  let runner = makeRunner();
  const snapshot = f.preparation.executionSnapshot.bind(f.preparation);
  const injected = spyOn(f.preparation, "executionSnapshot").mockImplementation(async (...args) => {
    if (mode === "unavailable") throw new Error("temporary database connection loss");
    return snapshot(...args);
  });
  try {
    if (mode === "revoked")
      await db.update(users).set({ suspended: true }).where(eq(users.id, identity.userId));
    await runner.recoverInterruptedRuns(true);
    for (const task of pending.splice(0)) await task();
    const run = await registry.getById(binding.workflowRunId);
    expect(executions).toBe(mode === "granted" || mode === "checkpoint" ? 1 : 0);
    expect(run?.status).toBe(
      mode === "granted" ? "completed" : mode === "revoked" ? "failed" : "running",
    );
    if (mode === "unavailable" || mode === "checkpoint") {
      expect(run?.errorCode).toBe("WORKFLOW_RECOVERY_PENDING");
      injected.mockRestore();
      await runner.stop();
      checkpointPending = false;
      runner = makeRunner();
      await runner.recoverInterruptedRuns(true);
      for (const task of pending.splice(0)) await task();
      expect((await registry.getById(binding.workflowRunId))?.status).toBe("completed");
      expect(executions).toBe(1);
    }
    expect(
      await queueFederationWorkflow(db, authorization, binding.workflowRunId).catch(() => false),
    ).toBe(false);
  } finally {
    injected.mockRestore();
    await runner.stop();
    await db.update(users).set({ suspended: false }).where(eq(users.id, identity.userId));
  }
});

test("federation activation worker recovers a previously bound held run after temporary failure", async () => {
  const f = await executionFixture();
  const binding = await f.bindings.stage(f.reservationId);
  await f.preparation.prepare(f.reservationId);
  const authorization = new FederationDispatchAuthorization(db, f.preparation);
  let available = false;
  const worker = new FederationPreparationWorker(db, f.preparation, f.bindings, async (id) => {
    if (id !== binding.workflowRunId) return false;
    if (!available) throw new Error("temporary activation outage");
    return queueFederationWorkflow(db, authorization, id);
  });
  const readyForRetry = () =>
    db
      .update(federationPreparations)
      .set({ updatedAt: new Date(0) })
      .where(eq(federationPreparations.reservationId, f.reservationId));
  await readyForRetry();
  await worker.tick();
  expect((await new WorkflowRunRegistry(db).getById(binding.workflowRunId))?.status).toBe(
    "submitted",
  );
  const [state] = await db
    .select()
    .from(federationPreparations)
    .where(eq(federationPreparations.reservationId, f.reservationId));
  expect(state?.updatedAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
  available = true;
  await readyForRetry();
  await worker.tick();
  expect((await new WorkflowRunRegistry(db).getById(binding.workflowRunId))?.status).toBe("queued");
  await worker.stop();
});

test("reservation status includes the bound workflow failure without exposing execution inputs", async () => {
  const f = await executionFixture();
  const permissions = new FederationPermissionService(db);
  for (const subject of [actor, outsider])
    await permissions.set(
      { ...subject, capability: "agreement.read", enabled: true },
      actor.userId,
    );
  const service = new FederationAgreementService(db, target.signing, () => testNow);
  const status = async () =>
    (await service.listReservations(actor, agreement.agreementRevisionId, 100)).find(
      (row) => row.id === f.reservationId,
    );
  expect((await status())?.workflow).toBeNull();
  await f.preparation.prepare(f.reservationId);
  const binding = await f.bindings.stage(f.reservationId);
  expect((await status())?.workflow).toMatchObject({
    runId: binding.workflowRunId,
    status: "submitted",
    errorCode: null,
  });
  await new WorkflowRunRegistry(db).failRun(
    binding.workflowRunId,
    new Error("Private script input must not appear in agreement status"),
    "WORKFLOW_NODE_FAILED",
  );
  const saved = await status();
  expect(saved?.preparation?.state).toBe("resolved");
  expect(saved?.workflow).toEqual({
    runId: binding.workflowRunId,
    status: "failed",
    errorCode: "WORKFLOW_NODE_FAILED",
    updatedAt: expect.any(Date),
  });
  expect(await service.listReservations(actor, agreement.agreementRevisionId, 1)).toHaveLength(1);
  expect(await service.listReservations(actor, agreement.agreementRevisionId, 1, 1000)).toEqual([]);
  await expect(service.listReservations(outsider, agreement.agreementRevisionId)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await permissions.set({ ...actor, capability: "agreement.read", enabled: false }, actor.userId);
  try {
    await expect(service.listReservations(actor, agreement.agreementRevisionId)).rejects.toThrow(
      "POLICY_DENIED",
    );
  } finally {
    await permissions.set({ ...actor, capability: "agreement.read", enabled: true }, actor.userId);
  }
});
