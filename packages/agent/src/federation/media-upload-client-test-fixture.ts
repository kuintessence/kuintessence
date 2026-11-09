import { FederationMediaUploadTaskSchema } from "@kuintessence/shared/federation";

export function mediaUploadClientTask(kind: "task-input" | "task-result") {
  const expiresAt = new Date(Date.now() + 90_000).toISOString();
  const binding = {
    transferId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    manifestDigest: `sha256:${"b".repeat(64)}`,
    path: "original.dat",
    sizeBytes: 3,
    sha256: "c".repeat(64),
  };
  return FederationMediaUploadTaskSchema.parse({
    media: {
      generation: crypto.randomUUID(),
      packageId: crypto.randomUUID(),
      authorizationId: crypto.randomUUID(),
      manifestDigest: `sha256:${"a".repeat(64)}`,
      agentId: "receiver",
      sourceSiteId: crypto.randomUUID(),
      recipientSiteId: crypto.randomUUID(),
      agreementRevisionId: crypto.randomUUID(),
      managedRootId: crypto.randomUUID(),
      maxBytes: 3,
      signedManifest: "unused.in.transport",
      signingKey: {
        keyId: "test",
        publicKeyPem: "unused in injected uploader",
        validFrom: new Date(Date.now() - 1000).toISOString(),
        validUntil: expiresAt,
      },
      expiresAt,
    },
    memberIndex: 0,
    target:
      kind === "task-input"
        ? {
            kind,
            binding: { ...binding, descriptor: "input" },
            partSize: 8 * 1024 * 1024,
            availableUntil: expiresAt,
          }
        : {
            kind,
            binding: {
              ...binding,
              outputId: `sha256:${"d".repeat(64)}`,
              partSize: 8 * 1024 * 1024,
            },
            availableUntil: expiresAt,
          },
  });
}
