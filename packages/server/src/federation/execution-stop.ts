import { createHash, randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  auditLog,
  type PgDb,
  type PgTransaction,
  federationMarketSubmissions as submissions,
} from "@kuintessence/db";
import {
  type FederationDelegation,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { CommercialReservationSchema } from "@kuintessence/shared/federation/commercial";
import {
  MarketExecutionStopSchema,
  MarketQueryResultSchema,
} from "@kuintessence/shared/federation/market";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { renewTaskCompletion } from "./completion-capacity";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import type { FederationStorageGuard } from "./storage-capacity";

type Approval = typeof approvals.$inferSelect;
const key = (siteId: string, recordId: string) =>
  and(eq(approvals.localSiteId, siteId), eq(approvals.recordId, recordId));

/** Caller holds the approval for update and has independently authorized the stop. */
async function recordStop(
  tx: PgTransaction,
  row: Approval,
  actor: FederationActor,
  storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
) {
  if (row.localOrgId !== actor.orgId) throw new FederationError("POLICY_DENIED");
  const reserve = CommercialReservationSchema.parse(row.payload);
  if (
    reserve.request.mode !== "ledger_coordinated" ||
    ![reserve.request.senderSiteId, reserve.request.recipientSiteId].includes(row.localSiteId) ||
    reserve.reservationId !== row.recordId ||
    `sha256:${createHash("sha256").update(JSON.stringify(reserve)).digest("hex")}` !== row.digest
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (row.stopId) return { id: row.stopId, requestedAt: row.stopRequestedAt };
  await renewTaskCompletion(tx, row.localSiteId, reserve.request, storageGuard);
  const id = randomUUID();
  const [saved] = await tx
    .update(approvals)
    .set({
      stopId: id,
      stopRequestedBy: actor.userId,
      stopRequestedAt: sql`clock_timestamp()`,
      stopNextAttemptAt: sql`clock_timestamp()`,
    })
    .where(key(row.localSiteId, row.recordId))
    .returning();
  if (!saved) throw new FederationError("OPERATION_CONFLICT");
  await tx.insert(auditLog).values({
    actor: actor.userId,
    orgId: actor.orgId,
    action: "federation.execution.stop",
    target: row.recordId,
    diff: { after: { stopId: id } },
  });
  return { id, requestedAt: saved.stopRequestedAt };
}

/** Reuse the already authorized source cancellation; do not require a second business grant. */
export async function stopCancelledExecution(
  tx: PgTransaction,
  siteId: string,
  actor: FederationActor,
  request: FederationDelegation,
  storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
) {
  if (request.mode !== "ledger_coordinated") return;
  const rows = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.localSiteId, siteId),
        eq(approvals.localOrgId, actor.orgId),
        eq(approvals.agreementRevisionId, request.agreementRevisionId),
        sql`${approvals.payload}->>'kind' = 'commercial-reservation'`,
        sql`${approvals.payload}->'request'->>'operationId' = ${request.operationId}`,
      ),
    )
    .for("update");
  for (const row of rows) {
    const reserve = CommercialReservationSchema.parse(row.payload);
    if (federationCanonicalJson(reserve.request) !== federationCanonicalJson(request))
      throw new FederationError("OPERATION_CONFLICT");
    await recordStop(tx, row, actor, storageGuard);
  }
}

/** Local denial is committed before any network I/O; ledger delivery cannot undo it. */
export class FederationExecutionStopService {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly market?: Pick<MarketClient, "query">,
    private readonly storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
  ) {}

  async request(actor: FederationActor, revisionId: string, recordId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [row] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            key(this.siteId, recordId),
            eq(approvals.localOrgId, actor.orgId),
            eq(approvals.agreementRevisionId, revisionId),
          ),
        )
        .for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      if (row.payload.kind !== "commercial-reservation") throw new FederationError("POLICY_DENIED");
      return recordStop(tx, row, actor, this.storageGuard);
    });
  }

  async advanceNext(): Promise<boolean> {
    if (!this.market) return false;
    const row = await this.db.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, this.siteId),
            sql`${approvals.stopNextAttemptAt} <= clock_timestamp()`,
          ),
        )
        .orderBy(asc(approvals.stopNextAttemptAt), asc(approvals.recordId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!pending) return;
      // Concurrent workers may query again after this delay; the immutable ID deduplicates enqueue.
      await tx
        .update(approvals)
        .set({ stopNextAttemptAt: sql`clock_timestamp() + interval '30 seconds'` })
        .where(key(this.siteId, pending.recordId));
      return pending;
    });
    if (!row) return false;
    try {
      if (!row.stopId || !row.stopRequestedBy) throw new FederationError("OPERATION_CONFLICT");
      const reserve = CommercialReservationSchema.parse(row.payload);
      const result = MarketQueryResultSchema.parse(
        await this.market.query({ operation: "get-demand", demandId: reserve.demandId }),
      );
      if (result.operation !== "get-demand")
        throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
      const state = result.demand;
      if (!state || state.status === "OPEN" || state.status === "CLAIMED")
        throw new FabricClientFailure("ACTIVATION_PENDING");
      if (state.status === "CLOSED" && state.closure?.gate.state === "REVOKED") {
        const gate = state.closure.gate;
        if (
          state.demand.demandId !== reserve.demandId ||
          state.demand.sourceSiteId !== reserve.request.senderSiteId ||
          state.claim?.providerSiteId !== reserve.request.recipientSiteId ||
          state.claim.claimId !== reserve.reservationId ||
          state.claim.commercialDomainId !== reserve.domainId ||
          gate.domainId !== reserve.domainId ||
          gate.reservationId !== reserve.reservationId ||
          gate.reservationDigest !== row.digest ||
          gate.claimVersion !== reserve.claimVersion ||
          gate.expiresAt !== reserve.request.expiresAt
        )
          throw new FederationError("OPERATION_CONFLICT");
        await this.db
          .update(approvals)
          .set({ stopNextAttemptAt: null, stopLastError: null })
          .where(
            and(
              key(this.siteId, row.recordId),
              eq(approvals.stopId, row.stopId),
              eq(approvals.digest, row.digest),
            ),
          );
        return true;
      }
      const activation = state.activation;
      if (
        !["ACTIVE", "STOPPING", "CLOSED"].includes(state.status) ||
        !activation ||
        state.demand.demandId !== reserve.demandId ||
        state.demand.sourceSiteId !== reserve.request.senderSiteId ||
        state.claim?.providerSiteId !== reserve.request.recipientSiteId ||
        state.claim.claimId !== reserve.reservationId ||
        state.claim.commercialDomainId !== reserve.domainId ||
        activation.demandId !== reserve.demandId ||
        activation.expectedVersion !== reserve.claimVersion ||
        activation.gate.reservationId !== reserve.reservationId ||
        activation.gate.reservationDigest !== row.digest ||
        activation.gate.domainId !== reserve.domainId ||
        activation.gate.demandId !== reserve.demandId ||
        activation.gate.claimVersion !== reserve.claimVersion ||
        activation.gate.version !== 1 ||
        activation.gate.state !== "READY" ||
        activation.gate.expiresAt !== reserve.request.expiresAt
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (state.status === "CLOSED") {
        await this.db
          .update(approvals)
          .set({ stopNextAttemptAt: null, stopLastError: null })
          .where(
            and(
              key(this.siteId, row.recordId),
              eq(approvals.stopId, row.stopId),
              eq(approvals.digest, row.digest),
            ),
          );
        return true;
      }
      const input = {
        operation: "request-execution-stop" as const,
        stop: MarketExecutionStopSchema.parse({
          stopId: row.stopId,
          issuerSiteId: this.siteId,
          demandId: reserve.demandId,
          activationId: activation.activationId,
          expectedVersion: activation.expectedVersion + 1,
        }),
      };
      const digest = federationMaterialDigest(input);
      await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(approvals)
          .where(key(this.siteId, row.recordId))
          .for("update");
        if (!current?.stopNextAttemptAt) return;
        if (current.stopId !== row.stopId || current.digest !== row.digest)
          throw new FederationError("OPERATION_CONFLICT");
        await tx.insert(submissions).values({
          id: input.stop.stopId,
          localSiteId: this.siteId,
          localOrgId: row.localOrgId,
          requestedBy: row.stopRequestedBy ?? row.approvedBy,
          demandId: reserve.demandId,
          input,
          digest,
        });
        await tx
          .update(approvals)
          .set({ stopNextAttemptAt: null, stopLastError: null })
          .where(key(this.siteId, row.recordId));
      });
    } catch (error) {
      const code =
        error instanceof FederationError || error instanceof FabricClientFailure
          ? error.code
          : error instanceof z.ZodError
            ? "INVALID_ADAPTER_RESPONSE"
            : "STOP_RETRY";
      await this.db
        .update(approvals)
        .set({ stopLastError: code })
        .where(
          and(key(this.siteId, row.recordId), sql`${approvals.stopNextAttemptAt} IS NOT NULL`),
        );
    }
    return true;
  }
}
