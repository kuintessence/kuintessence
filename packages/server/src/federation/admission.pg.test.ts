import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createPgDb,
  federationAgreements,
  federationAttestationOutbox,
  federationBudgets,
  federationEvidence,
  federationReservations,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  type FederationAgreement,
  FederationAgreementSchema,
  type FederationDelegation,
  FederationDelegationSchema,
} from "@kuintessence/shared/federation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { FederationAdmission } from "./admission";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys, testNow } from "./test-fixtures";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Federation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const identity = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const agreements: FederationAgreement[] = [];
let a: Awaited<ReturnType<typeof testKeys>>;
let b: Awaited<ReturnType<typeof testKeys>>;
let service: FederationAdmission;

beforeAll(async () => {
  [a, b] = await Promise.all([testKeys(), testKeys()]);
  service = new FederationAdmission(db, b.signing, b.verification, () => testNow);
  await db.insert(orgs).values({ id: identity.orgId, name: "Federation isolated test" });
  await db.insert(users).values({
    id: identity.userId,
    orgId: identity.orgId,
    email: `${identity.userId}@test.invalid`,
    role: "user",
    serviceAccount: true,
  });
  await db.insert(userOrgMemberships).values({ ...identity, role: "member" });
});

afterAll(async () => {
  for (const agreement of agreements) {
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
});

async function approve(terms: FederationAgreement) {
  return {
    sourceApprovalJws: await signFederationMessage(FederationAgreementSchema, terms, a.signing),
    targetApprovalJws: await signFederationMessage(FederationAgreementSchema, terms, b.signing),
    sourceKey: a.verification,
    targetKey: b.verification,
    identity,
  };
}
async function install(overrides: Partial<FederationAgreement> = {}) {
  const terms = { ...testAgreement(a.signing.siteId, b.signing.siteId), ...overrides };
  agreements.push(terms);
  await service.installApprovedAgreement(await approve(terms));
  return terms;
}
async function requestInput(request: FederationDelegation) {
  return {
    requestJws: await signFederationMessage(FederationDelegationSchema, request, a.signing),
    senderKey: a.verification,
    authenticatedPeerSiteId: a.signing.siteId,
  };
}
async function rows(terms: FederationAgreement) {
  const [budget] = await db
    .select()
    .from(federationBudgets)
    .where(
      and(
        eq(federationBudgets.domainId, terms.budgetDomainId),
        eq(federationBudgets.epoch, terms.epoch),
      ),
    );
  const reservations = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.agreementRevisionId, terms.agreementRevisionId));
  const evidence = reservations.length
    ? await db
        .select()
        .from(federationEvidence)
        .where(
          inArray(
            federationEvidence.reservationId,
            reservations.map((row) => row.id),
          ),
        )
    : [];
  const outbox = evidence.length
    ? await db
        .select()
        .from(federationAttestationOutbox)
        .where(
          inArray(
            federationAttestationOutbox.evidenceId,
            evidence.map((row) => row.id),
          ),
        )
    : [];
  return { budget, reservations, evidence, outbox };
}

test("concurrent retries reserve once and return one verifiable receipt without any ledger", async () => {
  const terms = await install();
  const input = await requestInput(testDelegation(terms));
  const results = await Promise.all(Array.from({ length: 8 }, () => service.receive(input)));
  expect(new Set(results.map((r) => r.reservationId)).size).toBe(1);
  expect(new Set(results.map((r) => r.receiptJws)).size).toBe(1);
  const state = await rows(terms);
  expect(state.budget?.available).toBe("40");
  expect(state.budget?.reserved).toBe("60");
  expect(state.reservations).toHaveLength(1);
  expect(state.evidence).toHaveLength(2);
  expect(state.outbox).toHaveLength(0);
  const verified = await verifyFederationMessage(
    FederationAcceptanceSchema,
    results[0]?.receiptJws ?? "",
    b.verification,
    testNow,
  );
  expect(verified.payload.status).toBe("RESERVED");
  expect(verified.payload.recipientSiteId).toBe(a.signing.siteId);
  // Replaying approval must not reset the balance.
  await service.installApprovedAgreement(await approve(terms));
  expect((await rows(terms)).budget?.available).toBe("40");
});

test("competing unique requests cannot oversubscribe the budget", async () => {
  const terms = await install();
  const inputs = await Promise.all(
    Array.from({ length: 8 }, () => requestInput(testDelegation(terms))),
  );
  const results = await Promise.allSettled(inputs.map((input) => service.receive(input)));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const result of results)
    if (result.status === "rejected") expect(result.reason.code).toBe("BUDGET_EXHAUSTED");
  const state = await rows(terms);
  expect(state.reservations).toHaveLength(1);
  expect(state.budget?.reserved).toBe("60");
});

test("same ID with changed payload and same attempt with a new ID cannot create another reservation", async () => {
  const terms = await install({ budgetLimit: "1000" });
  const request = testDelegation(terms);
  await service.receive(await requestInput(request));
  await expect(
    service.receive(await requestInput({ ...request, maxAmount: "59" })),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    service.receive(await requestInput({ ...request, operationId: crypto.randomUUID() })),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect((await rows(terms)).budget?.reserved).toBe("60");
});

test("attested mode saves evidence and pending outbox without contacting Fabric", async () => {
  const terms = await install({ mode: "bilateral_attested" });
  const input = await requestInput(testDelegation(terms));
  await service.receive(input);
  await service.receive(input);
  const state = await rows(terms);
  expect(state.outbox).toHaveLength(2);
  expect(state.outbox.every((row) => row.state === "pending")).toBe(true);
  expect(state.reservations[0]?.state).toBe("reserved");
});

test("signing outage preserves a single unsigned reservation and recovers after process replacement", async () => {
  const terms = await install({ mode: "bilateral_attested" });
  const input = await requestInput(testDelegation(terms));
  const broken = new FederationAdmission(
    db,
    b.signing,
    { ...b.verification, revoked: true },
    () => testNow,
  );
  await expect(broken.receive(input)).rejects.toThrow("UNTRUSTED_IDENTITY");
  const pending = await rows(terms);
  expect(pending.reservations[0]?.state).toBe("pending_signature");
  expect(pending.reservations[0]?.receiptJws).toBeNull();
  expect(pending.budget?.reserved).toBe("60");
  expect(pending.evidence).toHaveLength(1);
  const recovered = new FederationAdmission(db, b.signing, b.verification, () => testNow);
  const result = await recovered.receive(input);
  expect(pending.reservations[0]?.id).toBe(result.reservationId);
  const state = await rows(terms);
  expect(state.evidence).toHaveLength(2);
  expect(state.outbox).toHaveLength(2);
  expect(state.budget?.reserved).toBe("60");
});

test("evidence write failure rolls back inbox and budget together", async () => {
  const terms = await install();
  const request = testDelegation(terms);
  // Inject a server-side failure after the budget update, scoped to this test's operation.
  await db.execute(sql`CREATE FUNCTION federation_test_fail_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM federation_reservations WHERE id = NEW.reservation_id
        AND operation_id::text = TG_ARGV[0]) THEN RAISE EXCEPTION 'injected evidence failure'; END IF;
      RETURN NEW;
    END $$`);
  await db.execute(
    sql.raw(`CREATE TRIGGER federation_test_evidence_failure BEFORE INSERT ON federation_evidence
    FOR EACH ROW EXECUTE FUNCTION federation_test_fail_evidence('${request.operationId}')`),
  );
  try {
    await expect(service.receive(await requestInput(request))).rejects.toThrow();
    const state = await rows(terms);
    expect(state.reservations).toHaveLength(0);
    expect(state.evidence).toHaveLength(0);
    expect(state.budget?.available).toBe("100");
  } finally {
    await db.execute(sql`DROP TRIGGER federation_test_evidence_failure ON federation_evidence`);
    await db.execute(sql`DROP FUNCTION federation_test_fail_evidence()`);
  }
});

test("exact large amounts remain intact through PostgreSQL and a signed receipt", async () => {
  const amount = "900719925474099399999999";
  const terms = await install({ budgetLimit: amount, maxTaskAmount: amount });
  await service.receive(await requestInput({ ...testDelegation(terms), maxAmount: amount }));
  const state = await rows(terms);
  expect(state.budget?.available).toBe("0");
  expect(state.budget?.reserved).toBe(amount);
  expect(state.reservations[0]?.receipt.reservedAmount).toBe(amount);
});

test("peer identity, agreement suspension and local machine-account revocation are enforced", async () => {
  const terms = await install();
  const input = await requestInput(testDelegation(terms));
  await expect(
    service.receive({ ...input, authenticatedPeerSiteId: crypto.randomUUID() }),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  await db
    .update(federationAgreements)
    .set({ state: "suspended" })
    .where(eq(federationAgreements.revisionId, terms.agreementRevisionId));
  await expect(service.receive(input)).rejects.toThrow("AGREEMENT_UNAVAILABLE");
  await db
    .update(federationAgreements)
    .set({ state: "active" })
    .where(eq(federationAgreements.revisionId, terms.agreementRevisionId));
  await db.update(users).set({ suspended: true }).where(eq(users.id, identity.userId));
  try {
    await expect(service.receive(input)).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, identity.userId));
  }
  expect((await rows(terms)).budget?.reserved).toBe("0");
});

test("approval requires both authorized institutions and cannot open a second spendable epoch", async () => {
  const terms = await install();
  const changed = { ...terms, agreementRevisionId: crypto.randomUUID() };
  await expect(service.installApprovedAgreement(await approve(changed))).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  const approvals = await approve({ ...testAgreement(a.signing.siteId, b.signing.siteId) });
  await expect(
    service.installApprovedAgreement({
      ...approvals,
      sourceKey: { ...a.verification, allowedKinds: ["delegation"] },
    }),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  const chain = testAgreement(a.signing.siteId, b.signing.siteId, "ledger_coordinated");
  await expect(service.installApprovedAgreement(await approve(chain))).rejects.toThrow(
    "LEDGER_REQUIRED",
  );
});

test("zero-cost work is still limited by the number of reserved tasks", async () => {
  const terms = await install({ budgetLimit: "0", maxTaskAmount: "0", maxReservations: 1 });
  await service.receive(await requestInput({ ...testDelegation(terms), maxAmount: "0" }));
  await expect(
    service.receive(await requestInput({ ...testDelegation(terms), maxAmount: "0" })),
  ).rejects.toThrow("BUDGET_EXHAUSTED");
});

test("database constraints reject NaN budgets, negative balances and unsigned ready receipts", async () => {
  const terms = await install();
  for (const values of [
    { limit: "NaN", available: "NaN", reserved: "NaN" },
    { limit: "100", available: "-1", reserved: "101" },
    { limit: "100", available: "100", reserved: "1" },
  ])
    await expect(
      db
        .update(federationBudgets)
        .set(values)
        .where(eq(federationBudgets.domainId, terms.budgetDomainId))
        .execute(),
    ).rejects.toThrow();
  const result = await service.receive(await requestInput(testDelegation(terms)));
  await expect(
    db
      .update(federationReservations)
      .set({ receiptJws: null })
      .where(eq(federationReservations.id, result.reservationId))
      .execute(),
  ).rejects.toThrow();
  expect((await rows(terms)).budget?.reserved).toBe("60");
});

test("authorization is checked again after verification and blocking locks", async () => {
  const terms = await install();
  const request = testDelegation(terms);
  let reads = 0;
  const expiring = new FederationAdmission(db, b.signing, b.verification, () =>
    reads++ === 0 ? testNow : new Date(request.expiresAt),
  );
  await expect(expiring.receive(await requestInput(request))).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  expect((await rows(terms)).reservations).toHaveLength(0);
});

test("a signed long execution window cannot admit late work or rewrite an accepted deadline", async () => {
  const terms = await install();
  const request = { ...testDelegation(terms), executionExpiresAt: "2026-01-01T12:00:00.000Z" };
  const input = await requestInput(request);
  const accepted = await service.receive(input);
  const late = new FederationAdmission(
    db,
    b.signing,
    b.verification,
    () => new Date("2026-01-01T02:00:00.000Z"),
  );
  expect(await late.receive(input)).toEqual(accepted);
  await expect(
    late.receive(
      await requestInput({
        ...request,
        maxAmount: "1",
        operationId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
      }),
    ),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  await expect(
    service.receive(
      await requestInput({ ...request, executionExpiresAt: "2026-01-01T18:00:00.000Z" }),
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect((await rows(terms)).reservations).toHaveLength(1);
  expect((await rows(terms)).budget?.reserved).toBe("60");
});
