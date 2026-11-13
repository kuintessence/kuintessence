import { afterAll, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  federationAgreementApprovals as approvals,
  auditLog,
  authzOutbox,
  createPgDb,
  federationAgreements,
  federationBudgets,
  federationCapabilities,
  federationCertificates,
  federationCommercialAgreements,
  federationCommercialSubmissions,
  federationMarketSubmissions,
  federationSigningKeys,
  federationSites,
  orgs,
  federationAgreementSyncs as syncs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { FederationAgreementSchema, type FederationMode } from "@kuintessence/shared/federation";
import {
  AgreementApprovalQuerySchema,
  AgreementApprovalWaitingSchema,
} from "@kuintessence/shared/federation/agreement-exchange";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationAgreementRoutes } from "../routes/federation-agreements";
import { FederationAgreementExchange } from "./agreement-exchange";
import { FederationAgreementService } from "./agreements";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationCommercialWorker } from "./commercial-worker";
import { createFederationIngress } from "./ingress";
import type { FederationSend } from "./outbound-client";
import { FederationPermissionService } from "./permissions";
import {
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { testAgreement, testKeys } from "./test-fixtures";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Isolated database required");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const orgIds: string[] = [],
  userIds: string[] = [],
  siteIds: string[] = [],
  revisions: string[] = [],
  domains: string[] = [];
afterAll(async () => {
  if (!orgIds.length) return;
  await db.delete(syncs).where(inArray(syncs.localSiteId, siteIds));
  await db.delete(federationAgreements).where(inArray(federationAgreements.revisionId, revisions));
  await db.delete(federationBudgets).where(inArray(federationBudgets.domainId, domains));
  await db
    .delete(federationCommercialSubmissions)
    .where(inArray(federationCommercialSubmissions.localSiteId, siteIds));
  await db
    .delete(federationCommercialAgreements)
    .where(inArray(federationCommercialAgreements.localSiteId, siteIds));
  await db.delete(approvals).where(inArray(approvals.localSiteId, siteIds));
  await db.delete(federationCapabilities).where(inArray(federationCapabilities.orgId, orgIds));
  await db.delete(federationCertificates).where(inArray(federationCertificates.siteId, siteIds));
  await db.delete(federationSigningKeys).where(inArray(federationSigningKeys.siteId, siteIds));
  await db.delete(federationSites).where(inArray(federationSites.id, siteIds));
  await db.delete(auditLog).where(inArray(auditLog.orgId, orgIds));
  await db.delete(authzOutbox).where(inArray(authzOutbox.resourceId, orgIds));
  await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.orgId, orgIds));
  await db.delete(users).where(inArray(users.id, userIds));
  await db.delete(orgs).where(inArray(orgs.id, orgIds));
});
async function fixture(mode: FederationMode = "bilateral_direct", both = true) {
  const a = await testKeys(),
    b = await testKeys();
  const aa = { orgId: randomUUID(), userId: randomUUID() },
    ba = { orgId: randomUUID(), userId: randomUUID() },
    executionId = randomUUID();
  orgIds.push(aa.orgId, ba.orgId);
  userIds.push(aa.userId, ba.userId, executionId);
  siteIds.push(a.signing.siteId, b.signing.siteId);
  for (const actor of [aa, ba]) {
    await db.insert(orgs).values({ id: actor.orgId, name: "Agreement exchange test" });
    await db.insert(users).values({
      id: actor.userId,
      orgId: actor.orgId,
      email: `${actor.userId}@test.invalid`,
      role: "user",
    });
    await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
    await new FederationPermissionService(db).set(
      { ...actor, capability: "agreement.approve", enabled: true },
      actor.userId,
    );
  }
  await db.insert(users).values({
    id: executionId,
    orgId: ba.orgId,
    email: `${executionId}@test.invalid`,
    role: "user",
    serviceAccount: true,
  });
  await db
    .insert(userOrgMemberships)
    .values({ userId: executionId, orgId: ba.orgId, role: "member" });
  const certificates: string[] = [];
  for (const key of [a, b]) {
    key.verification.validUntil = new Date("2099-01-01");
    const allowedKinds = [
      "agreement",
      "agreement-approval-query",
      "agreement-approval-waiting",
      "acceptance",
      "commercial-agreement",
    ] as const;
    key.verification.allowedKinds = allowedKinds;
    await db
      .insert(federationSites)
      .values({ id: key.signing.siteId, name: "Exchange peer", endpoint: "https://test.invalid" });
    await db.insert(federationSigningKeys).values({
      siteId: key.signing.siteId,
      keyId: key.signing.keyId,
      publicKeyPem: await exportSPKI(key.verification.publicKey),
      allowedKinds: [...allowedKinds],
      validFrom: key.verification.validFrom,
      validUntil: key.verification.validUntil,
    });
    const fingerprint = randomBytes(32).toString("hex");
    certificates.push(fingerprint);
    await db.insert(federationCertificates).values({
      siteId: key.signing.siteId,
      fingerprint,
      certificatePem: "fixture; real TLS verified separately",
      validFrom: new Date("2020-01-01"),
      validUntil: new Date("2099-01-01"),
    });
  }
  const terms = {
    ...testAgreement(a.signing.siteId, b.signing.siteId, mode),
    validFrom: new Date(Date.now() - 60000).toISOString(),
    validUntil: new Date(Date.now() + 3600000).toISOString(),
  };
  revisions.push(terms.agreementRevisionId);
  domains.push(terms.budgetDomainId);
  if (mode === "ledger_coordinated") {
    const contract = CommercialAgreementSchema.parse({
      protocolVersion: 1,
      kind: "commercial-agreement",
      domainId: randomUUID(),
      salt: "a".repeat(64),
      createdAt: new Date().toISOString(),
      agreement: terms,
      consideration: "exchange",
      priceVersionId: randomUUID(),
      prices: [
        { metric: "cpu.time", quantityUnit: "cpu-millisecond", perQuantity: "1000", amount: "1" },
      ],
      termsText: "Private test",
    });
    const ca = new FederationCommercialAgreementService(db, a.signing),
      cb = new FederationCommercialAgreementService(db, b.signing);
    const one = await ca.approve(aa, contract),
      two = await cb.approve(ba, contract);
    await ca.attachCounterparty(aa, terms.agreementRevisionId, two.approvalJws);
    await cb.attachCounterparty(ba, terms.agreementRevisionId, one.approvalJws);
  }
  const source = new FederationAgreementService(db, a.signing),
    provider = new FederationAgreementService(db, b.signing);
  const own = await source.approve(aa, { terms });
  const approveProvider = () => provider.approve(ba, { terms, executionUserId: executionId });
  const other = both ? await approveProvider() : undefined;
  const receiverA = new FederationAgreementExchange(db, a.signing),
    receiverB = new FederationAgreementExchange(db, b.signing);
  let hook: ((jws: string, response: string, provider: boolean) => Promise<string>) | undefined;
  const sender =
    (provider: boolean): FederationSend =>
    async (_endpoint, jws, path) => {
      expect(path).toBe("/federation/v1/agreement-approvals");
      const response = await (provider ? receiverA : receiverB).receive(
        jws,
        certificates[provider ? 1 : 0] ?? "",
      );
      return hook ? hook(jws, response, provider) : response;
    };
  const sourceExchange = new FederationAgreementExchange(db, a.signing, sender(false)),
    providerExchange = new FederationAgreementExchange(db, b.signing, sender(true));
  await sourceExchange.discover();
  if (both) await providerExchange.discover();
  const due = () =>
    db
      .update(syncs)
      .set({ nextAttemptAt: new Date(0) })
      .where(inArray(syncs.localSiteId, [a.signing.siteId, b.signing.siteId]));
  const installed = () =>
    db
      .select()
      .from(federationAgreements)
      .where(eq(federationAgreements.revisionId, terms.agreementRevisionId));
  return {
    a,
    b,
    aa,
    ba,
    executionId,
    terms,
    own,
    other,
    source,
    provider,
    approveProvider,
    sourceExchange,
    providerExchange,
    receiverA,
    receiverB,
    certificates,
    due,
    installed,
    sender,
    hook: (fn: typeof hook) => {
      hook = fn;
    },
  };
}
for (const mode of ["bilateral_direct", "bilateral_attested"] as const)
  test(`agreement exchange ${mode} waits for independent consent then installs one budget without chain`, async () => {
    const f = await fixture(mode, false);
    await f.sourceExchange.advanceNext();
    expect((await f.sourceExchange.status(f.aa, f.terms.agreementRevisionId)).sync?.state).toBe(
      "pending",
    );
    expect(await f.installed()).toHaveLength(0);
    expect(
      await db
        .select()
        .from(approvals)
        .where(eq(approvals.revisionId, f.terms.agreementRevisionId)),
    ).toHaveLength(1);
    const other = await f.approveProvider();
    await f.providerExchange.discover();
    await f.due();
    await Promise.all([
      f.sourceExchange.advanceNext(),
      f.sourceExchange.advanceNext(),
      f.providerExchange.advanceNext(),
    ]);
    expect((await f.source.get(f.aa, f.terms.agreementRevisionId)).counterpartyApprovalJws).toBe(
      other.approvalJws,
    );
    expect((await f.provider.get(f.ba, f.terms.agreementRevisionId)).counterpartyApprovalJws).toBe(
      f.own.approvalJws,
    );
    expect(await f.installed()).toHaveLength(1);
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.budgetDomainId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(federationMarketSubmissions)
        .where(
          inArray(federationMarketSubmissions.localSiteId, [
            f.a.signing.siteId,
            f.b.signing.siteId,
          ]),
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(federationCommercialSubmissions)
        .where(
          inArray(federationCommercialSubmissions.localSiteId, [
            f.a.signing.siteId,
            f.b.signing.siteId,
          ]),
        ),
    ).toHaveLength(0);
  });
test("agreement exchange coordinated consent installs an identity without a local budget or execution permit", async () => {
  const f = await fixture("ledger_coordinated");
  await f.sourceExchange.advanceNext();
  await f.providerExchange.advanceNext();
  expect((await f.installed())[0]).toMatchObject({
    executionUserId: f.executionId,
    localOrgId: f.ba.orgId,
    budgetDomainId: null,
    epoch: null,
  });
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.budgetDomainId)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationMarketSubmissions)
      .where(
        inArray(federationMarketSubmissions.localSiteId, [f.a.signing.siteId, f.b.signing.siteId]),
      ),
  ).toHaveLength(0);
});
test("agreement exchange transport loss and worker restart preserve original consent despite personal role changes", async () => {
  const f = await fixture();
  f.hook(async () => {
    throw new Error("lost response");
  });
  await f.sourceExchange.advanceNext();
  expect((await f.sourceExchange.status(f.aa, f.terms.agreementRevisionId)).sync).toMatchObject({
    state: "pending",
    lastError: "EXCHANGE_RETRY",
  });
  await new FederationPermissionService(db).set(
    { ...f.aa, capability: "agreement.approve", enabled: false },
    f.aa.userId,
  );
  f.hook(undefined);
  await f.due();
  const restarted = new FederationAgreementExchange(db, f.a.signing, f.sender(false));
  const worker = new FederationCommercialWorker(
    new FederationCommercialSubmissionService(db, f.a.signing.siteId),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    restarted,
  );
  await worker.tick();
  await worker.stop();
  expect(
    (
      await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, f.a.signing.siteId),
            eq(approvals.revisionId, f.terms.agreementRevisionId),
          ),
        )
    )[0]?.counterpartyApprovalJws,
  ).toBe(f.other?.approvalJws);
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.orgId, f.aa.orgId), eq(auditLog.action, "federation.agreement.activate")),
    );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.actor).toBe(`agreement-exchange:${f.terms.agreementRevisionId}`);
});
test("agreement exchange rejects altered terms and mismatched signed waiting responses", async () => {
  const changed = await fixture();
  changed.hook(async () =>
    signFederationMessage(
      FederationAgreementSchema,
      { ...changed.terms, maxTaskAmount: "1" },
      changed.b.signing,
    ),
  );
  await changed.sourceExchange.advanceNext();
  expect(
    (await changed.sourceExchange.status(changed.aa, changed.terms.agreementRevisionId)).sync
      ?.state,
  ).toBe("needs_review");
  expect(
    (await changed.source.get(changed.aa, changed.terms.agreementRevisionId))
      .counterpartyApprovalJws,
  ).toBeNull();
  const waiting = await fixture("bilateral_direct", false);
  waiting.hook(async (_jws, response) => {
    const parsed = await verifyFederationMessage(
      AgreementApprovalWaitingSchema,
      response,
      waiting.b.verification,
      new Date(),
    );
    return signFederationMessage(
      AgreementApprovalWaitingSchema,
      { ...parsed.payload, queryId: randomUUID() },
      waiting.b.signing,
    );
  });
  await waiting.sourceExchange.advanceNext();
  expect(
    (await waiting.sourceExchange.status(waiting.aa, waiting.terms.agreementRevisionId)).sync
      ?.lastError,
  ).toBe("OPERATION_CONFLICT");
});
test("agreement exchange rechecks state, key purpose and endpoint after a network response", async () => {
  for (const change of ["state", "purpose", "endpoint"] as const) {
    const f = await fixture();
    f.hook(async (_jws, response) => {
      if (change === "state")
        await f.source.setState(f.aa, f.terms.agreementRevisionId, "suspended");
      if (change === "purpose")
        await db
          .update(federationSigningKeys)
          .set({ allowedKinds: ["agreement-approval-query"] })
          .where(eq(federationSigningKeys.siteId, f.b.signing.siteId));
      if (change === "endpoint")
        await db
          .update(federationSites)
          .set({ endpoint: "https://changed.invalid" })
          .where(eq(federationSites.id, f.b.signing.siteId));
      return response;
    });
    await f.sourceExchange.advanceNext();
    expect((await f.sourceExchange.status(f.aa, f.terms.agreementRevisionId)).sync?.state).toBe(
      "needs_review",
    );
    expect(
      (await f.source.get(f.aa, f.terms.agreementRevisionId)).counterpartyApprovalJws,
    ).toBeNull();
  }
});
test("agreement exchange receiver identity suspension blocks installation after a response", async () => {
  const f = await fixture();
  f.hook(async (_jws, response) => {
    await db.update(users).set({ suspended: true }).where(eq(users.id, f.executionId));
    return response;
  });
  await f.providerExchange.advanceNext();
  expect((await f.providerExchange.status(f.ba, f.terms.agreementRevisionId)).sync?.state).toBe(
    "needs_review",
  );
  expect(await f.installed()).toHaveLength(0);
  expect(
    (await f.provider.get(f.ba, f.terms.agreementRevisionId)).counterpartyApprovalJws,
  ).toBeNull();
});
test("agreement exchange cannot complete or overwrite progress after losing its lease", async () => {
  for (const lostError of [false, true]) {
    const f = await fixture();
    f.hook(async (_jws, response) => {
      await expect(f.sourceExchange.retry(f.aa, f.terms.agreementRevisionId)).rejects.toMatchObject(
        { code: "OPERATION_CONFLICT" },
      );
      await db
        .update(syncs)
        .set({ leaseUntil: new Date(0) })
        .where(eq(syncs.localSiteId, f.a.signing.siteId));
      await f.sourceExchange.retry(f.aa, f.terms.agreementRevisionId);
      if (lostError) throw new Error("late failure");
      return response;
    });
    await f.sourceExchange.advanceNext();
    expect((await f.sourceExchange.status(f.aa, f.terms.agreementRevisionId)).sync).toMatchObject({
      state: "pending",
      lastError: null,
    });
    expect(
      (await f.source.get(f.aa, f.terms.agreementRevisionId)).counterpartyApprovalJws,
    ).toBeNull();
    f.hook(undefined);
    await f.sourceExchange.advanceNext();
    expect((await f.sourceExchange.status(f.aa, f.terms.agreementRevisionId)).sync?.state).toBe(
      "complete",
    );
  }
});
test("agreement exchange audit failure rolls back signature, consent, budget and completion together", async () => {
  const f = await fixture();
  await db.execute(
    sql`alter table audit_log add constraint test_agreement_exchange_audit check (actor <> ${sql.raw(`'agreement-exchange:${f.terms.agreementRevisionId}'`)})`,
  );
  try {
    await f.providerExchange.advanceNext();
    expect(
      (await f.provider.get(f.ba, f.terms.agreementRevisionId)).counterpartyApprovalJws,
    ).toBeNull();
    expect(await f.installed()).toHaveLength(0);
    expect((await f.providerExchange.status(f.ba, f.terms.agreementRevisionId)).sync?.state).toBe(
      "pending",
    );
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.budgetDomainId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_agreement_exchange_audit`);
  }
  await f.due();
  await f.providerExchange.advanceNext();
  expect(await f.installed()).toHaveLength(1);
});
test("agreement exchange recovers a concurrent manual signature import without replacing original evidence", async () => {
  const f = await fixture();
  f.hook(async (_jws, response) => {
    await f.provider.attachCounterparty(f.ba, f.terms.agreementRevisionId, response);
    return response;
  });
  await f.providerExchange.advanceNext();
  expect((await f.providerExchange.status(f.ba, f.terms.agreementRevisionId)).sync?.state).toBe(
    "complete",
  );
  expect(await f.installed()).toHaveLength(1);
  const audit = await db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.orgId, f.ba.orgId), eq(auditLog.action, "federation.agreement.activate")),
    );
  expect(audit).toHaveLength(1);
  expect(audit[0]?.actor).toBe(f.ba.userId);
});
test("agreement exchange rejects wrong institutions and revoked transport certificates before disclosure", async () => {
  const f = await fixture();
  const query = AgreementApprovalQuerySchema.parse({
    protocolVersion: 1,
    kind: "agreement-approval-query",
    queryId: randomUUID(),
    senderSiteId: f.a.signing.siteId,
    recipientSiteId: f.b.signing.siteId,
    agreementRevisionId: f.terms.agreementRevisionId,
    agreementDigest: f.own.termsDigest,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const jws = await signFederationMessage(AgreementApprovalQuerySchema, query, f.a.signing);
  await expect(f.receiverB.receive(jws, f.certificates[1] ?? "")).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  const stranger = await fixture();
  const wrong = await signFederationMessage(
    AgreementApprovalQuerySchema,
    { ...query, senderSiteId: stranger.a.signing.siteId },
    stranger.a.signing,
  );
  await expect(f.receiverB.receive(wrong, stranger.certificates[0] ?? "")).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await db
    .update(federationCertificates)
    .set({ revokedAt: new Date() })
    .where(eq(federationCertificates.fingerprint, f.certificates[0] ?? ""));
  await expect(f.receiverB.receive(jws, f.certificates[0] ?? "")).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
});
test("agreement exchange HTTP requires human scope and empty retry while private ingress accepts only signed transport", async () => {
  const f = await fixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let actor = f.aa,
    automated = false;
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    c.set("automation" as never, automated as never);
    await next();
  });
  app.route("/", createFederationAgreementRoutes(f.source, undefined, f.sourceExchange));
  const path = `/federation/agreements/${f.terms.agreementRevisionId}/exchange`;
  const post = (body: unknown = {}) =>
    app.request(`${path}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  automated = true;
  expect((await post()).status).toBe(403);
  automated = false;
  expect((await post({ executionUserId: f.executionId })).status).toBe(400);
  actor = f.ba;
  expect((await app.request(path)).status).toBe(409);
  expect((await post()).status).toBe(403);
  actor = f.aa;
  expect((await post()).status).toBe(200);
  const status = await app.request(path);
  expect(status.headers.get("cache-control")).toBe("no-store");
  const data = JSON.stringify(await status.json());
  expect(data).not.toContain('"leaseToken"');
  expect(data).not.toContain('"approvalJws"');
  await f.sourceExchange.advanceNext();
  expect((await post()).status).toBe(409);
  const ingress = createFederationIngress(db, f.b.signing);
  expect(
    (await ingress.request("/federation/v1/agreement-approvals", { method: "POST", body: "bad" }))
      .status,
  ).toBe(415);
  expect(
    (
      await ingress.request("/federation/v1/agreement-approvals", {
        method: "POST",
        body: "bad",
        headers: { "content-type": "application/jose" },
      })
    ).status,
  ).toBe(400);
});
test("agreement exchange disabled sender does not advance existing intent or sign approvals", async () => {
  const f = await fixture();
  const disabled = new FederationAgreementExchange(db, f.a.signing);
  expect(await disabled.advanceNext()).toBe(false);
  expect((await disabled.status(f.aa, f.terms.agreementRevisionId)).enabled).toBe(false);
  await expect(disabled.retry(f.aa, f.terms.agreementRevisionId)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  expect(
    (await f.source.get(f.aa, f.terms.agreementRevisionId)).counterpartyApprovalJws,
  ).toBeNull();
  expect(federationMessageKeyId(f.own.approvalJws)).toBe(f.a.signing.keyId);
});

test("agreement exchange builds its minute window from one observation", async () => {
  const f = await fixture("bilateral_attested");
  const current = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => current() + 5);
  try {
    await f.sourceExchange.advanceNext();
    await f.providerExchange.advanceNext();
    for (const [exchange, actor] of [
      [f.sourceExchange, f.aa],
      [f.providerExchange, f.ba],
    ] as const)
      expect((await exchange.status(actor, f.terms.agreementRevisionId)).sync).toMatchObject({
        state: "complete",
        lastError: null,
      });
  } finally {
    clock.mockRestore();
  }
});
