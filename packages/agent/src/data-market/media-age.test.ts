import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FederationMediaManifestSchema } from "@kuintessence/shared/federation";
import { MediaAge } from "@kuintessence/shared/federation/media-age";
import {
  signFederationMessage,
  verifyFederationMediaManifest,
} from "@kuintessence/shared/federation/signatures";
import { generateKeyPair } from "jose";
import { AgentDataRoots } from "./local-data-security";
import { exportMediaArchive, quarantineMediaArchive } from "./media-archive";

const binaryDirectory = process.env.KQ_MEDIA_AGE_TEST_BIN;
const live = binaryDirectory ? test : test.skip;

live(
  "real pinned age, signed manifest and managed dataset round-trip; wrong key and damaged ciphertext publish nothing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-media-age-"));
    const identityBuffers: Buffer[] = [];
    try {
      const signal = AbortSignal.timeout(20_000);
      const age = new MediaAge(binaryDirectory ?? "");
      const first = await age.generateIdentity(signal),
        second = await age.generateIdentity(signal);
      identityBuffers.push(first.identity, second.identity);
      expect(first.recipient).not.toBe(second.recipient);
      const source = join(root, "source"),
        quarantine = join(root, "quarantine");
      await mkdir(source, { mode: 0o700 });
      await mkdir(quarantine, { mode: 0o700 });
      await mkdir(join(source, "dataset"), { mode: 0o700 });
      const body = Buffer.alloc(256 * 1024, 37);
      await writeFile(join(source, "dataset", "science.dat"), body);
      const roots = new AgentDataRoots({
        datasetRoot: source,
        managedRoots: { data: "." },
        jobWorkRoot: join(root, "jobs"),
      });
      await roots.initialize();
      const keys = await generateKeyPair("RS256");
      const senderSiteId = crypto.randomUUID(),
        recipientSiteId = crypto.randomUUID();
      const now = new Date();
      const manifest = FederationMediaManifestSchema.parse({
        protocolVersion: 1,
        kind: "media-manifest",
        packageId: crypto.randomUUID(),
        senderSiteId,
        recipientSiteId,
        agreementRevisionId: crypto.randomUUID(),
        createdAt: now.toISOString(),
        subject: {
          kind: "dataset",
          asset: {
            originSiteId: senderSiteId,
            kind: "dataset",
            id: crypto.randomUUID(),
            revision: "v1",
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
        files: [
          {
            path: "science.dat",
            sizeBytes: body.length,
            sha256: createHash("sha256").update(body).digest("hex"),
            license: "CC-BY-4.0",
            provenance: { source: "test fixture", revision: "v1" },
          },
        ],
      });
      const signedManifest = await signFederationMessage(FederationMediaManifestSchema, manifest, {
        siteId: senderSiteId,
        keyId: "media-test",
        privateKey: keys.privateKey,
      });
      const verifyManifest = (jws: string) =>
        verifyFederationMediaManifest(
          jws,
          {
            siteId: senderSiteId,
            keyId: "media-test",
            publicKey: keys.publicKey,
            allowedKinds: ["media-manifest"],
            validFrom: new Date(now.getTime() - 60_000),
            validUntil: new Date(now.getTime() + 60_000),
            revoked: false,
          },
          recipientSiteId,
          now,
        );
      const cipher: Uint8Array[] = [];
      for await (const bytes of age.encrypt(
        exportMediaArchive({
          signedManifest,
          verifyManifest,
          roots,
          managedRootId: "data",
          relativePath: "dataset",
          signal,
        }),
        first.recipient,
        signal,
      ))
        cipher.push(bytes);
      const encrypted = Buffer.concat(cipher),
        file = join(root, `${manifest.packageId}.age`);
      expect(encrypted.includes(Buffer.from(signedManifest))).toBe(false);
      expect(encrypted.includes(Buffer.from(first.identity))).toBe(false);
      expect(encrypted.includes(body.subarray(0, 128))).toBe(false);
      await writeFile(file, encrypted, { mode: 0o600 });
      const receive = (identity: Buffer) =>
        quarantineMediaArchive({
          stream: age.decrypt(file, identity, signal),
          quarantineRoot: quarantine,
          maxBytes: body.length,
          reserveBytes: 1024 * 1024,
          verifyManifest,
          signal,
        });
      const result = await receive(first.identity);
      expect(result.manifest).toEqual(manifest);
      expect(await readFile(join(result.directory, "files", "science.dat"))).toEqual(body);
      await rm(result.directory, { recursive: true });
      await expect(receive(second.identity)).rejects.toThrow();
      expect(await readdir(quarantine)).toEqual([]);
      // Corrupt the final AEAD tag: previous chunks may already have reached quarantine.
      encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1] ?? 0) ^ 1;
      await writeFile(file, encrypted);
      await expect(receive(first.identity)).rejects.toThrow();
      expect(await readdir(quarantine)).toEqual([]);
      await writeFile(file, encrypted.subarray(0, encrypted.length - 32));
      await expect(receive(first.identity)).rejects.toThrow();
      expect(await readdir(quarantine)).toEqual([]);
    } finally {
      for (const identity of identityBuffers) identity.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

live("modified official binary is refused before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-media-age-pin-"));
  try {
    await copyFile(join(binaryDirectory ?? "", "age-keygen"), join(root, "age-keygen"));
    await chmod(join(root, "age-keygen"), 0o700);
    await writeFile(join(root, "age-keygen"), "#!/bin/sh\nexit 0\n");
    await expect(new MediaAge(root).generateIdentity(AbortSignal.timeout(5000))).rejects.toThrow(
      "BINARY_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

live(
  "cancelling an active encryption stops the subprocess and closes its source",
  async () => {
    const age = new MediaAge(binaryDirectory ?? "");
    const key = await age.generateIdentity(AbortSignal.timeout(5000));
    const controller = new AbortController();
    let sourceClosed = false;
    const source = (async function* () {
      try {
        for (let index = 0; index < 1000; index++) yield Buffer.alloc(64 * 1024, 11);
      } finally {
        sourceClosed = true;
      }
    })();
    try {
      await expect(
        (async () => {
          for await (const _ of age.encrypt(
            source,
            key.recipient,
            AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          )) {
            controller.abort(new Error("MEDIA_CANCELLED"));
          }
        })(),
      ).rejects.toThrow();
      expect(sourceClosed).toBe(true);
    } finally {
      key.identity.fill(0);
    }
  },
  10_000,
);
