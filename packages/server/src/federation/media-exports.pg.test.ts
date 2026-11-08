import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agents,
  auditLog,
  clusterFileRoots,
  createPgDb,
  dataAccessPolicies,
  dataAssetManifestEntries,
  dataAssets,
  dataAssetVersions,
  dataLocations,
  federationMediaExports,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAgreementSchema,
  FederationMediaManifestSchema,
} from "@kuintessence/shared/federation";
import { MediaAge } from "@kuintessence/shared/federation/media-age";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { decryptSecret } from "../auth/secret-cipher";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationMediaRoutes } from "../routes/federation-media";
import { FederationAdmission } from "./admission";
import { FederationMediaExportService, mediaIdentityDomain } from "./media-exports";
import { FederationMediaPackageService } from "./media-packages";
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
      for (const capability of ["asset.map", "media.export"] as const)
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
          allowedKinds: ["agreement", "media-manifest"],
        },
        actor.userId,
      );
    }
    terms = testAgreement(source.signing.siteId, target.signing.siteId);
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
    await db.insert(agents).values({
      agentId,
      providerOrgId: actor.orgId,
      siteName: "Source",
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
  function app() {
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
      ),
    );
    return r;
  }

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
});
