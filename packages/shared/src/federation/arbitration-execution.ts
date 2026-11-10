import { z } from "zod";
import { CommercialArbitrationResolutionSchema } from "./commercial";
import { FederationError, federationCanonicalJson } from "./index";
import { FederationDigestSchema } from "./references";

const Jws = z.string().min(1).max(32768);
/** Irrevocable local authority for this exact award; transport retries never create a new commitment. */
export const ArbitrationExecutionCommitmentSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("arbitration-execution-commitment"),
    resolution: CommercialArbitrationResolutionSchema,
    committingSiteId: z.uuid(),
    committedAt: z.iso.datetime(),
  })
  .refine(
    (v) =>
      v.resolution.mode !== "ledger_coordinated" &&
      v.resolution.outcome.action !== "resolve-without-financial-change" &&
      [v.resolution.sourceSiteId, v.resolution.targetSiteId].includes(v.committingSiteId),
  );
export type ArbitrationExecutionCommitment = z.infer<typeof ArbitrationExecutionCommitmentSchema>;
const Commitment = z.strictObject({ payload: ArbitrationExecutionCommitmentSchema, jws: Jws });
/** B creates this statement atomically with accounting; A applies only this receipt. */
export const ArbitrationExecutionReceiptSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("arbitration-execution-receipt"),
  resolution: CommercialArbitrationResolutionSchema,
  sourceCommitmentDigest: FederationDigestSchema,
  targetCommitmentDigest: FederationDigestSchema,
  executedAt: z.iso.datetime(),
});
export type ArbitrationExecutionReceipt = z.infer<typeof ArbitrationExecutionReceiptSchema>;
export const ArbitrationExecutionQuerySchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("arbitration-execution-query"),
  queryId: z.uuid(),
  sourceSiteId: z.uuid(),
  targetSiteId: z.uuid(),
  commitment: Commitment,
  issuedAt: z.iso.datetime(),
});
export const ArbitrationExecutionResponseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("arbitration-execution-response"),
  queryDigest: FederationDigestSchema,
  sourceSiteId: z.uuid(),
  targetSiteId: z.uuid(),
  commitment: Commitment,
  receipt: ArbitrationExecutionReceiptSchema,
  receiptJws: Jws,
  issuedAt: z.iso.datetime(),
});
export function assertArbitrationCommitment(
  commitment: ArbitrationExecutionCommitment,
  resolution: z.infer<typeof CommercialArbitrationResolutionSchema>,
  siteId: string,
) {
  if (
    commitment.committingSiteId !== siteId ||
    federationCanonicalJson(commitment.resolution) !== federationCanonicalJson(resolution)
  )
    throw new FederationError("OPERATION_CONFLICT");
}
