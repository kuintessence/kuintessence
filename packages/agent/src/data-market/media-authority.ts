import { createHash } from "node:crypto";
import {
  assertMediaKeyGrant,
  type FederationMediaImportGrant,
  FederationMediaImportGrantSchema,
  type FederationMediaImportTask,
  FederationMediaKeyGrantSchema,
  FederationMediaKeyQuerySchema,
  FederationMediaManifestSchema,
  type FederationMediaRecipientKey,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  parseFederationPublicKey,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { boundedAuthorization } from "../federation/file-copy";

export async function verifyMediaImportManifest(task: FederationMediaImportTask) {
  const key = {
    ...task.signingKey,
    siteId: task.sourceSiteId,
    publicKey: await parseFederationPublicKey(task.signingKey.publicKeyPem),
    validFrom: new Date(task.signingKey.validFrom),
    validUntil: new Date(task.signingKey.validUntil),
    allowedKinds: ["media-manifest"] as const,
    revoked: false,
  };
  const verified = await verifyFederationMessage(
    FederationMediaManifestSchema,
    task.signedManifest,
    { ...key, allowedKinds: [...key.allowedKinds] },
    new Date(),
  );
  const manifest = verified.payload;
  if (
    verified.digest !== task.manifestDigest ||
    manifest.packageId !== task.packageId ||
    manifest.senderSiteId !== task.sourceSiteId ||
    manifest.recipientSiteId !== task.recipientSiteId ||
    manifest.agreementRevisionId !== task.agreementRevisionId
  )
    throw new Error("MEDIA_MANIFEST_MISMATCH");
  return manifest;
}

/** A cached source permit never survives its actual expiry, even when shorter than the refresh interval. */
export function mediaImportAuthorization(options: {
  task: FederationMediaImportTask;
  recipientKey: FederationMediaRecipientKey;
  signal: AbortSignal;
  authorize(signal: AbortSignal): Promise<FederationMediaImportGrant>;
}) {
  const { task, signal } = options;
  let current: { encryptedIdentity: string; queryDigest: string; expiresAt: number } | undefined;
  let lastAuthorized = 0;
  async function authorize(force = false) {
    signal.throwIfAborted();
    if (Date.parse(task.expiresAt) <= Date.now()) throw new Error("MEDIA_APPROVAL_EXPIRED");
    if (
      !force &&
      current &&
      Date.now() - lastAuthorized < 15_000 &&
      current.expiresAt > Date.now() + 1000
    )
      return current;
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, Math.min(10_000, Date.parse(task.expiresAt) - Date.now()))),
    ]);
    const permit = FederationMediaImportGrantSchema.parse(
      await boundedAuthorization(options.authorize(requestSignal), requestSignal),
    );
    const query = FederationMediaKeyQuerySchema.parse(permit.query);
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(query)).digest("hex")}`;
    if (
      permit.binding.generation !== task.generation ||
      permit.binding.packageId !== task.packageId ||
      permit.binding.authorizationId !== task.authorizationId ||
      permit.binding.manifestDigest !== task.manifestDigest ||
      query.senderSiteId !== task.recipientSiteId ||
      query.recipientSiteId !== task.sourceSiteId ||
      query.packageId !== task.packageId ||
      query.manifestDigest !== task.manifestDigest ||
      query.agreementRevisionId !== task.agreementRevisionId ||
      query.authorizationId !== task.authorizationId ||
      query.agentId !== task.agentId ||
      query.managedRootId !== task.managedRootId ||
      query.maxBytes !== task.maxBytes ||
      query.authorizationExpiresAt !== task.expiresAt ||
      federationCanonicalJson(query.recipientKey) !==
        federationCanonicalJson(options.recipientKey) ||
      digest !== permit.queryDigest
    )
      throw new Error("MEDIA_KEY_SCOPE_INVALID");
    const signed = await verifyFederationMessage(
      FederationMediaKeyGrantSchema,
      permit.signedGrant,
      {
        ...permit.signingKey,
        siteId: task.sourceSiteId,
        publicKey: await parseFederationPublicKey(permit.signingKey.publicKeyPem),
        validFrom: new Date(permit.signingKey.validFrom),
        validUntil: new Date(permit.signingKey.validUntil),
        allowedKinds: ["media-key-grant"],
        revoked: false,
      },
      new Date(),
    );
    assertMediaKeyGrant(query, digest, signed.payload, new Date());
    if (
      Date.parse(permit.expiresAt) <= Date.now() ||
      Date.parse(permit.expiresAt) > Date.parse(signed.payload.expiresAt) ||
      Date.parse(permit.expiresAt) > Date.parse(permit.signingKey.validUntil)
    )
      throw new Error("MEDIA_LEASE_INVALID");
    signal.throwIfAborted();
    current = {
      encryptedIdentity: signed.payload.encryptedIdentity,
      queryDigest: digest,
      expiresAt: Date.parse(permit.expiresAt),
    };
    lastAuthorized = Date.now();
    return current;
  }
  return authorize;
}
