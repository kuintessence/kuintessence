import { describe, expect, test } from "bun:test";
import {
  SPACK_UPSTREAM_IMPORT_MAX_BYTES,
  SPACK_UPSTREAM_IMPORT_MAX_FILES,
  SPACK_UPSTREAM_RECIPE_MAX_BYTES,
  type SpackMaterialPublish,
  SpackUpstreamImportResultSchema,
  SpackUpstreamImportSchema,
  SpackUpstreamUrlSchema,
} from "./browser";

const source = { digest: `sha256:${"a".repeat(64)}`, size: 32 };
const lock = { digest: `sha256:${"b".repeat(64)}`, size: 64 };
const recipe = {
  kind: "recipe",
  repository: "public/recipes",
  url: "https://sources.example.org/recipes.bundle",
  ...source,
};

function material() {
  const release: SpackMaterialPublish = {
    version: 1,
    repository: "public/materials",
    spec: "hello@1.0",
    spackVersion: "1.0.0",
    target: "linux-ubuntu24.04-x86_64",
    redistribution: "unrestricted",
    lockfile: lock,
    sources: [{ path: "hello/hello-1.0.tar.gz", blob: source }],
    recipes: [{ repositoryId: "c".repeat(64), commit: "d".repeat(40), roots: ["."] }],
  };
  return {
    kind: "material",
    files: [
      { url: "https://sources.example.org/hello-1.0.tar.gz", blob: source },
      { url: "https://sources.example.org/spack.lock", blob: lock },
    ],
    release,
  };
}

describe("browser-safe Spack upstream contracts", () => {
  test("exports both discriminated requests, results and explicit limits", () => {
    expect(SpackUpstreamImportSchema.safeParse(recipe).success).toBe(true);
    expect(SpackUpstreamImportSchema.safeParse(material()).success).toBe(true);
    expect(SPACK_UPSTREAM_IMPORT_MAX_BYTES).toBe(2 * 1024 ** 2);
    expect(SPACK_UPSTREAM_IMPORT_MAX_FILES).toBe(256);
    expect(SPACK_UPSTREAM_RECIPE_MAX_BYTES).toBe(128 * 1024 ** 2);
    expect(
      SpackUpstreamImportResultSchema.safeParse({
        kind: "recipe",
        repository: {
          id: "c".repeat(64),
          repository: "public/recipes",
          activeCommit: null,
          snapshots: [],
        },
      }).success,
    ).toBe(true);
    expect(
      SpackUpstreamImportResultSchema.safeParse({
        kind: "material",
        binding: { repositoryId: "c".repeat(64), manifestDigest: source.digest },
      }).success,
    ).toBe(true);
    expect(
      SpackUpstreamImportResultSchema.safeParse({
        kind: "recipe",
        binding: { repositoryId: "c".repeat(64), manifestDigest: source.digest },
      }).success,
    ).toBe(false);
  });

  test.each([
    "http://sources.example.org/source",
    "https://user:secret@sources.example.org/source",
    "https://@sources.example.org/source",
    "https://sources.example.org/source?",
    "https://sources.example.org/source?token=secret",
    "https://sources.example.org/source#",
    "https://sources.example.org:8443/source",
    "https://[2001:4860:4860::8888]/source",
    "https://sources.example.org/\u0000source",
    "https://sources.example.org\\source",
    " https://sources.example.org/source",
    "file:///private/source",
  ])("rejects unsafe target syntax: %s", (url) => {
    expect(SpackUpstreamUrlSchema.safeParse(url).success).toBe(false);
  });

  test("accepts HTTPS/443 domains and IPv4 without relaxing deployment allowlists", () => {
    for (const url of [
      "https://sources.example.org/source",
      "https://sources.example.org:443/source",
      "https://8.8.8.8/source",
    ]) {
      expect(SpackUpstreamUrlSchema.safeParse(url).success).toBe(true);
    }
  });

  test("rejects missing, duplicate, unreferenced and conflicting file bindings", () => {
    const input = material();
    const [sourceFile, lockFile] = input.files;
    if (!sourceFile || !lockFile) throw new Error("Missing files");
    for (const files of [
      [sourceFile],
      [...input.files, sourceFile],
      [sourceFile, { ...lockFile, url: sourceFile.url }],
      [sourceFile, { ...lockFile, url: sourceFile.url.replace(".org/", ".org:443/") }],
      [sourceFile, { ...lockFile, blob: { ...lock, size: 65 } }],
      [
        ...input.files,
        { url: "https://sources.example.org/extra", blob: { ...source, digest: lock.digest } },
      ],
      [
        ...input.files,
        {
          url: "https://sources.example.org/extra",
          blob: { ...source, digest: `sha256:${"e".repeat(64)}` },
        },
      ],
    ]) {
      expect(SpackUpstreamImportSchema.safeParse({ ...input, files }).success).toBe(false);
    }
  });

  test("one digest binding may satisfy multiple source paths with identical bytes", () => {
    const input = material();
    input.release.sources.push({ path: "_source-cache/archive.tar.gz", blob: source });
    expect(SpackUpstreamImportSchema.safeParse(input).success).toBe(true);
  });

  test("enforces file count, per-file and aggregate byte limits", () => {
    expect(
      SpackUpstreamImportSchema.safeParse({ ...recipe, size: SPACK_UPSTREAM_RECIPE_MAX_BYTES + 1 })
        .success,
    ).toBe(false);
    for (const [count, size, valid] of [
      [255, 1, true],
      [256, 1, false],
      [1, 16 * 1024 ** 3 + 1, false],
      [32, 16 * 1024 ** 3, false],
    ] as const) {
      const input = material();
      input.release.sources = Array.from({ length: count }, (_, index) => ({
        path: `source-${index}.tar.gz`,
        blob: { digest: `sha256:${index.toString(16).padStart(64, "0")}`, size },
      }));
      input.files = [
        { url: "https://sources.example.org/spack.lock", blob: lock },
        ...input.release.sources.map((item) => ({
          url: `https://sources.example.org/${item.path}`,
          blob: item.blob,
        })),
      ];
      expect(SpackUpstreamImportSchema.safeParse(input).success).toBe(valid);
    }
  });

  test("refuses extra credentials and restricted redistribution", () => {
    expect(
      SpackUpstreamImportSchema.safeParse({ ...recipe, authorization: "secret" }).success,
    ).toBe(false);
    const input = material();
    expect(
      SpackUpstreamImportSchema.safeParse({
        ...input,
        release: { ...input.release, redistribution: "restricted" },
      }).success,
    ).toBe(false);
  });
});
