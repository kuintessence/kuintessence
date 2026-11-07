import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  federationCommercialAttempts as attempts,
  auditLog,
  federationCommercialAgreements as contracts,
  createPgDb,
  federationAgreements,
  federationBudgets,
  federationCapabilities,
  federationSigningKeys,
  federationSites,
  orgs,
  federationCommercialSubmissions as submissions,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import type { FederationMode } from "@kuintessence/shared/federation";
import {
  type CommercialAdvanceResult,
  CommercialAgreementSchema,
  type CommercialProposalInput,
} from "@kuintessence/shared/federation/commercial";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationCommercialRoutes } from "../routes/federation-commercial";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import type { CommercialClient } from "./commercial-client";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationCommercialWorker } from "./commercial-worker";
import { FabricClientFailure } from "./fabric-client";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage } from "./signatures";
import { testAgreement, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Commercial PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const fixtures: {
  a: Awaited<ReturnType<typeof testKeys>>;
  b: Awaited<ReturnType<typeof testKeys>>;
  actor: { orgId: string; userId: string };
}[] = [];
class Adapter implements CommercialClient {
  prepares: CommercialProposalInput[] = [];
  advances: string[] = [];
  offline = false;
  outcome: "pending" | "committed" | "invalid" = "committed";
  onAdvance?: (token: string, transactionId: string) => Promise<CommercialAdvanceResult>;
  async prepare(input: CommercialProposalInput) {
    this.prepares.push(input);
    if (this.offline) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const transactionId = randomBytes(32).toString("hex");
    return { transactionId, recovery: Buffer.from(`proposal:${transactionId}`).toString("base64") };
  }
  async advance(token: string): Promise<CommercialAdvanceResult> {
    this.advances.push(token);
    const [stage, transactionId] = Buffer.from(token, "base64").toString().split(":");
    if (!transactionId) throw new Error("Invalid test checkpoint");
    const [saved] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.transactionId, transactionId));
    expect(saved?.recovery).toBe(token);
    expect(saved?.stage).toBe(stage);
    if (this.offline) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    if (this.onAdvance) return this.onAdvance(token, transactionId);
    if (stage === "proposal")
      return {
        state: "prepared",
        transactionId,
        recovery: Buffer.from(`transaction:${transactionId}`).toString("base64"),
      };
    if (this.outcome === "pending") return { state: "pending", transactionId, recovery: token };
    if (this.outcome === "invalid")
      return { state: "invalid", transactionId, validationCode: 11, blockNumber: "7" };
    return { state: "committed", transactionId, blockNumber: "8" };
  }
}
async function fixture(mode: FederationMode = "bilateral_attested", grant = true) {
  const [a, b] = await Promise.all([testKeys(), testKeys()]);
  const actor = { orgId: randomUUID(), userId: randomUUID() };
  await db.insert(orgs).values({ id: actor.orgId, name: "Commercial test scope" });
  await db.insert(users).values({
    id: actor.userId,
    orgId: actor.orgId,
    email: `${actor.userId}@test.invalid`,
    role: "platform_admin",
  });
  await db.insert(userOrgMemberships).values({ ...actor, role: "owner" });
  if (grant)
    await new FederationPermissionService(db).set(
      { ...actor, capability: "agreement.approve", enabled: true },
      actor.userId,
    );
  const trust = new FederationTrustRegistry(db);
  for (const key of [a, b]) {
    await trust.addSite(
      { id: key.signing.siteId, name: "Commercial institution", endpoint: "https://test.invalid" },
      actor.userId,
    );
    await trust.addKey(
      key.signing.siteId,
      {
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: ["commercial-agreement", "commercial-usage"],
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
      {
        metric: "cpu",
        quantityUnit: "core-second",
        perQuantity: "3600",
        amount: "9007199254740993123",
      },
    ],
    termsText: "Private commercial test terms",
  });
  const adapter = new Adapter();
  const approvals = new FederationCommercialAgreementService(db, a.signing);
  const service = new FederationCommercialSubmissionService(db, a.signing.siteId, adapter);
  const value = {
    a,
    b,
    actor,
    terms,
    adapter,
    approvals,
    service,
    trust,
    revisionId: terms.agreement.agreementRevisionId,
  };
  fixtures.push(value);
  return value;
}
async function approveBoth(f: Awaited<ReturnType<typeof fixture>>) {
  const own = await f.approvals.approve(f.actor, f.terms);
  const other = await signFederationMessage(CommercialAgreementSchema, f.terms, f.b.signing);
  await f.approvals.attachCounterparty(f.actor, f.revisionId, other);
  return { own, other };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) {
  const [row] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.localSiteId, f.a.signing.siteId));
  if (!row) throw new Error("Missing test submission");
  return row;
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const row = await pending(f);
  await db
    .update(submissions)
    .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(submissions.id, row.id));
}
afterAll(async () => {
  for (const f of fixtures) {
    const rows = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.localSiteId, f.a.signing.siteId));
    if (rows.length)
      await db.delete(attempts).where(
        inArray(
          attempts.submissionId,
          rows.map((row) => row.id),
        ),
      );
    await db.delete(submissions).where(eq(submissions.localSiteId, f.a.signing.siteId));
    await db.delete(contracts).where(eq(contracts.localSiteId, f.a.signing.siteId));
    await db.delete(auditLog).where(eq(auditLog.actor, f.actor.userId));
    await db
      .delete(federationCapabilities)
      .where(eq(federationCapabilities.userId, f.actor.userId));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, f.actor.userId));
    await db.delete(users).where(eq(users.id, f.actor.userId));
    await db.delete(orgs).where(eq(orgs.id, f.actor.orgId));
    for (const key of [f.a, f.b]) {
      await db
        .delete(federationSigningKeys)
        .where(eq(federationSigningKeys.siteId, key.signing.siteId));
      await db.delete(federationSites).where(eq(federationSites.id, key.signing.siteId));
    }
  }
  await db.$client.end({ timeout: 5 });
});

test("platform role cannot sign; current organization grant and explicit commercial key purpose are required", async () => {
  const f = await fixture("bilateral_attested", false);
  await expect(f.approvals.approve(f.actor, f.terms)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: true },
    f.actor.userId,
  );
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["agreement"] })
    .where(eq(federationSigningKeys.siteId, f.a.signing.siteId));
  await expect(f.approvals.approve(f.actor, f.terms)).rejects.toMatchObject({
    code: "UNTRUSTED_IDENTITY",
  });
  expect(
    await db.select().from(contracts).where(eq(contracts.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test("commercial approval is immutable, exact and private to the local organization", async () => {
  const f = await fixture(),
    otherScope = await fixture();
  const record = await f.approvals.approve(f.actor, f.terms);
  expect(record.terms.prices[0]?.amount).toBe("9007199254740993123");
  expect((await f.approvals.approve(f.actor, f.terms)).approvalJws).toBe(record.approvalJws);
  await expect(
    f.approvals.approve(f.actor, { ...f.terms, termsText: "Replacement" }),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await expect(f.approvals.get(otherScope.actor, f.revisionId)).rejects.toMatchObject({
    code: "AGREEMENT_UNAVAILABLE",
  });
  expect(await f.approvals.list(otherScope.actor, 50, 0)).toHaveLength(0);
  const wrong = await signFederationMessage(
    CommercialAgreementSchema,
    { ...f.terms, termsText: "Different signed terms" },
    f.b.signing,
  );
  await expect(f.approvals.attachCounterparty(f.actor, f.revisionId, wrong)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  await expect(
    f.approvals.attachCounterparty(f.actor, f.revisionId, record.approvalJws),
  ).rejects.toThrow();
  expect(
    await db.select().from(submissions).where(eq(submissions.localSiteId, f.a.signing.siteId)),
  ).toHaveLength(0);
});

test.each([
  "bilateral_direct",
  "bilateral_attested",
  "ledger_coordinated",
] as const)("%s approvals preserve mode semantics and never activate execution or budgets", async (mode) => {
  const f = await fixture(mode);
  const { other } = await approveBoth(f);
  await Promise.all([
    f.approvals.attachCounterparty(f.actor, f.revisionId, other),
    f.approvals.attachCounterparty(f.actor, f.revisionId, other),
  ]);
  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.localSiteId, f.a.signing.siteId));
  expect(rows).toHaveLength(mode === "bilateral_direct" ? 0 : 1);
  expect(
    await db
      .select()
      .from(federationAgreements)
      .where(eq(federationAgreements.revisionId, f.revisionId)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.agreement.budgetDomainId)),
  ).toHaveLength(0);
  if (mode === "bilateral_direct") expect(await f.service.advanceNext()).toBe(false);
  else {
    f.adapter.offline = true;
    expect(await f.service.advanceNext()).toBe(true);
    expect((await pending(f)).state).toBe("pending");
    expect((await pending(f)).lastError).toBe("LEDGER_UNAVAILABLE");
  }
});

test("each checkpoint is persisted before external effects; concurrent workers and restarts retain original transaction", async () => {
  const f = await fixture();
  await approveBoth(f);
  await Promise.all([f.service.advanceNext(), f.service.advanceNext()]);
  expect(f.adapter.prepares).toHaveLength(1);
  await f.service.advanceNext();
  const row = await pending(f);
  const [prepared] = await db.select().from(attempts).where(eq(attempts.submissionId, row.id));
  expect(prepared?.stage).toBe("transaction");
  f.adapter.outcome = "pending";
  const restarted = new FederationCommercialSubmissionService(db, f.a.signing.siteId, f.adapter);
  await restarted.advanceNext();
  expect((await pending(f)).lastError).toBe("LEDGER_PENDING");
  const status = await restarted.status(f.actor, f.revisionId, 50, 0);
  expect(JSON.stringify(status)).not.toContain("recovery");
  expect(JSON.stringify(status)).not.toContain(f.terms.termsText);
  await ready(f);
  f.adapter.outcome = "committed";
  await restarted.advanceNext();
  expect((await pending(f)).state).toBe("committed");
  expect(
    (await restarted.status(f.actor, f.revisionId, 50, 0)).submissions[0]?.transaction
      ?.transactionId,
  ).toBe(prepared?.transactionId);
  expect(f.adapter.prepares).toHaveLength(1);
  expect(await restarted.advanceNext()).toBe(false);
});

test("revoked trust stops new disclosure, while confirmed INVALID attempts require explicit review and remain in history", async () => {
  const f = await fixture();
  await approveBoth(f);
  await f.service.advanceNext();
  await f.trust.revoke(f.b.signing.siteId, { keyId: f.b.signing.keyId }, f.actor.userId);
  await f.service.advanceNext();
  expect(f.adapter.advances).toHaveLength(0);
  expect((await pending(f)).state).toBe("needs_review");
  const valid = await fixture();
  await approveBoth(valid);
  await valid.service.advanceNext();
  await valid.service.advanceNext();
  valid.adapter.outcome = "invalid";
  await valid.service.advanceNext();
  expect((await pending(valid)).state).toBe("needs_review");
  const row = await pending(valid);
  await valid.service.retry(valid.actor, valid.revisionId, row.id);
  valid.adapter.outcome = "committed";
  for (let i = 0; i < 3; i++) await valid.service.advanceNext();
  expect((await pending(valid)).state).toBe("committed");
  const history = await db.select().from(attempts).where(eq(attempts.submissionId, row.id));
  expect(history.map((item) => item.stage).sort()).toEqual(["committed", "invalid"]);
});

test("uncertain submitted outcome cannot be abandoned by retry and stale lease cannot write a terminal result", async () => {
  const f = await fixture();
  await approveBoth(f);
  await f.service.advanceNext();
  await f.service.advanceNext();
  const row = await pending(f);
  f.adapter.onAdvance = async () => ({
    state: "committed",
    transactionId: "0".repeat(64),
    blockNumber: "9",
  });
  await f.service.advanceNext();
  expect((await pending(f)).state).toBe("needs_review");
  await db
    .update(submissions)
    .set({ leaseToken: randomUUID(), leaseUntil: sql`clock_timestamp() + interval '90 seconds'` })
    .where(eq(submissions.id, row.id));
  await expect(f.service.retry(f.actor, f.revisionId, row.id)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
  await db
    .update(submissions)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(submissions.id, row.id));
  await f.service.retry(f.actor, f.revisionId, row.id);
  f.adapter.onAdvance = async (_token, transactionId) => {
    await db
      .update(submissions)
      .set({ leaseToken: randomUUID(), leaseUntil: sql`clock_timestamp() + interval '90 seconds'` })
      .where(eq(submissions.id, row.id));
    return { state: "committed", transactionId, blockNumber: "9" };
  };
  await f.service.advanceNext();
  expect((await pending(f)).state).toBe("pending");
  expect(await f.service.advanceNext()).toBe(false);
  await db
    .update(submissions)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(submissions.id, row.id));
  f.adapter.onAdvance = undefined;
  await f.service.advanceNext();
  expect((await pending(f)).state).toBe("committed");
  expect(f.adapter.prepares).toHaveLength(1);
});

test("HTTP requires human scope, rejects unknown fields, hides private data from status and audit", async () => {
  const f = await fixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let human = true;
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    if (!human) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(f.approvals, f.service));
  human = false;
  expect((await app.request("/federation/commercial-agreements")).status).toBe(403);
  human = true;
  const response = await app.request("/federation/commercial-agreements/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terms: f.terms, channel: "arbitrary" }),
  });
  expect(response.status).toBe(400);
  await approveBoth(f);
  const status = await app.request(`/federation/commercial-agreements/${f.revisionId}/submissions`);
  expect(status.status).toBe(200);
  expect(status.headers.get("cache-control")).toBe("no-store");
  expect(await status.text()).not.toContain("approvalJws");
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actor, f.actor.userId),
        sql`${auditLog.action} LIKE 'federation.commercial.%'`,
      ),
    );
  expect(audits).toHaveLength(2);
  expect(JSON.stringify(audits)).not.toContain(f.terms.termsText);
  expect(JSON.stringify(audits)).not.toContain(f.terms.prices[0]?.amount ?? "missing");
  const worker = new FederationCommercialWorker(
    new FederationCommercialSubmissionService(db, f.a.signing.siteId),
  );
  await worker.tick();
  await worker.stop();
  expect(f.adapter.prepares).toHaveLength(0);
});
