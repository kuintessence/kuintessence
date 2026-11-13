import { expect, test } from "bun:test";
import { generateKeyPair } from "jose";
import { FederationMediaManifestSchema } from "./media";
import {
  type FederationVerificationKey,
  signFederationMessage,
  verifyFederationMediaManifest,
} from "./signatures";
import { FederationKeyInput } from "./trust";

const source = crypto.randomUUID(),
  target = crypto.randomUUID();
const now = new Date("2026-11-08T00:00:00.000Z");
const manifest = {
  protocolVersion: 1 as const,
  kind: "media-manifest" as const,
  packageId: crypto.randomUUID(),
  senderSiteId: source,
  recipientSiteId: target,
  agreementRevisionId: crypto.randomUUID(),
  createdAt: now.toISOString(),
  subject: {
    kind: "dataset" as const,
    asset: {
      originSiteId: source,
      kind: "dataset" as const,
      id: crypto.randomUUID(),
      revision: "v1",
      digest: `sha256:${"a".repeat(64)}`,
    },
  },
  files: [
    {
      path: "data/input.dat",
      sizeBytes: 1024 ** 4,
      sha256: "b".repeat(64),
      license: null,
      provenance: null,
    },
  ],
};

test("media inventory preserves missing provenance, supports TB files, and binds task packages", () => {
  expect(FederationMediaManifestSchema.parse(manifest)).toEqual(manifest);
  expect(
    FederationMediaManifestSchema.parse({
      ...manifest,
      subject: {
        kind: "task-result",
        operationId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        attempt: 1,
        requestDigest: manifest.subject.asset.digest,
        contentDigest: manifest.subject.asset.digest,
      },
    }).subject.kind,
  ).toBe("task-result");
  for (const path of ["../escape", "/absolute", "a\\b", "a//b", "a/./b", "a\0b", "a\nb"]) {
    expect(
      FederationMediaManifestSchema.safeParse({
        ...manifest,
        files: [{ ...manifest.files[0], path }],
      }).success,
    ).toBe(false);
  }
  for (const patch of [
    { senderSiteId: target },
    { privateKey: "must-not-travel" },
    { files: [{ ...manifest.files[0], license: undefined }] },
    { files: [{ ...manifest.files[0], sizeBytes: 6 * 1024 ** 4 }] },
    { files: [manifest.files[0], manifest.files[0]] },
    { files: [manifest.files[0], { ...manifest.files[0], path: "data" }] },
  ])
    expect(FederationMediaManifestSchema.safeParse({ ...manifest, ...patch }).success).toBe(false);
});

test("media signatures bind source, recipient, current trust and explicit purpose", async () => {
  const keys = await generateKeyPair("RS256");
  const key: FederationVerificationKey = {
    siteId: source,
    keyId: "media-key",
    publicKey: keys.publicKey,
    validFrom: new Date("2026-01-01"),
    validUntil: new Date("2027-01-01"),
    revoked: false,
    allowedKinds: ["media-manifest"],
  };
  const jws = await signFederationMessage(FederationMediaManifestSchema, manifest, {
    siteId: source,
    keyId: key.keyId,
    privateKey: keys.privateKey,
  });
  expect(await verifyFederationMediaManifest(jws, key, target, now)).toEqual(manifest);
  for (const patch of [
    { revoked: true },
    { siteId: target },
    { allowedKinds: [] },
    { validUntil: now },
  ]) {
    await expect(
      verifyFederationMediaManifest(jws, { ...key, ...patch }, target, now),
    ).rejects.toThrow();
  }
  await expect(verifyFederationMediaManifest(jws, key, source, now)).rejects.toThrow();
  const future = await signFederationMessage(
    FederationMediaManifestSchema,
    { ...manifest, createdAt: "2026-12-01T00:00:00.000Z" },
    { siteId: source, keyId: key.keyId, privateKey: keys.privateKey },
  );
  await expect(verifyFederationMediaManifest(future, key, target, now)).rejects.toThrow();
  expect(FederationKeyInput.shape.allowedKinds.parse(["media-manifest"])).toEqual([
    "media-manifest",
  ]);
});
