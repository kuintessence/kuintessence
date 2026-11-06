import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
  jobs,
  orgs,
  softwareAssetRevisions,
  softwareAssets,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAgreementSchema,
  type FederationAssetRef,
  FederationDelegationSchema,
  type FederationEnvironmentLock,
  type FederationInputManifest,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationAssetRoutes } from "../routes/federation-assets";
import { SoftwareAvailabilityService } from "../services/software-availability";
import { FederationAdmission } from "./admission";
import { FederationAssetService, federationMaterialDigest } from "./assets";
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
    await expect(assets.resolve(identity, scriptRef)).rejects.toThrow("ASSET_UNAVAILABLE");
  } finally {
    await db
      .update(softwareAssets)
      .set({ lifecycle: "published" })
      .where(eq(softwareAssets.id, assetId));
  }
  const reference = { ...scriptRef, id: crypto.randomUUID() };
  const mapping = await assets.register(actor, { reference, localRevisionId: revisionId });
  await assets.revoke(actor, mapping.id);
  await expect(assets.resolve(identity, reference)).rejects.toThrow("ASSET_UNAVAILABLE");
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
async function receive(input = inputs(), lock = environment()) {
  const request = {
    ...testDelegation(agreement),
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
