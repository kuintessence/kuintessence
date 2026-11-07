import { z } from "zod";
import { FederationDigestSchema } from "./references";
import { hasFederationQueryWindow } from "./status";

export const CommercialApprovalRecordKindSchema = z.enum(["agreement", "reservation", "release"]);
const identity = {
  protocolVersion: z.literal(1),
  queryId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  agreementRevisionId: z.uuid(),
  domainId: z.uuid(),
  recordKind: CommercialApprovalRecordKindSchema,
  recordId: z.uuid(),
  recordDigest: FederationDigestSchema,
};
export const CommercialApprovalQuerySchema = z
  .strictObject({
    ...identity,
    kind: z.literal("commercial-approval-query"),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(hasFederationQueryWindow, "Invalid query window")
  .refine(
    (v) => v.recordKind !== "agreement" || v.recordId === v.agreementRevisionId,
    "Invalid agreement identity",
  );
export type CommercialApprovalQuery = z.infer<typeof CommercialApprovalQuerySchema>;

/** A waiting response contains no contract or signature. Approved responses are the original business JWS. */
export const CommercialApprovalWaitingSchema = z.strictObject({
  ...identity,
  kind: z.literal("commercial-approval-waiting"),
  queryDigest: FederationDigestSchema,
  observedAt: z.iso.datetime(),
});
