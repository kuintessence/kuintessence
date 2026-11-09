import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPgDb,
  federationAttestationAttempts,
  federationAttestationOutbox,
  federationBudgets,
  federationCommercialAdjustments,
  federationCommercialAttempts,
  federationCommercialBills,
  federationCommercialPayments,
  federationCommercialRefunds,
  federationCommercialSettlements,
  federationCommercialSubmissions,
  federationEvidenceBatches,
  federationMarketAttempts,
  federationMarketSubmissions,
  federationOutbound,
  federationReservations,
  federationWorkflowBindings,
  jobs,
} from "@kuintessence/db";
import { FederationDelegationSchema, FederationError } from "@kuintessence/shared/federation";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { UnixCommercialClient } from "../../packages/server/src/federation/commercial-client";
import { FederationExecutionConfirmationService } from "../../packages/server/src/federation/execution-confirmation";
import { FabricClientFailure } from "../../packages/server/src/federation/fabric-client";
import { UnixMarketClient } from "../../packages/server/src/federation/market-client";

const url = z.string().min(1).parse(process.env.DATABASE_URL);
assert(new URL(url).pathname.startsWith("/kuintessence_unit_"));
const db = createPgDb(url);
try {
  const market = await db
    .select({
      id: federationMarketSubmissions.id,
      operation: federationMarketSubmissions.input,
      state: federationMarketSubmissions.state,
    })
    .from(federationMarketSubmissions);
  const marketTransactions = await db
    .select({
      submissionId: federationMarketAttempts.submissionId,
      transactionId: federationMarketAttempts.transactionId,
      stage: federationMarketAttempts.stage,
      validationCode: federationMarketAttempts.validationCode,
      blockNumber: federationMarketAttempts.blockNumber,
    })
    .from(federationMarketAttempts);
  const commercial = await db
    .select({
      id: federationCommercialSubmissions.id,
      input: federationCommercialSubmissions.input,
      lastError: federationCommercialSubmissions.lastError,
      state: federationCommercialSubmissions.state,
    })
    .from(federationCommercialSubmissions);
  const commercialTransactions = await db
    .select({
      submissionId: federationCommercialAttempts.submissionId,
      transactionId: federationCommercialAttempts.transactionId,
      stage: federationCommercialAttempts.stage,
      validationCode: federationCommercialAttempts.validationCode,
      blockNumber: federationCommercialAttempts.blockNumber,
      recoveryDigest: sql<string>`md5(${federationCommercialAttempts.recovery})`,
    })
    .from(federationCommercialAttempts);
  const budgets = await db.select().from(federationBudgets);
  const attestationOutbox = await db.select().from(federationAttestationOutbox);
  const attestationAttempts = await db
    .select({
      batchId: federationAttestationAttempts.batchId,
      transactionId: federationAttestationAttempts.transactionId,
      stage: federationAttestationAttempts.stage,
      validationCode: federationAttestationAttempts.validationCode,
      blockNumber: federationAttestationAttempts.blockNumber,
      recoveryDigest: sql<string>`md5(${federationAttestationAttempts.recovery})`,
    })
    .from(federationAttestationAttempts);
  const evidenceBatches = await db.select().from(federationEvidenceBatches);
  const reservations = await db
    .select({
      id: federationReservations.id,
      operationId: federationReservations.operationId,
      amount: federationReservations.amount,
      settledAmount: federationReservations.settledAmount,
    })
    .from(federationReservations);
  const outbound = await db
    .select({
      operationId: federationOutbound.operationId,
      amount: federationOutbound.amount,
      adjustmentHeldAmount: federationOutbound.adjustmentHeldAmount,
      settledAmount: federationOutbound.settledAmount,
    })
    .from(federationOutbound);
  const refunds = await db.select().from(federationCommercialRefunds);
  const bills = await db.select().from(federationCommercialBills);
  const payments = await db.select().from(federationCommercialPayments);
  const adjustments = await db.select().from(federationCommercialAdjustments);
  const settlements = await db.select().from(federationCommercialSettlements);
  const bindings = await db
    .select({
      reservationId: federationWorkflowBindings.reservationId,
      workflowRunId: federationWorkflowBindings.workflowRunId,
    })
    .from(federationWorkflowBindings);
  const execution = await db
    .select({ id: jobs.id, status: jobs.status, schedulerJobId: jobs.schedulerJobId })
    .from(jobs);
  const coordinated = process.env.LAB_MODE === "ledger_coordinated";
  if (coordinated) assert.equal(budgets.length, 0);
  else {
    assert(["bilateral_direct", "bilateral_attested"].includes(process.env.LAB_MODE ?? ""));
    assert.equal(market.length, 0);
    assert.equal(marketTransactions.length, 0);
    if (process.env.LAB_MODE === "bilateral_direct") {
      for (const name of [
        "FEDERATION_COMMERCIAL_SOCKET_PATH",
        "FEDERATION_MARKET_SOCKET_PATH",
        "FEDERATION_ATTESTATION_SOCKET_PATH",
      ])
        assert.equal(process.env[name], undefined);
      for (const rows of [
        market,
        marketTransactions,
        commercial,
        commercialTransactions,
        attestationOutbox,
        attestationAttempts,
        evidenceBatches,
      ])
        assert.equal(rows.length, 0, "Direct cooperation created ledger work");
    }
    for (const budget of budgets) {
      assert.equal(BigInt(budget.available) + BigInt(budget.reserved) + BigInt(budget.spent), 100n);
      assert(
        BigInt(budget.available) >= 0n &&
          BigInt(budget.reserved) >= 0n &&
          BigInt(budget.spent) >= 0n,
      );
    }
  }
  for (const batch of evidenceBatches.filter((row) => row.state === "anchored")) {
    assert(
      attestationAttempts.some(
        (row) =>
          row.batchId === batch.id &&
          row.stage === "anchored" &&
          row.validationCode === 0 &&
          row.blockNumber !== null,
      ),
    );
  }
  for (const record of [...market, ...commercial].filter((r) => r.state === "committed")) {
    const attempts = [...marketTransactions, ...commercialTransactions].filter(
      (a) => a.submissionId === record.id,
    );
    assert(
      attempts.some(
        (a) =>
          a.stage === "committed" &&
          a.validationCode === 0 &&
          a.blockNumber !== null &&
          a.transactionId,
      ),
    );
  }
  const root = z.string().min(1).parse(process.env.LAB_ROOT);
  let demand: Awaited<ReturnType<UnixMarketClient["query"]>> | null = null;
  let gate: Awaited<ReturnType<UnixCommercialClient["query"]>> | null = null;
  if (coordinated) {
    const proof = await Bun.file(`${root}/ledger-proof.json`).json();
    const config = await Bun.file(`${root}/source-init.json`).json();
    demand = await new UnixMarketClient(
      z.string().min(1).parse(process.env.FEDERATION_MARKET_SOCKET_PATH),
    ).query({
      operation: "get-demand",
      demandId: proof.demandId,
    });
    const closed = process.argv.includes("--closed");
    assert(demand.operation === "get-demand" && demand.demand);
    assert(
      closed
        ? demand.demand.status === "CLOSED"
        : demand.demand.status === "ACTIVE" ||
            (process.env.LAB_SCENARIO === "stop" && demand.demand.status === "STOPPING"),
    );
    assert.equal(demand.demand.activation?.activationId, proof.activationId);
    gate = await new UnixCommercialClient(
      z.string().min(1).parse(process.env.FEDERATION_COMMERCIAL_SOCKET_PATH),
    ).query({
      operation: "get-execution-gate-hash",
      domainId: config.commercial.domainId,
      reservationId: proof.reservationId,
    });
    assert(gate.hash, "Original reservation gate remains available");
    if (closed) {
      const closure = demand.demand.closure;
      assert(closure);
      assert.equal(closure.gate.terminal?.activationId, proof.activationId);
      assert.equal(closure.gate.state, "TERMINAL");
      assert.equal(closure.gate.version, 2);
      assert.equal(closure.gate.reservationId, proof.reservationId);
      assert.equal(
        gate.hash,
        createHash("sha256").update(JSON.stringify(closure.gate)).digest("hex"),
      );
      const actor = await Bun.file(
        `${root}/${process.env.FEDERATION_SITE_ID === config.source.siteId ? "source-actor" : "registration"}.json`,
      ).json();
      const service = new FederationExecutionConfirmationService(
        db,
        z.string().min(1).parse(process.env.FEDERATION_SITE_ID),
      );
      await assert.rejects(
        db.transaction((tx) =>
          service.authorize(
            tx,
            actor.orgId,
            FederationDelegationSchema.parse(config.request),
            "execution",
          ),
        ),
        (error: unknown) => error instanceof FederationError && error.code === "POLICY_DENIED",
      );
    }
    if (process.argv.includes("--expired") || process.argv.includes("--stopped")) {
      const actor = await Bun.file(`${root}/registration.json`).json();
      const service = new FederationExecutionConfirmationService(
        db,
        z.string().min(1).parse(process.env.FEDERATION_SITE_ID),
      );
      await assert.rejects(
        db.transaction((tx) =>
          service.authorize(
            tx,
            actor.orgId,
            FederationDelegationSchema.parse(config.request),
            "execution",
          ),
        ),
        (error: unknown) =>
          process.argv.includes("--stopped")
            ? error instanceof FederationError && error.code === "CANCELLATION_REQUESTED"
            : error instanceof FabricClientFailure && error.code === "LEDGER_PENDING",
      );
    }
  }
  await Bun.write(
    z.string().min(1).parse(process.env.LAB_EVIDENCE),
    JSON.stringify(
      {
        siteId: process.env.FEDERATION_SITE_ID,
        market,
        marketTransactions,
        commercial,
        commercialTransactions,
        budgets,
        attestationOutbox,
        attestationAttempts,
        evidenceBatches,
        reservations,
        outbound,
        bills,
        refunds,
        settlements,
        adjustments,
        payments,
        bindings,
        execution,
        demand,
        gate,
      },
      null,
      2,
    ),
  );
} finally {
  await db.$client.end();
}
