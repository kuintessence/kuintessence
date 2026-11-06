import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  federationAttestationAttempts as attempts,
  auditLog,
  federationEvidenceBatches as batches,
  createPgDb,
  federationEvidence as evidence,
  federationAgreements,
  federationBudgets,
  federationCapabilities,
  federationReservations,
  federationSigningKeys,
  federationSites,
  orgs,
  federationAttestationOutbox as outbox,
  federationEvidenceStreams as streams,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  type FederationAgreement,
  FederationAgreementSchema,
  FederationDelegationSchema,
  type FederationMode,
} from "@kuintessence/shared/federation";
import type {
  EvidenceAdvanceResult,
  EvidenceProposalInput,
} from "@kuintessence/shared/federation/ledger";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationAgreementRoutes } from "../routes/federation-agreements";
import { FederationAdmission } from "./admission";
import { FederationAgreementService } from "./agreements";
import { FederationAttestationService } from "./attestation";
import { type AttestationClient, AttestationFailure } from "./attestation-client";
import { FederationAttestationWorker } from "./attestation-worker";
import { signFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys, testNow } from "./test-fixtures";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Attestation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const fixtures: {
  actor: { orgId: string; userId: string };
  target: Awaited<ReturnType<typeof testKeys>>;
  terms: FederationAgreement;
}[] = [];

class Adapter implements AttestationClient {
  prepares: EvidenceProposalInput[] = [];
  advances: string[] = [];
  offline = false;
  outcome: "pending" | "anchored" | "invalid" = "anchored";
  onAdvance?: (token: string) => Promise<EvidenceAdvanceResult>;
  async prepare(input: EvidenceProposalInput) {
    if (this.offline) throw new AttestationFailure("LEDGER_UNAVAILABLE");
    this.prepares.push(input);
    const transactionId = randomBytes(32).toString("hex");
    return { transactionId, recovery: Buffer.from(`proposal:${transactionId}`).toString("base64") };
  }
  async advance(token: string): Promise<EvidenceAdvanceResult> {
    this.advances.push(token);
    if (this.onAdvance) return this.onAdvance(token);
    if (this.offline) throw new AttestationFailure("LEDGER_UNAVAILABLE");
    const [stage, transactionId] = Buffer.from(token, "base64").toString().split(":");
    if (!transactionId) throw new Error("Missing fixture transaction ID");
    const [saved] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.transactionId, transactionId));
    expect(saved?.recovery).toBe(token);
    expect(saved?.stage).toBe(stage);
    if (stage === "proposal")
      return {
        state: "prepared",
        transactionId,
        recovery: Buffer.from(`transaction:${transactionId}`).toString("base64"),
      };
    if (this.outcome === "pending") return { state: "pending", transactionId, recovery: token };
    if (this.outcome === "invalid")
      return { state: "invalid", transactionId, blockNumber: "7", validationCode: 11 };
    return { state: "anchored", transactionId, blockNumber: "8" };
  }
}

async function fixture(mode: FederationMode = "bilateral_attested") {
  const [source, target] = await Promise.all([testKeys(), testKeys()]);
  const identity = { orgId: randomUUID(), userId: randomUUID() };
  const actor = { orgId: identity.orgId, userId: randomUUID() };
  await db.insert(orgs).values({ id: identity.orgId, name: "Isolated attestation test" });
  await db.insert(users).values([
    {
      id: identity.userId,
      orgId: identity.orgId,
      email: `${identity.userId}@test.invalid`,
      role: "user",
      serviceAccount: true,
    },
    {
      id: actor.userId,
      orgId: actor.orgId,
      email: `${actor.userId}@test.invalid`,
      role: "admin",
      serviceAccount: false,
    },
  ]);
  await db.insert(userOrgMemberships).values([
    { ...identity, role: "member" },
    { ...actor, role: "member" },
  ]);
  await db
    .insert(federationCapabilities)
    .values({ ...actor, capability: "agreement.approve", grantedBy: actor.userId });
  await db
    .insert(federationSites)
    .values({ id: target.signing.siteId, name: "Target", endpoint: "https://target.test.invalid" });
  await db.insert(federationSigningKeys).values({
    siteId: target.signing.siteId,
    keyId: target.signing.keyId,
    publicKeyPem: await exportSPKI(target.verification.publicKey),
    validFrom: new Date("2020-01-01T00:00:00Z"),
    validUntil: new Date("2099-01-01T00:00:00Z"),
    allowedKinds: ["agreement", "delegation", "acceptance", "evidence-batch"],
  });
  const admission = new FederationAdmission(db, target.signing, target.verification, () => testNow);
  const terms = testAgreement(source.signing.siteId, target.signing.siteId, mode);
  await admission.installApprovedAgreement({
    sourceApprovalJws: await signFederationMessage(
      FederationAgreementSchema,
      terms,
      source.signing,
    ),
    targetApprovalJws: await signFederationMessage(
      FederationAgreementSchema,
      terms,
      target.signing,
    ),
    sourceKey: source.verification,
    targetKey: target.verification,
    identity,
  });
  const admit = async () =>
    admission.receive({
      requestJws: await signFederationMessage(
        FederationDelegationSchema,
        { ...testDelegation(terms), maxAmount: "10" },
        source.signing,
      ),
      senderKey: source.verification,
      authenticatedPeerSiteId: source.signing.siteId,
    });
  const adapter = new Adapter();
  const service = new FederationAttestationService(db, target.signing, adapter);
  const result = { identity, actor, source, target, terms, adapter, service, admit };
  fixtures.push(result);
  await admit();
  return result;
}

async function batchFor(siteId: string) {
  const [batch] = await db
    .select()
    .from(batches)
    .where(eq(batches.issuerSiteId, siteId))
    .orderBy(asc(batches.firstSequence))
    .limit(1);
  if (!batch) throw new Error("Missing batch");
  return batch;
}
async function ready(id: string) {
  await db.update(batches).set({ nextAttemptAt: sql`clock_timestamp()` }).where(eq(batches.id, id));
}
async function advance(service: FederationAttestationService, count: number) {
  for (let i = 0; i < count; i++) expect(await service.advanceNext()).toBe(true);
}

afterAll(async () => {
  for (const f of fixtures) {
    const batchIds = db
      .select({ id: batches.id })
      .from(batches)
      .where(eq(batches.issuerSiteId, f.target.signing.siteId));
    const reservationIds = db
      .select({ id: federationReservations.id })
      .from(federationReservations)
      .where(eq(federationReservations.agreementRevisionId, f.terms.agreementRevisionId));
    const evidenceIds = db
      .select({ id: evidence.id })
      .from(evidence)
      .where(inArray(evidence.reservationId, reservationIds));
    await db.delete(attempts).where(inArray(attempts.batchId, batchIds));
    await db.delete(outbox).where(inArray(outbox.evidenceId, evidenceIds));
    await db.delete(batches).where(eq(batches.issuerSiteId, f.target.signing.siteId));
    await db.delete(streams).where(eq(streams.issuerSiteId, f.target.signing.siteId));
    await db.delete(evidence).where(inArray(evidence.reservationId, reservationIds));
    await db
      .delete(federationReservations)
      .where(eq(federationReservations.agreementRevisionId, f.terms.agreementRevisionId));
    await db
      .delete(federationAgreements)
      .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
    await db
      .delete(federationBudgets)
      .where(
        and(
          eq(federationBudgets.domainId, f.terms.budgetDomainId),
          eq(federationBudgets.epoch, f.terms.epoch),
        ),
      );
    await db
      .delete(federationSigningKeys)
      .where(eq(federationSigningKeys.siteId, f.target.signing.siteId));
    await db.delete(federationSites).where(eq(federationSites.id, f.target.signing.siteId));
    await db.delete(auditLog).where(eq(auditLog.actor, f.actor.userId));
    await db.delete(federationCapabilities).where(eq(federationCapabilities.orgId, f.actor.orgId));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, f.actor.orgId));
    await db.delete(users).where(eq(users.orgId, f.actor.orgId));
    await db.delete(orgs).where(eq(orgs.id, f.actor.orgId));
  }
});

test("direct mode has no outbox or ledger calls; unconfigured attestation remains inspectable", async () => {
  const f = await fixture("bilateral_direct");
  await new FederationAttestationWorker(f.service).tick();
  expect(f.adapter.prepares).toHaveLength(0);
  expect(f.adapter.advances).toHaveLength(0);
  expect(
    (await f.service.list(f.actor, f.terms.agreementRevisionId, 50, 0)).unbatchedEvidenceCount,
  ).toBe(0);
  const attested = await fixture();
  const disabled = new FederationAttestationService(db, attested.target.signing);
  expect(await disabled.advanceNext()).toBe(false);
  expect(await disabled.list(attested.actor, attested.terms.agreementRevisionId, 50, 0)).toEqual({
    enabled: false,
    unbatchedEvidenceCount: 2,
    batches: [],
  });
});

test("concurrent batch assembly allocates evidence and sequences once, then advances the same stream", async () => {
  const f = await fixture();
  const allocated = await Promise.all(Array.from({ length: 8 }, () => f.service.assemble()));
  expect(allocated.filter(Boolean)).toHaveLength(1);
  const first = await batchFor(f.target.signing.siteId);
  expect(first.manifest.records.map((r) => r.sequence)).toEqual(["1", "2"]);
  expect(first.manifest.confirmation).toBe("unilateral");
  expect(await f.service.assemble()).toBeNull();
  await new FederationAttestationWorker(f.service).tick();
  expect((await batchFor(f.target.signing.siteId)).state).toBe("anchored");
  await f.admit();
  const secondId = await f.service.assemble();
  if (!secondId) throw new Error("Missing second batch");
  const [second] = await db.select().from(batches).where(eq(batches.id, secondId));
  expect(second?.manifest.records.map((r) => r.sequence)).toEqual(["3", "4"]);
  const [budget] = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, f.terms.budgetDomainId));
  expect(budget?.available).toBe("80");
  expect(budget?.reserved).toBe("20");
});

test("ledger downtime leaves admission independent; checkpoints survive restart and VALID finalizes atomically", async () => {
  const f = await fixture();
  f.adapter.offline = true;
  await advance(f.service, 2);
  const batch = await batchFor(f.target.signing.siteId);
  expect(batch.lastError).toBe("LEDGER_UNAVAILABLE");
  expect(batch.state).toBe("pending");
  await f.admit();
  f.adapter.offline = false;
  await ready(batch.id);
  await advance(f.service, 2);
  const [before] = await db.select().from(attempts).where(eq(attempts.batchId, batch.id));
  expect(before?.stage).toBe("transaction");
  f.adapter.outcome = "pending";
  await advance(f.service, 1);
  expect((await batchFor(f.target.signing.siteId)).state).toBe("pending");
  f.adapter.outcome = "anchored";
  await ready(batch.id);
  const restarted = new FederationAttestationService(db, f.target.signing, f.adapter);
  await advance(restarted, 1);
  const [after] = await db.select().from(attempts).where(eq(attempts.batchId, batch.id));
  expect(after?.transactionId).toBe(before?.transactionId);
  expect(after?.recovery).toBe(before?.recovery);
  expect(after?.validationCode).toBe(0);
  expect((await batchFor(f.target.signing.siteId)).state).toBe("anchored");
  expect(
    (await db.select().from(outbox).where(eq(outbox.batchId, batch.id))).every(
      (r) => r.state === "anchored",
    ),
  ).toBe(true);
  expect(f.adapter.prepares).toHaveLength(1);
});

test("expired worker cannot store a late result or release the new worker lease", async () => {
  const f = await fixture();
  await advance(f.service, 3);
  const batch = await batchFor(f.target.signing.siteId);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  f.adapter.onAdvance = async (token) => {
    const transactionId = Buffer.from(token, "base64").toString().split(":")[1];
    if (!transactionId) throw new Error("Missing transaction");
    if (count++ === 0) {
      entered();
      await blocked;
      return { state: "anchored", transactionId, blockNumber: "9" };
    }
    return { state: "pending", transactionId, recovery: token };
  };
  const late = f.service.advanceNext();
  await started;
  await db
    .update(batches)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(batches.id, batch.id));
  await advance(new FederationAttestationService(db, f.target.signing, f.adapter), 1);
  release();
  await late;
  expect((await batchFor(f.target.signing.siteId)).state).toBe("pending");
  const [attempt] = await db.select().from(attempts).where(eq(attempts.batchId, batch.id));
  expect(attempt?.stage).toBe("transaction");
  expect(f.adapter.advances.at(-1)).toBe(f.adapter.advances.at(-2));
});

test("confirmed INVALID is reviewed before a new tx; original transaction and unchanged batch remain auditable", async () => {
  const f = await fixture();
  f.adapter.outcome = "invalid";
  await new FederationAttestationWorker(f.service).tick();
  const batch = await batchFor(f.target.signing.siteId);
  expect(batch.state).toBe("needs_review");
  expect(await f.service.advanceNext()).toBe(false);
  await expect(f.service.retry(f.identity, f.terms.agreementRevisionId, batch.id)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(f.service.list(f.actor, randomUUID(), 50, 0)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await f.service.retry(f.actor, f.terms.agreementRevisionId, batch.id);
  f.adapter.outcome = "anchored";
  await new FederationAttestationWorker(f.service).tick();
  const history = await db
    .select()
    .from(attempts)
    .where(eq(attempts.batchId, batch.id))
    .orderBy(asc(attempts.number));
  expect(history.map((a) => a.stage)).toEqual(["invalid", "anchored"]);
  expect(history[0]?.transactionId).not.toBe(history[1]?.transactionId);
  expect(f.adapter.prepares[0]).toEqual(f.adapter.prepares[1]);
  expect((await batchFor(f.target.signing.siteId)).issuerJws).toBe(batch.issuerJws);
  const [audit] = await db.select().from(auditLog).where(eq(auditLog.target, batch.id));
  expect(audit?.action).toBe("federation.attestation.retry");
});

test("wrong tx response cannot replace persisted transaction; retry does not discard uncertain submissions", async () => {
  const f = await fixture();
  await advance(f.service, 3);
  const batch = await batchFor(f.target.signing.siteId);
  f.adapter.onAdvance = async () => ({
    state: "anchored",
    transactionId: "f".repeat(64),
    blockNumber: "8",
  });
  await advance(f.service, 1);
  expect((await batchFor(f.target.signing.siteId)).lastError).toBe("INVALID_ADAPTER_RESPONSE");
  const [old] = await db.select().from(attempts).where(eq(attempts.batchId, batch.id));
  await f.service.retry(f.actor, f.terms.agreementRevisionId, batch.id);
  f.adapter.onAdvance = undefined;
  await advance(f.service, 1);
  const history = await db.select().from(attempts).where(eq(attempts.batchId, batch.id));
  expect(history).toHaveLength(1);
  expect(history[0]?.transactionId).toBe(old?.transactionId);
  expect(history[0]?.stage).toBe("anchored");
});

test("a reviewed pre-submit proposal can be abandoned, but no transaction history is overwritten", async () => {
  const f = await fixture();
  await advance(f.service, 2);
  const batch = await batchFor(f.target.signing.siteId);
  f.adapter.onAdvance = async () => {
    throw new AttestationFailure("INVALID_RECOVERY", true);
  };
  await advance(f.service, 1);
  await f.service.retry(f.actor, f.terms.agreementRevisionId, batch.id);
  f.adapter.onAdvance = undefined;
  await new FederationAttestationWorker(f.service).tick();
  const history = await db
    .select()
    .from(attempts)
    .where(eq(attempts.batchId, batch.id))
    .orderBy(asc(attempts.number));
  expect(history.map((a) => a.stage)).toEqual(["abandoned", "anchored"]);
  expect(history[0]?.validationCode).toBeNull();
});

test("database constraints reject incomplete signature, membership, manifest and commit evidence", async () => {
  const f = await fixture();
  await advance(f.service, 2);
  const batch = await batchFor(f.target.signing.siteId);
  await expect(
    db.update(batches).set({ digest: null }).where(eq(batches.id, batch.id)).execute(),
  ).rejects.toThrow();
  await expect(
    db
      .update(batches)
      .set({ manifest: { ...batch.manifest, batchId: randomUUID() } })
      .where(eq(batches.id, batch.id))
      .execute(),
  ).rejects.toThrow();
  await expect(
    db.update(outbox).set({ sequence: null }).where(eq(outbox.batchId, batch.id)).execute(),
  ).rejects.toThrow();
  await expect(
    db.update(attempts).set({ stage: "anchored" }).where(eq(attempts.batchId, batch.id)).execute(),
  ).rejects.toThrow();
  await db.delete(federationCapabilities).where(eq(federationCapabilities.orgId, f.actor.orgId));
  await expect(f.service.list(f.actor, f.terms.agreementRevisionId, 50, 0)).rejects.toThrow(
    "POLICY_DENIED",
  );
});

test("attestation HTTP query and retry enforce human org authority and conceal recovery tokens", async () => {
  const f = await fixture();
  f.adapter.outcome = "invalid";
  await new FederationAttestationWorker(f.service).tick();
  const batch = await batchFor(f.target.signing.siteId);
  const app = (automation = false) => {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ level: "silent" })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, { ...f.actor, role: "admin" });
      if (automation) c.set("automation" as never, { userId: f.actor.userId });
      await next();
    });
    r.route(
      "/api",
      createFederationAgreementRoutes(
        new FederationAgreementService(db, f.target.signing),
        f.service,
      ),
    );
    return r;
  };
  const path = `/api/federation/agreements/${f.terms.agreementRevisionId}/attestation`;
  const response = await app().request(path);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("needs_review");
  expect(body).not.toContain("recovery");
  expect(body).not.toContain("leaseToken");
  expect((await app(true).request(path)).status).toBe(403);
  await db
    .update(federationCapabilities)
    .set({ capability: "agreement.read" })
    .where(eq(federationCapabilities.orgId, f.actor.orgId));
  expect((await app().request(`${path}/${batch.id}/retry`, { method: "POST" })).status).toBe(403);
  await db
    .update(federationCapabilities)
    .set({ capability: "agreement.approve" })
    .where(eq(federationCapabilities.orgId, f.actor.orgId));
  expect((await app().request(`${path}/${batch.id}/retry`, { method: "POST" })).status).toBe(200);
});
