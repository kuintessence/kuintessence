import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentDataRoots } from "@kuintessence/agent/data-market/roots";
import { FederationMediaExportClient } from "@kuintessence/agent/federation/media-export";
import { FederationMediaImportClient } from "@kuintessence/agent/federation/media-import";
import {
  agents,
  auditLog,
  authzOutbox,
  clusterFileRoots,
  createPgDb,
  dataAccessPolicies,
  dataAssetManifestEntries,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  dataLocations,
  federationAgreementApprovals,
  federationCertificates,
  federationDatasetAssets,
  federationDatasetReplicas,
  federationDatasetUseGrants,
  federationDatasetUsePolicies,
  federationMediaExports,
  federationMediaImportAuthorizations,
  federationMediaImportOperations,
  federationMediaKeyGrants,
  federationMediaReceipts,
  federationSigningKeys,
  jobDataBindings,
  jobs,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  DispatchJobSchema,
  FederationMediaExportLeaseResponseSchema,
  FederationMediaImportGrantResponseSchema,
  SandboxIoType,
  SandboxMountMode,
  ServerMessageSchema,
} from "@kuintessence/proto";
import {
  assertDatasetUseGrant,
  FederationAgreementSchema,
  FederationDatasetUseGrantSchema,
  FederationDatasetUseQuerySchema,
  FederationMediaKeyGrantSchema,
  FederationMediaKeyQuerySchema,
  FederationMediaManifestSchema,
  FederationMediaReceiptAckSchema,
  FederationMediaReceiptSchema,
  FederationMediaRecipientKeySchema,
} from "@kuintessence/shared/federation";
import { MediaAge } from "@kuintessence/shared/federation/media-age";
import { decryptFederationMediaIdentity } from "@kuintessence/shared/federation/media-key-crypto";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportJWK, exportSPKI, generateKeyPair } from "jose";
import pino from "pino";
import { z } from "zod";
import { decryptSecret } from "../auth/secret-cipher";
import { AgentDispatcher } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import { buildCpRouter } from "../routes/cp";
import { createFederationMediaRoutes } from "../routes/federation-media";
import type { CpConsoleService } from "../services/cp-console";
import { evaluateActiveDataAccess } from "../services/data-access-decision";
import { DataDeliveryResolver } from "../services/data-delivery";
import { DataDisclosurePolicyService } from "../services/data-disclosure-policies";
import {
  type DataMarketActor,
  DataMarketService,
  type DataUploadPort,
} from "../services/data-market";
import { PgDataMarketRepository } from "../services/data-market-repository-drizzle";
import { PgDataPrerequisiteRepository } from "../services/data-prerequisite-repository-drizzle";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { assertRunningDataBindings, FederationDataDispatch } from "./data-dispatch";
import { datasetSourceAuthority } from "./dataset-authority";
import { FederationDatasetPublicationService } from "./dataset-publication";
import { FederationDatasetUseClient } from "./dataset-use-client";
import { FederationDatasetUseResponder } from "./dataset-use-exchange";
import { FederationDatasetUsePolicies } from "./dataset-use-policies";
import { createFederationIngress } from "./ingress";
import { FederationMediaExportOperations } from "./media-export-operations";
import { FederationMediaExportTransport } from "./media-export-transport";
import { FederationMediaExportService, mediaIdentityDomain } from "./media-exports";
import { FederationMediaImportOperations } from "./media-import-operations";
import { FederationMediaImportTransport } from "./media-import-transport";
import { FederationMediaKeyRequester, FederationMediaKeyResponder } from "./media-key-exchange";
import { FederationMediaLogistics } from "./media-logistics";
import { FederationMediaPackageService } from "./media-packages";
import { FederationMediaReceiptReceiver, FederationMediaReceiptSender } from "./media-receipts";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { testAgreement, testKeys, testNow } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Media tests require an isolated kuintessence_unit_* DATABASE_URL");
const binary = process.env.KQ_MEDIA_AGE_TEST_BIN;
describe.skipIf(!binary)("source dataset export consent with real pinned age", () => {
  const db = createPgDb(url, { max: 6, idle_timeout: 1 });
  const actor = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() },
    other = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const worker = { orgId: actor.orgId, userId: crypto.randomUUID() };
  const versionId = crypto.randomUUID(),
    assetId = crypto.randomUUID(),
    locationId = crypto.randomUUID(),
    rootId = crypto.randomUUID(),
    entryId = crypto.randomUUID(),
    policyId = crypto.randomUUID();
  const agentId = `media-source-${crypto.randomUUID()}`,
    wrapping = "isolated-media-key-".repeat(3);
  const age = new MediaAge(binary ?? "");
  const provenance = {
    source: "institutional observations",
    revision: "2026-01",
    instruments: ["sensor-a"],
    sourceDigest: "c".repeat(64),
    checks: { calibrated: true },
  };
  const metadata = { license: "CC-BY-4.0", provenance };
  let source: Awaited<ReturnType<typeof testKeys>>, target: Awaited<ReturnType<typeof testKeys>>;
  let terms: ReturnType<typeof testAgreement>, service: FederationMediaExportService;
  let now = testNow;
  const permissions = new FederationPermissionService(db);
  beforeAll(async () => {
    await db.insert(orgs).values([
      { id: actor.orgId, name: "Source data institution" },
      { id: other.orgId, name: "Other local organization" },
    ]);
    await db.insert(users).values(
      [actor, other, worker].map((a) => ({
        id: a.userId,
        orgId: a.orgId,
        email: `${a.userId}@test.invalid`,
        role: "user",
        serviceAccount: a === worker,
      })),
    );
    await db
      .insert(userOrgMemberships)
      .values([actor, other, worker].map((a) => ({ ...a, role: "member" })));
    for (const a of [actor, other])
      for (const capability of ["agreement.approve", "asset.map", "media.export"] as const)
        await permissions.set({ ...a, capability, enabled: true }, actor.userId);
    [source, target] = await Promise.all([testKeys(), testKeys()]);
    const trust = new FederationTrustRegistry(db);
    for (const keys of [source, target]) {
      await trust.addSite(
        {
          id: keys.signing.siteId,
          name: "Media test site",
          endpoint: "https://media.test.invalid",
        },
        actor.userId,
      );
      await trust.addKey(
        keys.signing.siteId,
        {
          keyId: keys.signing.keyId,
          publicKeyPem: await exportSPKI(keys.verification.publicKey),
          validFrom: keys.verification.validFrom.toISOString(),
          validUntil: keys.verification.validUntil.toISOString(),
          allowedKinds: ["agreement", "media-manifest", "media-key-query", "media-key-grant"],
        },
        actor.userId,
      );
    }
    terms = testAgreement(source.signing.siteId, target.signing.siteId);
    // Fingerprint registry fixture; actual certificate transport is exercised by gateway/sender tests.
    await db.insert(federationCertificates).values({
      siteId: target.signing.siteId,
      fingerprint: "d".repeat(64),
      certificatePem: "isolated fingerprint registry fixture",
      validFrom: new Date("2025-01-01"),
      validUntil: new Date("2027-01-01"),
    });
    await new FederationAdmission(
      db,
      target.signing,
      target.verification,
      () => testNow,
    ).installApprovedAgreement({
      sourceApprovalJws: await signFederationMessage(
        FederationAgreementSchema,
        terms,
        source.signing,
      ),
      targetApprovalJws: await signFederationMessage(
        FederationAgreementSchema,
        terms,
        target.signing,
      ),
      sourceKey: source.verification,
      targetKey: target.verification,
      identity: worker,
    });
    const sourceConsent = new FederationAgreementService(db, source.signing, () => now);
    await sourceConsent.approve(actor, { terms });
    await sourceConsent.attachCounterparty(
      actor,
      terms.agreementRevisionId,
      await signFederationMessage(FederationAgreementSchema, terms, target.signing),
    );
    await db.insert(agents).values({
      agentId,
      providerOrgId: actor.orgId,
      siteName: "Source",
      siteId: "media-cluster",
      schedulerType: "slurm",
      schedulerVersion: "test",
    });
    await db.insert(clusterFileRoots).values({
      id: rootId,
      agentId,
      providerOrgId: actor.orgId,
      label: "Approved source storage",
      path: "/managed/datasets",
    });
    await db.insert(dataAssets).values({
      id: assetId,
      ownerUserId: actor.userId,
      name: "Immutable test observations",
      lifecycle: "published",
      visibility: "public",
      accessMode: "open",
      metadata: { license: "CC-BY-4.0" },
    });
    await db.insert(dataAssetVersions).values({
      id: versionId,
      dataAssetId: assetId,
      version: "v1",
      status: "ready",
      sizeBytes: 4,
      manifestDigest: "a".repeat(64),
      immutableAt: testNow,
      provenance,
    });
    await db.insert(dataAssetManifestEntries).values({
      id: entryId,
      dataAssetVersionId: versionId,
      entryPath: "input.dat",
      digest: createHash("sha256").update("data").digest("hex"),
      sizeBytes: 4,
      metadata,
    });
    await db.insert(dataLocations).values({
      id: locationId,
      dataAssetVersionId: versionId,
      kind: "cp-local",
      managedRootId: rootId,
      relativePath: "v1",
      agentId,
      providerOrgId: actor.orgId,
      status: "available",
    });
    await db.insert(dataAccessPolicies).values({
      id: policyId,
      dataAssetId: assetId,
      dataAssetVersionId: versionId,
      subjectKind: "user",
      subjectId: actor.userId,
      capabilities: ["download"],
      downloadPolicy: "allow",
      redistributionPolicy: "allow",
      crossCenterReplicationPolicy: "allow",
      expiresAt: new Date(testNow.getTime() + 7200_000),
    });
    service = new FederationMediaExportService(db, source.signing, age, wrapping, () => now);
  });
  beforeEach(async () => {
    now = testNow;
    const foreign = await db.select().from(federationDatasetAssets);
    await db.delete(federationDatasetReplicas);
    await db.delete(federationMediaImportOperations);
    await db.delete(federationMediaReceipts);
    await db.delete(federationDatasetAssets);
    for (const asset of foreign)
      await db.delete(dataAssets).where(eq(dataAssets.id, asset.assetId));
    await db
      .delete(dataAccessPolicies)
      .where(
        and(
          eq(dataAccessPolicies.dataAssetVersionId, versionId),
          eq(dataAccessPolicies.subjectKind, "org"),
        ),
      );
    await db
      .update(dataAssets)
      .set({
        ownerKind: "user",
        ownerUserId: actor.userId,
        providerOrgId: null,
        lifecycle: "published",
      })
      .where(eq(dataAssets.id, assetId));
    await db
      .update(userOrgMemberships)
      .set({ role: "member" })
      .where(eq(userOrgMemberships.userId, actor.userId));
    await db
      .update(dataAccessPolicies)
      .set({
        status: "active",
        effect: "allow",
        capabilities: ["download"],
        downloadPolicy: "allow",
        redistributionPolicy: "allow",
        crossCenterReplicationPolicy: "allow",
        expiresAt: new Date(testNow.getTime() + 7200_000),
      })
      .where(eq(dataAccessPolicies.id, policyId));
    await db
      .update(dataAssetManifestEntries)
      .set({ metadata, sizeBytes: 4 })
      .where(eq(dataAssetManifestEntries.id, entryId));
    await db
      .update(clusterFileRoots)
      .set({ enabled: true, providerOrgId: actor.orgId })
      .where(eq(clusterFileRoots.id, rootId));
    await permissions.set({ ...actor, capability: "media.export", enabled: true }, actor.userId);
  });
  afterAll(async () => {
    await db.$client.end();
  });
  const request = () => ({
    packageId: crypto.randomUUID(),
    recipientSiteId: target.signing.siteId,
    agreementRevisionId: terms.agreementRevisionId,
    versionId,
    locationId,
    expiresAt: new Date(testNow.getTime() + 3600_000).toISOString(),
  });
  test.each([
    "suspended",
    "unsigned",
    "wrong-organization",
    "wrong-signature",
  ] as const)("source media consent rejects invalid local agreement approval: %s", async (change) => {
    const use = await useFixture();
    const exported = await service.prepare(actor, request());
    const condition = and(
      eq(federationAgreementApprovals.localSiteId, source.signing.siteId),
      eq(federationAgreementApprovals.revisionId, terms.agreementRevisionId),
    );
    const [original] = await db.select().from(federationAgreementApprovals).where(condition);
    if (!original) throw new Error("Missing source approval");
    try {
      await db
        .update(federationAgreementApprovals)
        .set(
          change === "suspended"
            ? { state: "suspended" }
            : change === "wrong-organization"
              ? { localOrgId: other.orgId }
              : {
                  counterpartyApprovalJws: change === "unsigned" ? null : original.approvalJws,
                },
        )
        .where(condition);
      await expect(service.prepare(actor, request())).rejects.toThrow();
      await expect(authorize(exported.packageId)).rejects.toThrow();
      await expect(use.policyService.approve(actor, use.input)).rejects.toThrow();
      await expect(
        db.transaction((tx) => use.policyService.assertQuery(tx, use.query)),
      ).rejects.toThrow();
    } finally {
      await db
        .update(federationAgreementApprovals)
        .set({
          state: original.state,
          localOrgId: original.localOrgId,
          counterpartyApprovalJws: original.counterpartyApprovalJws,
        })
        .where(condition);
    }
  });
  const row = async (id: string) => {
    const [r] = await db
      .select()
      .from(federationMediaExports)
      .where(
        and(
          eq(federationMediaExports.localSiteId, source.signing.siteId),
          eq(federationMediaExports.packageId, id),
        ),
      );
    if (!r) throw new Error("Missing test export");
    return r;
  };
  const authorize = (id: string) =>
    db.transaction((tx) => service.assertExportAuthorized(tx, actor.orgId, id));
  const manager: DataMarketActor = {
    ...actor,
    role: "user",
    orgIds: [actor.orgId],
    providerManagerOrgIds: [actor.orgId],
  };
  const uploadPort: DataUploadPort = {
    createUploadSession: async () => {
      throw new Error("unused");
    },
    getUploadSessionAsset: async () => {
      throw new Error("unused");
    },
    commitUploadSession: async () => {
      throw new Error("unused");
    },
  };
  const market = new DataMarketService({ repository: new PgDataMarketRepository(db), uploadPort });
  const policies = new DataDisclosurePolicyService(
    db,
    (a, id) => market.requireManage(a, id),
    () => now,
  );
  const consent = () => ({
    expectedUpdatedAt: null,
    enabled: true,
    expiresAt: new Date(testNow.getTime() + 7200_000).toISOString(),
    reason: "Approved institutional data exchange",
  });
  async function onlyOrgConsent() {
    await db
      .update(dataAccessPolicies)
      .set({ status: "disabled" })
      .where(eq(dataAccessPolicies.id, policyId));
    return policies.write(manager, versionId, consent());
  }
  function app(
    operations?: FederationMediaExportOperations,
    usePolicies?: FederationDatasetUsePolicies,
  ) {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ enabled: false })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, actor as never);
      await next();
    });
    r.route(
      "/api",
      createFederationMediaRoutes(
        new FederationMediaPackageService(db, source.signing.siteId),
        service,
        operations,
        undefined,
        usePolicies,
      ),
    );
    return r;
  }

  test("logistics source: signed exports share one batch without disclosing keys or changing data permissions", async () => {
    await permissions.set({ ...actor, capability: "media.logistics", enabled: true }, actor.userId);
    const logistics = new FederationMediaLogistics(db, source.signing.siteId, () => now);
    const earlierPackages = (await logistics.transportPackages(actor)).data.map(
      (row) => row.packageId,
    );
    const first = await service.prepare(actor, request());
    const second = await service.prepare(actor, request());
    const devices = [crypto.randomUUID(), crypto.randomUUID()];
    for (const deviceId of devices)
      await logistics.registerDevice(actor, {
        deviceId,
        name: "Source encrypted drive",
        assetTag: deviceId,
        capacityBytes: 1000,
      });
    const input = {
      shipmentId: crypto.randomUUID(),
      name: "Source daily batch",
      deviceIds: devices,
      packageIds: [first.packageId, second.packageId],
    };
    const registered = await logistics.registerShipment(actor, input);
    const transport = await logistics.transportPackages(actor);
    expect(transport.data.map((row) => row.packageId).sort()).toEqual(
      [...earlierPackages, ...input.packageIds].sort(),
    );
    expect(
      transport.data.every(
        (row) => row.senderSiteId === source.signing.siteId && row.subjectKind === "dataset",
      ),
    ).toBe(true);
    expect(JSON.stringify(transport)).not.toContain("identityEncrypted");

    expect(registered.senderSiteId).toBe(source.signing.siteId);
    expect(registered.recipientSiteId).toBe(target.signing.siteId);
    expect(registered.packages).toHaveLength(2);
    expect(
      await logistics.registerShipment(actor, {
        ...input,
        deviceIds: [...devices].reverse(),
        packageIds: [...input.packageIds].reverse(),
      }),
    ).toEqual(registered);
    const event = {
      eventId: crypto.randomUUID(),
      expectedVersion: 1,
      state: "received",
      occurredAt: now.toISOString(),
      note: "Source cannot skip dispatch",
      evidenceDigest: null,
    };
    await expect(logistics.recordHandoff(actor, input.shipmentId, event)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await logistics.recordHandoff(actor, input.shipmentId, { ...event, state: "dispatched" });
    await logistics.recordHandoff(actor, input.shipmentId, {
      ...event,
      eventId: crypto.randomUUID(),
      expectedVersion: 2,
      state: "received",
    });
    await logistics.recordHandoff(actor, input.shipmentId, {
      ...event,
      eventId: crypto.randomUUID(),
      expectedVersion: 3,
      state: "closed",
    });
    const details = await logistics.shipmentDetails(actor, input.shipmentId);
    expect(details.devices).toHaveLength(2);
    expect(details.devices.every((entry) => !entry.active)).toBe(true);
    expect(details.events).toHaveLength(3);
    expect(JSON.stringify(details)).not.toContain("identityEncrypted");
    expect(JSON.stringify(details)).not.toContain("manifestJws");
    expect((await service.details(actor, first.packageId)).revokedAt).toBeNull();
  });

  test("HTTP preparation signs actual immutable entries, keeps full provenance, and hides encrypted identities", async () => {
    const input = request();
    const response = await app().request("/api/federation/media/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain("identityEncrypted");
    expect(text).not.toContain("AGE-SECRET-KEY");
    const saved = await row(input.packageId);
    const verified = await verifyFederationMessage(
      FederationMediaManifestSchema,
      saved.manifestJws,
      { ...source.verification, allowedKinds: ["media-manifest"] },
      testNow,
    );
    expect(verified.digest).toBe(saved.manifestDigest);
    expect(verified.payload.files[0]?.provenance).toEqual(provenance);
    expect(verified.payload.files[0]?.license).toBe("CC-BY-4.0");
    expect(verified.payload.subject).toMatchObject({
      kind: "dataset",
      provenance,
      asset: { digest: `sha256:${"a".repeat(64)}` },
    });
    await new FederationMediaPackageService(db, target.signing.siteId, () => testNow).register(
      actor,
      { senderSiteId: source.signing.siteId, signedManifest: saved.manifestJws },
    );
    const disclosed = JSON.stringify([
      await service.details(actor, input.packageId),
      await service.list(actor),
      await db.select().from(auditLog).where(eq(auditLog.target, input.packageId)),
    ]);
    expect(disclosed).not.toContain(saved.identityEncrypted);
    expect(disclosed).not.toContain("AGE-SECRET-KEY");
  });

  test("vault encryption binds site, package and original manifest, and restores a real working age key", async () => {
    const prepared = await service.prepare(actor, request());
    const saved = await row(prepared.packageId);
    const identity = Buffer.from(
      await decryptSecret(saved.identityEncrypted, wrapping, mediaIdentityDomain(saved)),
    );
    const directory = await mkdtemp(join(tmpdir(), "media-export-vault-"));
    try {
      const signal = AbortSignal.timeout(5000),
        chunks: Uint8Array[] = [];
      for await (const chunk of age.encrypt(
        (async function* () {
          yield Buffer.from("data");
        })(),
        saved.recipient,
        signal,
      ))
        chunks.push(chunk);
      const file = join(directory, "payload.age");
      await writeFile(file, Buffer.concat(chunks));
      const plaintext: Uint8Array[] = [];
      for await (const chunk of age.decrypt(file, identity, signal)) plaintext.push(chunk);
      expect(Buffer.concat(plaintext).toString()).toBe("data");
      await expect(
        decryptSecret(
          saved.identityEncrypted,
          wrapping,
          mediaIdentityDomain({ ...saved, packageId: crypto.randomUUID() }),
        ),
      ).rejects.toThrow();
      await expect(
        decryptSecret(saved.identityEncrypted, "wrong".repeat(9), mediaIdentityDomain(saved)),
      ).rejects.toThrow();
    } finally {
      identity.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
    const second = await service.prepare(actor, request());
    expect(second.recipient).not.toBe(prepared.recipient);
  });

  test("ownership, public visibility and download capability cannot bypass disclosure restrictions", async () => {
    for (const patch of [
      { status: "disabled" },
      { capabilities: ["use"] },
      { downloadPolicy: "deny" },
      { redistributionPolicy: "deny" },
      { crossCenterReplicationPolicy: "deny" },
      { effect: "deny" },
      { expiresAt: testNow },
    ]) {
      await db
        .update(dataAccessPolicies)
        .set({
          status: "active",
          capabilities: ["download"],
          effect: "allow",
          downloadPolicy: "allow",
          redistributionPolicy: "allow",
          crossCenterReplicationPolicy: "allow",
          expiresAt: new Date(testNow.getTime() + 7200_000),
          ...patch,
        })
        .where(eq(dataAccessPolicies.id, policyId));
      await expect(service.prepare(actor, request())).rejects.toThrow("POLICY_DENIED");
    }
  });

  test("concurrent replay preserves the original ciphertext, signature and audit exactly once", async () => {
    const input = request();
    const attempts = await Promise.all(
      Array.from({ length: 3 }, () => service.prepare(actor, input)),
    );
    expect(new Set(attempts.map((item) => item.recipient)).size).toBe(1);
    expect(new Set(attempts.map((item) => item.signedManifest)).size).toBe(1);
    const before = await row(input.packageId);
    await service.prepare(actor, input);
    expect((await row(input.packageId)).identityEncrypted).toBe(before.identityEncrypted);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "federation.media.export_approve"),
            eq(auditLog.target, input.packageId),
          ),
        ),
    ).toHaveLength(1);
    await expect(
      service.prepare(actor, {
        ...input,
        expiresAt: new Date(testNow.getTime() + 1800_000).toISOString(),
      }),
    ).rejects.toThrow("OPERATION_CONFLICT");
  });

  test("current policy, operator, source ownership, frozen metadata and expiry are rechecked", async () => {
    const input = request();
    await service.prepare(actor, input);
    await authorize(input.packageId);
    await expect(service.details(other, input.packageId)).rejects.toThrow("POLICY_DENIED");
    await permissions.set({ ...actor, capability: "media.export", enabled: false }, actor.userId);
    await expect(authorize(input.packageId)).rejects.toThrow("POLICY_DENIED");
    await permissions.set({ ...actor, capability: "media.export", enabled: true }, actor.userId);
    await db
      .update(dataAccessPolicies)
      .set({ redistributionPolicy: "deny" })
      .where(eq(dataAccessPolicies.id, policyId));
    await expect(authorize(input.packageId)).rejects.toThrow("POLICY_DENIED");
    await db
      .update(dataAccessPolicies)
      .set({ redistributionPolicy: "allow" })
      .where(eq(dataAccessPolicies.id, policyId));
    await db
      .update(clusterFileRoots)
      .set({ providerOrgId: other.orgId })
      .where(eq(clusterFileRoots.id, rootId));
    await expect(authorize(input.packageId)).rejects.toThrow("POLICY_DENIED");
    await db
      .update(clusterFileRoots)
      .set({ providerOrgId: actor.orgId })
      .where(eq(clusterFileRoots.id, rootId));
    await db
      .update(dataAssetManifestEntries)
      .set({ metadata: { ...metadata, license: "CC0-1.0" } })
      .where(eq(dataAssetManifestEntries.id, entryId));
    await expect(authorize(input.packageId)).rejects.toThrow("OPERATION_CONFLICT");
    await db
      .update(dataAssetManifestEntries)
      .set({ metadata })
      .where(eq(dataAssetManifestEntries.id, entryId));
    now = new Date(input.expiresAt);
    await expect(authorize(input.packageId)).rejects.toThrow("POLICY_DENIED");
  });

  test("policy revocation during real key generation leaves no usable export or escrow row", async () => {
    let generated: Buffer | undefined;
    const raced = new FederationMediaExportService(
      db,
      source.signing,
      {
        generateIdentity: async (signal) => {
          const key = await age.generateIdentity(signal);
          generated = key.identity;
          await db
            .update(dataAccessPolicies)
            .set({ status: "disabled" })
            .where(eq(dataAccessPolicies.id, policyId));
          return key;
        },
      },
      wrapping,
      () => testNow,
    );
    const input = request();
    await expect(raced.prepare(actor, input)).rejects.toThrow("POLICY_DENIED");
    expect(
      await db
        .select()
        .from(federationMediaExports)
        .where(eq(federationMediaExports.packageId, input.packageId)),
    ).toHaveLength(0);
    expect(generated?.every((byte) => byte === 0)).toBe(true);
  });

  test("revocation remains durable after service reconstruction and replays cannot mint another key", async () => {
    const input = request();
    await service.prepare(actor, input);
    await service.revoke(actor, input.packageId, { reason: "Source authorization withdrawn" });
    const restarted = new FederationMediaExportService(
      db,
      source.signing,
      age,
      wrapping,
      () => testNow,
    );
    await expect(restarted.prepare(actor, input)).rejects.toThrow("OPERATION_CONFLICT");
    await expect(
      db.transaction((tx) => restarted.assertExportAuthorized(tx, actor.orgId, input.packageId)),
    ).rejects.toThrow("POLICY_DENIED");
    expect((await restarted.details(actor, input.packageId)).revocationReason).toBe(
      "Source authorization withdrawn",
    );
  });

  test("disclosure HTTP approval enables source preparation; revocation blocks current export and stale replay", async () => {
    await db
      .update(dataAssets)
      .set({ ownerKind: "provider", ownerUserId: null, providerOrgId: actor.orgId })
      .where(eq(dataAssets.id, assetId));
    await db
      .update(userOrgMemberships)
      .set({ role: "admin" })
      .where(eq(userOrgMemberships.userId, actor.userId));
    await db
      .update(dataAccessPolicies)
      .set({ status: "disabled" })
      .where(eq(dataAccessPolicies.id, policyId));
    const r = new Hono();
    r.onError(createErrorHandler(pino({ enabled: false })));
    r.use("*", async (c, next) => {
      if (c.req.header("x-test-automation")) c.set("automation" as never, {} as never);
      c.set(
        "principal" as never,
        {
          sub: actor.userId,
          ...manager,
          memberships: [{ orgId: actor.orgId, role: "admin" }],
        } as never,
      );
      await next();
    });
    r.route(
      "/api/cp",
      buildCpRouter({ consoleService: {} as CpConsoleService, dataPolicies: policies }),
    );
    const path = `/api/cp/data/versions/${versionId}/disclosure-policy`;
    const post = (body: unknown) =>
      r.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-kq-active-organization": actor.orgId },
        body: JSON.stringify(body),
      });
    const input = request();
    await expect(service.prepare(actor, input)).rejects.toThrow("POLICY_DENIED");
    expect((await post({ ...consent(), subjectId: other.orgId })).status).toBe(400);
    expect(
      (
        await r.request(path, {
          method: "POST",
          headers: { "content-type": "application/json", "x-kq-active-organization": other.orgId },
          body: JSON.stringify(consent()),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await r.request(path, {
          headers: { "x-kq-active-organization": actor.orgId, "x-test-automation": "true" },
        })
      ).status,
    ).toBe(403);
    expect((await post(consent())).status).toBe(200);
    const approved = (await policies.read(manager, versionId)).policy;
    expect(approved?.subjectId).toBe(actor.orgId);
    expect(approved?.dataAssetVersionId).toBe(versionId);
    expect(approved?.capabilities).toEqual(["export"]);
    expect(
      (
        await evaluateActiveDataAccess(db, {
          assetId,
          versionId,
          actorUserId: actor.userId,
          orgIds: [actor.orgId],
          capability: "use",
          now: testNow,
        })
      ).allowed,
    ).toBe(false);
    await service.prepare(actor, input);
    expect(
      (await r.request(path, { headers: { "x-kq-active-organization": actor.orgId } })).status,
    ).toBe(200);
    expect(
      (
        await post({
          ...consent(),
          expectedUpdatedAt: approved?.updatedAt.toISOString(),
          enabled: false,
          reason: "Data owner withdrew permission",
        })
      ).status,
    ).toBe(200);
    await expect(authorize(input.packageId)).rejects.toThrow("POLICY_DENIED");
    expect((await post(consent())).status).toBe(409);
    expect((await policies.read(manager, versionId)).policy?.status).toBe("revoked");
  });

  test("disclosure edits serialize, retain one audit per change and reject inherited restrictions bypass", async () => {
    await db
      .update(dataAccessPolicies)
      .set({ status: "disabled" })
      .where(eq(dataAccessPolicies.id, policyId));
    const created = await Promise.all([
      policies.write(manager, versionId, consent()),
      policies.write(manager, versionId, consent()),
    ]);
    expect(created[0]?.id).toBe(created[1]?.id);
    const first = created[0];
    if (!first) throw new Error("Missing policy");
    expect(await db.select().from(auditLog).where(eq(auditLog.target, first.id))).toHaveLength(1);
    const base = { ...consent(), expectedUpdatedAt: first.updatedAt.toISOString() };
    const edits = await Promise.allSettled([
      policies.write(manager, versionId, { ...base, reason: "first update" }),
      policies.write(manager, versionId, { ...base, reason: "second update" }),
    ]);
    expect(edits.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(edits.filter((r) => r.status === "rejected")).toHaveLength(1);
    await db
      .update(dataAccessPolicies)
      .set({ status: "active", redistributionPolicy: "deny" })
      .where(eq(dataAccessPolicies.id, policyId));
    expect((await policies.read(manager, versionId)).otherPolicies).toHaveLength(1);
    await expect(service.prepare(actor, request())).rejects.toThrow("POLICY_DENIED");
  });

  test("disclosure management rechecks ownership, organization membership and external authorization", async () => {
    await expect(
      policies.read(
        { ...manager, userId: other.userId, orgId: other.orgId, orgIds: [other.orgId] },
        versionId,
      ),
    ).rejects.toThrow();
    const guarded = new DataDisclosurePolicyService(
      db,
      async (a, id) => {
        await market.requireManage(a, id);
        await db
          .update(dataAssets)
          .set({ ownerKind: "provider", ownerUserId: null, providerOrgId: other.orgId })
          .where(eq(dataAssets.id, assetId));
      },
      () => now,
    );
    await expect(guarded.write(manager, versionId, consent())).rejects.toThrow(
      "management authority",
    );
    await db
      .update(dataAssets)
      .set({ ownerKind: "provider", providerOrgId: actor.orgId })
      .where(eq(dataAssets.id, assetId));
    await expect(policies.write(manager, versionId, consent())).rejects.toThrow(
      "management authority",
    );
    const enforcedMarket = new DataMarketService({
      repository: new PgDataMarketRepository(db),
      uploadPort,
      authz: { check: async () => false },
    });
    const denied = new DataDisclosurePolicyService(db, (a, id) =>
      enforcedMarket.requireManage(a, id),
    );
    await expect(denied.write(manager, versionId, consent())).rejects.toThrow("Not authorized");
  });

  test("disclosure does not overwrite mixed policies and revocation remains possible for withdrawn versions", async () => {
    const created = await onlyOrgConsent();
    await db
      .update(dataAccessPolicies)
      .set({ capabilities: ["download", "manage"] })
      .where(eq(dataAccessPolicies.id, created.id));
    expect((await policies.read(manager, versionId)).editable).toBe(false);
    await expect(
      policies.write(manager, versionId, {
        ...consent(),
        expectedUpdatedAt: created.updatedAt.toISOString(),
        enabled: false,
      }),
    ).rejects.toThrow("DATA_POLICY_SCOPE_CONFLICT");
    await db
      .update(dataAccessPolicies)
      .set({ capabilities: ["export"] })
      .where(eq(dataAccessPolicies.id, created.id));
    await db.update(dataAssets).set({ lifecycle: "revoked" }).where(eq(dataAssets.id, assetId));
    const revoked = await policies.write(manager, versionId, {
      ...consent(),
      expectedUpdatedAt: created.updatedAt.toISOString(),
      enabled: false,
    });
    expect(revoked.status).toBe("revoked");
    await expect(
      policies.write(manager, versionId, {
        ...consent(),
        expectedUpdatedAt: revoked.updatedAt.toISOString(),
      }),
    ).rejects.toThrow("DATA_VERSION_NOT_READY");
  });

  test("disclosure audit failure rolls back consent and cannot leave a usable export grant", async () => {
    await db
      .update(dataAccessPolicies)
      .set({ status: "disabled" })
      .where(eq(dataAccessPolicies.id, policyId));
    await db.execute(
      sql`CREATE FUNCTION disclosure_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'data.disclosure_policy.update' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER disclosure_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION disclosure_reject_audit()`,
    );
    try {
      await expect(policies.write(manager, versionId, consent())).rejects.toThrow();
      expect((await policies.read(manager, versionId)).policy).toBeNull();
      await expect(service.prepare(actor, request())).rejects.toThrow("POLICY_DENIED");
    } finally {
      await db.execute(sql`DROP TRIGGER disclosure_reject_audit ON audit_log`);
      await db.execute(sql`DROP FUNCTION disclosure_reject_audit()`);
    }
  });
  async function keyFixture() {
    await permissions.set({ ...actor, capability: "media.import", enabled: true }, actor.userId);
    const prepared = await service.prepare(actor, request());
    const receiver = new FederationMediaPackageService(db, target.signing.siteId, () => now);
    await receiver.register(actor, {
      senderSiteId: source.signing.siteId,
      signedManifest: prepared.signedManifest,
    });
    const authorizationId = crypto.randomUUID();
    await receiver.approveImport(actor, prepared.packageId, {
      authorizationId,
      agentId,
      managedRootId: rootId,
      maxBytes: 4,
      expiresAt: new Date(testNow.getTime() + 3600_000).toISOString(),
    });
    const agentKeys = await generateKeyPair("RSA-OAEP-256", { modulusLength: 2048 });
    const recipientKey = FederationMediaRecipientKeySchema.parse(
      await exportJWK(agentKeys.publicKey),
    );
    const responder = new FederationMediaKeyResponder(db, source.signing, service, () => now);
    const ingress = createFederationIngress(
      db,
      source.signing,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      responder,
    );
    const call = async (jws: string, fingerprint = "d".repeat(64)) =>
      ingress.request("/federation/v1/media-keys", {
        method: "POST",
        headers: { "content-type": "application/jose", "x-kq-federation-cert": fingerprint },
        body: jws,
      });
    const input = {
      orgId: actor.orgId,
      packageId: prepared.packageId,
      authorizationId,
      authenticatedAgentId: agentId,
      recipientKey,
    };
    let queryJws = "";
    const requester = (after?: (response: string) => Promise<string>) =>
      new FederationMediaKeyRequester(
        db,
        target.signing,
        receiver,
        async (_endpoint, jws, path) => {
          expect(path).toBe("/federation/v1/media-keys");
          queryJws = jws;
          const response = await call(jws);
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          const body = await response.text();
          return after ? after(body) : body;
        },
        () => now,
      );
    return { input, agentKeys, responder, receiver, call, requester, query: () => queryJws };
  }

  test("media key exchange verifies both approvals and returns only Agent-encrypted identity", async () => {
    const f = await keyFixture();
    const result = await f.requester().request(f.input);
    const identity = await decryptFederationMediaIdentity(
      result.grant.encryptedIdentity,
      f.agentKeys.privateKey,
      result.queryDigest,
    );
    try {
      const original = await row(f.input.packageId);
      expect(new TextDecoder().decode(identity)).toBe(
        await decryptSecret(original.identityEncrypted, wrapping, mediaIdentityDomain(original)),
      );
      const stored = JSON.stringify([
        await db.select().from(federationMediaKeyGrants),
        await db.select().from(auditLog),
      ]);
      expect(stored).not.toContain(new TextDecoder().decode(identity));
      expect(result.signedGrant).not.toContain("AGE-SECRET-KEY");
      expect((await f.call(f.query(), "forged")).status).toBe(401);
    } finally {
      identity.fill(0);
    }
  });

  test("media key retries preserve the first response, reject query rekeying, and recheck source revocation", async () => {
    const f = await keyFixture();
    const result = await f.requester().request(f.input);
    const replays = await Promise.all([
      f.responder.respond(f.query(), "d".repeat(64)),
      f.responder.respond(f.query(), "d".repeat(64)),
    ]);
    expect(replays).toEqual([result.signedGrant, result.signedGrant]);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.target, result.query.queryId),
            eq(auditLog.action, "federation.media.key_issue"),
          ),
        ),
    ).toHaveLength(1);
    const otherKeys = await generateKeyPair("RSA-OAEP-256", { modulusLength: 2048 });
    const changed = await signFederationMessage(
      FederationMediaKeyQuerySchema,
      {
        ...result.query,
        recipientKey: FederationMediaRecipientKeySchema.parse(await exportJWK(otherKeys.publicKey)),
      },
      target.signing,
    );
    await expect(f.responder.respond(changed, "d".repeat(64))).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await service.revoke(actor, f.input.packageId, { reason: "Source withdraws key disclosure" });
    await expect(f.responder.respond(f.query(), "d".repeat(64))).rejects.toThrow("POLICY_DENIED");
  });

  test("media key exchange refuses wrong Agent and receiver revocation while the response is in flight", async () => {
    const f = await keyFixture();
    await expect(
      f.requester().request({ ...f.input, authenticatedAgentId: "another-agent" }),
    ).rejects.toThrow("POLICY_DENIED");
    expect(f.query()).toBe("");
    await expect(
      f
        .requester(async (response) => {
          await f.receiver.revoke(
            actor,
            f.input.packageId,
            { reason: "Receiving operator withdraws import consent" },
            f.input.authorizationId,
          );
          return response;
        })
        .request(f.input),
    ).rejects.toThrow("POLICY_DENIED");
  });

  test("media key exchange rejects signed but substituted response scope and delayed replies", async () => {
    const f = await keyFixture();
    await expect(
      f
        .requester(async (response) => {
          const verified = await verifyFederationMessage(
            FederationMediaKeyGrantSchema,
            response,
            { ...source.verification, allowedKinds: ["media-key-grant"] },
            now,
          );
          return signFederationMessage(
            FederationMediaKeyGrantSchema,
            { ...verified.payload, managedRootId: crypto.randomUUID() },
            source.signing,
          );
        })
        .request(f.input),
    ).rejects.toThrow("INVALID_MESSAGE");
    await expect(
      f
        .requester(async (response) => {
          now = new Date(testNow.getTime() + 60_001);
          return response;
        })
        .request(f.input),
    ).rejects.toThrow("AUTHORIZATION_EXPIRED");
    await expect(f.responder.respond(f.query(), "d".repeat(64))).rejects.toThrow(
      "AUTHORIZATION_EXPIRED",
    );
  });

  test("media key issuance rolls back on audit failure without persisting a usable response", async () => {
    const f = await keyFixture();
    await db.execute(
      sql`CREATE FUNCTION media_key_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.media.key_issue' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER media_key_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION media_key_reject_audit()`,
    );
    try {
      const requester = new FederationMediaKeyRequester(
        db,
        target.signing,
        f.receiver,
        async (_endpoint, jws) => f.responder.respond(jws, "d".repeat(64)),
        () => now,
      );
      await expect(requester.request(f.input)).rejects.toThrow();
      expect(
        await db
          .select()
          .from(federationMediaKeyGrants)
          .where(eq(federationMediaKeyGrants.packageId, f.input.packageId)),
      ).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER media_key_reject_audit ON audit_log`);
      await db.execute(sql`DROP FUNCTION media_key_reject_audit()`);
    }
  });

  test("media key purposes are required independently and rechecked after transport and on replay", async () => {
    const f = await keyFixture();
    const kinds = ["agreement", "media-manifest", "media-key-query", "media-key-grant"] as const;
    const setKinds = (siteId: string, omitted?: (typeof kinds)[number]) =>
      db
        .update(federationSigningKeys)
        .set({ allowedKinds: kinds.filter((kind) => kind !== omitted) })
        .where(eq(federationSigningKeys.siteId, siteId));
    try {
      await setKinds(target.signing.siteId, "media-key-query");
      await expect(f.requester().request(f.input)).rejects.toThrow("UNTRUSTED_IDENTITY");
      expect(f.query()).toBe("");
      await setKinds(target.signing.siteId);
      await f.requester().request(f.input);
      await setKinds(source.signing.siteId, "media-key-grant");
      await expect(f.responder.respond(f.query(), "d".repeat(64))).rejects.toThrow(
        "UNTRUSTED_IDENTITY",
      );
      await setKinds(source.signing.siteId);
      await expect(
        f
          .requester(async (response) => {
            await setKinds(target.signing.siteId, "media-key-query");
            return response;
          })
          .request(f.input),
      ).rejects.toThrow("UNTRUSTED_IDENTITY");
    } finally {
      await setKinds(source.signing.siteId);
      await setKinds(target.signing.siteId);
    }
  });
  test("media import operation receives a real encrypted package before separate publication and local approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kq-media-receive-"));
    let client: FederationMediaImportClient | undefined,
      sourceClient: FederationMediaExportClient | undefined;
    setSystemTime(testNow);
    try {
      const f = await keyFixture();
      const sourceOperations = new FederationMediaExportOperations(
        db,
        source.signing.siteId,
        service,
        () => now,
      );
      await sourceOperations.start(actor, f.input.packageId);
      await mkdir(join(directory, "source", "v1"), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "source", "v1", "input.dat"), "data");
      const sourceRoots = new AgentDataRoots({
        datasetRoot: join(directory, "source"),
        jobWorkRoot: join(directory, "source-jobs"),
        managedRoots: { [rootId]: "." },
      });
      await sourceRoots.initialize();
      const sourceDispatcher = new AgentDispatcher();
      const sourceTransport = new FederationMediaExportTransport(
        sourceOperations,
        sourceDispatcher,
      );
      const exported = Promise.withResolvers<void>();
      sourceClient = new FederationMediaExportClient(
        {
          agentId,
          roots: sourceRoots,
          mediaDirectory: join(directory, "source-media"),
          ageDirectory: binary ?? "",
        },
        (request) => {
          void sourceTransport
            .grant(agentId, request)
            .then((reply) => sourceClient?.receive(reply), exported.reject);
          return true;
        },
        (report) => {
          void sourceTransport.report(agentId, report).then(exported.resolve, exported.reject);
        },
      );
      sourceDispatcher.register(agentId, {
        federationMediaExportV1: true,
        verifiedCertFingerprint: "isolated-source-channel",
        push: (message) => {
          if (message.payload.case === "federationMediaExport")
            sourceClient?.start(message.payload.value);
        },
        close: () => {},
      });
      await sourceTransport.tick();
      await exported.promise;
      const mediaDirectory = join(directory, "receiver-media");
      const inbox = join(mediaDirectory, "inbox", f.input.packageId);
      await mkdir(inbox, { recursive: true, mode: 0o700 });
      await copyFile(
        join(directory, "source-media", "outbox", f.input.packageId, "bundle.age"),
        join(inbox, "bundle.age"),
      );
      const data = join(directory, "receiver-data");
      await mkdir(data, { mode: 0o700 });
      const roots = new AgentDataRoots({
        datasetRoot: data,
        jobWorkRoot: join(directory, "receiver-jobs"),
        managedRoots: { [rootId]: "." },
      });
      await roots.initialize();
      const operations = new FederationMediaImportOperations(
        db,
        target.signing.siteId,
        f.receiver,
        f.requester(),
        () => now,
      );
      const r = new Hono();
      r.onError(createErrorHandler(pino({ enabled: false })));
      r.use("*", async (c, next) => {
        c.set("principal" as never, actor as never);
        await next();
      });
      r.route("/api", createFederationMediaRoutes(f.receiver, undefined, undefined, operations));
      const path = `/api/federation/media/packages/${f.input.packageId}/import-authorizations/${f.input.authorizationId}`;
      expect((await r.request(`${path}/run`, { method: "POST" })).status).toBe(202);
      const [first, same] = await Promise.all([
        operations.start(actor, f.input.packageId, f.input.authorizationId),
        operations.start(actor, f.input.packageId, f.input.authorizationId),
      ]);
      expect(first.generation).toBe(same.generation);
      const before = await db.select().from(dataLocations);
      const dispatcher = new AgentDispatcher(),
        finished = Promise.withResolvers<void>();
      const transport = new FederationMediaImportTransport(operations, dispatcher);
      client = new FederationMediaImportClient(
        { agentId, roots, mediaDirectory, ageDirectory: binary ?? "" },
        (request) => {
          void transport.grant(agentId, request).then(
            (reply) => client?.receive(reply),
            (error) => {
              finished.reject(error);
              client?.receive(
                create(FederationMediaImportGrantResponseSchema, { requestId: request.requestId }),
              );
            },
          );
          return true;
        },
        (report) => {
          void transport.report(agentId, report).then(finished.resolve, finished.reject);
        },
      );
      dispatcher.register(agentId, {
        federationMediaImportV1: true,
        verifiedCertFingerprint: "isolated-receiver-channel",
        push: (message) => {
          if (message.payload.case === "federationMediaImport")
            client?.start(message.payload.value);
        },
        close: () => {},
      });
      await transport.tick();
      await finished.promise;
      await permissions.set({ ...actor, capability: "asset.read", enabled: true }, actor.userId);
      const response = await r.request(`${path}/operation`);
      expect(response.status).toBe(200);
      const { data: status } = z
        .object({ data: z.record(z.string(), z.unknown()) })
        .parse(await response.json());
      expect(status.state).toBe("verified");
      expect(status.verifiedBytes).toBe(4);
      expect(status.latestGrant).toBeUndefined();
      expect(JSON.stringify(status)).not.toContain("encryptedIdentity");
      expect(
        await readFile(
          join(data, ".federation-media", f.input.packageId, "files", "input.dat"),
          "utf8",
        ),
      ).toBe("data");
      expect(await db.select().from(dataLocations)).toEqual(before);
      expect(
        (await operations.start(actor, f.input.packageId, f.input.authorizationId)).generation,
      ).toBe(first.generation);
      const published = await publicationFixture(f);
      const imported = await published.publish();
      expect((await published.authority(imported)).allowed).toBe(true);
      expect((await published.access(imported)).allowed).toBe(false);
      const localRequest = await market.requestAccess(
        manager,
        imported.assetId,
        "Local research",
        crypto.randomUUID(),
      );
      await market.reviewProviderAccessRequest(manager, localRequest.id, { decision: "approve" });
      expect((await published.access(imported)).allowed).toBe(true);
      expect(
        (await db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, imported.assetId)))
          .length,
      ).toBeGreaterThan(0);
      await expect(
        market.requestAccess(
          { ...manager, ...other, orgIds: [other.orgId] },
          imported.assetId,
          "Outside recipient",
          crypto.randomUUID(),
        ),
      ).rejects.toThrow("receiving organization");
      const [version] = await db
        .select()
        .from(dataAssetVersions)
        .where(eq(dataAssetVersions.id, imported.versionId));
      expect(version?.provenance).toEqual(provenance);
      expect(version?.manifest.license).toBe("CC-BY-4.0");
      const receipts = await receiptFixture(f);
      await new FederationMediaImportTransport(
        operations,
        new AgentDispatcher(),
        receipts.sender(),
      ).tickReceipts();
      expect((await receipts.status()).state).toBe("recorded");
      expect((await receipts.receiver.list(actor, f.input.packageId))[0]?.receipt.state).toBe(
        "verified-private",
      );
    } finally {
      await client?.disconnect();
      await sourceClient?.disconnect();
      setSystemTime();
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);

  test("media import operation fences retries, wrong Agents, expired grants and revoked approvals", async () => {
    const f = await keyFixture();
    const operations = new FederationMediaImportOperations(
      db,
      target.signing.siteId,
      f.receiver,
      f.requester(),
      () => now,
    );
    const first = await operations.start(actor, f.input.packageId, f.input.authorizationId);
    const task = (await operations.task(agentId, f.input.authorizationId)).task;
    const binding = {
      generation: first.generation,
      packageId: f.input.packageId,
      authorizationId: f.input.authorizationId,
      manifestDigest: task.manifestDigest,
    };
    await expect(
      operations.grant("wrong-agent", { ...binding, recipientKey: f.input.recipientKey }),
    ).rejects.toThrow();
    await expect(
      operations.report(agentId, {
        ...binding,
        state: "verified",
        queryDigest: task.manifestDigest,
        sizeBytes: 4,
      }),
    ).rejects.toThrow();
    const grant = await operations.grant(agentId, {
      ...binding,
      recipientKey: f.input.recipientKey,
    });
    const success = { ...binding, state: "verified", queryDigest: grant.queryDigest, sizeBytes: 4 };
    await expect(operations.report(agentId, { ...success, sizeBytes: 5 })).rejects.toThrow();
    now = new Date(Date.parse(grant.expiresAt) + 1);
    await expect(operations.report(agentId, success)).rejects.toThrow();
    await operations.report(agentId, { ...binding, state: "failed" });
    const retry = await operations.start(actor, f.input.packageId, f.input.authorizationId);
    expect(retry.generation).not.toBe(first.generation);
    await expect(
      operations.grant(agentId, { ...binding, recipientKey: f.input.recipientKey }),
    ).rejects.toThrow();
    await expect(operations.report(agentId, success)).rejects.toThrow();
    await f.receiver.revoke(
      actor,
      f.input.packageId,
      { reason: "Approval withdrawn" },
      f.input.authorizationId,
    );
    await expect(operations.task(agentId, f.input.authorizationId)).rejects.toThrow();
  });

  test("dataset private verification cannot obtain task upload authority", async () => {
    const f = await keyFixture();
    const operations = new FederationMediaImportOperations(
      db,
      target.signing.siteId,
      f.receiver,
      f.requester(),
      () => now,
    );
    const started = await operations.start(actor, f.input.packageId, f.input.authorizationId);
    const task = (await operations.task(agentId, f.input.authorizationId)).task;
    const binding = {
      generation: started.generation,
      authorizationId: f.input.authorizationId,
      packageId: f.input.packageId,
      manifestDigest: task.manifestDigest,
    };
    const grant = await operations.grant(agentId, {
      ...binding,
      recipientKey: f.input.recipientKey,
    });
    await operations.report(agentId, {
      ...binding,
      state: "verified",
      queryDigest: grant.queryDigest,
      sizeBytes: 4,
    });
    await expect(operations.uploadTask(agentId, f.input.authorizationId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await expect(
      operations.grant(agentId, {
        ...binding,
        recipientKey: f.input.recipientKey,
        purpose: "task-upload",
      }),
    ).rejects.toThrow("OPERATION_CONFLICT");
  });

  test("media import rejects revoked in-flight key approval and rolls back failed audit", async () => {
    const f = await keyFixture();
    const operations = new FederationMediaImportOperations(
      db,
      target.signing.siteId,
      f.receiver,
      f.requester(),
      () => now,
    );
    await permissions.set({ ...actor, capability: "asset.read", enabled: true }, actor.userId);
    await db.execute(
      sql`CREATE FUNCTION media_import_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.media.import_start' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER media_import_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION media_import_reject_audit()`,
    );
    try {
      await expect(
        operations.start(actor, f.input.packageId, f.input.authorizationId),
      ).rejects.toThrow();
      expect(await operations.status(actor, f.input.packageId, f.input.authorizationId)).toBeNull();
    } finally {
      await db.execute(sql`DROP TRIGGER media_import_reject_audit ON audit_log`);
      await db.execute(sql`DROP FUNCTION media_import_reject_audit()`);
    }
    const attempt = await operations.start(actor, f.input.packageId, f.input.authorizationId);
    const task = (await operations.task(agentId, f.input.authorizationId)).task;
    const inflight = new FederationMediaImportOperations(
      db,
      target.signing.siteId,
      f.receiver,
      f.requester(async (response) => {
        await f.receiver.revoke(
          actor,
          f.input.packageId,
          { reason: "Withdrawn during key exchange" },
          f.input.authorizationId,
        );
        return response;
      }),
      () => now,
    );
    await expect(
      inflight.grant(agentId, {
        generation: attempt.generation,
        packageId: f.input.packageId,
        authorizationId: f.input.authorizationId,
        manifestDigest: task.manifestDigest,
        recipientKey: f.input.recipientKey,
      }),
    ).rejects.toThrow();
    expect(
      (await operations.status(actor, f.input.packageId, f.input.authorizationId))?.state,
    ).toBe("queued");
  });

  test("media key grant lifetime cannot exceed its source signing key", async () => {
    const f = await keyFixture();
    const expiresAt = new Date(now.getTime() + 3_000);
    try {
      await db
        .update(federationSigningKeys)
        .set({ validUntil: expiresAt })
        .where(
          and(
            eq(federationSigningKeys.siteId, source.signing.siteId),
            eq(federationSigningKeys.keyId, source.signing.keyId),
          ),
        );
      expect((await f.requester().request(f.input)).grant.expiresAt).toBe(expiresAt.toISOString());
    } finally {
      await db
        .update(federationSigningKeys)
        .set({ validUntil: source.verification.validUntil })
        .where(
          and(
            eq(federationSigningKeys.siteId, source.signing.siteId),
            eq(federationSigningKeys.keyId, source.signing.keyId),
          ),
        );
    }
  });

  async function publicationFixture(existing?: Awaited<ReturnType<typeof keyFixture>>) {
    const media = existing ?? (await keyFixture());
    const use = await useFixture();
    const makeClient = (after?: () => Promise<void>) =>
      new FederationDatasetUseClient(
        db,
        target.signing,
        async (_endpoint, jws, path) => {
          expect(path).toBe("/federation/v1/dataset-use");
          const response = await use.call(jws);
          if (response.status !== 200) throw new Error(`Source denied: ${response.status}`);
          const body = await response.text();
          await after?.();
          return body;
        },
        () => now,
      );
    const makeService = (after?: () => Promise<void>) =>
      new FederationDatasetPublicationService(
        db,
        target.signing.siteId,
        media.receiver,
        makeClient(after),
        () => now,
      );
    const publication = makeService();
    const input = {
      replicaId: crypto.randomUUID(),
      authorizationId: media.input.authorizationId,
      sourcePolicyId: use.input.policyId,
      name: "Partner observations",
    };
    if (!existing) {
      const operations = new FederationMediaImportOperations(
        db,
        target.signing.siteId,
        media.receiver,
        media.requester(),
        () => now,
      );
      const op = await operations.start(actor, media.input.packageId, media.input.authorizationId);
      const { task } = await operations.task(agentId, media.input.authorizationId);
      const binding = {
        generation: op.generation,
        authorizationId: media.input.authorizationId,
        packageId: media.input.packageId,
        manifestDigest: task.manifestDigest,
      };
      const grant = await operations.grant(agentId, {
        ...binding,
        recipientKey: media.input.recipientKey,
      });
      // Other tests above exercise real Agent decrypt; this fixture exercises the Server report boundary.
      await operations.report(agentId, {
        ...binding,
        state: "verified",
        sizeBytes: 4,
        queryDigest: grant.queryDigest,
      });
    }
    const authority = async (r: { assetId: string; versionId: string; locationId: string }) => {
      const a = await datasetSourceAuthority(db, r, now);
      if (!a) throw new Error("Missing structural origin");
      return a;
    };
    const access = (r: { assetId: string; versionId: string }) =>
      evaluateActiveDataAccess(db, {
        ...r,
        actorUserId: actor.userId,
        orgIds: [actor.orgId],
        capability: "use",
        now,
      });
    const allowLocal = async (r: { assetId: string; versionId: string }) => {
      await db.insert(dataGrants).values({
        dataAssetId: r.assetId,
        dataAssetVersionId: r.versionId,
        subjectKind: "org",
        subjectId: actor.orgId,
        capabilities: ["use"],
        grantedBy: actor.userId,
        startsAt: now,
      });
    };
    return {
      media,
      use,
      input,
      publication,
      makeService,
      authority,
      access,
      allowLocal,
      publish: () => publication.publish(actor, media.input.packageId, input),
    };
  }

  test("dataset publication reuses signed versions and requires both source and explicit local use", async () => {
    const f = await publicationFixture();
    const [first, repeated] = await Promise.all([f.publish(), f.publish()]);
    expect(repeated).toEqual(first);
    expect((await f.authority(first)).allowed).toBe(true);
    expect((await f.access(first)).allowed).toBe(false);
    const repo = new PgDataPrerequisiteRepository(db, { now: () => now });
    const accessInput = { ...first, actorUserId: actor.userId, orgId: actor.orgId };
    expect(await repo.verifyAccess(accessInput)).toBe(false);
    const candidate = {
      assetId: first.assetId,
      versionId: first.versionId,
      kind: "scientific-dataset",
      accessMode: "open",
      visibility: "public",
      lifecycle: "published",
      ownerUserId: actor.userId,
      ownerOrgId: actor.orgId,
      providerOrgId: actor.orgId,
    };
    const batch = () =>
      repo.verifyAccessBatch({
        actorUserId: actor.userId,
        orgId: actor.orgId,
        candidates: [candidate],
      });
    expect((await batch()).size).toBe(0);
    await f.allowLocal(first);
    expect((await batch()).has(first.versionId)).toBe(true);
    expect(await repo.verifyAccess(accessInput)).toBe(true);
    expect((await repo.listLocations(first.versionId)).map((r) => r.locationId)).toEqual([
      first.locationId,
    ]);
    expect((await repo.listAvailableVersionIds([first.versionId])).has(first.versionId)).toBe(true);
    await expect(
      f.publication.publish(actor, f.media.input.packageId, { ...f.input, name: "Changed intent" }),
    ).rejects.toThrow("OPERATION_CONFLICT");
    const second = await publicationFixture();
    const copy = await second.publish();
    expect(copy.assetId).toBe(first.assetId);
    expect(copy.versionId).toBe(first.versionId);
    expect(copy.locationId).not.toBe(first.locationId);
    const [entry] = await db
      .select()
      .from(dataAssetManifestEntries)
      .where(eq(dataAssetManifestEntries.dataAssetVersionId, first.versionId));
    expect(entry?.metadata).toEqual(metadata);
    await db
      .update(dataAssets)
      .set({ metadata: {}, accessMode: "open", visibility: "public" })
      .where(eq(dataAssets.id, first.assetId));
    now = new Date(now.getTime() + 60_001);
    expect((await f.access(first)).allowed).toBe(false);
    expect(await repo.verifyAccess(accessInput)).toBe(false);
    expect((await batch()).size).toBe(0);
    expect(await repo.listLocations(first.versionId)).toEqual([]);
    expect((await repo.listAvailableVersionIds([first.versionId])).size).toBe(0);
  });

  test("dataset publication rejects third-party scope and audit failure atomically", async () => {
    const f = await publicationFixture();
    await expect(f.publication.publish(other, f.media.input.packageId, f.input)).rejects.toThrow(
      "POLICY_DENIED",
    );
    await db.execute(
      sql`CREATE FUNCTION publication_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.dataset.publish' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER publication_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION publication_reject_audit()`,
    );
    try {
      await expect(f.publish()).rejects.toThrow();
      expect(await db.select().from(federationDatasetAssets)).toHaveLength(0);
      expect(await db.select().from(federationDatasetReplicas)).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER publication_reject_audit ON audit_log`);
      await db.execute(sql`DROP FUNCTION publication_reject_audit()`);
    }
  });

  test("dataset publication rejects approval revoked during source authorization", async () => {
    const f = await publicationFixture();
    const delayed = f.makeService(() =>
      f.media.receiver.revoke(
        actor,
        f.media.input.packageId,
        { reason: "Withdrawn during publication" },
        f.input.authorizationId,
      ),
    );
    await expect(delayed.publish(actor, f.media.input.packageId, f.input)).rejects.toThrow(
      "POLICY_DENIED",
    );
    expect(await db.select().from(federationDatasetReplicas)).toHaveLength(0);
  });

  test("dataset renewal cannot revive revoked replicas or extend an unavailable source", async () => {
    const f = await publicationFixture();
    const r = await f.publish();
    await f.allowLocal(r);
    now = new Date(now.getTime() + 21_000);
    expect(await f.publication.renewNext()).toBe(true);
    expect((await f.access(r)).expiresAtUnixMs).toBe(now.getTime() + 60_000);
    now = new Date(now.getTime() + 21_000);
    const late = f.makeService(() =>
      f.publication.revoke(actor, r.replicaId, { reason: "Stopped locally" }),
    );
    expect(await late.renewNext()).toBe(true);
    expect((await f.authority(r)).allowed).toBe(false);
    const [stored] = await db
      .select()
      .from(federationDatasetReplicas)
      .where(eq(federationDatasetReplicas.replicaId, r.replicaId));
    expect(stored?.lease).toBeNull();
    await expect(f.publish()).rejects.toThrow("OPERATION_CONFLICT");
  });

  test("dataset authority bounds use after source revocation and checks local storage every time", async () => {
    const f = await publicationFixture();
    const r = await f.publish();
    await f.allowLocal(r);
    await db
      .update(clusterFileRoots)
      .set({ enabled: false })
      .where(eq(clusterFileRoots.id, rootId));
    expect((await f.access(r)).allowed).toBe(false);
    await db.update(clusterFileRoots).set({ enabled: true }).where(eq(clusterFileRoots.id, rootId));
    now = new Date(now.getTime() + 1_000);
    await db
      .update(federationMediaImportAuthorizations)
      .set({ expiresAt: new Date(now.getTime() - 1) })
      .where(eq(federationMediaImportAuthorizations.authorizationId, f.input.authorizationId));
    expect((await f.access(r)).allowed).toBe(true);
    await f.use.policyService.revoke(actor, f.use.input.policyId, { reason: "Source withdrawn" });
    now = new Date(now.getTime() + 21_000);
    await f.publication.renewNext();
    now = new Date(testNow.getTime() + 60_001);
    expect((await f.access(r)).allowed).toBe(false);
  });

  test.each([
    "revoked-replica",
    "expired",
    "moved-root",
    "other-agent",
    "changed-path",
  ] as const)("running media Sandbox input checks its actual replica: %s", async (change) => {
    const f = await publicationFixture();
    const r = await f.publish();
    await f.allowLocal(r);
    const otherCopy =
      change === "revoked-replica" ? await (await publicationFixture()).publish() : undefined;
    const id = crypto.randomUUID();
    await db.insert(jobs).values({
      id,
      name: "Media runtime authorization",
      command: "true",
      cpus: 1,
      memoryMb: 16,
      submittedBy: actor.userId,
      orgId: actor.orgId,
      agentId,
      status: "queued",
      dispatchEpoch: 1,
    });
    const [binding] = await db
      .insert(jobDataBindings)
      .values({
        jobId: id,
        inputDescriptor: "dataset",
        source: "data-market",
        assetId: r.assetId,
        versionId: r.versionId,
        manifestDigest: f.use.approval.asset.digest,
        assetKind: "scientific-dataset",
        allowedLocationIds: [r.locationId, ...(otherCopy ? [otherCopy.locationId] : [])],
        selectedEntries: ["input.dat"],
        stagePath: "inputs/dataset",
        sensitivity: "restricted",
        egressPolicy: "deny",
      })
      .returning();
    if (!binding) throw new Error("Missing binding");
    const relativePath = `.federation-media/${f.media.input.packageId}/files`;
    const dispatch = create(DispatchJobSchema, {
      jobId: id,
      dispatchEpoch: 1n,
      federationExecution: true,
      restrictedNoEgress: true,
      sandboxExecution: {
        networkDisabled: true,
        artifactMounts: [
          {
            descriptor: "dataset",
            mode: SandboxMountMode.READ_ONLY,
            ioType: SandboxIoType.FILE_BATCH,
            relativePath: "inputs/dataset",
            containerPath: "/kq/inputs/dataset",
            batchEntries: [
              {
                relativePath: "input.dat",
                sha256: createHash("sha256").update("data").digest("hex"),
                sizeBytes: 4n,
              },
            ],
          },
        ],
      },
      inputStaging: [
        {
          fileMetadataId: `data-delivery-${binding.id}-0`,
          stagePath: "inputs/dataset/input.dat",
          deliveryLeaseId: crypto.randomUUID(),
          deliveryLeaseExpiresAtUnixMs: 1n,
          localDataSource: {
            locationId: r.locationId,
            managedRootId: rootId,
            relativePath: `${relativePath}/input.dat`,
          },
        },
      ],
    });
    try {
      setSystemTime(now);
      const envelope = create(ServerMessageSchema, {
        payload: { case: "dispatchJob", value: dispatch },
      });
      const prepared = await new FederationDataDispatch(db).prepare(agentId, envelope);
      await db.transaction(prepared.authorize);
      if (prepared.message.payload.case !== "dispatchJob")
        throw new Error("Missing prepared dispatch");
      expect(prepared.message.payload.value.inputStaging[0]?.localDataSource).toEqual(
        dispatch.inputStaging[0]?.localDataSource,
      );
      await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, id));
      expect(await db.transaction((tx) => assertRunningDataBindings(tx, dispatch))).toBe(
        now.getTime() + 60_000,
      );
      if (change === "revoked-replica") {
        await f.publication.revoke(actor, r.replicaId, { reason: "Stop this replica only" });
        const available = await datasetSourceAuthority(
          db,
          { assetId: r.assetId, versionId: r.versionId },
          now,
        );
        expect(available?.allowed).toBe(true);
        if (!otherCopy) throw new Error("Missing other replica");
        expect(available?.locationIds).toEqual([otherCopy.locationId]);
      }
      if (change === "expired") {
        now = new Date(now.getTime() + 60_001);
        setSystemTime(now);
      }
      if (change === "moved-root")
        await db
          .update(clusterFileRoots)
          .set({ enabled: false })
          .where(eq(clusterFileRoots.id, rootId));
      if (change === "other-agent")
        await db.update(jobs).set({ agentId: null }).where(eq(jobs.id, id));
      if (change === "changed-path")
        await db
          .update(dataLocations)
          .set({ relativePath: "other" })
          .where(eq(dataLocations.id, r.locationId));
      await expect(db.transaction((tx) => assertRunningDataBindings(tx, dispatch))).rejects.toThrow(
        "Running data binding changed",
      );
    } finally {
      setSystemTime();
      await db.delete(jobs).where(eq(jobs.id, id));
    }
  }, 15_000);

  test("dataset delivery lease never outlives source authority and imported data cannot be delegated again", async () => {
    const f = await publicationFixture();
    const r = await f.publish();
    await f.allowLocal(r);
    const id = crypto.randomUUID();
    await db.insert(jobs).values({
      id,
      name: "Foreign data dispatch",
      command: "true",
      cpus: 1,
      memoryMb: 16,
      submittedBy: actor.userId,
      agentId,
    });
    await db.insert(jobDataBindings).values({
      jobId: id,
      inputDescriptor: "dataset",
      source: "data-market",
      assetId: r.assetId,
      versionId: r.versionId,
      manifestDigest: f.use.approval.asset.digest,
      allowedLocationIds: [r.locationId],
      selectedEntries: ["input.dat"],
      stagePath: "inputs/dataset",
      sensitivity: "restricted",
      egressPolicy: "deny",
    });
    const repo = new PgDataPrerequisiteRepository(db, { now: () => now });
    const resolver = new DataDeliveryResolver(
      db,
      {
        dataMarketImmutableBucket: "unused",
        presignImmutableDownload: async () => {
          throw new Error("No download authorization");
        },
      },
      { now: () => now, verifyAccess: (input) => repo.verifyAccess(input) },
    );
    try {
      now = new Date(now.getTime() + 45_000);
      const [delivery] = await resolver.resolveForDispatch({
        jobId: id,
        actorUserId: actor.userId,
        orgId: actor.orgId,
        agentId,
      });
      expect(delivery?.leaseExpiresAtUnixMs).toBe(testNow.getTime() + 60_000);
      expect(delivery?.method).toBe("readonly-mount");
      expect(delivery?.selectedEntries[0]?.sha256).toBe(
        createHash("sha256").update("data").digest("hex"),
      );
      await db
        .update(userOrgMemberships)
        .set({ role: "admin" })
        .where(eq(userOrgMemberships.userId, actor.userId));
      await expect(
        f.use.policyService.approve(actor, {
          ...f.use.input,
          policyId: crypto.randomUUID(),
          versionId: r.versionId,
        }),
      ).rejects.toThrow();
      await expect(
        service.prepare(actor, { ...request(), versionId: r.versionId, locationId: r.locationId }),
      ).rejects.toThrow();
      await expect(policies.read({ ...manager, role: "org_admin" }, r.versionId)).rejects.toThrow();
      now = new Date(testNow.getTime() + 60_001);
      await expect(
        resolver.resolveForDispatch({
          jobId: id,
          actorUserId: actor.userId,
          orgId: actor.orgId,
          agentId,
        }),
      ).rejects.toThrow("DATA_ACCESS_REVOKED");
    } finally {
      await db.delete(jobs).where(eq(jobs.id, id));
    }
  });

  test("dataset authority rejects changed source key purposes and altered replica paths", async () => {
    const f = await publicationFixture();
    const r = await f.publish();
    const path = `.federation-media/${f.media.input.packageId}/files`;
    await db
      .update(dataLocations)
      .set({ relativePath: "other-data" })
      .where(eq(dataLocations.id, r.locationId));
    expect((await f.authority(r)).allowed).toBe(false);
    await db
      .update(dataLocations)
      .set({ relativePath: path })
      .where(eq(dataLocations.id, r.locationId));
    const [key] = await db
      .select()
      .from(federationSigningKeys)
      .where(
        and(
          eq(federationSigningKeys.siteId, source.signing.siteId),
          eq(federationSigningKeys.keyId, source.signing.keyId),
        ),
      );
    if (!key) throw new Error("Missing key");
    try {
      await db
        .update(federationSigningKeys)
        .set({ allowedKinds: key.allowedKinds.filter((k) => k !== "dataset-use-grant") })
        .where(
          and(
            eq(federationSigningKeys.siteId, source.signing.siteId),
            eq(federationSigningKeys.keyId, source.signing.keyId),
          ),
        );
      expect((await f.authority(r)).allowed).toBe(false);
    } finally {
      await db
        .update(federationSigningKeys)
        .set({ allowedKinds: key.allowedKinds })
        .where(
          and(
            eq(federationSigningKeys.siteId, source.signing.siteId),
            eq(federationSigningKeys.keyId, source.signing.keyId),
          ),
        );
    }
  });

  test("dataset publication HTTP scopes operations to the active human organization and hides signed leases", async () => {
    const f = await publicationFixture();
    const app = new Hono();
    app.onError(createErrorHandler(pino({ enabled: false })));
    app.use("*", async (c, next) => {
      c.set("principal" as never, actor as never);
      await next();
    });
    app.route(
      "/api",
      createFederationMediaRoutes(
        f.media.receiver,
        undefined,
        undefined,
        undefined,
        undefined,
        f.publication,
      ),
    );
    const path = `/api/federation/media/packages/${f.media.input.packageId}/datasets`;
    const post = (value: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    expect((await post({ ...f.input, relativePath: "unapproved" })).status).toBe(400);
    await permissions.set({ ...actor, capability: "asset.map", enabled: false }, actor.userId);
    try {
      expect((await post(f.input)).status).toBe(403);
    } finally {
      await permissions.set({ ...actor, capability: "asset.map", enabled: true }, actor.userId);
    }
    const response = await post(f.input);
    expect(response.status).toBe(201);
    const result = await response.text();
    expect(result).not.toContain("signedGrant");
    await permissions.set({ ...actor, capability: "asset.read", enabled: true }, actor.userId);
    expect((await app.request("/api/federation/media/datasets?limit=1")).status).toBe(200);
    expect(
      (
        await app.request(`/api/federation/media/datasets/${f.input.replicaId}/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "No longer needed" }),
        })
      ).status,
    ).toBe(200);
    expect((await post(f.input)).status).toBe(409);
  });

  test("dataset renewal fences an old network reply after another worker takes over", async () => {
    const f = await publicationFixture();
    const r = await f.publish();
    const arrived = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    now = new Date(now.getTime() + 21_000);
    const slow = f.makeService(async () => {
      arrived.resolve();
      await release.promise;
    });
    const first = slow.renewNext();
    await arrived.promise;
    try {
      now = new Date(now.getTime() + 31_000);
      expect(await f.publication.renewNext()).toBe(true);
      const freshExpiry = (await f.authority(r)).expiresAtUnixMs;
      release.resolve();
      await first;
      expect((await f.authority(r)).expiresAtUnixMs).toBe(freshExpiry);
      expect(freshExpiry).toBe(now.getTime() + 60_000);
    } finally {
      release.resolve();
      await first;
    }
  });

  test("dataset authorization fails promptly while a replica is being revoked", async () => {
    const f = await publicationFixture();
    const r = await f.publish();
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const writer = db.transaction(async (tx) => {
      await tx
        .select()
        .from(federationDatasetReplicas)
        .where(eq(federationDatasetReplicas.replicaId, r.replicaId))
        .for("update");
      held.resolve();
      await release.promise;
    });
    await held.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        f.authority(r).then(
          () => "allowed",
          () => "rejected",
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("waited on revocation"), 1000);
        }),
      ]);
      expect(outcome).toBe("rejected");
    } finally {
      if (timer) clearTimeout(timer);
      release.resolve();
      await writer;
    }
  });

  async function receiptFixture(existing?: Awaited<ReturnType<typeof keyFixture>>) {
    const f = await publicationFixture(existing);
    await permissions.set({ ...actor, capability: "asset.read", enabled: true }, actor.userId);
    for (const key of [source, target]) {
      const [row] = await db
        .select()
        .from(federationSigningKeys)
        .where(
          and(
            eq(federationSigningKeys.siteId, key.signing.siteId),
            eq(federationSigningKeys.keyId, key.signing.keyId),
          ),
        );
      if (!row) throw new Error("Missing key");
      await db
        .update(federationSigningKeys)
        .set({
          allowedKinds: [
            ...new Set([
              ...row.allowedKinds,
              "media-import-receipt" as const,
              "media-import-receipt-ack" as const,
            ]),
          ],
        })
        .where(
          and(
            eq(federationSigningKeys.siteId, key.signing.siteId),
            eq(federationSigningKeys.keyId, key.signing.keyId),
          ),
        );
    }
    const receiver = new FederationMediaReceiptReceiver(db, source.signing, () => now);
    const sent: string[] = [];
    const sender = (after?: (jws: string) => Promise<string>) =>
      new FederationMediaReceiptSender(
        db,
        target.signing,
        async (_endpoint, jws, path) => {
          expect(path).toBe("/federation/v1/media-receipts");
          sent.push(jws);
          const ack = await receiver.receive(jws, "d".repeat(64));
          return after ? after(ack) : ack;
        },
        () => now,
      );
    const status = () =>
      sender().status(actor, f.media.input.packageId, f.media.input.authorizationId);
    return { ...f, receiver, sender, sent, status };
  }

  test("media receipt retries the same historical import after lost acknowledgement and later revocation", async () => {
    const f = await receiptFixture();
    const lost = f.sender(async () => {
      throw new Error("Response lost after source commit");
    });
    expect(await lost.deliverNext()).toBe(true);
    expect((await f.status()).state).toBe("pending");
    expect(await db.select().from(federationMediaReceipts)).toHaveLength(1);
    await service.revoke(actor, f.media.input.packageId, { reason: "Export ended" });
    await f.media.receiver.revoke(
      actor,
      f.media.input.packageId,
      { reason: "Local custody revoked" },
      f.media.input.authorizationId,
    );
    await f.use.policyService.revoke(actor, f.use.input.policyId, { reason: "Use ended" });
    now = new Date(now.getTime() + 90_000);
    expect(await f.sender().deliverNext()).toBe(true);
    const status = await f.status();
    expect(status.state).toBe("recorded");
    expect(status.receipt?.receivedAt).toBe(testNow.toISOString());
    expect(status.receipt?.state).toBe("verified-private");
    expect(f.sent[1]).toBe(f.sent[0]);
    expect(await f.sender().deliverNext()).toBe(false);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "federation.media.receipt_received"),
            eq(auditLog.target, f.input.authorizationId),
          ),
        ),
    ).toHaveLength(1);
    expect(await db.select().from(federationDatasetAssets)).toHaveLength(0);
  });

  test("media receipt rejects forged scope, wrong peer, expired import facts and conflicting replay", async () => {
    const f = await receiptFixture();
    const receipt = (await f.status()).receipt;
    if (!receipt) throw new Error("Missing receipt");
    const signed = await signFederationMessage(
      FederationMediaReceiptSchema,
      receipt,
      target.signing,
    );
    await expect(f.receiver.receive(signed, "forged")).rejects.toThrow();
    for (const patch of [
      { manifestDigest: `sha256:${"e".repeat(64)}` },
      { keyQueryId: crypto.randomUUID() },
      { sizeBytes: 5 },
      { receiptId: crypto.randomUUID() },
      { receivedAt: new Date(now.getTime() + 61_000).toISOString() },
    ]) {
      const forged = await signFederationMessage(
        FederationMediaReceiptSchema,
        { ...receipt, ...patch },
        target.signing,
      );
      await expect(f.receiver.receive(forged, "d".repeat(64))).rejects.toThrow();
    }
    const [a, b] = await Promise.all([
      f.receiver.receive(signed, "d".repeat(64)),
      f.receiver.receive(signed, "d".repeat(64)),
    ]);
    expect(a).toBe(b);
    const changed = await signFederationMessage(
      FederationMediaReceiptSchema,
      { ...receipt, generation: crypto.randomUUID() },
      target.signing,
    );
    await expect(f.receiver.receive(changed, "d".repeat(64))).rejects.toThrow("OPERATION_CONFLICT");
    const badAck = f.sender(async (ackJws) => {
      const { payload } = await verifyFederationMessage(
        FederationMediaReceiptAckSchema,
        ackJws,
        { ...source.verification, allowedKinds: ["media-import-receipt-ack"] },
        now,
      );
      return signFederationMessage(
        FederationMediaReceiptAckSchema,
        { ...payload, receiptDigest: `sha256:${"f".repeat(64)}` },
        source.signing,
      );
    });
    await badAck.deliverNext();
    expect((await f.status()).lastError).toBe("INVALID_MESSAGE");
    expect((await f.status()).acknowledgement).toBeNull();
  });

  test("media receipt source and receiver audit failures roll back their own confirmations", async () => {
    const f = await receiptFixture();
    await db.execute(
      sql`CREATE FUNCTION media_receipt_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('federation.media.receipt_received', 'federation.media.receipt_recorded') THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER media_receipt_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION media_receipt_reject_audit()`,
    );
    try {
      await f.sender().deliverNext();
      expect(await db.select().from(federationMediaReceipts)).toHaveLength(0);
      expect((await f.status()).acknowledgement).toBeNull();
      await db.execute(
        sql`CREATE OR REPLACE FUNCTION media_receipt_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.media.receipt_recorded' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
      );
      now = new Date(now.getTime() + 31_000);
      await f.sender().deliverNext();
      expect(await db.select().from(federationMediaReceipts)).toHaveLength(1);
      expect((await f.status()).acknowledgement).toBeNull();
    } finally {
      await db.execute(sql`DROP TRIGGER media_receipt_reject_audit ON audit_log`);
      await db.execute(sql`DROP FUNCTION media_receipt_reject_audit()`);
    }
    now = new Date(now.getTime() + 31_000);
    await f.sender().deliverNext();
    expect((await f.status()).state).toBe("recorded");
    expect(await db.select().from(federationMediaReceipts)).toHaveLength(1);
  });

  test("media receipt manual retry fences an in-flight acknowledgement and needs current local authority", async () => {
    const f = await receiptFixture();
    const sender = f.sender(async (ack) => {
      await f.sender().retry(actor, f.media.input.packageId, f.media.input.authorizationId);
      return ack;
    });
    await sender.deliverNext();
    expect((await f.status()).state).toBe("pending");
    await expect(
      f.sender().retry(other, f.media.input.packageId, f.media.input.authorizationId),
    ).rejects.toThrow();
    await f.sender().deliverNext();
    expect((await f.status()).state).toBe("recorded");
  });

  test("media receipt requires dedicated current signing purposes without disturbing the imported data", async () => {
    const f = await receiptFixture();
    const [key] = await db
      .select()
      .from(federationSigningKeys)
      .where(
        and(
          eq(federationSigningKeys.siteId, target.signing.siteId),
          eq(federationSigningKeys.keyId, target.signing.keyId),
        ),
      );
    if (!key) throw new Error("Missing key");
    try {
      await db
        .update(federationSigningKeys)
        .set({ allowedKinds: key.allowedKinds.filter((k) => k !== "media-import-receipt") })
        .where(
          and(
            eq(federationSigningKeys.siteId, target.signing.siteId),
            eq(federationSigningKeys.keyId, target.signing.keyId),
          ),
        );
      await f.sender().deliverNext();
      expect((await f.status()).lastError).toBe("UNTRUSTED_IDENTITY");
      expect(f.sent).toHaveLength(0);
      const [op] = await db
        .select()
        .from(federationMediaImportOperations)
        .where(eq(federationMediaImportOperations.authorizationId, f.input.authorizationId));
      expect(op?.state).toBe("verified");
    } finally {
      await db
        .update(federationSigningKeys)
        .set({ allowedKinds: key.allowedKinds })
        .where(
          and(
            eq(federationSigningKeys.siteId, target.signing.siteId),
            eq(federationSigningKeys.keyId, target.signing.keyId),
          ),
        );
    }
  });

  test("media receipt key rotation re-signs transport while retaining the original custody statement", async () => {
    const f = await receiptFixture();
    await f
      .sender(async () => {
        throw new Error("Response lost");
      })
      .deliverNext();
    const original = (await f.receiver.list(actor, f.media.input.packageId))[0];
    if (!original) throw new Error("Missing original evidence");
    const nextSource = await testKeys(source.signing.siteId),
      nextTarget = await testKeys(target.signing.siteId);
    nextSource.signing.keyId += "-receipt-next";
    nextTarget.signing.keyId += "-receipt-next";
    const trust = new FederationTrustRegistry(db);
    for (const key of [nextSource, nextTarget])
      await trust.addKey(
        key.signing.siteId,
        {
          keyId: key.signing.keyId,
          publicKeyPem: await exportSPKI(key.verification.publicKey),
          validFrom: key.verification.validFrom.toISOString(),
          validUntil: key.verification.validUntil.toISOString(),
          allowedKinds: ["media-import-receipt", "media-import-receipt-ack"],
        },
        actor.userId,
      );
    for (const key of [source, target])
      await db
        .update(federationSigningKeys)
        .set({ revokedAt: now })
        .where(
          and(
            eq(federationSigningKeys.siteId, key.signing.siteId),
            eq(federationSigningKeys.keyId, key.signing.keyId),
          ),
        );
    try {
      now = new Date(now.getTime() + 31_000);
      const receiver = new FederationMediaReceiptReceiver(db, nextSource.signing, () => now);
      const sender = new FederationMediaReceiptSender(
        db,
        nextTarget.signing,
        (_endpoint, jws) => receiver.receive(jws, "d".repeat(64)),
        () => now,
      );
      await sender.deliverNext();
      const state = await sender.status(
        actor,
        f.media.input.packageId,
        f.media.input.authorizationId,
      );
      expect(state.state).toBe("recorded");
      expect(state.receipt).toEqual(original.receipt);
      expect(state.acknowledgement).toEqual(original.acknowledgement);
      expect(state.signedReceipt).not.toBe(original.signedReceipt);
      expect(state.signedAcknowledgement).not.toBe(original.signedAcknowledgement);
      expect((await receiver.list(actor, f.media.input.packageId))[0]?.signedReceipt).toBe(
        original.signedReceipt,
      );
    } finally {
      for (const key of [source, target])
        await db
          .update(federationSigningKeys)
          .set({ revokedAt: null })
          .where(
            and(
              eq(federationSigningKeys.siteId, key.signing.siteId),
              eq(federationSigningKeys.keyId, key.signing.keyId),
            ),
          );
    }
  });

  test("media receipt refuses an acknowledgement after its source key is revoked in flight", async () => {
    const f = await receiptFixture();
    try {
      await f
        .sender(async (ack) => {
          await db
            .update(federationSigningKeys)
            .set({ revokedAt: now })
            .where(
              and(
                eq(federationSigningKeys.siteId, source.signing.siteId),
                eq(federationSigningKeys.keyId, source.signing.keyId),
              ),
            );
          return ack;
        })
        .deliverNext();
      expect((await f.status()).lastError).toBe("UNTRUSTED_IDENTITY");
      expect((await f.status()).acknowledgement).toBeNull();
    } finally {
      await db
        .update(federationSigningKeys)
        .set({ revokedAt: null })
        .where(
          and(
            eq(federationSigningKeys.siteId, source.signing.siteId),
            eq(federationSigningKeys.keyId, source.signing.keyId),
          ),
        );
    }
  });

  test("media receipt HTTP exposes scoped evidence and supports explicit retry without re-import", async () => {
    setSystemTime(testNow);
    try {
      const f = await receiptFixture();
      const ingress = createFederationIngress(db, source.signing);
      const sender = new FederationMediaReceiptSender(
        db,
        target.signing,
        async (_endpoint, body) => {
          const r = await ingress.request("/federation/v1/media-receipts", {
            method: "POST",
            headers: {
              "content-type": "application/jose",
              "x-kq-federation-cert": "d".repeat(64),
            },
            body,
          });
          expect(r.status).toBe(200);
          expect(r.headers.get("cache-control")).toBe("no-store");
          return r.text();
        },
        () => now,
      );
      const app = new Hono();
      app.onError(createErrorHandler(pino({ enabled: false })));
      app.use("*", async (c, next) => {
        c.set("principal" as never, actor as never);
        await next();
      });
      app.route(
        "/api",
        createFederationMediaRoutes(
          f.media.receiver,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { sender, receiver: f.receiver },
        ),
      );
      const path = `/api/federation/media/packages/${f.media.input.packageId}/import-authorizations/${f.media.input.authorizationId}/receipt`;
      expect((await app.request(`${path}/retry`, { method: "POST" })).status).toBe(200);
      await sender.deliverNext();
      const r = await app.request(path);
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).toContain('"state":"recorded"');
      expect(text).not.toContain("encryptedIdentity");
      expect(text).not.toContain("managedRootId");
      expect(
        (
          await app.request(
            `/api/federation/media/exports/${f.media.input.packageId}/receipts?limit=1`,
          )
        ).status,
      ).toBe(200);
      await expect(
        sender.status(other, f.media.input.packageId, f.media.input.authorizationId),
      ).rejects.toThrow();
      await expect(f.receiver.list(other, f.media.input.packageId)).rejects.toThrow();
      expect(
        (
          await ingress.request("/federation/v1/media-receipts", {
            method: "POST",
            body: "unsigned",
          })
        ).status,
      ).toBe(415);
    } finally {
      setSystemTime();
    }
  });

  test("media receipt backfills an old verified operation and isolates a conflicting queue entry", async () => {
    const bad = await receiptFixture(),
      good = await receiptFixture();
    const old = (await bad.status()).receipt;
    if (!old) throw new Error("Missing receipt");
    await db
      .update(federationMediaImportOperations)
      .set({
        receipt: { ...old, generation: crypto.randomUUID() },
        receiptNextAttemptAt: new Date(now.getTime() - 1),
      })
      .where(eq(federationMediaImportOperations.authorizationId, bad.input.authorizationId));
    await db
      .update(federationMediaImportOperations)
      .set({ receipt: null })
      .where(eq(federationMediaImportOperations.authorizationId, good.input.authorizationId));
    await good.sender().deliverNext();
    expect((await bad.status()).lastError).toBe("RECEIPT_CONFLICT");
    await good.sender().deliverNext();
    expect((await good.status()).state).toBe("recorded");
    expect((await good.status()).receipt?.receivedAt).toBe(testNow.toISOString());
  });

  test("media receipt delivery cannot hold Agent dispatch scans and shutdown drains its request", async () => {
    const f = await receiptFixture();
    const arrived = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const operations = new FederationMediaImportOperations(
      db,
      target.signing.siteId,
      f.media.receiver,
      f.media.requester(),
      () => now,
    );
    const transport = new FederationMediaImportTransport(
      operations,
      new AgentDispatcher(),
      f.sender(async (ack) => {
        arrived.resolve();
        await release.promise;
        return ack;
      }),
    );
    const delivery = transport.tickReceipts();
    await arrived.promise;
    try {
      expect(transport.tickReceipts()).toBe(delivery);
      await transport.tick();
      expect((await f.status()).state).toBe("pending");
      const stopping = transport.stop();
      release.resolve();
      await stopping;
      expect((await f.status()).state).toBe("recorded");
    } finally {
      release.resolve();
      await delivery;
      await transport.stop();
    }
  });

  async function useFixture() {
    await permissions.set(
      { ...actor, capability: "dataset.use.approve", enabled: true },
      actor.userId,
    );
    for (const key of [source, target]) {
      const [row] = await db
        .select()
        .from(federationSigningKeys)
        .where(
          and(
            eq(federationSigningKeys.siteId, key.signing.siteId),
            eq(federationSigningKeys.keyId, key.signing.keyId),
          ),
        );
      if (!row) throw new Error("missing key");
      await db
        .update(federationSigningKeys)
        .set({
          allowedKinds: [
            ...new Set([
              ...row.allowedKinds,
              "dataset-use-query" as const,
              "dataset-use-grant" as const,
            ]),
          ],
        })
        .where(
          and(
            eq(federationSigningKeys.siteId, key.signing.siteId),
            eq(federationSigningKeys.keyId, key.signing.keyId),
          ),
        );
    }
    const policyService = new FederationDatasetUsePolicies(
      db,
      source.signing.siteId,
      (a, id) => market.requireManage(a, id),
      () => now,
    );
    const input = {
      policyId: crypto.randomUUID(),
      versionId,
      recipientSiteId: target.signing.siteId,
      agreementRevisionId: terms.agreementRevisionId,
      expiresAt: new Date(testNow.getTime() + 3600_000).toISOString(),
      reason: "Approved partner computation",
    };
    const approval = await policyService.approve(actor, input);
    const responder = new FederationDatasetUseResponder(
      db,
      source.signing,
      policyService,
      () => now,
    );
    const ingress = createFederationIngress(
      db,
      source.signing,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      responder,
    );
    const query = FederationDatasetUseQuerySchema.parse({
      protocolVersion: 1,
      kind: "dataset-use-query",
      queryId: crypto.randomUUID(),
      policyId: input.policyId,
      senderSiteId: target.signing.siteId,
      recipientSiteId: source.signing.siteId,
      agreementRevisionId: terms.agreementRevisionId,
      asset: approval.asset,
      replicaId: crypto.randomUUID(),
      agentId: "recipient-agent",
      managedRootId: crypto.randomUUID(),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const signed = await signFederationMessage(
      FederationDatasetUseQuerySchema,
      query,
      target.signing,
    );
    const call = (body: string, fingerprint = "d".repeat(64)) =>
      ingress.request("/federation/v1/dataset-use", {
        method: "POST",
        headers: { "content-type": "application/jose", "x-kq-federation-cert": fingerprint },
        body,
      });
    return { policyService, input, approval, responder, query, signed, call };
  }

  test("dataset use approval is independent, immutable and scoped to recipient, agreement and version", async () => {
    const f = await useFixture();
    const repeat = await f.policyService.approve(actor, f.input);
    expect(repeat.approvedAt).toEqual(f.approval.approvedAt);
    await expect(
      f.policyService.approve(actor, { ...f.input, reason: "Changed approval" }),
    ).rejects.toThrow("OPERATION_CONFLICT");
    await permissions.set(
      { ...actor, capability: "dataset.use.approve", enabled: false },
      actor.userId,
    );
    await expect(
      f.policyService.approve(actor, { ...f.input, policyId: crypto.randomUUID() }),
    ).rejects.toThrow("POLICY_DENIED");
    await permissions.set(
      { ...actor, capability: "dataset.use.approve", enabled: true },
      actor.userId,
    );
    await db
      .update(dataAccessPolicies)
      .set({ status: "disabled" })
      .where(eq(dataAccessPolicies.id, policyId));
    // Source use approval deliberately does not require another export or download grant.
    const result = await f.call(f.signed);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const verified = await verifyFederationMessage(
      FederationDatasetUseGrantSchema,
      await result.text(),
      { ...source.verification, allowedKinds: ["dataset-use-grant"] },
      now,
    );
    const q = await verifyFederationMessage(
      FederationDatasetUseQuerySchema,
      f.signed,
      { ...target.verification, allowedKinds: ["dataset-use-query"] },
      now,
    );
    assertDatasetUseGrant(f.query, q.digest, verified.payload, now);
    expect(JSON.stringify(verified.payload)).not.toContain(actor.userId);
    expect(JSON.stringify(verified.payload)).not.toContain(actor.orgId);
    expect(verified.payload.replicaId).toBe(f.query.replicaId);
    await expect(service.prepare(actor, request())).rejects.toThrow("POLICY_DENIED");
    const mismatched = {
      ...f.query,
      queryId: crypto.randomUUID(),
      asset: { ...f.query.asset, digest: `sha256:${"b".repeat(64)}` },
    };
    expect(
      (
        await f.call(
          await signFederationMessage(FederationDatasetUseQuerySchema, mismatched, target.signing),
        )
      ).status,
    ).toBe(409);
    expect((await f.call(f.signed, "forged")).status).toBe(401);
  });

  test("dataset use human HTTP routes keep approval separate and reject extra input", async () => {
    const f = await useFixture();
    const r = app(undefined, f.policyService);
    const path = "/api/federation/media/dataset-use-policies";
    const post = (body: unknown) =>
      r.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await permissions.set(
      { ...actor, capability: "dataset.use.approve", enabled: false },
      actor.userId,
    );
    expect((await post(f.input)).status).toBe(403);
    await permissions.set(
      { ...actor, capability: "dataset.use.approve", enabled: true },
      actor.userId,
    );
    expect((await post({ ...f.input, grantDownload: true })).status).toBe(400);
    expect((await post(f.input)).status).toBe(201);
    expect((await r.request(path)).status).toBe(200);
    expect(
      (
        await r.request(`${path}/${f.input.policyId}/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Owner withdraws use" }),
        })
      ).status,
    ).toBe(200);
    expect((await f.call(f.signed)).status).toBe(409);
    await permissions.set(
      { ...other, capability: "dataset.use.approve", enabled: true },
      actor.userId,
    );
    await expect(
      f.policyService.revoke(other, f.input.policyId, { reason: "Other organization" }),
    ).rejects.toThrow("POLICY_DENIED");
  });

  test("dataset use leases preserve signed replay, bind replica scope and stop after revocation", async () => {
    const f = await useFixture();
    const [one, two] = await Promise.all([
      f.responder.respond(f.signed, "d".repeat(64)),
      f.responder.respond(f.signed, "d".repeat(64)),
    ]);
    expect(one).toBe(two);
    expect(
      (
        await db
          .select()
          .from(federationDatasetUseGrants)
          .where(eq(federationDatasetUseGrants.queryId, f.query.queryId))
      ).length,
    ).toBe(1);
    expect(
      (
        await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.target, f.query.queryId),
              eq(auditLog.action, "federation.dataset_use.issue"),
            ),
          )
      ).length,
    ).toBe(1);
    const changed = await signFederationMessage(
      FederationDatasetUseQuerySchema,
      { ...f.query, replicaId: crypto.randomUUID() },
      target.signing,
    );
    await expect(f.responder.respond(changed, "d".repeat(64))).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await f.policyService.revoke(actor, f.input.policyId, { reason: "Partner access withdrawn" });
    await expect(f.responder.respond(f.signed, "d".repeat(64))).rejects.toThrow("POLICY_DENIED");
    await expect(f.policyService.approve(actor, f.input)).rejects.toThrow("OPERATION_CONFLICT");
    expect(
      (await f.policyService.list(actor, 50, 0)).find((p) => p.policyId === f.input.policyId)
        ?.revokedAt,
    ).not.toBeNull();
  });

  test.each([
    "permission",
    "ownership",
    "deny",
    "key-purpose",
    "expired",
  ] as const)("dataset use checks current %s on original-query replay", async (mode) => {
    const f = await useFixture();
    await f.responder.respond(f.signed, "d".repeat(64));
    if (mode === "permission")
      await permissions.set(
        { ...actor, capability: "dataset.use.approve", enabled: false },
        actor.userId,
      );
    if (mode === "ownership")
      await db
        .update(dataAssets)
        .set({ ownerUserId: other.userId })
        .where(eq(dataAssets.id, assetId));
    if (mode === "deny")
      await db
        .update(dataAccessPolicies)
        .set({ effect: "deny", capabilities: ["use"] })
        .where(eq(dataAccessPolicies.id, policyId));
    if (mode === "key-purpose")
      await db
        .update(federationSigningKeys)
        .set({
          allowedKinds: ["agreement", "media-manifest", "media-key-query", "media-key-grant"],
        })
        .where(eq(federationSigningKeys.siteId, source.signing.siteId));
    if (mode === "expired") now = new Date(now.getTime() + 60_001);
    await expect(f.responder.respond(f.signed, "d".repeat(64))).rejects.toThrow();
  });

  test("dataset use preserves licensed material entitlement and its expiry", async () => {
    const f = await useFixture();
    const [before] = await db.select().from(dataAssets).where(eq(dataAssets.id, assetId));
    if (!before) throw new Error("Missing asset");
    const grantId = crypto.randomUUID();
    try {
      await db
        .update(dataAssets)
        .set({ kind: "licensed-material", accessMode: "entitlement" })
        .where(eq(dataAssets.id, assetId));
      await db
        .update(dataAccessPolicies)
        .set({ status: "disabled" })
        .where(eq(dataAccessPolicies.id, policyId));
      await expect(f.responder.respond(f.signed, "d".repeat(64))).rejects.toThrow("POLICY_DENIED");
      const expiresAt = new Date(now.getTime() + 5_000);
      await db.insert(dataGrants).values({
        id: grantId,
        dataAssetId: assetId,
        dataAssetVersionId: versionId,
        subjectKind: "user",
        subjectId: actor.userId,
        capabilities: ["use"],
        startsAt: now,
        expiresAt,
      });
      const response = await f.responder.respond(f.signed, "d".repeat(64));
      const verified = await verifyFederationMessage(
        FederationDatasetUseGrantSchema,
        response,
        { ...source.verification, allowedKinds: ["dataset-use-grant"] },
        now,
      );
      expect(verified.payload.expiresAt).toBe(expiresAt.toISOString());
      await db.update(dataGrants).set({ status: "revoked" }).where(eq(dataGrants.id, grantId));
      await expect(f.responder.respond(f.signed, "d".repeat(64))).rejects.toThrow("POLICY_DENIED");
    } finally {
      await db.delete(dataGrants).where(eq(dataGrants.id, grantId));
      await db
        .update(dataAssets)
        .set({ kind: before.kind, accessMode: before.accessMode })
        .where(eq(dataAssets.id, assetId));
    }
  });

  test("dataset use custody rechecks external authorization and changing ownership", async () => {
    const f = await useFixture();
    const denied = new FederationDatasetUsePolicies(
      db,
      source.signing.siteId,
      async () => {
        throw new Error("external authorization denied");
      },
      () => now,
    );
    await expect(
      denied.approve(actor, { ...f.input, policyId: crypto.randomUUID() }),
    ).rejects.toThrow("external authorization denied");
    const race = new FederationDatasetUsePolicies(
      db,
      source.signing.siteId,
      async (a, id) => {
        await market.requireManage(a, id);
        await db
          .update(dataAssets)
          .set({ ownerUserId: other.userId })
          .where(eq(dataAssets.id, assetId));
      },
      () => now,
    );
    await expect(
      race.approve(actor, { ...f.input, policyId: crypto.randomUUID() }),
    ).rejects.toThrow("POLICY_DENIED");
    // The independent institution capability still permits withdrawing a historical policy.
    await f.policyService.revoke(actor, f.input.policyId, { reason: "Custody changed" });
  });

  test("dataset use cannot issue or approve without its atomic audit and caps key lifetime", async () => {
    const f = await useFixture();
    const newId = crypto.randomUUID();
    await db.execute(
      sql`CREATE FUNCTION dataset_use_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'federation.dataset_use.%' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER dataset_use_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dataset_use_reject_audit()`,
    );
    try {
      await expect(
        f.policyService.approve(actor, { ...f.input, policyId: newId }),
      ).rejects.toThrow();
      await expect(f.responder.respond(f.signed, "d".repeat(64))).rejects.toThrow();
      expect(
        await db
          .select()
          .from(federationDatasetUsePolicies)
          .where(eq(federationDatasetUsePolicies.policyId, newId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(federationDatasetUseGrants)
          .where(eq(federationDatasetUseGrants.queryId, f.query.queryId)),
      ).toEqual([]);
    } finally {
      await db.execute(sql`DROP TRIGGER dataset_use_reject_audit ON audit_log`);
      await db.execute(sql`DROP FUNCTION dataset_use_reject_audit()`);
    }
    const expiry = new Date(now.getTime() + 3_000);
    try {
      await db
        .update(federationSigningKeys)
        .set({ validUntil: expiry })
        .where(eq(federationSigningKeys.siteId, source.signing.siteId));
      const response = await f.responder.respond(f.signed, "d".repeat(64));
      const verified = await verifyFederationMessage(
        FederationDatasetUseGrantSchema,
        response,
        { ...source.verification, allowedKinds: ["dataset-use-grant"] },
        now,
      );
      expect(verified.payload.expiresAt).toBe(expiry.toISOString());
    } finally {
      await db
        .update(federationSigningKeys)
        .set({ validUntil: source.verification.validUntil })
        .where(eq(federationSigningKeys.siteId, source.signing.siteId));
    }
  });

  test("media export operation dispatches real encrypted files through Agent lease and report transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kq-media-operation-"));
    let client: FederationMediaExportClient | undefined;
    setSystemTime(testNow);
    try {
      const input = request();
      await service.prepare(actor, input);
      const operations = new FederationMediaExportOperations(
        db,
        source.signing.siteId,
        service,
        () => now,
      );
      const response = await app(operations).request(
        `/api/federation/media/exports/${input.packageId}/run`,
        { method: "POST" },
      );
      expect(response.status).toBe(202);
      const [first, same] = await Promise.all([
        operations.start(actor, input.packageId),
        operations.start(actor, input.packageId),
      ]);
      expect(first?.generation).toBe(same?.generation);
      await mkdir(join(directory, "source", "v1"), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "source", "v1", "input.dat"), "data");
      const roots = new AgentDataRoots({
        datasetRoot: join(directory, "source"),
        jobWorkRoot: join(directory, "jobs"),
        managedRoots: { [rootId]: "." },
      });
      await roots.initialize();
      const dispatcher = new AgentDispatcher();
      const transport = new FederationMediaExportTransport(operations, dispatcher);
      const finished = Promise.withResolvers<void>();
      client = new FederationMediaExportClient(
        { agentId, roots, mediaDirectory: join(directory, "media"), ageDirectory: binary ?? "" },
        (request) => {
          void transport.grant(agentId, request).then(
            (reply) => client?.receive(reply),
            (error) => {
              finished.reject(error);
              client?.receive(
                create(FederationMediaExportLeaseResponseSchema, { requestId: request.requestId }),
              );
            },
          );
          return true;
        },
        (report) => {
          void transport.report(agentId, report).then(finished.resolve, finished.reject);
        },
      );
      dispatcher.register(agentId, {
        federationMediaExportV1: true,
        verifiedCertFingerprint: "isolated-channel-fixture",
        push: (message) => {
          if (message.payload.case === "federationMediaExport")
            client?.start(message.payload.value);
        },
        close: () => {},
      });
      await transport.tick();
      await finished.promise;
      await permissions.set({ ...actor, capability: "asset.read", enabled: true }, actor.userId);
      const status = await operations.status(actor, input.packageId);
      expect(status?.state).toBe("exported");
      const cipher = await readFile(
        join(directory, "media", "outbox", input.packageId, "bundle.age"),
      );
      expect(status?.sha256).toBe(createHash("sha256").update(cipher).digest("hex"));
      expect(status?.sizeBytes).toBe(cipher.length);
      expect((await operations.start(actor, input.packageId))?.generation).toBe(first?.generation);
      expect(JSON.stringify(status)).not.toContain("AGE-SECRET-KEY");
    } finally {
      await client?.disconnect();
      setSystemTime();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("media export operation fences retries, wrong Agents, revoked consent and duplicate reports", async () => {
    const prepared = await service.prepare(actor, request());
    const operations = new FederationMediaExportOperations(
      db,
      source.signing.siteId,
      service,
      () => now,
    );
    await operations.start(actor, prepared.packageId);
    const first = await operations.task(agentId, prepared.packageId);
    const binding = {
      generation: first.task.generation,
      packageId: prepared.packageId,
      manifestDigest: first.task.manifestDigest,
    };
    expect((await operations.lease(agentId, binding)).expiresAt).toBe(
      new Date(testNow.getTime() + 30_000).toISOString(),
    );
    await expect(operations.lease("wrong-agent", binding)).rejects.toThrow("POLICY_DENIED");
    await operations.report(agentId, { ...binding, state: "failed" });
    const retry = await operations.start(actor, prepared.packageId);
    expect(retry?.generation).not.toBe(binding.generation);
    const [retryAudit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, prepared.packageId),
          eq(auditLog.action, "federation.media.export_retry"),
        ),
      );
    expect(retryAudit?.diff).toEqual({
      after: { generation: retry?.generation, previousGeneration: binding.generation },
    });
    await expect(
      operations.report(agentId, {
        ...binding,
        state: "exported",
        sha256: "a".repeat(64),
        sizeBytes: 100,
      }),
    ).rejects.toThrow("OPERATION_CONFLICT");
    const current = { ...binding, generation: retry?.generation };
    await db
      .update(dataAccessPolicies)
      .set({ redistributionPolicy: "deny" })
      .where(eq(dataAccessPolicies.id, policyId));
    await expect(operations.lease(agentId, current)).rejects.toThrow("POLICY_DENIED");
    await db
      .update(dataAccessPolicies)
      .set({ redistributionPolicy: "allow" })
      .where(eq(dataAccessPolicies.id, policyId));
    const report = { ...current, state: "exported", sha256: "a".repeat(64), sizeBytes: 100 };
    await operations.report(agentId, report);
    await operations.report(agentId, report);
    await expect(operations.report(agentId, { ...report, sha256: "b".repeat(64) })).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await expect(operations.lease(agentId, current)).rejects.toThrow("OPERATION_CONFLICT");
    await expect(operations.start(other, prepared.packageId)).rejects.toThrow("POLICY_DENIED");
  });

  test("media export operation start rolls back when the audit cannot be stored", async () => {
    const prepared = await service.prepare(actor, request());
    const operations = new FederationMediaExportOperations(
      db,
      source.signing.siteId,
      service,
      () => now,
    );
    await db.execute(
      sql`CREATE FUNCTION media_export_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.media.export_start' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER media_export_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION media_export_reject_audit()`,
    );
    try {
      await expect(operations.start(actor, prepared.packageId)).rejects.toThrow();
      await expect(operations.task(agentId, prepared.packageId)).rejects.toThrow("POLICY_DENIED");
    } finally {
      await db.execute(sql`DROP TRIGGER media_export_reject_audit ON audit_log`);
      await db.execute(sql`DROP FUNCTION media_export_reject_audit()`);
    }
  });
});
