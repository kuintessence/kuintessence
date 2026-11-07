import { z } from "zod";
import { FederationDigestSchema } from "./references";
import { hasFederationQueryWindow } from "./status";

const identity = {
  protocolVersion: z.literal(1),
  queryId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  agreementRevisionId: z.uuid(),
  agreementDigest: FederationDigestSchema,
};
export const AgreementApprovalQuerySchema = z
  .strictObject({
    ...identity,
    kind: z.literal("agreement-approval-query"),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(hasFederationQueryWindow, "Invalid query window");

/** An approved response is the original agreement JWS, never a second business approval. */
export const AgreementApprovalWaitingSchema = z.strictObject({
  ...identity,
  kind: z.literal("agreement-approval-waiting"),
  queryDigest: FederationDigestSchema,
  observedAt: z.iso.datetime(),
});
