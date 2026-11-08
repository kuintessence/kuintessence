import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { quarantineMediaArchive } from "./media-archive";
import { exportFederationMedia } from "./media-export";

const live = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;
async function fixture() {
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

live(
  "real media export publishes complete ciphertext and replays the same completed file",
  async () => {
    const f = await fixture();
    try {
      let permits = 0;
      const receipt = await exportFederationMedia({
        ...f.options,
        authorize: async () => {
          permits++;
        },
      });
      expect(permits).toBe(2);
      const target = join(f.options.mediaDirectory, "outbox", receipt.packageId);
      const cipher = await readFile(join(target, "bundle.age"));
      expect(receipt.sha256).toBe(createHash("sha256").update(cipher).digest("hex"));
      expect(receipt.sizeBytes).toBe(cipher.length);
      expect(cipher.includes(Buffer.from(f.options.task.signedManifest))).toBe(false);
      const imported = await quarantineMediaArchive({
        stream: f.age.decrypt(join(target, "bundle.age"), f.identity.identity, f.options.signal),
        quarantineRoot: join(f.root, "quarantine"),
        maxBytes: f.bytes.length,
        reserveBytes: 1024 * 1024,
        verifyManifest: async (jws) => (await f.verify(jws)).payload,
        signal: f.options.signal,
      });
      expect(await readFile(join(imported.directory, "files", "input.dat"))).toEqual(f.bytes);
      const generation = crypto.randomUUID();
      const replay = await exportFederationMedia({
        ...f.options,
        task: { ...f.options.task, generation },
      });
      expect(replay).toEqual({ ...receipt, generation });
      expect(await readdir(join(f.options.mediaDirectory, "outbox"))).toEqual([receipt.packageId]);
      await writeFile(join(target, "bundle.age"), Buffer.alloc(cipher.length));
      await expect(exportFederationMedia(f.options)).rejects.toThrow("MEDIA_EXPORT_CHANGED");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

live(
  "revocation at publication and ciphertext stream failure leave no completed package",
  async () => {
    const f = await fixture();
    try {
      let permits = 0;
      await expect(
        exportFederationMedia({
          ...f.options,
          authorize: async () => {
            if (++permits === 2) throw new Error("revoked");
          },
        }),
      ).rejects.toThrow("revoked");
      expect(await readdir(join(f.options.mediaDirectory, "outbox"))).toEqual([]);
      await expect(
        exportFederationMedia({
          ...f.options,
          age: {
            async *encrypt() {
              yield Buffer.from("partial");
              throw new Error("stream failed");
            },
          },
        }),
      ).rejects.toThrow("stream failed");
      expect(await readdir(join(f.options.mediaDirectory, "outbox"))).toEqual([]);
      await expect(exportFederationMedia({ ...f.options, agentId: "wrong-agent" })).rejects.toThrow(
        "MEDIA_AGENT_MISMATCH",
      );
      await expect(
        exportFederationMedia({
          ...f.options,
          task: { ...f.options.task, recipientSiteId: crypto.randomUUID() },
        }),
      ).rejects.toThrow("MEDIA_MANIFEST_MISMATCH");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
