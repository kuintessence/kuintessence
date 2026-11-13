import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  federationCommercialAgreements as agreements,
  federationCommercialAttempts as attempts,
  createPgDb,
  federationAgreementApprovals,
  federationAgreements,
  federationBudgets,
  federationCapabilities,
  federationOutbound,
  federationReceivedUsage,
  federationReservations,
  federationSigningKeys,
  federationSites,
  federationUsageReports,
  federationUsageSyncs,
  federationUsageTasks,
  orgs,
  type PgDb,
  federationCommercialHistoryRecoveries as recoveries,
  federationCommercialSubmissions as submissions,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  FederationDelegationSchema,
} from "@kuintessence/shared/federation";
import {
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
  CommercialAgreementSchema,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, eq, sql } from "drizzle-orm";
import { exportSPKI } from "jose";
import type { CommercialClient } from "./commercial-client";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import {
  assertCommercialHistorySubmission,
  FederationCommercialHistoryService,
} from "./history-recovery";
import { signFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys } from "./test-fixtures";

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(sourceUrl).pathname))
  throw new Error("History PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const administrativeUrl = new URL(sourceUrl);
administrativeUrl.pathname = "/postgres";
const admin = createPgDb(administrativeUrl.toString(), { max: 1, idle_timeout: 1 });
const databases: { name: string; db: PgDb }[] = [];
let dbA: PgDb, dbB: PgDb;
beforeAll(async () => {
  for (const suffix of ["a", "b"]) {
    const name = `kuintessence_unit_history_${process.pid}_${randomBytes(4).toString("hex")}_${suffix}`;
    await admin.$client.unsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(sourceUrl);
    target.pathname = `/${name}`;
    const db = createPgDb(target.toString(), { max: 4, idle_timeout: 1 });
    databases.push({ name, db });
    const child = Bun.spawn(
      ["bun", "run", fileURLToPath(new URL("../../../db/src/pg/migrate.ts", import.meta.url))],
      {
        env: { ...process.env, DATABASE_URL: target.toString() },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const error = await new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error(`Isolated history migration failed: ${error}`);
  }
  const [a, b] = databases;
  if (!a || !b) throw new Error("Missing independent history databases");
  dbA = a.db;
  dbB = b.db;
}, 60000);
afterAll(async () => {
  try {
    for (const item of databases) {
      await item.db.$client.end({ timeout: 5 });
      await admin.$client.unsafe(`DROP DATABASE "${item.name}" WITH (FORCE)`);
    }
  } finally {
    await admin.$client.end({ timeout: 5 });
  }
});

const digest = (jws: string) =>
  `sha256:${createHash("sha256")
    .update(Buffer.from(jws.split(".")[1] ?? "", "base64url"))
    .digest("hex")}`;
async function fixture() {
  const oldA = await testKeys(),
    oldB = await testKeys();
  const currentA = await testKeys(oldA.signing.siteId),
    currentB = await testKeys(oldB.signing.siteId);
  currentA.signing.keyId = "history-current";
  currentB.signing.keyId = "history-current";
  const a = oldA.signing.siteId,
    b = oldB.signing.siteId;
  const actors = [
    { userId: randomUUID(), orgId: randomUUID() },
    { userId: randomUUID(), orgId: randomUUID() },
  ];
  const actorA = actors[0],
    actorB = actors[1];
  if (!actorA || !actorB) throw new Error("Missing independent human identities");
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    createdAt: "2026-01-01T00:00:00.000Z",
    agreement: testAgreement(a, b, "bilateral_attested"),
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [{ metric: "cpu", quantityUnit: "core-second", perQuantity: "1", amount: "1" }],
    termsText: "Historical fixture contract",
  });
  const revisionId = terms.agreement.agreementRevisionId;
  const oldApprovalA = await signFederationMessage(CommercialAgreementSchema, terms, oldA.signing);
  const oldApprovalB = await signFederationMessage(CommercialAgreementSchema, terms, oldB.signing);
  for (const [db, actor, own] of [
    [dbA, actorA, a],
    [dbB, actorB, b],
  ] as const) {
    await db.insert(orgs).values({ id: actor.orgId, name: "History fixture institution" });
    await db.insert(users).values({
      id: actor.userId,
      orgId: actor.orgId,
      email: `${actor.userId}@test.invalid`,
      role: "user",
    });
    await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
    await db
      .insert(federationCapabilities)
      .values({ ...actor, capability: "attestation.recover", grantedBy: actor.userId });
    for (const site of [a, b])
      await db
        .insert(federationSites)
        .values({ id: site, name: "History fixture", endpoint: "https://history.test.invalid" });
    for (const key of [oldA, oldB, currentA, currentB]) {
      const current = key === currentA || key === currentB;
      await db.insert(federationSigningKeys).values({
        siteId: key.signing.siteId,
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: current
          ? ["commercial-history-recovery"]
          : ["commercial-agreement", "commercial-usage", "agreement", "delegation", "acceptance"],
        validFrom: new Date("2025-01-01"),
        validUntil: new Date(current ? "2099-01-01" : "2026-02-01"),
        revokedAt: current ? null : new Date("2026-02-01"),
      });
    }
    await db.insert(agreements).values({
      localSiteId: own,
      revisionId,
      localOrgId: actor.orgId,
      terms,
      digest: digest(oldApprovalA),
      approvalJws: own === a ? oldApprovalA : oldApprovalB,
      counterpartyJws: own === a ? oldApprovalB : oldApprovalA,
      approvedBy: actor.userId,
    });
    await db.insert(federationBudgets).values({
      domainId: terms.agreement.budgetDomainId,
      epoch: terms.agreement.epoch,
      unit: terms.agreement.unit,
      limit: "100",
      available: "40",
      reserved: "60",
      spent: "0",
    });
  }
  const request = FederationDelegationSchema.parse(testDelegation(terms.agreement)),
    reservationId = randomUUID();
  const requestJws = await signFederationMessage(FederationDelegationSchema, request, oldA.signing);
  const receipt = FederationAcceptanceSchema.parse({
    protocolVersion: 1,
    kind: "acceptance",
    operationId: request.operationId,
    senderSiteId: b,
    recipientSiteId: a,
    agreementRevisionId: revisionId,
    mode: request.mode,
    budgetDomainId: request.budgetDomainId,
    epoch: request.epoch,
    taskId: request.taskId,
    attempt: request.attempt,
    unit: request.unit,
    requestDigest: digest(requestJws),
    reservationId,
    reservedAmount: "60",
    acceptedAt: "2026-01-01T00:00:01.000Z",
    status: "RESERVED",
  });
  const receiptJws = await signFederationMessage(FederationAcceptanceSchema, receipt, oldB.signing);
  const executionA = await signFederationMessage(
    FederationAgreementSchema,
    terms.agreement,
    oldA.signing,
  );
  const executionB = await signFederationMessage(
    FederationAgreementSchema,
    terms.agreement,
    oldB.signing,
  );
  await dbB.insert(federationAgreements).values({
    revisionId,
    sourceSiteId: a,
    targetSiteId: b,
    localOrgId: actorB.orgId,
    executionUserId: actorB.userId,
    budgetDomainId: terms.agreement.budgetDomainId,
    epoch: terms.agreement.epoch,
    terms: terms.agreement,
    termsDigest: digest(executionA),
    sourceApprovalJws: executionA,
    targetApprovalJws: executionB,
  });
  await dbB.insert(federationReservations).values({
    id: reservationId,
    agreementRevisionId: revisionId,
    senderSiteId: a,
    operationId: request.operationId,
    taskId: request.taskId,
    attempt: 1,
    requestDigest: digest(requestJws),
    requestJws,
    amount: "60",
    receipt,
    receiptJws,
    state: "reserved",
  });
  await dbB.insert(federationUsageTasks).values({
    reservationId,
    localSiteId: b,
    localOrgId: actorB.orgId,
    agreementRevisionId: revisionId,
    state: "reported",
  });
  const report = CommercialUsageSchema.parse({
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId: terms.domainId,
    agreementRevisionId: revisionId,
    agreementDigest: digest(oldApprovalA),
    sourceSiteId: a,
    targetSiteId: b,
    taskId: request.taskId,
    attempt: 1,
    salt: randomBytes(32).toString("hex"),
    periodStart: "2026-01-01T00:00:01.000Z",
    periodEnd: "2026-01-01T00:00:02.000Z",
    reportedAt: "2026-01-01T00:00:03.000Z",
    measurements: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        quantity: "1",
        evidenceDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
  const reportJws = await signFederationMessage(CommercialUsageSchema, report, oldB.signing),
    reportDigest = digest(reportJws);
  await dbB.insert(federationUsageReports).values({
    id: report.reportId,
    reservationId,
    number: 1,
    report,
    reportJws,
    digest: reportDigest,
    evidenceSet: {
      version: 1,
      reservationId,
      agreementRevisionId: revisionId,
      priceVersionId: terms.priceVersionId,
      records: [{ jobId: randomUUID(), digest: `sha256:${"b".repeat(64)}` }],
    },
  });
  await dbA.insert(federationAgreementApprovals).values({
    localSiteId: a,
    revisionId,
    localOrgId: actorA.orgId,
    terms: terms.agreement,
    termsDigest: digest(executionA),
    approvalJws: executionA,
    counterpartyApprovalJws: executionB,
    approvedBy: actorA.userId,
  });
  await dbA.insert(federationOutbound).values({
    localSiteId: a,
    localOrgId: actorA.orgId,
    operationId: request.operationId,
    agreementRevisionId: revisionId,
    submittedBy: actorA.userId,
    taskId: request.taskId,
    attempt: 1,
    budgetDomainId: request.budgetDomainId,
    epoch: request.epoch,
    amount: "60",
    endpoint: "https://provider.test.invalid",
    request,
    requestDigest: digest(requestJws),
    requestJws,
    receipt,
    receiptJws,
    state: "accepted",
  });
  await dbA
    .insert(federationUsageSyncs)
    .values({ localSiteId: a, operationId: request.operationId });
  const received = {
    localSiteId: a,
    operationId: request.operationId,
    reportId: report.reportId,
    number: 1,
    report,
    reportJws,
    digest: reportDigest,
    pageJws: "historical-page-fixture",
  };
  await dbA.insert(federationReceivedUsage).values(received);
  const input = CommercialAdapterProposalInputSchema.parse({
    operation: "record-usage",
    domainId: terms.domainId,
    recordId: report.reportId,
    digest: reportDigest,
    envelope: { providerJws: reportJws },
  });
  const originalId = randomUUID();
  await dbB.insert(submissions).values({
    id: originalId,
    localSiteId: b,
    agreementRevisionId: revisionId,
    input,
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
  });
  return {
    a,
    b,
    actorA,
    actorB,
    revisionId,
    terms,
    request,
    input,
    originalId,
    received,
    historyA: new FederationCommercialHistoryService(dbA, currentA.signing),
    historyB: new FederationCommercialHistoryService(dbB, currentB.signing),
    currentA,
    currentB,
  };
}

class HistoryClient implements CommercialClient {
  inputs: CommercialAdapterProposalInput[] = [];
  checkpoints: string[] = [];
  async prepare(input: CommercialAdapterProposalInput) {
    expect(input.operation).toBe("record-historical-commercial");
    this.inputs.push(input);
    const transactionId = randomBytes(32).toString("hex");
    return { transactionId, recovery: Buffer.from(`proposal-${transactionId}`).toString("base64") };
  }
  async advance(recovery: string) {
    this.checkpoints.push(recovery);
    const decoded = Buffer.from(recovery, "base64").toString();
    const transactionId = decoded.slice(decoded.indexOf("-") + 1);
    return decoded.startsWith("proposal-")
      ? {
          state: "prepared" as const,
          transactionId,
          recovery: Buffer.from(`transaction-${transactionId}`).toString("base64"),
        }
      : { state: "committed" as const, transactionId, blockNumber: "8" };
  }
}

test("independent sites recover provider-only usage using a closed consumer archive and preserve every balance", async () => {
  const f = await fixture();
  expect(
    await dbA.select().from(submissions).where(eq(submissions.agreementRevisionId, f.revisionId)),
  ).toHaveLength(0);
  const budgets = await Promise.all([
    dbA.select().from(federationBudgets),
    dbB.select().from(federationBudgets),
  ]);
  const payload = await f.historyB.draft(f.actorB, f.revisionId, f.originalId, {
    recoveryId: randomUUID(),
    reason: "Both institutions reviewed the immutable historical report",
  });
  const provider = await f.historyB.approve(f.actorB, f.revisionId, f.originalId, payload);
  const file = { payload, jws: provider.approvalJws, originalInput: provider.originalInput };
  await dbA
    .delete(federationReceivedUsage)
    .where(
      and(
        eq(federationReceivedUsage.localSiteId, f.a),
        eq(federationReceivedUsage.reportId, f.input.recordId),
      ),
    );
  await expect(f.historyA.importCounterparty(f.actorA, f.revisionId, file)).rejects.toMatchObject({
    code: "DATA_WAITING",
  });
  expect(
    await dbA.select().from(submissions).where(eq(submissions.agreementRevisionId, f.revisionId)),
  ).toHaveLength(0);
  await dbA.insert(federationReceivedUsage).values(f.received);
  const consumer = await f.historyA.importCounterparty(f.actorA, f.revisionId, file);
  expect(consumer.original.archiveOnly).toBe(true);
  expect(consumer.original.state).toBe("closed");
  expect(consumer.counterpartyApproved).toBe(true);
  const confirmed = await f.historyB.counterparty(
    f.actorB,
    f.revisionId,
    f.originalId,
    consumer.approvalJws,
  );
  expect(confirmed.counterpartyApproved).toBe(true);
  expect(await f.historyA.importCounterparty(f.actorA, f.revisionId, file)).toEqual(consumer);
  for (const [db, siteId, actor, originalId] of [
    [dbA, f.a, f.actorA, consumer.original.id],
    [dbB, f.b, f.actorB, f.originalId],
  ] as const) {
    const client = new HistoryClient();
    let worker = new FederationCommercialSubmissionService(db, siteId, client);
    await expect(worker.retry(actor, f.revisionId, originalId)).rejects.toMatchObject({
      code: "OPERATION_CONFLICT",
    });
    expect(await worker.advanceNext()).toBe(true);
    worker = new FederationCommercialSubmissionService(db, siteId, client);
    expect(await worker.advanceNext()).toBe(true);
    expect(await worker.advanceNext()).toBe(true);
    expect(client.inputs).toHaveLength(1);
    expect(client.checkpoints).toHaveLength(2);
    const [original] = await db.select().from(submissions).where(eq(submissions.id, originalId));
    expect(original?.input).toEqual(f.input);
    expect(original?.state).toBe(siteId === f.a ? "closed" : "needs_review");
    const [record] = await db
      .select()
      .from(recoveries)
      .where(and(eq(recoveries.localSiteId, siteId), eq(recoveries.submissionId, originalId)));
    expect(record?.payload).toEqual(payload);
  }
  expect((await f.historyA.get(f.actorA, f.revisionId, consumer.original.id))?.ledger?.state).toBe(
    "committed",
  );
  expect((await f.historyB.get(f.actorB, f.revisionId, f.originalId))?.ledger?.state).toBe(
    "committed",
  );
  expect(
    await Promise.all([dbA.select().from(federationBudgets), dbB.select().from(federationBudgets)]),
  ).toEqual(budgets);
}, 30000);

test("unknown original transaction must resume its checkpoint and cannot start history recovery", async () => {
  const f = await fixture(),
    transactionId = randomBytes(32).toString("hex");
  await dbB.insert(attempts).values({
    id: randomUUID(),
    submissionId: f.originalId,
    number: 1,
    transactionId,
    recovery: Buffer.from(`transaction-${transactionId}`).toString("base64"),
    stage: "transaction",
  });
  await expect(
    f.historyB.draft(f.actorB, f.revisionId, f.originalId, {
      recoveryId: randomUUID(),
      reason: "Must not replace an unknown transaction",
    }),
  ).rejects.toMatchObject({ code: "DATA_WAITING" });
  const worker = new FederationCommercialSubmissionService(dbB, f.b, new HistoryClient());
  await dbB
    .insert(federationCapabilities)
    .values({ ...f.actorB, capability: "agreement.approve", grantedBy: f.actorB.userId });
  await worker.retry(f.actorB, f.revisionId, f.originalId);
  const [attempt] = await dbB
    .select()
    .from(attempts)
    .where(eq(attempts.submissionId, f.originalId));
  expect(attempt?.transactionId).toBe(transactionId);
  expect(attempt?.stage).toBe("transaction");
  expect(
    await dbB.select().from(recoveries).where(eq(recoveries.submissionId, f.originalId)),
  ).toHaveLength(0);
});

test("platform roles and a different institution never inherit historical approval authority", async () => {
  const f = await fixture();
  await dbB
    .delete(federationCapabilities)
    .where(
      and(
        eq(federationCapabilities.orgId, f.actorB.orgId),
        eq(federationCapabilities.userId, f.actorB.userId),
      ),
    );
  await dbB.update(users).set({ role: "platform_admin" }).where(eq(users.id, f.actorB.userId));
  await expect(
    f.historyB.draft(f.actorB, f.revisionId, f.originalId, {
      recoveryId: randomUUID(),
      reason: "No implicit administrator authority",
    }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(f.historyA.get(f.actorA, f.revisionId, f.originalId)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
});

test("retired recovery approvals are archived and both institutions reapprove the same immutable fact", async () => {
  const f = await fixture();
  const payload = await f.historyB.draft(f.actorB, f.revisionId, f.originalId, {
    recoveryId: randomUUID(),
    reason: "Renew authorization without changing historical evidence",
  });
  const provider = await f.historyB.approve(f.actorB, f.revisionId, f.originalId, payload);
  const consumer = await f.historyA.importCounterparty(f.actorA, f.revisionId, {
    payload,
    jws: provider.approvalJws,
    originalInput: provider.originalInput,
  });
  const confirmed = await f.historyB.counterparty(
    f.actorB,
    f.revisionId,
    f.originalId,
    consumer.approvalJws,
  );
  if (!confirmed.ledger || !consumer.ledger) throw new Error("Missing approved history queues");
  const [oldQueue] = await dbB
    .select()
    .from(submissions)
    .where(eq(submissions.id, confirmed.ledger.id));
  if (!oldQueue || oldQueue.input.operation !== "record-historical-commercial")
    throw new Error("Missing immutable history input");
  const failedTransaction = randomBytes(32).toString("hex");
  await dbB.insert(attempts).values({
    id: randomUUID(),
    submissionId: confirmed.ledger.id,
    number: 1,
    transactionId: failedTransaction,
    recovery: Buffer.from("definitively-invalid").toString("base64"),
    stage: "invalid",
    validationCode: 10,
    blockNumber: "7",
  });
  const renewedA = await testKeys(f.a),
    renewedB = await testKeys(f.b);
  renewedA.signing.keyId = "history-renewed";
  renewedB.signing.keyId = "history-renewed";
  for (const db of [dbA, dbB]) {
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(federationSigningKeys.keyId, "history-current"),
          sql`${federationSigningKeys.siteId} IN (${f.a}, ${f.b})`,
        ),
      );
    for (const key of [renewedA, renewedB])
      await db.insert(federationSigningKeys).values({
        siteId: key.signing.siteId,
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: ["commercial-history-recovery"],
        validFrom: new Date("2025-01-01"),
        validUntil: new Date("2099-01-01"),
      });
  }
  await expect(f.historyB.reauthorize(f.actorB, f.revisionId, f.originalId)).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  const historyA = new FederationCommercialHistoryService(dbA, renewedA.signing),
    historyB = new FederationCommercialHistoryService(dbB, renewedB.signing);
  const newProvider = await historyB.reauthorize(f.actorB, f.revisionId, f.originalId);
  expect(newProvider.payload).toEqual(payload);
  expect(newProvider.digest).toBe(provider.digest);
  expect(newProvider.approvalJws).not.toBe(provider.approvalJws);
  expect(newProvider.counterpartyApproved).toBe(false);
  expect(newProvider.approvalHistoryCount).toBe(1);
  expect(newProvider.ledger?.state).toBe("needs_review");
  await expect(assertCommercialHistorySubmission(dbB, f.b, oldQueue.input)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  const newConsumer = await historyA.reauthorize(f.actorA, f.revisionId, consumer.original.id);
  await historyA.counterparty(
    f.actorA,
    f.revisionId,
    consumer.original.id,
    newProvider.approvalJws,
  );
  const renewed = await historyB.counterparty(
    f.actorB,
    f.revisionId,
    f.originalId,
    newConsumer.approvalJws,
  );
  expect(renewed.ledger?.id).toBe(confirmed.ledger.id);
  expect(renewed.ledger?.state).toBe("pending");
  await expect(assertCommercialHistorySubmission(dbB, f.b, oldQueue.input)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  const [archive] = await dbB
    .select()
    .from(recoveries)
    .where(eq(recoveries.submissionId, f.originalId));
  expect(archive?.approvalHistory).toEqual([
    {
      approvalJws: provider.approvalJws,
      counterpartyJws: consumer.approvalJws,
      recordedAt: expect.any(String),
      approvedBy: f.actorB.userId,
      transactionId: failedTransaction,
    },
  ]);
  const [original] = await dbB.select().from(submissions).where(eq(submissions.id, f.originalId));
  expect(original?.input).toEqual(f.input);
  const [failed] = await dbB
    .select()
    .from(attempts)
    .where(eq(attempts.submissionId, confirmed.ledger.id));
  expect(failed?.transactionId).toBe(failedTransaction);
  expect(failed?.stage).toBe("invalid");
  expect((await historyB.get(f.actorB, f.revisionId, f.originalId))?.canReauthorize).toBe(false);
  await expect(historyB.reauthorize(f.actorB, f.revisionId, f.originalId)).rejects.toMatchObject({
    code: "DATA_WAITING",
  });
  expect((await historyB.get(f.actorB, f.revisionId, f.originalId))?.approvalHistoryCount).toBe(1);
  expect((await historyB.get(f.actorB, f.revisionId, f.originalId))?.counterpartyApproved).toBe(
    true,
  );
  await dbB
    .update(federationSigningKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(federationSigningKeys.siteId, f.a),
        eq(federationSigningKeys.keyId, renewedA.signing.keyId),
      ),
    );
  const peerRetired = await historyB.reauthorize(f.actorB, f.revisionId, f.originalId);
  expect(peerRetired.approvalJws).toBe(newProvider.approvalJws);
  expect(peerRetired.counterpartyApproved).toBe(false);
  expect(peerRetired.approvalHistoryCount).toBe(2);
  await expect(historyB.reauthorize(f.actorB, f.revisionId, f.originalId)).rejects.toMatchObject({
    code: "DATA_WAITING",
  });
  expect((await historyB.get(f.actorB, f.revisionId, f.originalId))?.approvalHistoryCount).toBe(2);
});

test("recovery reauthorization cannot replace a leased, unknown or valid transaction", async () => {
  const f = await fixture();
  const payload = await f.historyB.draft(f.actorB, f.revisionId, f.originalId, {
    recoveryId: randomUUID(),
    reason: "Preserve every submitted transaction",
  });
  const provider = await f.historyB.approve(f.actorB, f.revisionId, f.originalId, payload);
  const consumer = await f.historyA.importCounterparty(f.actorA, f.revisionId, {
    payload,
    jws: provider.approvalJws,
    originalInput: provider.originalInput,
  });
  const approved = await f.historyB.counterparty(
    f.actorB,
    f.revisionId,
    f.originalId,
    consumer.approvalJws,
  );
  if (!approved.ledger) throw new Error("Missing recovery queue");
  await dbB
    .update(submissions)
    .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) })
    .where(eq(submissions.id, approved.ledger.id));
  expect((await f.historyB.get(f.actorB, f.revisionId, f.originalId))?.canReauthorize).toBe(false);
  await expect(f.historyB.reauthorize(f.actorB, f.revisionId, f.originalId)).rejects.toMatchObject({
    code: "DATA_WAITING",
  });
  await dbB
    .update(submissions)
    .set({ leaseToken: null, leaseUntil: null })
    .where(eq(submissions.id, approved.ledger.id));
  const attemptId = randomUUID(),
    transactionId = randomBytes(32).toString("hex");
  await dbB.insert(attempts).values({
    id: attemptId,
    submissionId: approved.ledger.id,
    number: 1,
    transactionId,
    recovery: Buffer.from("unknown-proposal").toString("base64"),
    stage: "proposal",
  });
  for (const stage of ["proposal", "transaction", "committed"] as const) {
    await dbB
      .update(attempts)
      .set({
        stage,
        validationCode: stage === "committed" ? 0 : null,
        blockNumber: stage === "committed" ? "8" : null,
      })
      .where(eq(attempts.id, attemptId));
    expect((await f.historyB.get(f.actorB, f.revisionId, f.originalId))?.canReauthorize).toBe(
      false,
    );
    await expect(
      f.historyB.reauthorize(f.actorB, f.revisionId, f.originalId),
    ).rejects.toMatchObject({ code: "DATA_WAITING" });
  }
  const [unchanged] = await dbB.select().from(attempts).where(eq(attempts.id, attemptId));
  expect(unchanged?.transactionId).toBe(transactionId);
  expect((await f.historyB.get(f.actorB, f.revisionId, f.originalId))?.approvalHistoryCount).toBe(
    0,
  );
});
