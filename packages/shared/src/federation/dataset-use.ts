import { z } from "zod";
import { FederationError } from "./errors";
import { FederationAssetRefSchema, FederationDigestSchema } from "./references";
import { assertFederationStatusQueryFresh, hasFederationQueryWindow } from "./status";

export const FederationDatasetUseApprovalSchema = z.strictObject({
  policyId: z.uuid(),
  versionId: z.uuid(),
  recipientSiteId: z.uuid(),
  agreementRevisionId: z.uuid(),
  expiresAt: z.iso.datetime(),
  reason: z.string().trim().min(1).max(500),
});
export type FederationDatasetUseApproval = z.infer<typeof FederationDatasetUseApprovalSchema>;
const Scope = {
  protocolVersion: z.literal(1),
  queryId: z.uuid(),
  policyId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  agreementRevisionId: z.uuid(),
  asset: FederationAssetRefSchema.refine((ref) => ref.kind === "dataset"),
  replicaId: z.uuid(),
  agentId: z.string().min(1).max(255),
  managedRootId: z.uuid(),
};
export const FederationDatasetUseQuerySchema = z
  .strictObject({
    ...Scope,
    kind: z.literal("dataset-use-query"),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(hasFederationQueryWindow);
export type FederationDatasetUseQuery = z.infer<typeof FederationDatasetUseQuerySchema>;
export const FederationDatasetUseGrantSchema = z
  .strictObject({
    ...Scope,
    kind: z.literal("dataset-use-grant"),
    queryDigest: FederationDigestSchema,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(hasFederationQueryWindow);
export type FederationDatasetUseGrant = z.infer<typeof FederationDatasetUseGrantSchema>;

/** Grants only this recipient's managed replica use, never download or redistribution. */
export function assertDatasetUseGrant(
  query: FederationDatasetUseQuery,
  queryDigest: string,
  grant: FederationDatasetUseGrant,
  now: Date,
) {
  assertFederationStatusQueryFresh(query, now);
  assertFederationStatusQueryFresh(grant, now);
  if (
    grant.senderSiteId !== query.recipientSiteId ||
    grant.recipientSiteId !== query.senderSiteId ||
    grant.queryDigest !== queryDigest ||
    Date.parse(grant.expiresAt) > Date.parse(query.expiresAt) ||
    Date.parse(grant.issuedAt) < Date.parse(query.issuedAt) - 60_000 ||
    (
      [
        "queryId",
        "policyId",
        "agreementRevisionId",
        "replicaId",
        "agentId",
        "managedRootId",
      ] as const
    ).some((key) => grant[key] !== query[key]) ||
    (["kind", "originSiteId", "id", "revision", "digest"] as const).some(
      (key) => grant.asset[key] !== query.asset[key],
    )
  )
    throw new FederationError("INVALID_MESSAGE");
}
