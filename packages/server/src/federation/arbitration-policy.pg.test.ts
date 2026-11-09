import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialAgreements as contracts,
  createPgDb,
  federationCapabilities,
  federationCertificates,
  federationSigningKeys,
  federationSites,
  orgs,
  federationArbitrationPolicies as policies,
  federationCommercialSubmissions as submissions,
  federationCommercialApprovalSyncs as syncs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { FederationError, type FederationMode } from "@kuintessence/shared/federation";
import {
  CommercialArbitrationPolicyApprovalSchema,
  CommercialArbitrationPolicyListSchema,
  CommercialArbitrationPolicySchema,
} from "@kuintessence/shared/federation/arbitration-policy";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { z } from "zod";
import { createErrorHandler } from "../middleware/error-handler";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { createFederationCommercialRoutes } from "../routes/federation-commercial";
import { FederationArbitrationPolicyService } from "./arbitration-policy";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialApprovalExchange } from "./commercial-approval-exchange";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { createFederationIngress } from "./ingress";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage } from "./signatures";
import { testAgreement, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Arbitration tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const fixtures: { sites: string[]; actors: { orgId: string; userId: string }[] }[] = [];
const permissions = new FederationPermissionService(db);

async function fixture(mode: FederationMode = "bilateral_direct") {
  const [a, b, r] = await Promise.all([testKeys(), testKeys(), testKeys()]);
  const actor = { orgId: randomUUID(), userId: randomUUID() };
  const otherActor = { orgId: randomUUID(), userId: randomUUID() };
  fixtures.push({
    sites: [a.signing.siteId, b.signing.siteId, r.signing.siteId],
    actors: [actor, otherActor],
  });
  for (const member of [actor, otherActor]) {
    await db.insert(orgs).values({ id: member.orgId, name: "Arbitration institution" });
    await db.insert(users).values({
      id: member.userId,
      orgId: member.orgId,
      email: `${member.userId}@test.invalid`,
      role: "platform_admin",
    });
    await db.insert(userOrgMemberships).values({ ...member, role: "owner" });
    for (const capability of ["agreement.approve", "arbitration.approve"] as const)
      await permissions.set({ ...member, capability, enabled: true }, member.userId);
  }
  const trust = new FederationTrustRegistry(db);
  for (const key of [a, b, r]) {
    await trust.addSite(
      { id: key.signing.siteId, name: "Arbitration site", endpoint: "https://test.invalid" },
      actor.userId,
    );
    await trust.addKey(
      key.signing.siteId,
      {
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: ["commercial-agreement", "commercial-arbitration-policy"],
        validFrom: "2020-01-01T00:00:00Z",
        validUntil: "2099-01-01T00:00:00Z",
      },
      actor.userId,
    );
  }
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    agreement: {
      ...testAgreement(a.signing.siteId, b.signing.siteId, mode),
      validFrom: "2020-01-01T00:00:00Z",
      validUntil: "2099-01-01T00:00:00Z",
    },
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [
      { metric: "job.elapsed", quantityUnit: "job-millisecond", perQuantity: "1000", amount: "1" },
    ],
    termsText: "Private contract",
  });
  const revision = terms.agreement.agreementRevisionId;
  const agreementsA = new FederationCommercialAgreementService(db, a.signing);
  const agreementsB = new FederationCommercialAgreementService(db, b.signing);
  const ownContract = await agreementsA.approve(actor, terms),
    peerContract = await agreementsB.approve(otherActor, terms);
  await agreementsA.attachCounterparty(actor, revision, peerContract.approvalJws);
  await agreementsB.attachCounterparty(otherActor, revision, ownContract.approvalJws);
  const service = new FederationArbitrationPolicyService(db, a.signing),
    peer = new FederationArbitrationPolicyService(db, b.signing);
  const input = {
    policyId: randomUUID(),
    arbitratorSiteId: r.signing.siteId,
    disclosures: [{ recordType: "payment" as const, fields: ["amount" as const, "unit" as const] }],
    requiredEvidence: [{ recordType: "payment" as const, fields: ["amount" as const] }],
    subjectTypes: ["payment" as const],
    decisionRule: "designated-arbitrator" as const,
    actions: ["adjust" as const],
    maxChargedAmount: "9007199254740993",
    validUntil: "2098-01-01T00:00:00Z",
  };
  const draft = await service.draft(actor, revision, input);
  const approve = async () => ({
    own: await service.approve(actor, revision, draft),
    other: await peer.approve(otherActor, revision, draft),
  });
  const row = async () => (await service.list(actor, revision, 10, 0, draft.policyId)).data[0];
  const audit = async (action: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.target, draft.policyId)));
  const ledger = () =>
    db
      .select()
      .from(submissions)
      .where(inArray(submissions.localSiteId, [a.signing.siteId, b.signing.siteId]))
      .orderBy(submissions.id);
  return {
    a,
    b,
    r,
    actor,
    otherActor,
    trust,
    terms,
    revision,
    agreementsA,
    service,
    peer,
    input,
    draft,
    approve,
    row,
    audit,
    ledger,
  };
}

afterAll(async () => {
  for (const f of fixtures.reverse()) {
    await db.delete(syncs).where(inArray(syncs.localSiteId, f.sites));
    await db.delete(federationCertificates).where(inArray(federationCertificates.siteId, f.sites));
    await db.delete(policies).where(inArray(policies.localSiteId, f.sites));
    await db.delete(submissions).where(inArray(submissions.localSiteId, f.sites));
    await db.delete(contracts).where(inArray(contracts.localSiteId, f.sites));
    await db.delete(federationSigningKeys).where(inArray(federationSigningKeys.siteId, f.sites));
    await db.delete(federationSites).where(inArray(federationSites.id, f.sites));
    for (const actor of f.actors) {
      await db
        .delete(auditLog)
        .where(or(eq(auditLog.actor, actor.userId), eq(auditLog.orgId, actor.orgId)));
      await db.delete(federationCapabilities).where(eq(federationCapabilities.orgId, actor.orgId));
      await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, actor.orgId));
      await db.delete(users).where(eq(users.id, actor.userId));
      await db.delete(orgs).where(eq(orgs.id, actor.orgId));
    }
  }
  await db.$client.end();
});

test("arbitration policies persist independent approvals in all modes without additional ledger work", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested", "ledger_coordinated"] as const) {
    const f = await fixture(mode),
      before = await f.ledger();
    expect((await f.service.list(f.actor, f.revision)).data).toHaveLength(0);
    const { own, other } = await f.approve();
    expect(own.confirmedAt).toBeNull();
    expect(own.counterpartyJws).toBeNull();
    expect(other.digest).toBe(own.digest);
    const confirmed = await f.service.attachCounterparty(
      f.actor,
      f.revision,
      f.draft.policyId,
      other.approvalJws,
    );
    await f.peer.attachCounterparty(f.otherActor, f.revision, f.draft.policyId, own.approvalJws);
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.approvalJws).toBe(own.approvalJws);
    expect(await f.service.approve(f.actor, f.revision, f.draft)).toEqual(confirmed);
    expect(
      await f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, other.approvalJws),
    ).toEqual(confirmed);
    const restarted = new FederationArbitrationPolicyService(db, f.a.signing);
    expect((await restarted.list(f.actor, f.revision, 1, 0, f.draft.policyId)).data).toEqual([
      confirmed,
    ]);
    expect(await f.ledger()).toEqual(before);
    expect(await f.audit("federation.arbitration_policy.confirm")).toHaveLength(2);
  }
});

test("policy approval requires independent capability, current arbitrator trust and explicit signing purpose", async () => {
  const f = await fixture();
  await permissions.set(
    { ...f.actor, capability: "arbitration.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.service.approve(f.actor, f.revision, f.draft)).rejects.toThrow("POLICY_DENIED");
  await permissions.set(
    { ...f.actor, capability: "arbitration.approve", enabled: true },
    f.actor.userId,
  );
  await expect(f.service.approve(f.otherActor, f.revision, f.draft)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement"] })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await expect(f.service.approve(f.actor, f.revision, f.draft)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement", "commercial-arbitration-policy"] })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await db
    .update(federationSites)
    .set({ state: "suspended" })
    .where(eq(federationSites.id, f.r.signing.siteId));
  await expect(f.service.approve(f.actor, f.revision, f.draft)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  expect(await f.row()).toBeUndefined();
});

test("concurrent policy identities cannot approve competing bodies or duplicate an audit", async () => {
  const f = await fixture();
  const changed = CommercialArbitrationPolicySchema.parse({
    ...f.draft,
    disclosures: [{ recordType: "payment", fields: ["amount", "unit", "reason"] }],
  });
  const results = await Promise.allSettled([
    f.service.approve(f.actor, f.revision, f.draft),
    f.service.approve(f.actor, f.revision, changed),
  ]);
  expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((v) => v.status === "rejected")).toHaveLength(1);
  const row = await f.row();
  if (!row) throw new Error("Missing winner");
  expect(await f.service.approve(f.actor, f.revision, row.payload)).toEqual(row);
  expect(await f.audit("federation.arbitration_policy.approve")).toHaveLength(1);
});

test("revocation survives countersignature races and replay, including when signing trust is unavailable", async () => {
  const f = await fixture(),
    both = await f.approve();
  await Promise.allSettled([
    f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, both.other.approvalJws),
    f.service.revoke(f.actor, f.revision, f.draft.policyId),
  ]);
  const revoked = await f.row();
  if (!revoked) throw new Error("Missing revoked policy");
  expect(revoked.revokedAt).not.toBeNull();
  expect(revoked.approvalJws).toBe(both.own.approvalJws);
  await expect(f.service.approve(f.actor, f.revision, f.draft)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  await expect(
    f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, both.other.approvalJws),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect(await f.service.revoke(f.actor, f.revision, f.draft.policyId)).toEqual(revoked);
  expect(await f.audit("federation.arbitration_policy.revoke")).toHaveLength(1);
  const second = await f.service.draft(f.actor, f.revision, { ...f.input, policyId: randomUUID() });
  await f.service.approve(f.actor, f.revision, second);
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: new Date() })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await db
    .update(federationSites)
    .set({ state: "suspended" })
    .where(eq(federationSites.id, f.r.signing.siteId));
  expect((await f.service.revoke(f.actor, f.revision, second.policyId)).revokedAt).not.toBeNull();
  expect((await f.service.list(f.actor, f.revision)).data).toHaveLength(2);
});

test("audit failure rolls back approval, confirmation and revocation with the original signatures intact", async () => {
  const f = await fixture();
  const other = await f.peer.approve(f.otherActor, f.revision, f.draft);
  const constraints = {
    approve: sql`alter table audit_log add constraint test_arbitration_audit_failure check (action <> 'federation.arbitration_policy.approve') NOT VALID`,
    confirm: sql`alter table audit_log add constraint test_arbitration_audit_failure check (action <> 'federation.arbitration_policy.confirm') NOT VALID`,
    revoke: sql`alter table audit_log add constraint test_arbitration_audit_failure check (action <> 'federation.arbitration_policy.revoke') NOT VALID`,
  };
  for (const action of ["approve", "confirm", "revoke"] as const) {
    await db.execute(constraints[action]);
    try {
      if (action === "approve") {
        await expect(f.service.approve(f.actor, f.revision, f.draft)).rejects.toThrow();
        expect(await f.row()).toBeUndefined();
      } else if (action === "confirm") {
        await expect(
          f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, other.approvalJws),
        ).rejects.toThrow();
        expect((await f.row())?.counterpartyJws).toBeNull();
      } else {
        await expect(f.service.revoke(f.actor, f.revision, f.draft.policyId)).rejects.toThrow();
        expect((await f.row())?.revokedAt).toBeNull();
      }
    } finally {
      await db.execute(sql`alter table audit_log drop constraint test_arbitration_audit_failure`);
    }
    if (action === "approve") await f.service.approve(f.actor, f.revision, f.draft);
    else if (action === "confirm")
      await f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, other.approvalJws);
    else await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  }
  expect((await f.row())?.counterpartyJws).toBe(other.approvalJws);
});

test("policy references, countersignatures and database state constraints reject inconsistent originals", async () => {
  const f = await fixture();
  for (const patch of [
    { domainId: randomUUID() },
    { unit: "wrong-unit" },
    { agreementDigest: `sha256:${"e".repeat(64)}` },
    { agreementRevisionId: randomUUID() },
  ])
    await expect(f.service.approve(f.actor, f.revision, { ...f.draft, ...patch })).rejects.toThrow(
      "POLICY_DENIED",
    );
  const own = await f.service.approve(f.actor, f.revision, f.draft);
  const wrong = await signFederationMessage(
    CommercialArbitrationPolicySchema,
    f.draft,
    f.r.signing,
  );
  await expect(
    f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, wrong),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  const otherBody = await signFederationMessage(
    CommercialArbitrationPolicySchema,
    { ...f.draft, salt: "f".repeat(64) },
    f.b.signing,
  );
  await expect(
    f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, otherBody),
  ).rejects.toThrow("OPERATION_CONFLICT");
  for (const patch of [
    { confirmedAt: new Date() },
    { revokedAt: new Date() },
    { arbitratorSiteId: f.a.signing.siteId },
  ])
    await expect(
      Promise.resolve(
        db.update(policies).set(patch).where(eq(policies.policyId, f.draft.policyId)),
      ),
    ).rejects.toThrow();
  expect(await f.row()).toEqual(own);
});

test("policy HTTP uses human organization scope, no-store, exact original lookup and strict draft input", async () => {
  const f = await fixture();
  const dependencies: Parameters<typeof createFederationCommercialRoutes> = [
    f.agreementsA,
    new FederationCommercialSubmissionService(db, f.a.signing.siteId),
  ];
  dependencies[27] = f.service;
  let automation = false,
    actor = f.actor;
  const app = new Hono<{ Variables: { principal: BoundPrincipal; automation: boolean } }>();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal", {
      ...actor,
      sub: actor.userId,
      role: "platform_admin",
      email: "test@example.invalid",
      orgIds: [actor.orgId],
      memberships: [{ orgId: actor.orgId, role: "owner" }],
      capabilities: [],
    });
    c.set("automation", automation);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...dependencies));
  const path = `/federation/commercial-agreements/${f.revision}/arbitration-policies`;
  const post = (suffix: string, body: unknown) =>
    app.request(path + suffix, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (
      await post("/draft", {
        ...f.input,
        disclosures: [{ recordType: "payment", fields: ["amount", "amount"] }],
      })
    ).status,
  ).toBe(400);
  expect((await post("/draft", { ...f.input, debitAmount: "1" })).status).toBe(400);
  const approved = await post("/approve", f.draft);
  expect(approved.status).toBe(200);
  expect(approved.headers.get("cache-control")).toBe("no-store");
  z.object({ data: CommercialArbitrationPolicyApprovalSchema }).parse(await approved.json());
  const listed = await app.request(`${path}?policyId=${f.draft.policyId}`);
  const result = z
    .object({ data: CommercialArbitrationPolicyListSchema })
    .parse(await listed.json());
  expect(result.data.data).toHaveLength(1);
  expect((await post(`/${f.draft.policyId}/revoke`, {})).status).toBe(200);
  actor = f.otherActor;
  expect((await app.request(path)).status).toBe(409);
  automation = true;
  expect((await app.request(path)).status).toBe(403);
});

async function exchangeFixture() {
  const f = await fixture();
  const fingerprint = randomBytes(32).toString("hex");
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: f.a.signing.siteId,
    certificatePem: "isolated verified-fingerprint fixture, not a TLS handshake",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-approval-query","commercial-approval-waiting"]'::jsonb`,
    })
    .where(inArray(federationSigningKeys.siteId, [f.a.signing.siteId, f.b.signing.siteId]));
  const receiver = new FederationCommercialApprovalExchange(db, f.b.signing);
  const deliver: FederationSend = async (endpoint, jws, path) => {
    expect(endpoint).toBe("https://test.invalid");
    expect(path).toBe("/federation/v1/commercial-approvals");
    return receiver.receive(jws, fingerprint);
  };
  const key = and(
    eq(syncs.localSiteId, f.a.signing.siteId),
    eq(syncs.recordKind, "arbitration-policy"),
    eq(syncs.recordId, f.draft.policyId),
  );
  const queue = async () => (await db.select().from(syncs).where(key))[0];
  const due = () =>
    db
      .update(syncs)
      .set({ nextAttemptAt: new Date(0) })
      .where(key);
  return {
    ...f,
    fingerprint,
    deliver,
    key,
    queue,
    due,
    worker: (send = deliver) => new FederationCommercialApprovalExchange(db, f.a.signing, send),
  };
}

test("arbitration exchange production ingress requires the registered peer and returns only the approved policy", async () => {
  const f = await exchangeFixture();
  const { other } = await f.approve();
  const ingress = createFederationIngress(db, f.b.signing);
  const worker = f.worker(async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/commercial-approvals");
    const request = (fingerprint?: string) =>
      ingress.request("/federation/v1/commercial-approvals", {
        method: "POST",
        body: jws,
        headers: {
          "content-type": "application/jose",
          ...(fingerprint ? { "x-kq-federation-cert": fingerprint } : {}),
        },
      });
    expect((await request()).status).toBe(401);
    expect((await request(randomBytes(32).toString("hex"))).status).toBe(401);
    const response = await request(f.fingerprint);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const original = await response.text();
    expect(original).toBe(other.approvalJws);
    return original;
  });
  await worker.discover();
  await worker.advanceNext();
  expect((await f.queue())?.state).toBe("complete");
});

test("verified arbitration consent requires both signatures, an active window and no revocation", async () => {
  const f = await fixture();
  const { other } = await f.approve();
  const verify = () =>
    db.transaction((tx) => f.service.verified(tx, f.actor, f.revision, f.draft.policyId));
  await expect(verify()).rejects.toThrow("POLICY_DENIED");
  await f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, other.approvalJws);
  expect((await verify()).row.payload.unit).toBe(f.terms.agreement.unit);
  await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  await expect(verify()).rejects.toThrow("AUTHORIZATION_EXPIRED");
  const future = {
    ...f.draft,
    policyId: randomUUID(),
    validFrom: new Date(Date.now() + 60_000).toISOString(),
  };
  await f.service.approve(f.actor, f.revision, future);
  const peer = await f.peer.approve(f.otherActor, f.revision, future);
  await f.service.attachCounterparty(f.actor, f.revision, future.policyId, peer.approvalJws);
  await expect(
    db.transaction((tx) => f.service.verified(tx, f.actor, f.revision, future.policyId)),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("arbitration exchange waits for the peer's human approval and recovers lost responses using original signatures", async () => {
  const f = await exchangeFixture();
  const before = await f.ledger();
  const own = await f.service.approve(f.actor, f.revision, f.draft);
  let worker = f.worker();
  await worker.discover();
  await worker.advanceNext();
  expect((await f.queue())?.state).toBe("pending");
  expect((await f.peer.list(f.otherActor, f.revision)).data).toHaveLength(0);
  const other = await f.peer.approve(f.otherActor, f.revision, f.draft);
  await f.due();
  worker = f.worker(async (...args) => {
    await f.deliver(...args);
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  });
  await worker.advanceNext();
  expect((await f.row())?.counterpartyJws).toBeNull();
  expect((await f.queue())?.lastError).toBe("DELIVERY_UNAVAILABLE");
  await f.due();
  await f.worker().advanceNext();
  const saved = await f.row();
  expect(saved?.approvalJws).toBe(own.approvalJws);
  expect(saved?.counterpartyJws).toBe(other.approvalJws);
  expect((await f.queue())?.state).toBe("complete");
  await f.worker().discover();
  expect(await f.worker().advanceNext()).toBe(false);
  expect(await f.audit("federation.arbitration_policy.confirm")).toHaveLength(1);
  expect(await f.ledger()).toEqual(before);
});

test("arbitration exchange rejects a late response after local revocation and requires independent retry authority", async () => {
  const f = await exchangeFixture();
  await f.approve();
  const worker = f.worker(async (...args) => {
    const reply = await f.deliver(...args);
    await f.service.revoke(f.actor, f.revision, f.draft.policyId);
    return reply;
  });
  await worker.discover();
  await worker.advanceNext();
  expect((await f.queue())?.state).toBe("needs_review");
  expect((await f.queue())?.lastError).toBe("AUTHORIZATION_EXPIRED");
  expect((await f.row())?.counterpartyJws).toBeNull();
  await permissions.set(
    { ...f.actor, capability: "arbitration.approve", enabled: false },
    f.actor.userId,
  );
  await expect(
    worker.retry(f.actor, {
      agreementRevisionId: f.revision,
      recordKind: "arbitration-policy",
      recordId: f.draft.policyId,
    }),
  ).rejects.toThrow("POLICY_DENIED");
  expect(await f.audit("federation.arbitration_policy.confirm")).toHaveLength(0);
});

test("arbitration exchange audit failure rolls back both countersignature and queue completion", async () => {
  const f = await exchangeFixture();
  const { other } = await f.approve();
  const worker = f.worker();
  await worker.discover();
  await db.execute(
    sql`alter table audit_log add constraint test_arbitration_exchange_audit check (action <> 'federation.arbitration_policy.confirm') NOT VALID`,
  );
  try {
    await worker.advanceNext();
    expect((await f.row())?.counterpartyJws).toBeNull();
    expect((await f.queue())?.state).toBe("pending");
    expect((await f.queue())?.verifiedAt).toBeNull();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_arbitration_exchange_audit`);
  }
  await f.due();
  await f.worker().advanceNext();
  expect((await f.row())?.counterpartyJws).toBe(other.approvalJws);
  expect((await f.queue())?.state).toBe("complete");
});

test("arbitration approval rechecks expiry after a real policy identity lock wait", async () => {
  const f = await fixture();
  const value = { ...f.draft, validUntil: new Date(Date.now() + 800).toISOString() };
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const lock = db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`arbitration-policy:${f.a.signing.siteId}:${value.policyId}`}, 0))`,
    );
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const pending = f.service.approve(f.actor, f.revision, value).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const rows = await db.execute(
        sql`select 1 from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    await Bun.sleep(Math.max(1, Date.parse(value.validUntil) - Date.now() + 20));
  } finally {
    release.resolve();
    await lock;
  }
  const result = await pending;
  expect(result).toBeInstanceOf(FederationError);
  expect((result as FederationError).code).toBe("AUTHORIZATION_EXPIRED");
  expect(await f.row()).toBeUndefined();
  expect(await f.audit("federation.arbitration_policy.approve")).toHaveLength(0);
});
