import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStager } from "./local-file-stager";

describe("LocalFileStager.stage", () => {
  test("copies an absolute source into workingDir/stagePath, creating parent dirs", async () => {
    const base = mkdtempSync(join(tmpdir(), "stager-src-"));
    const workDir = mkdtempSync(join(tmpdir(), "stager-work-"));
    const src = join(base, "data.txt");
    writeFileSync(src, "payload-bytes");

    const stager = new LocalFileStager();
    await stager.stage([{ fileMetadataId: src, stagePath: "in/nested/data.txt" }], workDir);

    const dest = join(workDir, "in/nested/data.txt");
    expect(readFileSync(dest, "utf8")).toBe("payload-bytes");
  });

  test("resolves a relative fileMetadataId against the configured base", async () => {
    const base = mkdtempSync(join(tmpdir(), "stager-relbase-"));
    const workDir = mkdtempSync(join(tmpdir(), "stager-relwork-"));
    writeFileSync(join(base, "rel.txt"), "from-relative");

    const stager = new LocalFileStager({ base });
    await stager.stage([{ fileMetadataId: "rel.txt", stagePath: "rel.txt" }], workDir);

    expect(readFileSync(join(workDir, "rel.txt"), "utf8")).toBe("from-relative");
  });

  test("throws a clear error when the source is missing", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "stager-missing-"));
    const stager = new LocalFileStager();
    await expect(
      stager.stage([{ fileMetadataId: "/no/such/file.txt", stagePath: "x.txt" }], workDir),
    ).rejects.toThrow(/local file staging: source not found for x\.txt: \/no\/such\/file\.txt/);
  });

  test("rejects a stagePath that escapes workingDir", async () => {
    const base = mkdtempSync(join(tmpdir(), "stager-escape-src-"));
    const workDir = mkdtempSync(join(tmpdir(), "stager-escape-work-"));
    const src = join(base, "data.txt");
    writeFileSync(src, "payload");

    const stager = new LocalFileStager();
    await expect(
      stager.stage([{ fileMetadataId: src, stagePath: "../escape.txt" }], workDir),
    ).rejects.toThrow(/escapes/);
  });

  test("is a no-op for an empty staging list", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "stager-empty-"));
    const stager = new LocalFileStager();
    await stager.stage([], workDir);
  });
});
