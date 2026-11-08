import { expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importFederationMedia } from "./media-import";
import { mediaImportFixture as fixture } from "./media-import-test-fixture";

const live = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;

live(
  "real receiver decrypts privately, reuses a verified copy without inbox, and detects tampering",
  async () => {
    const f = await fixture();
    try {
      const result = await importFederationMedia(f.options);
      expect(result.state).toBe("verified");
      expect(result.sizeBytes).toBe(f.bytes.length);
      expect(await readFile(join(f.target, "files", "input.dat"))).toEqual(f.bytes);
      await rm(f.cipher);
      expect((await importFederationMedia(f.options)).state).toBe("verified");
      await writeFile(join(f.target, "files", "extra"), "unlisted");
      await expect(importFederationMedia(f.options)).rejects.toThrow("MEDIA_IMPORT_CHANGED");
      await rm(join(f.target, "files", "extra"));
      await writeFile(join(f.target, "files", "input.dat"), Buffer.alloc(f.bytes.length));
      await expect(importFederationMedia(f.options)).rejects.toThrow("MEDIA_SOURCE_CHANGED");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
live.each(["scope", "key", "damaged", "revoked"] as const)(
  "receiver rejects %s without retaining plaintext",
  async (mode) => {
    const f = await fixture();
    try {
      let count = 0;
      if (mode === "damaged") await writeFile(f.cipher, "broken age file");
      const authorize = async () => {
        if (mode === "revoked" && ++count > 1) throw new Error("revoked");
        const grant = await f.options.authorize();
        if (mode === "scope") grant.query.managedRootId = crypto.randomUUID();
        if (mode === "key") grant.query.recipientKey.n = "b".repeat(342);
        return grant;
      };
      await expect(importFederationMedia({ ...f.options, authorize })).rejects.toThrow();
      expect(await readdir(f.parent)).toEqual([".media-work"]);
      expect(await readdir(join(f.parent, ".media-work"))).toEqual(["lock"]);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
