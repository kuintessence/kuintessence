import type {
  PgTransaction,
  federationArbitrationResolutions as resolutions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  ArbitrationExecutionCommitmentSchema,
  ArbitrationExecutionReceiptSchema,
  assertArbitrationCommitment,
} from "@kuintessence/shared/federation/arbitration-execution";
import { verifyArbitrationHistory } from "./arbitration-decision-history";

type Execution = typeof resolutions.$inferSelect;
/** Validates saved execution evidence; never grants fresh authority or rechecks today's business policy. */
export async function verifyBilateralArbitrationExecution(tx: PgTransaction, row: Execution) {
  const value = row.payload;
  if (
    value.mode === "ledger_coordinated" ||
    !row.commitment ||
    !row.commitmentJws ||
    !row.counterpartyCommitment ||
    !row.counterpartyCommitmentJws ||
    !row.executionReceipt ||
    !row.executionReceiptJws
  )
    throw new FederationError("DATA_WAITING");
  const own = await verifyArbitrationHistory(
    tx,
    ArbitrationExecutionCommitmentSchema,
    row.commitmentJws,
    row.localSiteId,
    new Date(row.commitment.committedAt),
  );
  const otherSiteId =
    row.localSiteId === value.sourceSiteId ? value.targetSiteId : value.sourceSiteId;
  const peer = await verifyArbitrationHistory(
    tx,
    ArbitrationExecutionCommitmentSchema,
    row.counterpartyCommitmentJws,
    otherSiteId,
    new Date(row.counterpartyCommitment.committedAt),
  );
  assertArbitrationCommitment(own.payload, value, row.localSiteId);
  assertArbitrationCommitment(peer.payload, value, otherSiteId);
  const receipt = await verifyArbitrationHistory(
    tx,
    ArbitrationExecutionReceiptSchema,
    row.executionReceiptJws,
    value.targetSiteId,
    new Date(row.executionReceipt.executedAt),
  );
  const r = receipt.payload;
  if (
    federationCanonicalJson(own.payload) !== federationCanonicalJson(row.commitment) ||
    federationCanonicalJson(peer.payload) !== federationCanonicalJson(row.counterpartyCommitment) ||
    federationCanonicalJson(r) !== federationCanonicalJson(row.executionReceipt) ||
    federationCanonicalJson(r.resolution) !== federationCanonicalJson(value) ||
    r.sourceCommitmentDigest !==
      (row.localSiteId === value.sourceSiteId ? own.digest : peer.digest) ||
    r.targetCommitmentDigest !==
      (row.localSiteId === value.targetSiteId ? own.digest : peer.digest) ||
    Date.parse(r.executedAt) <
      Math.max(Date.parse(own.payload.committedAt), Date.parse(peer.payload.committedAt)) ||
    Date.parse(r.executedAt) > Date.now() + 60000
  )
    throw new FederationError("OPERATION_CONFLICT");
  return r;
}
