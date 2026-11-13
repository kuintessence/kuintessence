import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FederationMediaManifestSchema } from "@kuintessence/shared/federation";
import { MediaAge } from "@kuintessence/shared/federation/media-age";
import {
  signFederationMessage,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { exportSPKI, generateKeyPair } from "jose";
import { AgentDataRoots } from "./local-data-security";

export async function mediaExportFixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-media-export-"));
  const age = new MediaAge(process.env.KQ_MEDIA_AGE_TEST_BIN ?? "");
  const signal = AbortSignal.timeout(20_000);
  const identity = await age.generateIdentity(signal);
  const source = join(root, "source");
  await mkdir(join(source, "dataset"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "quarantine"), { mode: 0o700 });
  const bytes = Buffer.alloc(256 * 1024, 41);
  await writeFile(join(source, "dataset", "input.dat"), bytes);
  const managedRootId = crypto.randomUUID();
  const roots = new AgentDataRoots({
    datasetRoot: source,
    jobWorkRoot: join(root, "jobs"),
    managedRoots: { [managedRootId]: "." },
  });
  await roots.initialize();
  const sourceSiteId = crypto.randomUUID(),
    recipientSiteId = crypto.randomUUID();
  const keyPair = await generateKeyPair("RS256");
  const key = {
    siteId: sourceSiteId,
    keyId: "export-test",
    publicKey: keyPair.publicKey,
    allowedKinds: ["media-manifest"] as const,
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    revoked: false,
  };
  const manifest = FederationMediaManifestSchema.parse({
    protocolVersion: 1,
    kind: "media-manifest",
    packageId: crypto.randomUUID(),
    senderSiteId: sourceSiteId,
    recipientSiteId,
    agreementRevisionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    subject: {
      kind: "dataset",
      asset: {
        kind: "dataset",
        originSiteId: sourceSiteId,
        id: crypto.randomUUID(),
        revision: "v1",
        digest: `sha256:${"a".repeat(64)}`,
      },
    },
    files: [
      {
        path: "input.dat",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        license: "CC-BY-4.0",
        provenance: null,
      },
    ],
  });
  const signedManifest = await signFederationMessage(FederationMediaManifestSchema, manifest, {
    ...key,
    privateKey: keyPair.privateKey,
  });
  const verify = (jws: string) =>
    verifyFederationMessage(
      FederationMediaManifestSchema,
      jws,
      { ...key, allowedKinds: [...key.allowedKinds] },
      new Date(),
    );
  const task = {
    generation: crypto.randomUUID(),
    packageId: manifest.packageId,
    manifestDigest: (await verify(signedManifest)).digest,
    agentId: "source-agent",
    sourceSiteId,
    recipientSiteId,
    managedRootId,
    relativePath: "dataset",
    recipient: identity.recipient,
    signedManifest,
    signingKey: {
      keyId: key.keyId,
      publicKeyPem: await exportSPKI(keyPair.publicKey),
      validFrom: key.validFrom.toISOString(),
      validUntil: key.validUntil.toISOString(),
    },
    expiresAt: key.validUntil.toISOString(),
  };
  const options = {
    task,
    agentId: task.agentId,
    mediaDirectory: join(root, "media"),
    roots,
    age,
    signal,
    authorize: async () => {},
  };
  return {
    root,
    keyPair,
    manifest,
    age,
    identity,
    bytes,
    verify,
    options,
    cleanup: async () => {
      identity.identity.fill(0);
      await rm(root, { recursive: true, force: true });
    },
  };
}
