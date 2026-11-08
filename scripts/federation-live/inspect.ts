import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPgDb,
  federationBudgets,
  federationCommercialAdjustments,
  federationCommercialAttempts,
  federationCommercialBills,
  federationCommercialSettlements,
  federationCommercialSubmissions,
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
  const budgets = await db.select({ domainId: federationBudgets.domainId }).from(federationBudgets);
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
      settledAmount: federationOutbound.settledAmount,
    })
    .from(federationOutbound);
  const bills = await db.select().from(federationCommercialBills);
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
  assert.equal(budgets.length, 0);
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
  const proof = await Bun.file(`${root}/ledger-proof.json`).json();
  const config = await Bun.file(`${root}/source-init.json`).json();
  const demand = await new UnixMarketClient(
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
  const gate = await new UnixCommercialClient(
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
        reservations,
        outbound,
        bills,
        settlements,
        adjustments,
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
