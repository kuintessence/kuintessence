import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  federationCommercialAgreements as agreements,
  federationArbitrationResolutions as arbitrationExecutions,
  auditLog,
  federationCommercialBills as bills,
  createPgDb,
  federationDisputes as disputes,
  federationDisputeFreezes as freezes,
  orgs,
  federationReceivedArbitrationDecisions as receivedDecisions,
  federationDisputeResolutions as resolutions,
  federationCommercialSettlements as settlements,
  federationCommercialSubmissions as submissions,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import type { FederationMode } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisputeFreezeSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import { and, eq, sql } from "drizzle-orm";
import { exportSPKI } from "jose";
import { FederationArbitrationResolutionService } from "./arbitration-resolution";
import { FederationDisputeResolutionService } from "./dispute-resolution";
import { applyCoordinatedDisputeResolution } from "./dispute-resolution-state";
import { FederationDisputeService } from "./disputes";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Dispute resolution requires an isolated unit database");
const db = createPgDb(url, { max: 6, idle_timeout: 1 });
afterAll(() => db.$client.end({ timeout: 5 }));
const digest = `sha256:${"a".repeat(64)}`;
function signedDigest(jws: string | undefined) {
  if (!jws) throw new Error("Missing signed fixture original");
  return `sha256:${createHash("sha256")
    .update(Buffer.from(jws.split(".")[1] ?? "", "base64url"))
    .digest("hex")}`;
}

// Signed originals represent an already acknowledged bill/freeze, not a scientific execution.
async function fixture(mode: FederationMode = "bilateral_direct") {
  const a = await testKeys(),
    b = await testKeys();
  const actor = { userId: randomUUID(), orgId: randomUUID() };
  await db.insert(orgs).values({ id: actor.orgId, name: "Resolution scope" });
  await db.insert(users).values({ id: actor.userId, email: `${actor.userId}@test.invalid` });
  await db.insert(userOrgMemberships).values({ ...actor, role: "owner" });
  const permissions = new FederationPermissionService(db);
  for (const capability of ["dispute.read", "dispute.resolve", "arbitration.execute"] as const)
    await permissions.set({ ...actor, capability, enabled: true }, actor.userId);
  const trust = new FederationTrustRegistry(db);
  for (const key of [a, b]) {
    await trust.addSite(
      { id: key.signing.siteId, name: "Resolution institution", endpoint: "https://test.invalid" },
      actor.userId,
    );
    await trust.addKey(
      key.signing.siteId,
      {
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: [
          "commercial-agreement",
          "commercial-bill",
          "commercial-dispute",
          "commercial-dispute-freeze",
          "commercial-dispute-resolution",
          "commercial-settlement",
        ],
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
    salt: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00Z",
    agreement: {
      ...testAgreement(a.signing.siteId, b.signing.siteId, mode),
      validUntil: "2099-01-01T00:00:00Z",
    },
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [{ metric: "cpu", quantityUnit: "core-second", perQuantity: "1", amount: "1" }],
    termsText: "Private terms",
  });
  const agreementJws = await Promise.all(
    [a, b].map((k) => signFederationMessage(CommercialAgreementSchema, terms, k.signing)),
  );
  const agreementDigest = signedDigest(agreementJws[0]);
  const revisionId = terms.agreement.agreementRevisionId;
  const request = testDelegation(terms.agreement);
  const bill = CommercialBillSchema.parse({
    protocolVersion: 1,
    kind: "commercial-bill",
    billId: randomUUID(),
    domainId: terms.domainId,
    agreementDigest: agreementDigest,
    priceVersionId: terms.priceVersionId,
    reportId: randomUUID(),
    reportDigest: digest,
    request,
    reservationId: mode === "ledger_coordinated" ? randomUUID() : null,
    discount: null,
    calculation: {
      rounding: "ceil-per-line",
      lines: [
        {
          metric: "cpu",
          quantityUnit: "core-second",
          quantity: "10",
          perQuantity: "1",
          rateAmount: "1",
          amount: "10",
        },
      ],
      grossAmount: "10",
      capReduction: "0",
      discountAmount: "0",
      dueAmount: "10",
    },
    issuedAt: "2026-01-01T00:01:00Z",
    salt: "b".repeat(64),
  });
  const billJws = await Promise.all(
    [a, b].map((k) => signFederationMessage(CommercialBillSchema, bill, k.signing)),
  );
  const billDigest = signedDigest(billJws[0]);
  const scope = CommercialDisputeSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute",
    caseId: randomUUID(),
    subject: {
      recordType: "bill",
      recordId: bill.billId,
      recordDigest: billDigest,
    },
    reason: "Check the bill",
    requestedResolution: "Reconcile",
    domainId: terms.domainId,
    agreementRevisionId: revisionId,
    agreementDigest: bill.agreementDigest,
    sourceSiteId: a.signing.siteId,
    targetSiteId: b.signing.siteId,
    openingSiteId: a.signing.siteId,
    taskId: request.taskId,
    attempt: request.attempt,
    issuedAt: "2026-01-01T00:02:00Z",
    salt: "c".repeat(64),
  });
  const openingJws = await signFederationMessage(CommercialDisputeSchema, scope, a.signing);
  for (const [index, key] of [a, b].entries()) {
    await db.insert(agreements).values({
      localSiteId: key.signing.siteId,
      localOrgId: actor.orgId,
      revisionId,
      terms,
      digest: bill.agreementDigest,
      approvalJws: agreementJws[index] ?? "",
      counterpartyJws: agreementJws[1 - index],
      approvedBy: actor.userId,
    });
    await db.insert(bills).values({
      localSiteId: key.signing.siteId,
      localOrgId: actor.orgId,
      agreementRevisionId: revisionId,
      billId: bill.billId,
      taskId: request.taskId,
      attempt: request.attempt,
      payload: bill,
      digest: billDigest,
      approvalJws: billJws[index] ?? "",
      counterpartyJws: billJws[1 - index],
      approvedBy: actor.userId,
    });
    await db.insert(disputes).values({
      localSiteId: key.signing.siteId,
      localOrgId: actor.orgId,
      agreementRevisionId: revisionId,
      caseId: scope.caseId,
      taskId: request.taskId,
      attempt: request.attempt,
      payload: scope,
      digest: signedDigest(openingJws),
      openingJws,
      openedBy: index === 0 ? actor.userId : null,
      acceptanceJws: index === 0 ? null : "acknowledged-fixture",
      receivedAt: index === 0 ? null : new Date(),
      state: "DISPUTED",
    });
  }
  if (mode === "ledger_coordinated") {
    const current = await db.transaction((tx) =>
      new FederationDisputeService(db, a.signing).financialSnapshot(tx, scope.caseId),
    );
    const freeze = CommercialDisputeFreezeSchema.parse({
      protocolVersion: 1,
      kind: "commercial-dispute-freeze",
      caseId: scope.caseId,
      caseDigest: signedDigest(openingJws),
      agreementRevisionId: revisionId,
      sourceSiteId: a.signing.siteId,
      targetSiteId: b.signing.siteId,
      taskId: request.taskId,
      attempt: request.attempt,
      mode,
      headDigest: current.view.headDigest,
      issuedAt: "2026-01-01T00:03:00Z",
      salt: "d".repeat(64),
    });
    const signatures = await Promise.all(
      [a, b].map((k) => signFederationMessage(CommercialDisputeFreezeSchema, freeze, k.signing)),
    );
    for (const [index, key] of [a, b].entries())
      await db.insert(freezes).values({
        localSiteId: key.signing.siteId,
        caseId: scope.caseId,
        state: "confirmed",
        payload: freeze,
        financialView: current.view,
        digest: signedDigest(signatures[0]),
        approvalJws: signatures[index],
        counterpartyJws: signatures[1 - index],
        confirmedAt: new Date(),
        ledgerReceipt: { recordId: scope.caseId, digest: signedDigest(signatures[0]) },
      });
  }
  const serviceA = new FederationDisputeResolutionService(db, a.signing),
    serviceB = new FederationDisputeResolutionService(db, b.signing);
  return { a, b, actor, terms, revisionId, request, bill, billDigest, scope, serviceA, serviceB };
}

async function approvedResolutionDigest(f: Awaited<ReturnType<typeof fixture>>) {
  const view = await f.serviceA.read(f.actor, f.revisionId, f.scope.caseId);
  if (!view) throw new Error("Missing signed resolution original");
  return view.digest;
}

async function approveBoth(
  f: Awaited<ReturnType<typeof fixture>>,
  financial: ReturnType<typeof CommercialSettlementSchema.parse> | null = null,
) {
  const value = await f.serviceA.draft(f.actor, f.revisionId, f.scope.caseId, {
    resolutionId: randomUUID(),
    reason: "Joint reconciliation",
    financial,
  });
  await f.serviceA.approve(f.actor, f.revisionId, f.scope.caseId, value);
  await f.serviceB.approve(f.actor, f.revisionId, f.scope.caseId, value);
  const rows = await db.select().from(resolutions).where(eq(resolutions.caseId, f.scope.caseId));
  const a = rows.find((r) => r.localSiteId === f.a.signing.siteId),
    b = rows.find((r) => r.localSiteId === f.b.signing.siteId);
  if (!a || !b) throw new Error("Missing fixture approvals");
  await f.serviceA.attachExchanged(f.revisionId, value.resolutionId, b.approvalJws, async () => {});
  await f.serviceB.attachExchanged(f.revisionId, value.resolutionId, a.approvalJws, async () => {});
  return value;
}

for (const mode of ["bilateral_direct", "bilateral_attested"] as const)
  test(`generic ${mode} reconciliation needs no R execution and closes only after dual approval`, async () => {
    const f = await fixture(mode);
    expect((await f.serviceA.context(f.actor, f.revisionId, f.scope.caseId)).canDraft).toBe(true);
    const value = await approveBoth(f);
    expect(value.protocolVersion).toBe(2);
    expect(value.decisionId).toBeNull();
    expect(value.withdrawalDigest).toBeNull();
    expect(value.freezeDigest).toBeNull();
    expect((await f.serviceA.read(f.actor, f.revisionId, f.scope.caseId))?.appliedAt).toBeTruthy();
    expect((await f.serviceB.read(f.actor, f.revisionId, f.scope.caseId))?.appliedAt).toBeTruthy();
    const submitted = await db
      .select()
      .from(submissions)
      .where(eq(submissions.agreementRevisionId, f.revisionId));
    expect(submitted).toHaveLength(mode === "bilateral_attested" ? 1 : 0);
    if (mode === "bilateral_attested") {
      const original = submitted[0];
      if (!original) throw new Error("Missing original attestation");
      await db.insert(submissions).values({
        id: randomUUID(),
        localSiteId: f.b.signing.siteId,
        agreementRevisionId: f.revisionId,
        input: original.input,
        state: "closed",
        lastError: "HISTORY_ARCHIVE_ONLY",
      });
      expect((await f.serviceB.read(f.actor, f.revisionId, f.scope.caseId))?.ledger).toBeNull();
      expect((await f.serviceA.read(f.actor, f.revisionId, f.scope.caseId))?.ledger?.state).toBe(
        "pending",
      );
    }
    expect((await f.serviceA.context(f.actor, f.revisionId, f.scope.caseId)).blockedReason).toBe(
      "RESOLUTION_EXISTS",
    );
    await expect(
      new FederationArbitrationResolutionService(db, f.a.signing).execute(
        f.actor,
        f.revisionId,
        f.scope.caseId,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  });

test("a persisted R execution intent blocks generic reconciliation before its result is known", async () => {
  const f = await fixture();
  const input = { resolutionId: randomUUID(), reason: "Reconcile", financial: null };
  const draft = await f.serviceA.draft(f.actor, f.revisionId, f.scope.caseId, input);
  const decisionId = randomUUID();
  // A persisted intent is sufficient to block replacement, even without an execution receipt.
  await db.insert(receivedDecisions).values({
    localSiteId: f.a.signing.siteId,
    localOrgId: f.actor.orgId,
    decisionId,
    caseId: f.scope.caseId,
    payload: sql`${JSON.stringify({ receivingSiteId: f.a.signing.siteId, decisionId, caseId: f.scope.caseId })}::jsonb`,
    deliveryJws: "persisted-original",
    receipt: sql`'{}'::jsonb`,
  });
  await db.insert(arbitrationExecutions).values({
    localSiteId: f.a.signing.siteId,
    localOrgId: f.actor.orgId,
    decisionId,
    caseId: f.scope.caseId,
    agreementRevisionId: f.revisionId,
    initiatedBy: f.actor.userId,
    payload: sql`${JSON.stringify({ decisionId, caseId: f.scope.caseId, agreementRevisionId: f.revisionId, sourceSiteId: f.a.signing.siteId, targetSiteId: f.b.signing.siteId, mode: "bilateral_direct", outcome: { action: "resolve-without-financial-change" } })}::jsonb`,
    envelope: sql`'{}'::jsonb`,
  });
  expect((await f.serviceA.context(f.actor, f.revisionId, f.scope.caseId)).blockedReason).toBe(
    "DATA_WAITING",
  );
  await expect(
    f.serviceA.draft(f.actor, f.revisionId, f.scope.caseId, input),
  ).rejects.toMatchObject({ code: "DATA_WAITING" });
  await expect(
    f.serviceA.approve(f.actor, f.revisionId, f.scope.caseId, draft),
  ).rejects.toMatchObject({ code: "DATA_WAITING" });
  expect(
    await db.select().from(resolutions).where(eq(resolutions.caseId, f.scope.caseId)),
  ).toHaveLength(0);
});

test("coordinated no-financial reconciliation stays frozen until its original VALID result and replays once", async () => {
  const f = await fixture("ledger_coordinated"),
    value = await approveBoth(f);
  const valueDigest = await approvedResolutionDigest(f);
  expect(value.freezeDigest).toBeTruthy();
  expect((await f.serviceA.read(f.actor, f.revisionId, f.scope.caseId))?.appliedAt).toBeNull();
  await expect(
    db.transaction((tx) =>
      applyCoordinatedDisputeResolution(tx, f.a.signing.siteId, value.resolutionId, valueDigest),
    ),
  ).rejects.toMatchObject({ code: "DATA_WAITING" });
  expect(
    (await db.select().from(disputes).where(eq(disputes.caseId, f.scope.caseId))).every(
      (r) => r.state === "DISPUTED",
    ),
  ).toBe(true);
  await db
    .update(submissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(submissions.localSiteId, f.a.signing.siteId),
        sql`${submissions.input}->>'recordId' = ${value.resolutionId}`,
      ),
    );
  for (let i = 0; i < 2; i++)
    await db.transaction((tx) =>
      applyCoordinatedDisputeResolution(tx, f.a.signing.siteId, value.resolutionId, valueDigest),
    );
  expect((await f.serviceA.read(f.actor, f.revisionId, f.scope.caseId))?.appliedAt).toBeTruthy();
  expect((await f.serviceB.read(f.actor, f.revisionId, f.scope.caseId))?.appliedAt).toBeNull();
  const events = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target, value.resolutionId),
        eq(auditLog.action, "federation.dispute_resolution.apply"),
      ),
    );
  expect(events).toHaveLength(1);
});

test("coordinated money reconciliation authorizes exact financial terms without signing or applying them", async () => {
  const f = await fixture("ledger_coordinated");
  const financial = CommercialSettlementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-settlement",
    settlementId: randomUUID(),
    domainId: f.terms.domainId,
    agreementRevisionId: f.revisionId,
    billId: f.bill.billId,
    billDigest: f.billDigest,
    sourceSiteId: f.a.signing.siteId,
    targetSiteId: f.b.signing.siteId,
    reservationId: f.bill.reservationId,
    terminal: { terminalId: randomUUID(), digest },
    unit: f.request.unit,
    reservedAmount: "60",
    chargedAmount: "10",
    releasedAmount: "50",
    issuedAt: new Date().toISOString(),
    salt: "e".repeat(64),
  });
  const value = await approveBoth(f, financial);
  const valueDigest = await approvedResolutionDigest(f);
  const pending = await db
    .select()
    .from(submissions)
    .where(eq(submissions.agreementRevisionId, f.revisionId));
  expect(pending).toHaveLength(2);
  expect(pending.every((r) => r.input.operation === "authorize-dispute-resolution")).toBe(true);
  expect(
    await db.select().from(settlements).where(eq(settlements.agreementRevisionId, f.revisionId)),
  ).toHaveLength(0);
  const status = await f.serviceA.read(f.actor, f.revisionId, f.scope.caseId);
  expect(status?.financialApproved).toBe(false);
  expect(status?.authorizationLedger?.state).toBe("pending");
  expect(status?.ledger).toBeNull();
  expect(status?.appliedAt).toBeNull();
  await expect(
    db.transaction((tx) =>
      applyCoordinatedDisputeResolution(tx, f.a.signing.siteId, value.resolutionId, valueDigest),
    ),
  ).rejects.toMatchObject({ code: "DATA_WAITING" });
});

test("coordinated generic draft rejects missing native freeze and altered financial head", async () => {
  const f = await fixture("ledger_coordinated");
  const input = { resolutionId: randomUUID(), reason: "Reconcile", financial: null };
  const value = await f.serviceA.draft(f.actor, f.revisionId, f.scope.caseId, input);
  await expect(
    f.serviceA.approve(f.actor, f.revisionId, f.scope.caseId, {
      ...value,
      headDigest: `sha256:${"f".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await db
    .update(freezes)
    .set({ ledgerReceipt: null, state: "ledger_pending", confirmedAt: null })
    .where(eq(freezes.caseId, f.scope.caseId));
  expect((await f.serviceA.context(f.actor, f.revisionId, f.scope.caseId)).canDraft).toBe(false);
  await expect(
    f.serviceA.draft(f.actor, f.revisionId, f.scope.caseId, input),
  ).rejects.toMatchObject({ code: "DATA_WAITING" });
});
