import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditLog,
  createPgDb,
  federationAgreements,
  federationAttestationOutbox,
  federationBudgets,
  federationCertificates,
  federationEvidence,
  federationReservations,
  federationSigningKeys,
  federationSites,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  FederationDelegationSchema,
} from "@kuintessence/shared/federation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminFederationRoutes } from "../routes/admin-federation";
import { FederationAdmission } from "./admission";
import { createFederationIngress } from "./ingress";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Federation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const trust = new FederationTrustRegistry(db);
const actor = crypto.randomUUID();
const sites: string[] = [];
const identity = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
let dir: string;
let certPem: string;
let source: Awaited<ReturnType<typeof testKeys>>;
let target: Awaited<ReturnType<typeof testKeys>>;
let fingerprint: string;
let agreement: ReturnType<typeof testAgreement>;

async function site() {
  const keys = await testKeys();
  sites.push(keys.signing.siteId);
  await trust.addSite(
    {
      id: keys.signing.siteId,
      name: "Test institution",
      endpoint: "https://institution.test.invalid",
    },
    actor,
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
    actor,
  );
  return keys;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kq-trust-check-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "client.key"),
      "-out",
      join(dir, "client.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=Test institution",
      "-addext",
      "basicConstraints=CA:FALSE",
      "-addext",
      "extendedKeyUsage=clientAuth",
    ],
    { stdio: "pipe" },
  );
  certPem = await readFile(join(dir, "client.pem"), "utf8");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "server.key"),
      "-out",
      join(dir, "server.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "basicConstraints=CA:FALSE",
      "-addext",
      "extendedKeyUsage=serverAuth",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "pipe" },
  );
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "ingress-check.fixture.ts")],
    outdir: dir,
    target: "node",
  });
  if (!build.success) throw new Error("Cannot build Node ingress check");
  source = await site();
  target = await site();
  fingerprint = (
    await trust.addCertificate(source.signing.siteId, { certificatePem: certPem }, actor)
  ).fingerprint;
  await db.insert(orgs).values({ id: identity.orgId, name: "Test federation identity" });
  await db.insert(users).values({
    id: identity.userId,
    orgId: identity.orgId,
    email: `${identity.userId}@test.invalid`,
    role: "user",
    serviceAccount: true,
  });
  await db.insert(userOrgMemberships).values({ ...identity, role: "member" });
  agreement = {
    ...testAgreement(source.signing.siteId, target.signing.siteId),
    validFrom: new Date(Date.now() - 86400000).toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(),
  };
  await new FederationAdmission(db, target.signing, target.verification).installApprovedAgreement({
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
  if (agreement) {
    const reservations = db
      .select({ id: federationReservations.id })
      .from(federationReservations)
      .where(eq(federationReservations.agreementRevisionId, agreement.agreementRevisionId));
    const evidence = db
      .select({ id: federationEvidence.id })
      .from(federationEvidence)
      .where(inArray(federationEvidence.reservationId, reservations));
    await db
      .delete(federationAttestationOutbox)
      .where(inArray(federationAttestationOutbox.evidenceId, evidence));
    await db
      .delete(federationEvidence)
      .where(inArray(federationEvidence.reservationId, reservations));
    await db
      .delete(federationReservations)
      .where(eq(federationReservations.agreementRevisionId, agreement.agreementRevisionId));
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
  await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, identity.userId));
  await db.delete(users).where(eq(users.id, identity.userId));
  await db.delete(orgs).where(eq(orgs.id, identity.orgId));
  await db.delete(federationCertificates).where(inArray(federationCertificates.siteId, sites));
  await db.delete(federationSigningKeys).where(inArray(federationSigningKeys.siteId, sites));
  await db.delete(federationSites).where(inArray(federationSites.id, sites));
  await db.delete(auditLog).where(eq(auditLog.actor, actor));
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("certificate binds one institution; unknown, expired and revoked keys fail closed", async () => {
  const key = await trust.resolvePeer(fingerprint, source.signing.keyId, new Date());
  expect(key.siteId).toBe(source.signing.siteId);
  await expect(
    trust.addCertificate(target.signing.siteId, { certificatePem: certPem }, actor),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(trust.resolvePeer("f".repeat(64), source.signing.keyId, new Date())).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await expect(trust.resolvePeer(fingerprint, target.signing.keyId, new Date())).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await expect(
    trust.resolveKey(source.signing.siteId, source.signing.keyId, source.verification.validUntil),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  const temporary = await site();
  await trust.revoke(temporary.signing.siteId, { keyId: temporary.signing.keyId }, actor);
  await expect(
    trust.resolveKey(temporary.signing.siteId, temporary.signing.keyId, new Date()),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  await expect(
    trust.addKey(
      temporary.signing.siteId,
      {
        keyId: temporary.signing.keyId,
        publicKeyPem: await exportSPKI(source.verification.publicKey),
        allowedKinds: ["delegation"],
        validFrom: source.verification.validFrom.toISOString(),
        validUntil: source.verification.validUntil.toISOString(),
      },
      actor,
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("private ingress validates JWS against certificate institution and reserves exactly once", async () => {
  const ingress = createFederationIngress(db, target.signing);
  const request = {
    ...testDelegation(agreement),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const jws = await signFederationMessage(FederationDelegationSchema, request, source.signing);
  const call = (fp: string, body = jws) =>
    ingress.request("/federation/v1/delegations", {
      method: "POST",
      headers: { "content-type": "application/jose", "x-kq-federation-cert": fp },
      body,
    });
  expect((await call("")).status).toBe(401);
  expect(
    (
      await call(
        fingerprint,
        await signFederationMessage(FederationDelegationSchema, request, target.signing),
      )
    ).status,
  ).toBe(401);
  await trust.addKey(
    target.signing.siteId,
    {
      keyId: "approval-only",
      publicKeyPem: await exportSPKI(target.verification.publicKey),
      allowedKinds: ["agreement"],
      validFrom: target.verification.validFrom.toISOString(),
      validUntil: target.verification.validUntil.toISOString(),
    },
    actor,
  );
  const wrongPurpose = createFederationIngress(db, { ...target.signing, keyId: "approval-only" });
  expect(
    (
      await wrongPurpose.request("/federation/v1/delegations", {
        method: "POST",
        headers: { "content-type": "application/jose", "x-kq-federation-cert": fingerprint },
        body: jws,
      })
    ).status,
  ).toBe(401);
  const [before] = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, agreement.budgetDomainId));
  expect(before?.reserved).toBe("0");
  const socketPath = join(dir, "ingress.sock");
  const backend = Bun.serve({ unix: socketPath, fetch: ingress.fetch });
  let receipt: string;
  try {
    const child = Bun.spawn(["node", join(dir, "ingress-check.fixture.js")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(
      JSON.stringify({
        socketPath,
        requestJws: jws,
        clientCert: certPem,
        clientKey: await readFile(join(dir, "client.key"), "utf8"),
        serverCert: await readFile(join(dir, "server.pem"), "utf8"),
        serverKey: await readFile(join(dir, "server.key"), "utf8"),
      }),
    );
    child.stdin.end();
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const response = JSON.parse(out) as { status: number; body: string };
    expect(response.status).toBe(200);
    receipt = response.body;
  } finally {
    await backend.stop(true);
  }
  expect(
    (
      await verifyFederationMessage(
        FederationAcceptanceSchema,
        receipt,
        target.verification,
        new Date(),
      )
    ).payload.status,
  ).toBe("RESERVED");
  expect(await (await call(fingerprint)).text()).toBe(receipt);
  await trust.setState(source.signing.siteId, "suspended", actor);
  expect((await call(fingerprint)).status).toBe(401);
  await trust.setState(source.signing.siteId, "active", actor);
  const [budget] = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, agreement.budgetDomainId));
  expect(budget?.reserved).toBe("60");
});

test("transaction rechecks trust even when caller verified before revocation", async () => {
  const key = await trust.resolvePeer(fingerprint, source.signing.keyId, new Date());
  await trust.revoke(source.signing.siteId, { fingerprint }, actor);
  const request = {
    ...testDelegation(agreement),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAmount: "1",
  };
  await expect(
    new FederationAdmission(db, target.signing, target.verification).receive({
      requestJws: await signFederationMessage(FederationDelegationSchema, request, source.signing),
      senderKey: key,
      authenticatedPeerSiteId: key.siteId,
      authorize: (tx, now) => trust.assertPeer(tx, fingerprint, key.siteId, key.keyId, now),
    }),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  const [budget] = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, agreement.budgetDomainId));
  expect(budget?.reserved).toBe("60");
});

test("site revocation cannot be undone; audit failure rolls trust registration back", async () => {
  const temporary = await site();
  await trust.setState(temporary.signing.siteId, "revoked", actor);
  await expect(trust.setState(temporary.signing.siteId, "active", actor)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  const id = crypto.randomUUID();
  await db.execute(
    sql`CREATE FUNCTION federation_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.trust.site.add' THEN RAISE EXCEPTION 'injected audit fault'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER federation_test_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION federation_test_audit_fail()`,
  );
  try {
    await expect(
      trust.addSite({ id, name: "Must roll back", endpoint: "https://test.invalid" }, actor),
    ).rejects.toThrow();
    expect(await db.select().from(federationSites).where(eq(federationSites.id, id))).toHaveLength(
      0,
    );
  } finally {
    await db.execute(sql`DROP TRIGGER federation_test_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION federation_test_audit_fail()`);
  }
});

test("browser trust routes require bound administrator and never expose peer ingress", async () => {
  function app(role: string, bound = true) {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ level: "silent" })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, { role, userId: bound ? actor : null });
      await next();
    });
    r.route("/api", createAdminFederationRoutes(trust));
    return r;
  }
  for (const role of ["operator", "user", "compute_provider", "guest"]) {
    expect((await app(role).request("/api/admin/federation/sites")).status).toBe(403);
  }
  expect((await app("platform_admin", false).request("/api/admin/federation/sites")).status).toBe(
    403,
  );
  expect((await app("platform_admin").request("/api/admin/federation/sites")).status).toBe(200);
  expect(
    (
      await app("platform_admin").request("/federation/v1/delegations", {
        method: "POST",
        headers: { "x-kq-federation-cert": fingerprint },
      })
    ).status,
  ).toBe(404);
  const invalid = await app("platform_admin").request("/api/admin/federation/sites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      name: "bad",
      endpoint: "https://user:secret@example.invalid",
    }),
  });
  expect(invalid.status).toBe(400);
});
