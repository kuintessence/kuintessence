import { afterAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  federationCommercialAttempts as attempts,
  auditLog,
  federationCommercialAgreements as contracts,
  createPgDb,
  federationArbitrationRevocationDeliveries as deliveries,
  federationCapabilities,
  federationCertificates,
  federationSigningKeys,
  federationSites,
  federationArbitrationRevocationNotices as notices,
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
import { CommercialArbitrationRevocationSchema } from "@kuintessence/shared/federation/arbitration-revocation";
import {
  ArbitrationRevocationNoticeSchema,
  ArbitrationRevocationReceiptSchema,
} from "@kuintessence/shared/federation/arbitration-revocation-notice";
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
import { FederationArbitrationRevocationDelivery } from "./arbitration-revocations";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialApprovalExchange } from "./commercial-approval-exchange";
import type { CommercialClient } from "./commercial-client";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationCommercialWorker } from "./commercial-worker";
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
    await db
      .delete(attempts)
      .where(
        inArray(
          attempts.submissionId,
          db
            .select({ id: submissions.id })
            .from(submissions)
            .where(inArray(submissions.localSiteId, f.sites)),
        ),
      );
    await db.delete(deliveries).where(inArray(deliveries.localSiteId, f.sites));
    await db.delete(notices).where(inArray(notices.localSiteId, f.sites));
    await db.delete(auditLog).where(
      inArray(
        auditLog.actor,
        f.sites.map((id) => `arbitration-revocation:${id}`),
      ),
    );
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

test("arbitration native withdrawal queues one signed intent and recovers its original transaction", async () => {
  for (const mode of ["bilateral_attested", "ledger_coordinated"] as const) {
    const f = await fixture(mode);
    await f.approve();
    const prepared: string[] = [];
    const client: CommercialClient = {
      async prepare(input) {
        prepared.push(input.operation);
        const transactionId = randomBytes(32).toString("hex");
        return {
          transactionId,
          recovery: Buffer.from(`proposal:${transactionId}`).toString("base64"),
        };
      },
      async advance(recovery) {
        const [stage, transactionId] = Buffer.from(recovery, "base64").toString().split(":");
        if (!transactionId) throw new Error("Missing fixture transaction");
        return stage === "proposal"
          ? {
              state: "prepared",
              transactionId,
              recovery: Buffer.from(`transaction:${transactionId}`).toString("base64"),
            }
          : { state: "committed", transactionId, blockNumber: "9" };
      },
    };
    let worker = new FederationCommercialSubmissionService(db, f.a.signing.siteId, client);
    for (let step = 0; step < 3; step++) expect(await worker.advanceNext()).toBe(true);
    await expect(f.service.submitRevocation(f.actor, f.revision, f.draft.policyId)).rejects.toThrow(
      "POLICY_DENIED",
    );
    await f.service.revoke(f.actor, f.revision, f.draft.policyId);
    await expect(f.service.submitRevocation(f.actor, f.revision, f.draft.policyId)).rejects.toThrow(
      "UNTRUSTED_IDENTITY",
    );
    expect((await f.row())?.revokedAt).not.toBeNull();
    await db
      .update(federationSigningKeys)
      .set({ allowedKinds: ["commercial-arbitration-revocation"] })
      .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
    const values = await Promise.all(
      Array.from({ length: 3 }, () =>
        f.service.submitRevocation(f.actor, f.revision, f.draft.policyId),
      ),
    );
    expect(new Set(values.map((value) => value.id)).size).toBe(1);
    const id = values[0]?.id;
    if (!id) throw new Error("Missing withdrawal submission");
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, id));
    if (submission?.input.operation !== "revoke-arbitration-policy")
      throw new Error("Missing withdrawal input");
    const payload = CommercialArbitrationRevocationSchema.parse(
      JSON.parse(
        Buffer.from(
          submission.input.envelope.revocationJws.split(".")[1] ?? "",
          "base64url",
        ).toString(),
      ),
    );
    const policy = await f.row();
    if (!policy) throw new Error("Missing original policy");
    expect(payload.policyDigest).toBe(policy.digest);
    expect(payload.issuerSiteId).toBe(f.a.signing.siteId);
    for (let step = 0; step < 2; step++) expect(await worker.advanceNext()).toBe(true);
    const [before] = await db.select().from(attempts).where(eq(attempts.submissionId, id));
    expect(before?.stage).toBe("transaction");
    worker = new FederationCommercialSubmissionService(db, f.a.signing.siteId, client);
    expect(await worker.advanceNext()).toBe(true);
    const [after] = await db.select().from(attempts).where(eq(attempts.submissionId, id));
    if (!before || !after) throw new Error("Missing persisted withdrawal attempts");
    expect(after.transactionId).toBe(before.transactionId);
    expect(after?.stage).toBe("committed");
    expect(await f.service.submitRevocation(f.actor, f.revision, f.draft.policyId)).toEqual({
      id,
      state: "committed",
    });
    expect(prepared).toEqual(["register-agreement", "revoke-arbitration-policy"]);
    expect(await f.audit("federation.arbitration_policy.ledger_revocation")).toHaveLength(1);
  }
});

test("arbitration native withdrawal preserves local refusal and rejects direct mode, foreign scope and ungranted signing", async () => {
  const direct = await fixture();
  await direct.approve();
  await direct.service.revoke(direct.actor, direct.revision, direct.draft.policyId);
  await expect(
    direct.service.submitRevocation(direct.actor, direct.revision, direct.draft.policyId),
  ).rejects.toThrow("POLICY_DENIED");
  const f = await fixture("ledger_coordinated");
  await f.approve();
  await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-arbitration-revocation"] })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await expect(
    f.service.submitRevocation(f.otherActor, f.revision, f.draft.policyId),
  ).rejects.toThrow("AGREEMENT_UNAVAILABLE");
  await db.execute(
    sql`alter table audit_log add constraint test_arbitration_withdrawal_audit check (action <> 'federation.arbitration_policy.ledger_revocation') NOT VALID`,
  );
  const before = await f.ledger();
  try {
    await expect(
      f.service.submitRevocation(f.actor, f.revision, f.draft.policyId),
    ).rejects.toThrow();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_arbitration_withdrawal_audit`);
  }
  expect(await f.ledger()).toEqual(before);
  const queued = await f.service.submitRevocation(f.actor, f.revision, f.draft.policyId);
  await db.update(submissions).set({ state: "needs_review" }).where(eq(submissions.id, queued.id));
  const worker = new FederationCommercialSubmissionService(db, f.a.signing.siteId);
  await permissions.set(
    { ...f.actor, capability: "arbitration.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.service.submitRevocation(f.actor, f.revision, f.draft.policyId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(worker.retry(f.actor, f.revision, queued.id)).rejects.toThrow("POLICY_DENIED");
  await permissions.set(
    { ...f.actor, capability: "arbitration.approve", enabled: true },
    f.actor.userId,
  );
  await worker.retry(f.actor, f.revision, queued.id);
  expect((await db.select().from(submissions).where(eq(submissions.id, queued.id)))[0]?.state).toBe(
    "pending",
  );
  expect((await f.row())?.revokedAt).not.toBeNull();
});

test("arbitration native withdrawal HTTP requires a human, exact scope and empty intent", async () => {
  const f = await fixture("bilateral_attested");
  await f.approve();
  await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-arbitration-revocation"] })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  const dependencies: Parameters<typeof createFederationCommercialRoutes> = [
    f.agreementsA,
    new FederationCommercialSubmissionService(db, f.a.signing.siteId),
  ];
  dependencies[27] = f.service;
  let automation = false;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, { ...f.actor, role: "platform_admin" } as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...dependencies));
  const path = `/federation/commercial-agreements/${f.revision}/arbitration-policies/${f.draft.policyId}/ledger-revocation`;
  const post = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  automation = true;
  expect((await post({})).status).toBe(403);
  automation = false;
  expect((await post({ amount: "1" })).status).toBe(400);
  const response = await post({});
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).not.toContain("revocationJws");
  expect(body).not.toContain("recovery");
  expect(await (await post({})).text()).toBe(body);
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

async function withdrawalFixture(mode: FederationMode = "bilateral_direct") {
  const f = await fixture(mode);
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
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-arbitration-revocation","arbitration-revocation-notice","arbitration-revocation-receipt"]'::jsonb`,
    })
    .where(
      inArray(federationSigningKeys.siteId, [
        f.a.signing.siteId,
        f.b.signing.siteId,
        f.r.signing.siteId,
      ]),
    );
  const receivers = new Map(
    [f.b, f.r].map((k) => [
      k.signing.siteId,
      new FederationArbitrationRevocationDelivery(
        db,
        k.signing,
        new FederationArbitrationPolicyService(db, k.signing),
      ),
    ]),
  );
  const deliver: FederationSend = async (endpoint, jws, path) => {
    expect(endpoint).toBe("https://test.invalid");
    expect(path).toBe("/federation/v1/arbitration-revocations");
    const value = ArbitrationRevocationNoticeSchema.parse(
      JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString()),
    );
    const receiver = receivers.get(value.receivingSiteId);
    if (!receiver) throw new Error("Unexpected recipient");
    return receiver.receive(jws, fingerprint);
  };
  const key = and(
    eq(deliveries.localSiteId, f.a.signing.siteId),
    eq(deliveries.policyId, f.draft.policyId),
  );
  const rows = () => db.select().from(deliveries).where(key).orderBy(deliveries.receivingSiteId);
  const due = () =>
    db
      .update(deliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(key);
  return {
    ...f,
    fingerprint,
    receivers,
    deliver,
    key,
    rows,
    due,
    worker: (send = deliver) =>
      new FederationArbitrationRevocationDelivery(db, f.a.signing, f.service, send),
  };
}

async function signedWithdrawalNotice(
  f: Awaited<ReturnType<typeof withdrawalFixture>>,
  policy = f.draft,
) {
  const policyJws = await signFederationMessage(
    CommercialArbitrationPolicySchema,
    policy,
    f.a.signing,
  );
  const policyDigest = `sha256:${createHash("sha256")
    .update(Buffer.from(policyJws.split(".")[1] ?? "", "base64url"))
    .digest("hex")}`;
  const revocation = CommercialArbitrationRevocationSchema.parse({
    protocolVersion: 1,
    kind: "commercial-arbitration-revocation",
    revocationId: randomUUID(),
    policyId: policy.policyId,
    policyDigest,
    domainId: policy.domainId,
    agreementRevisionId: policy.agreementRevisionId,
    agreementDigest: policy.agreementDigest,
    sourceSiteId: policy.sourceSiteId,
    targetSiteId: policy.targetSiteId,
    issuerSiteId: f.a.signing.siteId,
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const value = ArbitrationRevocationNoticeSchema.parse({
    protocolVersion: 1,
    kind: "arbitration-revocation-notice",
    noticeId: randomUUID(),
    issuerSiteId: f.a.signing.siteId,
    receivingSiteId: f.b.signing.siteId,
    policy,
    policyJws,
    revocationJws: await signFederationMessage(
      CommercialArbitrationRevocationSchema,
      revocation,
      f.a.signing,
    ),
    issuedAt: new Date().toISOString(),
  });
  return {
    value,
    jws: await signFederationMessage(ArbitrationRevocationNoticeSchema, value, f.a.signing),
  };
}

test("arbitration notification worker reaches both peer and R without contract disclosure or a ledger", async () => {
  const f = await withdrawalFixture();
  const { own } = await f.approve();
  await f.peer.attachCounterparty(f.otherActor, f.revision, f.draft.policyId, own.approvalJws);
  await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  // The original policy purpose may be removed without disabling its independent withdrawal.
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: [
        "commercial-agreement",
        "commercial-arbitration-revocation",
        "arbitration-revocation-notice",
      ],
    })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  const args: ConstructorParameters<typeof FederationCommercialWorker> = [
    new FederationCommercialSubmissionService(db, f.a.signing.siteId),
  ];
  args[19] = f.worker();
  const worker = new FederationCommercialWorker(...args);
  await worker.tick();
  await worker.stop();
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.state === "received")).toBe(true);
  expect(rows[0]?.payload?.revocationJws).toBe(rows[1]?.payload?.revocationJws);
  expect(JSON.stringify(rows)).not.toContain("Private contract");
  expect(
    await db.select().from(contracts).where(eq(contracts.localSiteId, f.r.signing.siteId)),
  ).toHaveLength(0);
  await expect(
    db.transaction((tx) =>
      f.peer.exchangeRecord(tx, f.otherActor.orgId, f.revision, f.draft.policyId),
    ),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  await expect(
    f.peer.attachCounterparty(f.otherActor, f.revision, f.draft.policyId, own.approvalJws),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect((await f.peer.list(f.otherActor, f.revision)).data[0]?.approvalJws).toBeDefined();
});

test("arbitration notification arriving before approval fences only its exact policy digest", async () => {
  const f = await withdrawalFixture();
  const receiver = f.receivers.get(f.b.signing.siteId);
  if (!receiver) throw new Error("Missing receiver");
  const different = await signedWithdrawalNotice(f, {
    ...f.draft,
    salt: randomBytes(32).toString("hex"),
  });
  await receiver.receive(different.jws, f.fingerprint);
  const approved = await f.peer.approve(f.otherActor, f.revision, f.draft);
  expect(approved.policyId).toBe(f.draft.policyId);
  await expect(receiver.receive(different.jws, f.fingerprint)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  const g = await withdrawalFixture();
  const original = await signedWithdrawalNotice(g);
  const response = await g.receivers.get(g.b.signing.siteId)?.receive(original.jws, g.fingerprint);
  expect(response).toBeDefined();
  await expect(g.peer.approve(g.otherActor, g.revision, g.draft)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
});

test("arbitration notification retries lost responses using the original signed notice and receipt", async () => {
  const f = await withdrawalFixture("bilateral_attested");
  await f.approve();
  await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  const receipts = new Map<string, string>();
  const worker = f.worker(async (...args) => {
    const receipt = await f.deliver(...args);
    receipts.set(args[1], receipt);
    throw new Error("Response lost");
  });
  await worker.discover();
  await worker.advanceNext();
  await worker.advanceNext();
  const before = await f.rows();
  expect(before.every((r) => r.state === "pending" && r.noticeJws)).toBe(true);
  const queuedResult = await f.service.submitRevocation(f.actor, f.revision, f.draft.policyId);
  const queued = (await f.ledger()).find((row) => row.id === queuedResult.id);
  if (!queued || queued.input.operation !== "revoke-arbitration-policy")
    throw new Error("Wrong operation");
  const originalJws = before[0]?.payload?.revocationJws;
  if (!originalJws) throw new Error("Missing signed withdrawal");
  expect(queued.input.envelope.revocationJws).toBe(originalJws);
  await f.due();
  const recovered = f.worker();
  await recovered.advanceNext();
  await recovered.advanceNext();
  const after = await f.rows();
  for (let i = 0; i < after.length; i++) {
    expect(after[i]?.noticeJws).toBe(before[i]?.noticeJws);
    expect(after[i]?.receiptJws).toBe(receipts.get(before[i]?.noticeJws ?? ""));
    expect(after[i]?.state).toBe("received");
  }
  expect(await f.audit("federation.arbitration_policy.withdrawal_signed")).toHaveLength(1);
});

test("arbitration notification adopts pre-upgrade native withdrawal and rejects ungranted senders", async () => {
  const f = await withdrawalFixture("ledger_coordinated");
  await f.approve();
  await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  const queuedResult = await f.service.submitRevocation(f.actor, f.revision, f.draft.policyId);
  const queued = (await f.ledger()).find((row) => row.id === queuedResult.id);
  if (!queued || queued.input.operation !== "revoke-arbitration-policy")
    throw new Error("Wrong operation");
  await db
    .update(policies)
    .set({ revocationPayload: null, revocationJws: null })
    .where(
      and(eq(policies.localSiteId, f.a.signing.siteId), eq(policies.policyId, f.draft.policyId)),
    );
  const worker = f.worker();
  await worker.discover();
  await worker.advanceNext();
  await worker.advanceNext();
  const originalJws = queued.input.envelope.revocationJws;
  expect((await f.rows()).every((r) => r.payload?.revocationJws === originalJws)).toBe(true);
  const g = await withdrawalFixture();
  await g.approve();
  await g.service.revoke(g.actor, g.revision, g.draft.policyId);
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["arbitration-revocation-notice"] })
    .where(eq(federationSigningKeys.siteId, g.a.signing.siteId));
  const refused = g.worker();
  await refused.discover();
  await refused.advanceNext();
  expect(
    (await g.rows()).some(
      (r) => r.state === "needs_review" && r.lastError === "UNTRUSTED_IDENTITY",
    ),
  ).toBe(true);
});

test("arbitration notification ingress requires certificate identity and independent signatures", async () => {
  const f = await withdrawalFixture();
  const original = await signedWithdrawalNotice(f);
  const ingress = createFederationIngress(db, f.b.signing);
  const post = (jws: string, fingerprint?: string) =>
    ingress.request("/federation/v1/arbitration-revocations", {
      method: "POST",
      headers: {
        "content-type": "application/jose",
        ...(fingerprint ? { "x-kq-federation-cert": fingerprint } : {}),
      },
      body: jws,
    });
  expect((await post(original.jws)).status).toBe(401);
  const good = await post(original.jws, f.fingerprint);
  expect(good.status).toBe(200);
  expect(good.headers.get("cache-control")).toBe("no-store");
  expect(await (await post(original.jws, f.fingerprint)).text()).toBe(await good.text());
  const wrong = await signFederationMessage(
    ArbitrationRevocationNoticeSchema,
    { ...original.value, noticeId: randomUUID() },
    f.a.signing,
  );
  expect((await post(wrong, f.fingerprint)).status).toBe(409);
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["arbitration-revocation-receipt"] })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  expect((await post(original.jws, f.fingerprint)).status).toBe(401);
});

test("arbitration notification rolls back receiver and sender audits without changing original approvals", async () => {
  const f = await withdrawalFixture();
  await f.approve();
  await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  const worker = f.worker();
  await worker.discover();
  for (const action of ["receive", "delivered"]) {
    await db.execute(
      sql.raw(
        `alter table audit_log add constraint test_arbitration_notice_audit check (action <> 'federation.arbitration_revocation.${action}') NOT VALID`,
      ),
    );
    try {
      await f.due();
      await worker.advanceNext();
      await worker.advanceNext();
      expect((await f.rows()).every((r) => r.state === "pending" && r.receiptJws === null)).toBe(
        true,
      );
      const saved = await db.select().from(notices).where(eq(notices.policyId, f.draft.policyId));
      expect(saved).toHaveLength(action === "receive" ? 0 : 2);
    } finally {
      await db.execute(sql`alter table audit_log drop constraint test_arbitration_notice_audit`);
    }
  }
  await f.due();
  await worker.advanceNext();
  await worker.advanceNext();
  expect((await f.rows()).every((r) => r.state === "received")).toBe(true);
});

test("arbitration notification ignores late lease responses and requires independent human retry", async () => {
  const f = await withdrawalFixture();
  await f.approve();
  await f.service.revoke(f.actor, f.revision, f.draft.policyId);
  const worker = f.worker(async (...args) => {
    const response = await f.deliver(...args);
    await db
      .update(deliveries)
      .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) })
      .where(f.key);
    return response;
  });
  await worker.discover();
  await worker.advanceNext();
  const row = (await f.rows()).find((r) => r.noticeJws);
  if (!row) throw new Error("Missing delivery");
  expect(row.state).toBe("pending");
  expect(row.receiptJws).toBeNull();
  await expect(
    f.worker().retry(f.actor, f.revision, f.draft.policyId, row.receivingSiteId),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(deliveries)
    .set({ leaseUntil: new Date(0), state: "needs_review" })
    .where(f.key);
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    f.agreementsA,
    new FederationCommercialSubmissionService(db, f.a.signing.siteId),
  ];
  deps[28] = f.worker();
  const app = new Hono();
  let automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, { ...f.actor, role: "platform_admin" } as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...deps));
  const path = `/federation/commercial-agreements/${f.revision}/arbitration-policies/${f.draft.policyId}/revocation-deliveries`;
  const post = (body: unknown) =>
    app.request(`${path}/${row.receivingSiteId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  automation = true;
  expect((await post({})).status).toBe(403);
  automation = false;
  expect((await post({ amount: "1" })).status).toBe(400);
  await permissions.set(
    { ...f.actor, capability: "arbitration.approve", enabled: false },
    f.actor.userId,
  );
  expect((await post({})).status).toBe(403);
  await permissions.set(
    { ...f.actor, capability: "arbitration.approve", enabled: true },
    f.actor.userId,
  );
  expect((await post({})).status).toBe(200);
  const status = await app.request(path);
  expect(status.status).toBe(200);
  expect(await status.text()).not.toContain("Jws");
  await f.worker().advanceNext();
  expect((await f.rows()).find((r) => r.receivingSiteId === row.receivingSiteId)?.state).toBe(
    "received",
  );
});

test("arbitration notification refuses changed endpoints and invalid receipt authority", async () => {
  for (const mutation of ["endpoint", "receipt"]) {
    const f = await withdrawalFixture();
    await f.approve();
    await f.service.revoke(f.actor, f.revision, f.draft.policyId);
    const worker = f.worker(async (...args) => {
      const response = await f.deliver(...args);
      const receipt = ArbitrationRevocationReceiptSchema.parse(
        JSON.parse(Buffer.from(response.split(".")[1] ?? "", "base64url").toString()),
      );
      if (mutation === "endpoint")
        await db
          .update(federationSites)
          .set({ endpoint: "https://changed.invalid" })
          .where(eq(federationSites.id, receipt.receivingSiteId));
      else
        await db
          .update(federationSigningKeys)
          .set({ allowedKinds: ["commercial-agreement"] })
          .where(eq(federationSigningKeys.siteId, receipt.receivingSiteId));
      return response;
    });
    await worker.discover();
    await worker.advanceNext();
    expect((await f.rows()).some((r) => r.state === "needs_review" && r.receiptJws === null)).toBe(
      true,
    );
  }
});

test("arbitration notification waits for an in-flight binding before permanently fencing new bindings", async () => {
  const f = await withdrawalFixture();
  const { own } = await f.approve();
  await f.peer.attachCounterparty(f.otherActor, f.revision, f.draft.policyId, own.approvalJws);
  const original = await signedWithdrawalNotice(f);
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const binding = db.transaction(async (tx) => {
    await f.peer.verified(tx, f.otherActor, f.revision, f.draft.policyId);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const receiving = f.receivers.get(f.b.signing.siteId)?.receive(original.jws, f.fingerprint);
  if (!receiving) throw new Error("Missing receiver");
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const rows = await db.execute(
        sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%federation_arbitration_policies%for update%'`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect(
      await db.select().from(notices).where(eq(notices.policyId, f.draft.policyId)),
    ).toHaveLength(0);
  } finally {
    release.resolve();
    await binding;
  }
  await receiving;
  await expect(
    db.transaction((tx) => f.peer.verified(tx, f.otherActor, f.revision, f.draft.policyId)),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("arbitration notification rechecks signer expiry after an actual approval identity lock wait", async () => {
  const f = await withdrawalFixture();
  const original = await signedWithdrawalNotice(f);
  const until = new Date(Date.now() + 1000);
  await db
    .update(federationSigningKeys)
    .set({ validUntil: until })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const lock = db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`arbitration-policy:${f.b.signing.siteId}:${f.draft.policyId}`}, 0))`,
    );
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const receiving = f.receivers
    .get(f.b.signing.siteId)
    ?.receive(original.jws, f.fingerprint)
    .then(
      () => null,
      (error: unknown) => error,
    );
  if (!receiving) throw new Error("Missing receiver");
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if (
        (
          await db.execute(
            sql`select 1 from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`,
          )
        ).length
      ) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    await Bun.sleep(Math.max(1, until.getTime() - Date.now() + 20));
  } finally {
    release.resolve();
    await lock;
  }
  const result = await receiving;
  expect(result).toBeInstanceOf(FederationError);
  expect((result as FederationError).code).toBe("UNTRUSTED_IDENTITY");
  expect(
    await db.select().from(notices).where(eq(notices.policyId, f.draft.policyId)),
  ).toHaveLength(0);
});

test("arbitration notification forbids R and a nonparty to revoke a policy", async () => {
  const f = await withdrawalFixture();
  const original = await signedWithdrawalNotice(f);
  const receiver = f.receivers.get(f.b.signing.siteId);
  if (!receiver) throw new Error("Missing receiver");
  for (const patch of [
    { issuerSiteId: f.r.signing.siteId },
    { policy: { ...f.draft, sourceSiteId: randomUUID() } },
    { receivingSiteId: randomUUID() },
  ]) {
    const jws = await signFederationMessage(
      ArbitrationRevocationNoticeSchema,
      { ...original.value, ...patch },
      f.a.signing,
    );
    await expect(receiver.receive(jws, f.fingerprint)).rejects.toBeInstanceOf(FederationError);
  }
  const rFingerprint = randomBytes(32).toString("hex");
  await db.insert(federationCertificates).values({
    fingerprint: rFingerprint,
    siteId: f.r.signing.siteId,
    certificatePem: "isolated verified-fingerprint fixture, not a TLS handshake",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  const rNotice = await signFederationMessage(
    ArbitrationRevocationNoticeSchema,
    { ...original.value, issuerSiteId: f.r.signing.siteId },
    f.r.signing,
  );
  await expect(receiver.receive(rNotice, rFingerprint)).rejects.toThrow("POLICY_DENIED");
  expect(
    await db.select().from(notices).where(eq(notices.policyId, f.draft.policyId)),
  ).toHaveLength(0);
});

test("arbitration notification and first approval serialize on the same identity lock", async () => {
  const f = await withdrawalFixture();
  const original = await signedWithdrawalNotice(f);
  const receiver = f.receivers.get(f.b.signing.siteId);
  if (!receiver) throw new Error("Missing receiver");
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const lock = db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`arbitration-policy:${f.b.signing.siteId}:${f.draft.policyId}`}, 0))`,
    );
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const receiving = receiver.receive(original.jws, f.fingerprint);
  const waiters = async (n: number) => {
    for (let i = 0; i < 100; i++) {
      const rows = await db.execute(
        sql`select 1 from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`,
      );
      if (rows.length === n) return;
      await Bun.sleep(10);
    }
    throw new Error("Expected actual advisory lock wait");
  };
  let approval: Promise<unknown> | undefined;
  try {
    await waiters(1);
    approval = f.peer.approve(f.otherActor, f.revision, f.draft).then(
      () => null,
      (error: unknown) => error,
    );
    await waiters(2);
  } finally {
    release.resolve();
    await lock;
  }
  await receiving;
  const result = await approval;
  expect(result).toBeInstanceOf(FederationError);
  expect((result as FederationError).code).toBe("AUTHORIZATION_EXPIRED");
  expect((await f.peer.list(f.otherActor, f.revision)).data).toHaveLength(0);
});
