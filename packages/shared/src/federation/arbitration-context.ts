import { z } from "zod";
import {
  CommercialArbitrationPolicySchema,
  CommercialArbitrationTaskBindingSchema,
} from "./arbitration-policy";
import { CommercialEvidenceCaseInputSchema } from "./disclosure-authorization";
import {
  assertFederationStatusQueryFresh,
  FederationError,
  federationCanonicalJson,
} from "./index";
import { FederationDigestSchema } from "./references";

const identity = {
  protocolVersion: z.literal(1),
  readId: z.uuid(),
  queryId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  scope: CommercialEvidenceCaseInputSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};
function window(value: { issuedAt: string; expiresAt: string }) {
  const duration = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  return duration > 0 && duration <= 60000;
}
export const ArbitrationContextQuerySchema = z
  .strictObject({
    ...identity,
    kind: z.literal("arbitration-context-query"),
  })
  .refine(
    (v) =>
      window(v) &&
      v.senderSiteId === v.scope.evidenceRecipientSiteId &&
      [v.scope.sourceSiteId, v.scope.targetSiteId].includes(v.recipientSiteId),
  );
export type ArbitrationContextQuery = z.infer<typeof ArbitrationContextQuerySchema>;

/** A current observation, never a freeze confirmation or permission to execute an award. */
export const ArbitrationContextSchema = z
  .strictObject({
    ...identity,
    kind: z.literal("arbitration-context"),
    queryDigest: FederationDigestSchema,
    binding: CommercialArbitrationTaskBindingSchema,
    sourceJws: z.string().min(1).max(524288),
    targetJws: z.string().min(1).max(524288),
  })
  .refine(
    (v) =>
      window(v) &&
      v.recipientSiteId === v.scope.evidenceRecipientSiteId &&
      [v.scope.sourceSiteId, v.scope.targetSiteId].includes(v.senderSiteId),
  );
export type ArbitrationContext = z.infer<typeof ArbitrationContextSchema>;

export function assertArbitrationContext(
  query: ArbitrationContextQuery,
  digest: string,
  response: ArbitrationContext,
  now: Date,
) {
  assertFederationStatusQueryFresh(query, now);
  assertFederationStatusQueryFresh(response, now);
  const b = response.binding,
    s = query.scope;
  if (
    response.queryId !== query.queryId ||
    response.readId !== query.readId ||
    response.queryDigest !== digest ||
    response.senderSiteId !== query.recipientSiteId ||
    response.recipientSiteId !== query.senderSiteId ||
    federationCanonicalJson(response.scope) !== federationCanonicalJson(s) ||
    b.arbitratorSiteId !== s.evidenceRecipientSiteId ||
    (
      [
        "caseId",
        "domainId",
        "agreementRevisionId",
        "agreementDigest",
        "sourceSiteId",
        "targetSiteId",
      ] as const
    ).some((k) => b[k] !== s[k])
  )
    throw new FederationError("POLICY_DENIED");
  if (
    Date.parse(response.expiresAt) > Date.parse(query.expiresAt) ||
    Date.parse(response.issuedAt) < Date.parse(query.issuedAt) - 60000 ||
    Date.parse(b.observedAt) < Date.parse(response.issuedAt) - 60000 ||
    Date.parse(b.observedAt) > Date.parse(response.issuedAt)
  )
    throw new FederationError("AUTHORIZATION_EXPIRED");
}

export const ArbitrationContextViewSchema = z.strictObject({
  readId: z.uuid(),
  binding: CommercialArbitrationTaskBindingSchema,
  policy: CommercialArbitrationPolicySchema,
  observations: z.tuple([
    z.strictObject({ siteId: z.uuid(), observedAt: z.iso.datetime() }),
    z.strictObject({ siteId: z.uuid(), observedAt: z.iso.datetime() }),
  ]),
  expiresAt: z.iso.datetime(),
});
