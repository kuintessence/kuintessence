import { describe, expect, test } from "bun:test";
import { SpackMaterialImportSchema } from "./spack-material-import";

const blob = (letter: string) => ({ digest: `sha256:${letter.repeat(64)}`, size: 4 });
const source = blob("a");
const lockfile = blob("b");
const pack = {
  version: 1,
  files: [
    { path: "blobs/source.tar.gz", blob: source },
    { path: "locks/root.json", blob: lockfile },
  ],
  releases: [
    {
      version: 1,
      repository: "public/materials",
      spec: "hello@1.0",
      spackVersion: "1.0.0",
      target: "linux-ubuntu24.04-x86_64",
      redistribution: "unrestricted",
      lockfile,
      sources: [{ path: "hello/hello-1.0.tar.gz", blob: source }],
      recipes: [{ repositoryId: "c".repeat(64), commit: "d".repeat(40), roots: ["."] }],
    },
  ],
};

describe("material import contract", () => {
  test("accepts a closed file set shared across distinct releases", () => {
    expect(SpackMaterialImportSchema.parse(pack).files).toHaveLength(2);
    expect(
      SpackMaterialImportSchema.parse({
        ...pack,
        releases: [...pack.releases, { ...pack.releases[0], repository: "public/other" }],
      }).releases,
    ).toHaveLength(2);
  });
  test.each([
    "/etc/passwd",
    "../secret",
    "file:///tmp/source",
    "https://upstream/source",
    "blobs\\file",
    ".git/config",
  ])("rejects unsafe input path %s", (path) => {
    expect(
      SpackMaterialImportSchema.safeParse({
        ...pack,
        files: [{ path, blob: source }, pack.files[1]],
      }).success,
    ).toBe(false);
  });
  test("rejects duplicates, overlaps, missing/extra files and inconsistent sizes", () => {
    for (const files of [
      [...pack.files, pack.files[0]],
      [pack.files[0]],
      [...pack.files, { path: "extra", blob: blob("e") }],
      [{ path: "blobs", blob: lockfile }, pack.files[0]],
      [pack.files[0], { path: "blobs/source.tar.gz", blob: lockfile }],
      [pack.files[0], { path: "locks/root.json", blob: { ...lockfile, size: 5 } }],
    ])
      expect(SpackMaterialImportSchema.safeParse({ ...pack, files }).success).toBe(false);
    expect(
      SpackMaterialImportSchema.safeParse({
        ...pack,
        releases: [...pack.releases, ...pack.releases],
      }).success,
    ).toBe(false);
  });
  test("rejects nonstandard fields, unsupported licenses and oversized batches", () => {
    for (const value of [
      { ...pack, script: "install.sh" },
      { ...pack, files: [{ ...pack.files[0], url: "https://upstream/source" }, pack.files[1]] },
      { ...pack, releases: [{ ...pack.releases[0], redistribution: "restricted" }] },
      {
        ...pack,
        releases: Array.from({ length: 201 }, (_, i) => ({
          ...pack.releases[0],
          repository: `public/r${i}`,
        })),
      },
    ])
      expect(SpackMaterialImportSchema.safeParse(value).success).toBe(false);
  });

  test("counts unique bytes across releases against the 512 GiB pack limit", () => {
    const make = (count: number) => {
      const files = Array.from({ length: count }, (_, index) => ({
        path: `blob-${index}`,
        blob: { digest: `sha256:${index.toString(16).padStart(64, "0")}`, size: 16 * 1024 ** 3 },
      }));
      return {
        version: 1,
        files,
        releases: files.map((file, index) => ({
          ...pack.releases[0],
          repository: `public/release-${index}`,
          sources: [{ path: "source.tar.gz", blob: file.blob }],
          lockfile: file.blob,
        })),
      };
    };
    expect(SpackMaterialImportSchema.safeParse(make(32)).success).toBe(true);
    expect(SpackMaterialImportSchema.safeParse(make(33)).success).toBe(false);
  });
});
