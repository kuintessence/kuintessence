import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialAgreements as contracts,
  createPgDb,
  federationCapabilities,
  federationSigningKeys,
  federationSites,
  orgs,
  federationDisclosurePolicies as policies,
  federationCommercialSubmissions as submissions,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import type { FederationMode } from "@kuintessence/shared/federation";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisclosurePolicyApprovalSchema,
  CommercialDisclosurePolicyListSchema,
  CommercialDisclosurePolicySchema,
} from "@kuintessence/shared/federation/disclosure-authorization";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { z } from "zod";
import { createErrorHandler } from "../middleware/error-handler";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { createFederationCommercialRoutes } from "../routes/federation-commercial";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationDisclosurePolicyService } from "./disclosure-policy";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage } from "./signatures";
import { testAgreement, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Disclosure tests require an isolated kuintessence_unit_* DATABASE_URL");
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
    await db.insert(orgs).values({ id: member.orgId, name: "Disclosure institution" });
    await db.insert(users).values({
      id: member.userId,
      orgId: member.orgId,
      email: `${member.userId}@test.invalid`,
      role: "platform_admin",
    });
    await db.insert(userOrgMemberships).values({ ...member, role: "owner" });
    for (const capability of ["agreement.approve", "disclosure.approve"] as const)
      await permissions.set({ ...member, capability, enabled: true }, member.userId);
  }
  const trust = new FederationTrustRegistry(db);
  for (const key of [a, b, r]) {
    await trust.addSite(
      { id: key.signing.siteId, name: "Disclosure site", endpoint: "https://test.invalid" },
      actor.userId,
    );
    await trust.addKey(
      key.signing.siteId,
      {
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: ["commercial-agreement", "commercial-disclosure-policy"],
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
  const service = new FederationDisclosurePolicyService(db, a.signing),
    peer = new FederationDisclosurePolicyService(db, b.signing);
  const input = {
    policyId: randomUUID(),
    recipientSiteId: r.signing.siteId,
    disclosures: [{ recordType: "payment" as const, fields: ["amount" as const] }],
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
    await db.delete(policies).where(inArray(policies.localSiteId, f.sites));
    await db.delete(submissions).where(inArray(submissions.localSiteId, f.sites));
    await db.delete(contracts).where(inArray(contracts.localSiteId, f.sites));
    await db.delete(federationSigningKeys).where(inArray(federationSigningKeys.siteId, f.sites));
    await db.delete(federationSites).where(inArray(federationSites.id, f.sites));
    for (const actor of f.actors) {
      await db.delete(auditLog).where(eq(auditLog.actor, actor.userId));
      await db.delete(federationCapabilities).where(eq(federationCapabilities.orgId, actor.orgId));
      await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, actor.orgId));
      await db.delete(users).where(eq(users.id, actor.userId));
      await db.delete(orgs).where(eq(orgs.id, actor.orgId));
    }
  }
  await db.$client.end();
});

test("disclosure policies persist independent approvals in all modes without additional ledger work", async () => {
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
    const restarted = new FederationDisclosurePolicyService(db, f.a.signing);
    expect((await restarted.list(f.actor, f.revision, 1, 0, f.draft.policyId)).data).toEqual([
      confirmed,
    ]);
    expect(await f.ledger()).toEqual(before);
    expect(await f.audit("federation.disclosure_policy.confirm")).toHaveLength(2);
  }
});

test("policy approval requires independent capability, current recipient trust and explicit signing purpose", async () => {
  const f = await fixture();
  await permissions.set(
    { ...f.actor, capability: "disclosure.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.service.approve(f.actor, f.revision, f.draft)).rejects.toThrow("POLICY_DENIED");
  await permissions.set(
    { ...f.actor, capability: "disclosure.approve", enabled: true },
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
    .set({ allowedKinds: ["commercial-agreement", "commercial-disclosure-policy"] })
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
  const changed = CommercialDisclosurePolicySchema.parse({
    ...f.draft,
    disclosures: [{ recordType: "payment", fields: ["unit"] }],
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
  expect(await f.audit("federation.disclosure_policy.approve")).toHaveLength(1);
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
  expect(await f.audit("federation.disclosure_policy.revoke")).toHaveLength(1);
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
    approve: sql`alter table audit_log add constraint test_disclosure_audit_failure check (action <> 'federation.disclosure_policy.approve') NOT VALID`,
    confirm: sql`alter table audit_log add constraint test_disclosure_audit_failure check (action <> 'federation.disclosure_policy.confirm') NOT VALID`,
    revoke: sql`alter table audit_log add constraint test_disclosure_audit_failure check (action <> 'federation.disclosure_policy.revoke') NOT VALID`,
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
      await db.execute(sql`alter table audit_log drop constraint test_disclosure_audit_failure`);
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
    { agreementDigest: `sha256:${"e".repeat(64)}` },
    { agreementRevisionId: randomUUID() },
  ])
    await expect(f.service.approve(f.actor, f.revision, { ...f.draft, ...patch })).rejects.toThrow(
      "POLICY_DENIED",
    );
  const own = await f.service.approve(f.actor, f.revision, f.draft);
  const wrong = await signFederationMessage(CommercialDisclosurePolicySchema, f.draft, f.r.signing);
  await expect(
    f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, wrong),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  const otherBody = await signFederationMessage(
    CommercialDisclosurePolicySchema,
    { ...f.draft, salt: "f".repeat(64) },
    f.b.signing,
  );
  await expect(
    f.service.attachCounterparty(f.actor, f.revision, f.draft.policyId, otherBody),
  ).rejects.toThrow("OPERATION_CONFLICT");
  for (const patch of [
    { confirmedAt: new Date() },
    { revokedAt: new Date() },
    { recipientSiteId: f.a.signing.siteId },
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
  dependencies[22] = f.service;
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
  const path = `/federation/commercial-agreements/${f.revision}/disclosure-policies`;
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
  z.object({ data: CommercialDisclosurePolicyApprovalSchema }).parse(await approved.json());
  const listed = await app.request(`${path}?policyId=${f.draft.policyId}`);
  const result = z
    .object({ data: CommercialDisclosurePolicyListSchema })
    .parse(await listed.json());
  expect(result.data.data).toHaveLength(1);
  expect((await post(`/${f.draft.policyId}/revoke`, {})).status).toBe(200);
  actor = f.otherActor;
  expect((await app.request(path)).status).toBe(409);
  automation = true;
  expect((await app.request(path)).status).toBe(403);
});
