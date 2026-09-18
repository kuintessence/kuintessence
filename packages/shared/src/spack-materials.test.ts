import { describe, expect, test } from "bun:test";
import {
  SpackMaterialManifestSchema,
  SpackMaterialPathSchema,
  SpackMaterialPublishSchema,
  spackMaterialBlobs,
} from "./spack-materials";

const blob = { digest: `sha256:${"a".repeat(64)}`, size: 10 };
const fixture = {
  version: 1,
  repository: "org/provider-a/sources",
  spec: "zlib@1.3.1",
  spackVersion: "1.0.0",
  target: "linux-x86_64",
  redistribution: "unrestricted",
  recipes: [{ repositoryId: "b".repeat(64), commit: "c".repeat(40), roots: ["."] }],
  sources: [{ path: "_source-cache/archive/ab/source.tar.gz", blob }],
  lockfile: blob,
};

describe("Spack material release contracts", () => {
  test("accepts native mirror cache and repository paths without allowing traversal", () => {
    for (const path of [
      "_source-cache/archive/ab/source.tar.gz",
      ".ci/repo",
      "zlib-1.3.1.tar.gz",
    ]) {
      expect(SpackMaterialPathSchema.safeParse(path).success).toBe(true);
    }
    for (const path of [
      "",
      "/tmp/x",
      "../x",
      "a/../x",
      "a\\x",
      "a//x",
      "https://x",
      "a/%2e",
      ".git/config",
    ]) {
      expect(SpackMaterialPathSchema.safeParse(path).success).toBe(false);
    }
  });

  test("requires unrestricted redistributability, exact version and content digests", () => {
    expect(SpackMaterialPublishSchema.safeParse(fixture).success).toBe(true);
    for (const patch of [
      { redistribution: "restricted" },
      { spackVersion: "develop" },
      { lockfile: { digest: "https://external/lock", size: 5 } },
      { lockfile: { ...blob, size: 0 } },
      { lockfile: { ...blob, size: 17 * 1024 ** 3 } },
      { downloadUrl: "https://external" },
    ]) {
      expect(SpackMaterialPublishSchema.safeParse({ ...fixture, ...patch }).success).toBe(false);
    }
  });

  test("rejects duplicate or overlapping source mirror paths", () => {
    expect(
      SpackMaterialPublishSchema.safeParse({
        ...fixture,
        sources: [...fixture.sources, ...fixture.sources],
      }).success,
    ).toBe(false);
    expect(
      SpackMaterialPublishSchema.safeParse({
        ...fixture,
        sources: [
          { path: "source", blob },
          { path: "source/file", blob },
        ],
      }).success,
    ).toBe(false);
  });

  test("a published manifest adds Registry-produced recipe archive references", () => {
    expect(SpackMaterialManifestSchema.safeParse(fixture).success).toBe(false);
    const manifest = SpackMaterialManifestSchema.parse({
      ...fixture,
      recipes: fixture.recipes.map((recipe) => ({ ...recipe, archive: blob })),
    });
    expect(spackMaterialBlobs(manifest)).toEqual([blob, blob, blob]);
  });
  test("rejects conflicting sizes across lockfile, source and recipe references", () => {
    expect(
      SpackMaterialPublishSchema.safeParse({
        ...fixture,
        lockfile: { ...blob, size: blob.size + 1 },
      }).success,
    ).toBe(false);
    expect(
      SpackMaterialManifestSchema.safeParse({
        ...fixture,
        recipes: fixture.recipes.map((recipe) => ({
          ...recipe,
          archive: { ...blob, size: blob.size + 1 },
        })),
      }).success,
    ).toBe(false);
  });
});
