import { createHash } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  type PgTransaction,
  federationReservationProposals as proposals,
  federationMarketRequests as requests,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  type CommercialReservation,
  CommercialReservationSchema,
} from "@kuintessence/shared/federation/commercial";
import { MarketRequestSchema } from "@kuintessence/shared/federation/market-request";
import { and, eq } from "drizzle-orm";
import { assertTaskCompletionRoom } from "./completion-capacity";
import type { FederationStorageGuard } from "./storage-capacity";

/** Accepted institutional intents keep their completion path even before an execution row exists. */
export async function assertReservationCapacity(
  tx: PgTransaction,
  siteId: string,
  orgId: string,
  payload: CommercialReservation,
  guard?: Pick<FederationStorageGuard, "assertAdmission">,
) {
  const digest = (value: unknown) =>
    `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  const expected = digest(payload);
  const [approval] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.localSiteId, siteId), eq(approvals.recordId, payload.reservationId)));
  if (approval) {
    if (
      approval.localOrgId !== orgId ||
      approval.agreementRevisionId !== payload.request.agreementRevisionId ||
      approval.digest !== expected ||
      digest(CommercialReservationSchema.parse(approval.payload)) !== expected
    )
      throw new FederationError("OPERATION_CONFLICT");
    return;
  }
  const [proposal] = await tx
    .select()
    .from(proposals)
    .where(
      and(eq(proposals.localSiteId, siteId), eq(proposals.reservationId, payload.reservationId)),
    );
  if (proposal) {
    if (
      proposal.localOrgId !== orgId ||
      proposal.agreementRevisionId !== payload.request.agreementRevisionId ||
      proposal.digest !== expected ||
      digest(CommercialReservationSchema.parse(proposal.payload)) !== expected
    )
      throw new FederationError("OPERATION_CONFLICT");
    return;
  }
  const [request] = await tx
    .select()
    .from(requests)
    .where(
      and(eq(requests.localSiteId, siteId), eq(requests.reservationId, payload.reservationId)),
    );
  if (request) {
    const accepted = MarketRequestSchema.parse(request.payload);
    if (
      request.localOrgId !== orgId ||
      request.agreementRevisionId !== payload.request.agreementRevisionId ||
      digest(accepted) !== request.digest ||
      digest(accepted.proposal) !== expected
    )
      throw new FederationError("OPERATION_CONFLICT");
    return;
  }
  await guard?.assertAdmission(payload.request.mode);
  await assertTaskCompletionRoom(tx, siteId, guard);
}
