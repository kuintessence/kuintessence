import { describe, expect, test } from "bun:test";
import {
  SpackMaterialManifestSchema,
  SpackMaterialPathSchema,
  SpackMaterialPublishSchema,
  spackMaterialBlobs,
  spackMaterialInputBlobs,
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
    expect(spackMaterialBlobs(manifest)).toEqual([blob]);
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

test("v2 evidence preserves pending status, requires every source and retains all evidence blobs", () => {
  const attachment = { digest: `sha256:${"f".repeat(64)}`, size: 20 };
  const evidence = {
    version: 1,
    materials: [
      {
        subject: blob,
        license: { expression: "LicenseRef-Upstream", status: "pending" },
        provenance: [{ origin: "original-id", original: blob, evidence: attachment }],
        attachments: [{ path: "NOTICE", kind: "notice", blob: attachment }],
      },
    ],
  };
  const value = { ...fixture, version: 2, evidence };
  const parsed = SpackMaterialPublishSchema.parse(value);
  expect(parsed.version).toBe(2);
  expect(SpackMaterialPublishSchema.safeParse({ ...fixture, evidence }).success).toBe(false);
  expect(
    SpackMaterialPublishSchema.safeParse({ ...value, evidence: { ...evidence, materials: [] } })
      .success,
  ).toBe(false);
  expect(
    SpackMaterialPublishSchema.safeParse({ ...value, evidence: { ...evidence, version: 2 } })
      .success,
  ).toBe(false);
  const manifest = SpackMaterialManifestSchema.parse({
    ...value,
    recipes: fixture.recipes.map((recipe) => ({ ...recipe, archive: blob })),
  });
  expect(spackMaterialInputBlobs(parsed)).toEqual([blob, attachment]);
  expect(spackMaterialBlobs(manifest)).toEqual([blob, attachment]);
  if (parsed.version !== 2) throw new Error("v2 expected");
  expect(evidence).toEqual(parsed.evidence);
  const conflicting = structuredClone(value);
  const material = conflicting.evidence.materials[0];
  if (!material) throw new Error("evidence expected");
  material.attachments[0] = {
    path: "NOTICE",
    kind: "notice",
    blob: { ...attachment, size: attachment.size + 1 },
  };
  expect(SpackMaterialPublishSchema.safeParse(conflicting).success).toBe(false);
});
