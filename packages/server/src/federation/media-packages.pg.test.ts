import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  agents,
  auditLog,
  clusterFileRoots,
  createPgDb,
  dataLocations,
  federationAgreements,
  federationMediaImportAuthorizations,
  federationMediaPackages,
  federationSigningKeys,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAgreementSchema,
  FederationMediaManifestSchema,
} from "@kuintessence/shared/federation";
import { and, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { z } from "zod";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationMediaRoutes } from "../routes/federation-media";
import { FederationAdmission } from "./admission";
import { FederationMediaPackageService } from "./media-packages";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage } from "./signatures";
import { testAgreement, testKeys, testNow } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Media tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 6, idle_timeout: 1 });
const actor = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const outsider = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const worker = { orgId: actor.orgId, userId: crypto.randomUUID() };
const reader = { orgId: actor.orgId, userId: crypto.randomUUID() };
const agentId = `media-agent-${crypto.randomUUID()}`,
  managedRootId = crypto.randomUUID();
let source: Awaited<ReturnType<typeof testKeys>>, target: Awaited<ReturnType<typeof testKeys>>;
let agreement: ReturnType<typeof testAgreement>, service: FederationMediaPackageService;
let now = testNow;
const permissions = new FederationPermissionService(db);

beforeAll(async () => {
  await db.insert(orgs).values([
    { id: actor.orgId, name: "Media receiver" },
    { id: outsider.orgId, name: "Other organization" },
  ]);
  await db.insert(users).values(
    [actor, outsider, worker, reader].map((a) => ({
      id: a.userId,
      orgId: a.orgId,
      email: `${a.userId}@test.invalid`,
      role: "user",
      serviceAccount: a === worker,
    })),
  );
  await db
    .insert(userOrgMemberships)
    .values([actor, outsider, worker, reader].map((a) => ({ ...a, role: "member" })));
  for (const a of [actor, outsider])
    for (const capability of ["asset.map", "media.import"] as const)
      await permissions.set({ ...a, capability, enabled: true }, actor.userId);
  await permissions.set({ ...reader, capability: "asset.read", enabled: true }, actor.userId);
  [source, target] = await Promise.all([testKeys(), testKeys()]);
  const trust = new FederationTrustRegistry(db);
  for (const keys of [source, target]) {
    await trust.addSite(
      { id: keys.signing.siteId, name: "Test site", endpoint: "https://media.test.invalid" },
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
  agreement = testAgreement(source.signing.siteId, target.signing.siteId);
  await new FederationAdmission(
    db,
    target.signing,
    target.verification,
    () => testNow,
  ).installApprovedAgreement({
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
    identity: worker,
  });
  await db.insert(agents).values({
    agentId,
    siteName: "Receiver",
    providerOrgId: actor.orgId,
    schedulerType: "slurm",
    schedulerVersion: "test",
  });
  await db.insert(clusterFileRoots).values({
    id: managedRootId,
    label: "Media receiver",
    providerOrgId: actor.orgId,
    agentId,
    path: "/managed/media",
  });
  service = new FederationMediaPackageService(db, target.signing.siteId, () => now);
});
afterAll(async () => {
  await db.$client.end();
});

async function inventory(packageId = crypto.randomUUID()) {
  const manifest = FederationMediaManifestSchema.parse({
    protocolVersion: 1,
    kind: "media-manifest",
    packageId,
    senderSiteId: source.signing.siteId,
    recipientSiteId: target.signing.siteId,
    agreementRevisionId: agreement.agreementRevisionId,
    createdAt: testNow.toISOString(),
    subject: {
      kind: "dataset",
      asset: {
        originSiteId: source.signing.siteId,
        kind: "dataset",
        id: crypto.randomUUID(),
        revision: "v1",
        digest: `sha256:${"a".repeat(64)}`,
      },
    },
    files: [
      {
        path: "science/input.dat",
        sizeBytes: 42,
        sha256: "b".repeat(64),
        license: null,
        provenance: null,
      },
    ],
  });
  const input = {
    senderSiteId: source.signing.siteId,
    signedManifest: await signFederationMessage(
      FederationMediaManifestSchema,
      manifest,
      source.signing,
    ),
  };
  return { manifest, input };
}
async function registered() {
  const item = await inventory();
  await service.register(actor, item.input);
  return item;
}
function approval() {
  return {
    authorizationId: crypto.randomUUID(),
    agentId,
    managedRootId,
    maxBytes: 42,
    expiresAt: new Date(testNow.getTime() + 3600_000).toISOString(),
  };
}
function authorized(packageId: string, authorizationId: string) {
  return db.transaction((tx) =>
    service.assertImportAuthorized(tx, actor.orgId, packageId, authorizationId),
  );
}
function app(a: typeof actor | undefined = actor, automation = false) {
  const r = new Hono();
  r.onError(createErrorHandler(pino({ enabled: false })));
  r.use("*", async (c, next) => {
    if (a) c.set("principal" as never, { userId: a.userId, orgId: a.orgId } as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  r.route("/api", createFederationMediaRoutes(service));
  return r;
}

test("HTTP registration persists exact signed inventory without granting import or publishing data", async () => {
  const { manifest, input } = await inventory();
  const [before] = await db.select({ count: count() }).from(dataLocations);
  const r = app();
  const response = await r.request("/api/federation/media/packages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const details = await service.details(reader, manifest.packageId);
  expect(details.manifest).toEqual(manifest);
  expect(details.signedManifest).toBe(input.signedManifest);
  expect(details.authorizations).toEqual([]);
  expect(JSON.stringify(await service.list(actor))).not.toContain(input.signedManifest);
  const [after] = await db.select({ count: count() }).from(dataLocations);
  expect(after?.count).toBe(before?.count);
  await expect(authorized(manifest.packageId, crypto.randomUUID())).rejects.toThrow(
    "POLICY_DENIED",
  );
});

test("concurrent registration replays once and changed content cannot reuse a package ID", async () => {
  const item = await inventory();
  const rows = await Promise.all(
    Array.from({ length: 4 }, () => service.register(actor, item.input)),
  );
  expect(new Set(rows.map((row) => row.manifestDigest)).size).toBe(1);
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "federation.media.register"),
        eq(auditLog.target, item.manifest.packageId),
      ),
    );
  expect(audits).toHaveLength(1);
  const changed = { ...item.manifest, files: [{ ...item.manifest.files[0], sizeBytes: 43 }] };
  const signedManifest = await signFederationMessage(
    FederationMediaManifestSchema,
    FederationMediaManifestSchema.parse(changed),
    source.signing,
  );
  await expect(service.register(actor, { ...item.input, signedManifest })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect((await service.details(actor, item.manifest.packageId)).signedManifest).toBe(
    item.input.signedManifest,
  );
});

test("wrong signatures, sender, recipient and cross-organization access fail closed", async () => {
  const { manifest, input } = await registered();
  await expect(service.register(reader, input)).rejects.toThrow("POLICY_DENIED");
  await expect(service.register(outsider, input)).rejects.toThrow("POLICY_DENIED");
  await expect(service.details(outsider, manifest.packageId)).rejects.toThrow("POLICY_DENIED");
  expect(await service.list(outsider)).toEqual([]);
  await expect(
    service.register(actor, { ...input, senderSiteId: target.signing.siteId }),
  ).rejects.toThrow();
  const wrong = {
    ...manifest,
    packageId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
  };
  await expect(
    service.register(actor, {
      ...input,
      signedManifest: await signFederationMessage(
        FederationMediaManifestSchema,
        wrong,
        source.signing,
      ),
    }),
  ).rejects.toThrow("INVALID_MESSAGE");
  const pieces = input.signedManifest.split(".");
  pieces[1] = Buffer.from(JSON.stringify(wrong)).toString("base64url");
  await expect(
    service.register(actor, { ...input, signedManifest: pieces.join(".") }),
  ).rejects.toThrow("INVALID_MESSAGE");
  expect((await app(actor, true).request("/api/federation/media/packages")).status).toBe(403);
  expect(
    (
      await app().request("/api/federation/media/packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, privateKey: "forbidden" }),
      })
    ).status,
  ).toBe(400);
});

test("local import consent is separate, finite, rooted in the same organization and idempotent", async () => {
  const { manifest } = await registered(),
    input = approval();
  await expect(service.approveImport(reader, manifest.packageId, input)).rejects.toThrow(
    "POLICY_DENIED",
  );
  for (const patch of [
    { maxBytes: 41 },
    { expiresAt: testNow.toISOString() },
    { expiresAt: "2027-01-01T00:00:00.000Z" },
    { agentId: "unknown-agent" },
    { managedRootId: crypto.randomUUID() },
  ])
    await expect(
      service.approveImport(actor, manifest.packageId, { ...input, ...patch }),
    ).rejects.toThrow("POLICY_DENIED");
  const rows = await Promise.all(
    Array.from({ length: 4 }, () => service.approveImport(actor, manifest.packageId, input)),
  );
  expect(new Set(rows.map((row) => row.authorizationId)).size).toBe(1);
  expect((await authorized(manifest.packageId, input.authorizationId)).authorization.agentId).toBe(
    agentId,
  );
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "federation.media.import_approve"),
        eq(auditLog.target, manifest.packageId),
      ),
    );
  expect(audits).toHaveLength(1);
  await expect(
    service.approveImport(actor, manifest.packageId, { ...input, maxBytes: 43 }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("every use rechecks operator permission, root ownership, root enabled state and original signing purpose", async () => {
  const { manifest } = await registered(),
    input = approval();
  await service.approveImport(actor, manifest.packageId, input);
  try {
    await permissions.set({ ...actor, capability: "media.import", enabled: false }, actor.userId);
    await expect(authorized(manifest.packageId, input.authorizationId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    await permissions.set({ ...actor, capability: "media.import", enabled: true }, actor.userId);
    await db.update(users).set({ suspended: true }).where(eq(users.id, actor.userId));
    await expect(authorized(manifest.packageId, input.authorizationId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    await db.update(users).set({ suspended: false }).where(eq(users.id, actor.userId));
    await db
      .update(clusterFileRoots)
      .set({ enabled: false })
      .where(eq(clusterFileRoots.id, managedRootId));
    await expect(authorized(manifest.packageId, input.authorizationId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    await db
      .update(clusterFileRoots)
      .set({ enabled: true, providerOrgId: outsider.orgId })
      .where(eq(clusterFileRoots.id, managedRootId));
    await expect(authorized(manifest.packageId, input.authorizationId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    await db
      .update(clusterFileRoots)
      .set({ providerOrgId: actor.orgId })
      .where(eq(clusterFileRoots.id, managedRootId));
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: ["agreement"] })
      .where(eq(federationSigningKeys.keyId, source.signing.keyId));
    await expect(authorized(manifest.packageId, input.authorizationId)).rejects.toThrow(
      "UNTRUSTED_IDENTITY",
    );
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, actor.userId));
    await db
      .update(clusterFileRoots)
      .set({ enabled: true, providerOrgId: actor.orgId })
      .where(eq(clusterFileRoots.id, managedRootId));
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: ["agreement", "media-manifest"] })
      .where(eq(federationSigningKeys.keyId, source.signing.keyId));
    await permissions.set({ ...actor, capability: "media.import", enabled: true }, actor.userId);
  }
});

test("expired or suspended cooperation can retain inventory but never grants import", async () => {
  const { manifest } = await registered(),
    input = approval();
  await service.approveImport(actor, manifest.packageId, input);
  try {
    now = new Date(input.expiresAt);
    await expect(authorized(manifest.packageId, input.authorizationId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    now = testNow;
    await db
      .update(federationAgreements)
      .set({ state: "suspended" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
    await expect(authorized(manifest.packageId, input.authorizationId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    const later = await registered();
    await expect(
      service.approveImport(actor, later.manifest.packageId, approval()),
    ).rejects.toThrow("POLICY_DENIED");
  } finally {
    now = testNow;
    await db
      .update(federationAgreements)
      .set({ state: "active" })
      .where(eq(federationAgreements.revisionId, agreement.agreementRevisionId));
  }
});

test("authorization and package revocations are durable, idempotent and cannot be undone by replay", async () => {
  const { manifest, input: registration } = await registered(),
    input = approval();
  await service.approveImport(actor, manifest.packageId, input);
  await service.revoke(
    actor,
    manifest.packageId,
    { reason: "Local authorization withdrawn" },
    input.authorizationId,
  );
  await expect(authorized(manifest.packageId, input.authorizationId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(service.approveImport(actor, manifest.packageId, input)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  const next = approval();
  await service.approveImport(actor, manifest.packageId, next);
  await service.revoke(actor, manifest.packageId, { reason: "Package withdrawn" });
  await service.revoke(actor, manifest.packageId, { reason: "Repeated request" });
  const restarted = new FederationMediaPackageService(db, target.signing.siteId, () => testNow);
  await expect(
    db.transaction((tx) =>
      restarted.assertImportAuthorized(tx, actor.orgId, manifest.packageId, next.authorizationId),
    ),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(restarted.register(actor, registration)).rejects.toThrow("OPERATION_CONFLICT");
  expect((await restarted.details(actor, manifest.packageId)).revocationReason).toBe(
    "Package withdrawn",
  );
});

test("audit failure rolls back the authorization and its API success", async () => {
  const { manifest } = await registered(),
    input = approval();
  await db.execute(
    sql`CREATE FUNCTION media_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.media.import_approve' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER media_test_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION media_test_reject_audit()`,
  );
  try {
    await expect(service.approveImport(actor, manifest.packageId, input)).rejects.toThrow();
    expect(
      await db
        .select()
        .from(federationMediaImportAuthorizations)
        .where(eq(federationMediaImportAuthorizations.authorizationId, input.authorizationId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`DROP TRIGGER media_test_reject_audit ON audit_log`);
    await db.execute(sql`DROP FUNCTION media_test_reject_audit()`);
  }
});

test("database constraints reject a mismatched recipient or an excessive consent lifetime", async () => {
  const { manifest } = await registered(),
    input = approval();
  await expect(
    db
      .update(federationMediaPackages)
      .set({ manifest: { ...manifest, recipientSiteId: crypto.randomUUID() } })
      .where(eq(federationMediaPackages.packageId, manifest.packageId))
      .execute(),
  ).rejects.toThrow();
  await expect(
    db
      .insert(federationMediaImportAuthorizations)
      .values({
        ...input,
        localSiteId: target.signing.siteId,
        packageId: manifest.packageId,
        approvedBy: actor.userId,
        approvedAt: testNow,
        expiresAt: new Date(testNow.getTime() + 8 * 86400_000),
      })
      .execute(),
  ).rejects.toThrow();
  expect((await service.details(actor, manifest.packageId)).manifest).toEqual(manifest);
});

test("authorization history remains pageable and readonly sessions cannot approve imports", async () => {
  const pageSchema = z.object({
    data: z.object({
      authorizations: z.array(z.object({ authorizationId: z.uuid() })),
      hasMoreAuthorizations: z.boolean(),
    }),
  });
  const { manifest } = await registered();
  await db.insert(federationMediaImportAuthorizations).values(
    Array.from({ length: 101 }, () => ({
      ...approval(),
      localSiteId: target.signing.siteId,
      packageId: manifest.packageId,
      approvedBy: actor.userId,
      approvedAt: testNow,
      expiresAt: new Date(testNow.getTime() + 3600_000),
    })),
  );
  const first = await app(reader).request(`/api/federation/media/packages/${manifest.packageId}`);
  const firstPage = pageSchema.parse(await first.json());
  expect(firstPage.data.authorizations).toHaveLength(100);
  expect(firstPage.data.hasMoreAuthorizations).toBe(true);
  const second = await app(reader).request(
    `/api/federation/media/packages/${manifest.packageId}?authorizationOffset=100`,
  );
  const secondPage = pageSchema.parse(await second.json());
  expect(secondPage.data.authorizations).toHaveLength(1);
  expect(secondPage.data.hasMoreAuthorizations).toBe(false);
  const ids = [...firstPage.data.authorizations, ...secondPage.data.authorizations].map(
    (item: { authorizationId: string }) => item.authorizationId,
  );
  expect(new Set(ids).size).toBe(101);
  const response = await app(reader).request(
    `/api/federation/media/packages/${manifest.packageId}/import-authorizations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(approval()),
    },
  );
  expect(response.status).toBe(403);
});
