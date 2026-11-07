import { createHash } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  federationCommercialAttempts as attempts,
  auditLog,
  federationMarketSubmissions as market,
  type PgTransaction,
  federationCommercialSubmissions as submissions,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAdapterProposalInputSchema,
  CommercialReservationSchema,
  CommercialTerminalSchema,
} from "@kuintessence/shared/federation/commercial";
import { MarketClosureSchema } from "@kuintessence/shared/federation/market";
import { and, desc, eq, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";

/** Historical VALID evidence authorizes closure even after business signing keys expire. */
export async function executionClosure(tx: PgTransaction, siteId: string, terminalId: string) {
  const [row] = await tx
    .select()
    .from(submissions)
    .where(
      and(
        eq(submissions.localSiteId, siteId),
        sql`${submissions.input}->>'operation' = 'record-execution-terminal'`,
        sql`${submissions.input}->>'recordId' = ${terminalId}`,
      ),
    );
  if (row?.state !== "committed") throw new FederationError("OPERATION_CONFLICT");
  const [attempt] = await tx
    .select()
    .from(attempts)
    .where(eq(attempts.submissionId, row.id))
    .orderBy(desc(attempts.number))
    .limit(1);
  if (
    attempt?.stage !== "committed" ||
    attempt.validationCode !== 0 ||
    attempt.blockNumber === null
  )
    throw new FederationError("OPERATION_CONFLICT");
  const input = CommercialAdapterProposalInputSchema.parse(row.input);
  const [terminal] = await tx
    .select()
    .from(terminals)
    .where(and(eq(terminals.localSiteId, siteId), eq(terminals.terminalId, terminalId)));
  if (
    !terminal?.counterpartyJws ||
    !terminal.sourceReview ||
    input.operation !== "record-execution-terminal"
  )
    throw new FederationError("OPERATION_CONFLICT");
  const payload = CommercialTerminalSchema.parse(terminal.payload);
  const [approval] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.localSiteId, siteId), eq(approvals.recordId, terminal.reservationId)));
  if (!approval?.counterpartyJws) throw new FederationError("OPERATION_CONFLICT");
  const reserve = CommercialReservationSchema.parse(approval.payload);
  const wireDigest = (value: unknown) =>
    `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  if (
    payload.sourceSiteId !== siteId ||
    input.envelope.sourceSiteId !== siteId ||
    input.envelope.targetSiteId !== payload.targetSiteId ||
    input.envelope.sourceJws !== terminal.approvalJws ||
    input.envelope.targetJws !== terminal.counterpartyJws ||
    input.domainId !== payload.domainId ||
    input.digest !== terminal.digest ||
    wireDigest(payload) !== terminal.digest ||
    payload.terminalId !== terminalId ||
    payload.reservationId !== reserve.reservationId ||
    payload.reservationDigest !== approval.digest ||
    wireDigest(reserve) !== approval.digest ||
    reserve.domainId !== payload.domainId ||
    reserve.request.mode !== "ledger_coordinated" ||
    reserve.request.senderSiteId !== siteId ||
    reserve.request.recipientSiteId !== payload.targetSiteId ||
    reserve.request.agreementRevisionId !== row.agreementRevisionId ||
    approval.agreementRevisionId !== row.agreementRevisionId ||
    payload.expectedGateVersion !== 1
  )
    throw new FederationError("OPERATION_CONFLICT");
  return {
    localOrgId: approval.localOrgId,
    requestedBy: terminal.approvedBy,
    input: {
      operation: "close-demand" as const,
      closure: MarketClosureSchema.parse({
        demandId: reserve.demandId,
        closureId: terminalId,
        expectedVersion: reserve.claimVersion + 1,
        gate: {
          domainId: reserve.domainId,
          reservationId: reserve.reservationId,
          demandId: reserve.demandId,
          claimVersion: reserve.claimVersion,
          version: payload.expectedGateVersion + 1,
          state: "TERMINAL",
          reservationDigest: approval.digest,
          expiresAt: reserve.request.expiresAt,
          terminal: { terminalId, activationId: payload.activationId, digest: terminal.digest },
        },
      }),
    },
  };
}

/** Caller holds the private submission lock; commit confirmation and enqueue are atomic. */
export async function enqueueExecutionClosure(
  tx: PgTransaction,
  siteId: string,
  terminalId: string,
) {
  const closure = await executionClosure(tx, siteId, terminalId);
  const digest = federationMaterialDigest(closure.input);
  const inserted = await tx
    .insert(market)
    .values({
      ...closure,
      id: terminalId,
      localSiteId: siteId,
      demandId: closure.input.closure.demandId,
      digest,
    })
    .onConflictDoNothing()
    .returning({ id: market.id });
  if (!inserted.length) {
    const [prior] = await tx.select().from(market).where(eq(market.id, terminalId));
    if (
      prior?.localSiteId !== siteId ||
      prior.localOrgId !== closure.localOrgId ||
      prior.digest !== digest ||
      federationMaterialDigest(prior.input) !== digest
    )
      throw new FederationError("OPERATION_CONFLICT");
    return;
  }
  await tx.insert(auditLog).values({
    actor: closure.requestedBy,
    orgId: closure.localOrgId,
    action: "federation.execution.close_enqueue",
    target: terminalId,
    diff: { after: { demandId: closure.input.closure.demandId, digest } },
  });
}
