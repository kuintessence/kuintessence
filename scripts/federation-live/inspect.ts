import assert from "node:assert/strict";
import {
  createPgDb,
  federationBudgets,
  federationCommercialAttempts,
  federationCommercialSubmissions,
  federationMarketAttempts,
  federationMarketSubmissions,
  federationReservations,
  federationWorkflowBindings,
  jobs,
} from "@kuintessence/db";
import { FederationDelegationSchema } from "@kuintessence/shared/federation";
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
    })
    .from(federationCommercialAttempts);
  const budgets = await db.select({ domainId: federationBudgets.domainId }).from(federationBudgets);
  const reservations = await db
    .select({ id: federationReservations.id, operationId: federationReservations.operationId })
    .from(federationReservations);
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
  assert(demand.operation === "get-demand" && demand.demand?.status === "ACTIVE");
  assert.equal(demand.demand.activation?.activationId, proof.activationId);
  const gate = await new UnixCommercialClient(
    z.string().min(1).parse(process.env.FEDERATION_COMMERCIAL_SOCKET_PATH),
  ).query({
    operation: "get-execution-gate-hash",
    domainId: config.commercial.domainId,
    reservationId: proof.reservationId,
  });
  assert(gate.hash, "Reservation remains locked");
  if (process.argv.includes("--expired")) {
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
      (error: unknown) => error instanceof FabricClientFailure && error.code === "LEDGER_PENDING",
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
