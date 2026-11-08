import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quarantineMediaArchive } from "./media-archive";
import { exportFederationMedia } from "./media-export";
import { mediaExportFixture } from "./media-test-fixtures";

const live = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;

live(
  "real media export publishes complete ciphertext and replays the same completed file",
  async () => {
    const f = await mediaExportFixture();
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
    const f = await mediaExportFixture();
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
