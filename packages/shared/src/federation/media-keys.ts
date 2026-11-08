import { z } from "zod";
import { FederationError } from "./errors";
import { FEDERATION_MEDIA_MAX_BYTES } from "./media";
import { FederationDigestSchema } from "./references";
import { assertFederationStatusQueryFresh, hasFederationQueryWindow } from "./status";

/** An encryption-only ephemeral Agent key. Private JWK parameters and signing keys are not accepted. */
export const FederationMediaRecipientKeySchema = z.strictObject({
  kty: z.literal("RSA"),
  n: z
    .string()
    .min(342)
    .max(683)
    .regex(/^[A-Za-z0-9_-]+$/),
  e: z.literal("AQAB"),
});
export type FederationMediaRecipientKey = z.infer<typeof FederationMediaRecipientKeySchema>;
const Scope = {
  protocolVersion: z.literal(1),
  queryId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  packageId: z.uuid(),
  agreementRevisionId: z.uuid(),
  manifestDigest: FederationDigestSchema,
  authorizationId: z.uuid(),
  agentId: z.string().min(1).max(255),
  managedRootId: z.uuid(),
};
export const FederationMediaKeyQuerySchema = z
  .strictObject({
    ...Scope,
    kind: z.literal("media-key-query"),
    recipientKey: FederationMediaRecipientKeySchema,
    maxBytes: z.number().int().nonnegative().max(FEDERATION_MEDIA_MAX_BYTES),
    authorizationExpiresAt: z.iso.datetime(),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(hasFederationQueryWindow)
  .refine((q) => Date.parse(q.expiresAt) <= Date.parse(q.authorizationExpiresAt));
export type FederationMediaKeyQuery = z.infer<typeof FederationMediaKeyQuerySchema>;

export const FederationMediaKeyGrantSchema = z
  .strictObject({
    ...Scope,
    kind: z.literal("media-key-grant"),
    queryDigest: FederationDigestSchema,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    encryptedIdentity: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+$/),
  })
  .refine(hasFederationQueryWindow);
export type FederationMediaKeyGrant = z.infer<typeof FederationMediaKeyGrantSchema>;

export function assertMediaKeyGrant(
  query: FederationMediaKeyQuery,
  queryDigest: string,
  grant: ReturnType<typeof FederationMediaKeyGrantSchema.parse>,
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
        "packageId",
        "agreementRevisionId",
        "manifestDigest",
        "authorizationId",
        "agentId",
        "managedRootId",
      ] as const
    ).some((key) => grant[key] !== query[key])
  )
    throw new FederationError("INVALID_MESSAGE");
}
