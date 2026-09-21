import { afterEach, describe, expect, mock, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SpackUpstreamImport } from "@kuintessence/shared";
import {
  cleanupMaterials,
  LOCK,
  LOCK_BLOB,
  materialFixture,
  SOURCE,
  SOURCE_BLOB,
} from "../routes/spack-materials.test-helpers";
import {
  byteStream,
  createStore,
  OTHER_ORG,
  OWNER,
  PLATFORM,
  repository,
  SUPER,
  USER,
} from "../routes/spack-repositories.test-helpers";
import { materialDigest } from "./spack-material-storage";
import {
  type SpackUpstreamDownloadPort,
  SpackUpstreamImportService,
} from "./spack-upstream-import";
import { SpackUpstreamError } from "./spack-upstream-policy";

afterEach(cleanupMaterials);

const LOCK_URL = "https://sources.example.org/spack.lock";
const SOURCE_URL = "https://sources.example.org/source.tar.gz";
const BUNDLE = new TextEncoder().encode("bundle fixture");
const BUNDLE_URL = "https://sources.example.org/recipes.bundle";
type DownloadInput = Parameters<SpackUpstreamDownloadPort["withDownload"]>[0];

function downloader(
  entries = new Map([
    [LOCK_URL, LOCK],
    [SOURCE_URL, SOURCE],
    [BUNDLE_URL, BUNDLE],
  ]),
) {
  const calls: DownloadInput[] = [];
  const signals: AbortSignal[] = [];
  const port: SpackUpstreamDownloadPort = {
    async withDownload(input, signal, consume) {
      calls.push(input);
      signals.push(signal);
      signal.throwIfAborted();
      const bytes = entries.get(input.url);
      if (!bytes || materialDigest(bytes) !== input.digest || bytes.byteLength !== input.size) {
        throw new SpackUpstreamError("integrity");
      }
      return consume(byteStream(bytes));
    },
  };
  return { port, calls, signals };
}

async function fixture(recipe = repository()) {
  const f = await materialFixture({}, recipe);
  const download = downloader();
  const service = new SpackUpstreamImportService({
    downloader: download.port,
    recipeStore: f.recipes,
    materialStore: f.store,
  });
  const input: SpackUpstreamImport = {
    kind: "material",
    files: [
      { url: LOCK_URL, blob: LOCK_BLOB },
      { url: SOURCE_URL, blob: SOURCE_BLOB },
    ],
    release: f.input,
  };
  return { ...f, download, service, input, signal: new AbortController().signal };
}

function recipeInput(): SpackUpstreamImport {
  return {
    kind: "recipe",
    repository: repository().repository,
    url: BUNDLE_URL,
    digest: materialDigest(BUNDLE),
    size: BUNDLE.byteLength,
  };
}

describe("Spack online import orchestration", () => {
  test("binds URLs and exact bytes to receipts and real publication", async () => {
    const f = await fixture();
    const result = await f.service.import(f.input, OWNER, f.signal);
    expect(result.kind).toBe("material");
    if (result.kind !== "material") throw new Error("Expected material result");
    expect(f.download.calls).toEqual([
      { url: LOCK_URL, ...LOCK_BLOB },
      { url: SOURCE_URL, ...SOURCE_BLOB },
    ]);
    expect(f.download.signals).toHaveLength(2);
    expect(f.download.signals[0]).toBe(f.download.signals[1]);
    expect(f.download.signals[0]?.aborted).toBe(false);
    const stored = await f.store.getManifest(
      result.binding.repositoryId,
      result.binding.manifestDigest,
    );
    expect(stored.manifest.repository).toBe(f.input.release.repository);
    expect(stored.manifest.sources).toEqual(f.input.release.sources);
    for (const [blob, bytes] of [
      [LOCK_BLOB, LOCK],
      [SOURCE_BLOB, SOURCE],
    ] as const) {
      const downloaded = await f.store.getBlob(
        result.binding.repositoryId,
        result.binding.manifestDigest,
        blob.digest,
        USER,
      );
      expect(new Uint8Array(await new Response(downloaded.stream).arrayBuffer())).toEqual(bytes);
    }
  });

  test("imports verified recipe bytes with canonical actor without activation", async () => {
    const recipes = createStore();
    const download = downloader();
    const service = new SpackUpstreamImportService({
      downloader: download.port,
      recipeStore: recipes.store,
    });
    const result = await service.import(recipeInput(), OWNER, new AbortController().signal);
    expect(result).toMatchObject({ kind: "recipe", repository: { activeCommit: null } });
    expect(recipes.imports).toEqual([
      { repository: repository().repository, actor: OWNER.sub, bytes: BUNDLE },
    ]);
    expect(recipes.store.activate).not.toHaveBeenCalled();
    expect(download.calls).toEqual([
      { url: BUNDLE_URL, digest: materialDigest(BUNDLE), size: BUNDLE.byteLength },
    ]);
  });

  test.each([
    USER,
    PLATFORM,
    { ...OWNER, orgIds: [OTHER_ORG] },
  ])("denies namespace or publisher access before downloading", async (actor) => {
    const f = await fixture();
    await expect(f.service.import(f.input, actor, f.signal)).rejects.toMatchObject({
      status: 403,
    });
    expect(f.download.calls).toEqual([]);
    expect(f.recipes.get).not.toHaveBeenCalled();
  });

  test("configured publisher exclusions also apply to direct service calls", async () => {
    const f = await fixture();
    const service = new SpackUpstreamImportService({
      downloader: f.download.port,
      recipeStore: f.recipes,
      materialStore: f.store,
      publisherRoles: [],
    });
    await expect(service.import(f.input, SUPER, f.signal)).rejects.toMatchObject({ status: 403 });
    expect(f.download.calls).toEqual([]);
  });

  test("conceals cross-namespace recipe references before network activity", async () => {
    const f = await fixture();
    f.recipe.repository = `org/${OTHER_ORG}/recipes`;
    await expect(f.service.import(f.input, OWNER, f.signal)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.download.calls).toEqual([]);
  });

  test("cannot broaden recipe visibility even as super_admin", async () => {
    const f = await fixture();
    f.input.release.repository = "public/materials";
    await expect(f.service.import(f.input, SUPER, f.signal)).rejects.toMatchObject({
      status: 403,
    });
    expect(f.download.calls).toEqual([]);
  });

  test.each([
    "root",
    "commit",
    "diagnostics",
  ])("invalid recipe %s is rejected before downloading", async (kind) => {
    const f = await fixture();
    const selection = f.input.release.recipes[0];
    if (!selection) throw new Error("Missing selection");
    if (kind === "root") selection.roots = ["unverified"];
    if (kind === "commit") selection.commit = "b".repeat(40);
    if (kind === "diagnostics") {
      f.recipe.snapshots[0]?.diagnostics.push({
        severity: "error",
        code: "INVALID_RECIPE",
        message: "Invalid recipe",
      });
    }
    await expect(f.service.import(f.input, OWNER, f.signal)).rejects.toMatchObject({
      status: kind === "commit" ? 404 : 422,
    });
    expect(f.download.calls).toEqual([]);
  });

  test("rechecks recipe visibility at publication after downloads", async () => {
    const f = await fixture();
    const original = f.download.port.withDownload;
    f.download.port.withDownload = async (input, signal, consume) => {
      const result = await original(input, signal, consume);
      f.recipe.repository = `org/${OTHER_ORG}/recipes`;
      return result;
    };
    await expect(f.service.import(f.input, OWNER, f.signal)).rejects.toMatchObject({ status: 404 });
    expect(await readdir(f.root)).not.toContain("manifests");
  });

  test("unavailable stores and configured byte limits reject before downloading", async () => {
    const f = await fixture();
    const unavailable = new SpackUpstreamImportService({ downloader: f.download.port });
    await expect(unavailable.import(f.input, OWNER, f.signal)).rejects.toMatchObject({
      status: 503,
    });
    f.store.limits.maxBlobBytes = 1;
    await expect(f.service.import(f.input, OWNER, f.signal)).rejects.toMatchObject({ status: 413 });
    f.recipes.limits.maxBundleBytes = 1;
    await expect(f.service.import(recipeInput(), OWNER, f.signal)).rejects.toMatchObject({
      status: 413,
    });
    expect(f.download.calls).toEqual([]);
  });

  test("digest/size mismatch in staged download prevents recipe mutation", async () => {
    const recipes = createStore();
    const download = downloader(new Map([[BUNDLE_URL, SOURCE]]));
    const service = new SpackUpstreamImportService({
      downloader: download.port,
      recipeStore: recipes.store,
    });
    await expect(
      service.import(recipeInput(), OWNER, new AbortController().signal),
    ).rejects.toMatchObject({ status: 422, code: "SPACK_UPSTREAM_INTEGRITY" });
    expect(recipes.store.importBundle).not.toHaveBeenCalled();
  });

  test("real storage rejects incorrect bytes from a misbehaving downloader", async () => {
    const f = await fixture();
    f.download.port.withDownload = async (_input, _signal, consume) => consume(byteStream(SOURCE));
    await expect(f.service.import(f.input, OWNER, f.signal)).rejects.toMatchObject({ status: 422 });
    expect(await readdir(f.root)).not.toContain("manifests");
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
  });

  test("real lock validation runs before publication, not only digest validation", async () => {
    const f = await fixture();
    f.input.release.target = "linux-ubuntu24.04-aarch64";
    await expect(f.service.import(f.input, OWNER, f.signal)).rejects.toMatchObject({ status: 422 });
    expect(f.download.calls).toHaveLength(2);
    expect(f.recipes.archive).not.toHaveBeenCalled();
    expect(await readdir(f.root)).not.toContain("manifests");
  });
});

describe("Spack online import cancellation and admission", () => {
  test("pre-cancelled imports make no network or storage calls", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("private cancellation reason"));
    await expect(f.service.import(f.input, OWNER, controller.signal)).rejects.toMatchObject({
      status: 408,
      code: "UPSTREAM_IMPORT_CANCELLED",
    });
    expect(f.download.calls).toEqual([]);
    expect(f.recipes.get).not.toHaveBeenCalled();
  });

  test("cancellation before consume prevents any recipe mutation", async () => {
    const recipes = createStore();
    const controller = new AbortController();
    const service = new SpackUpstreamImportService({
      recipeStore: recipes.store,
      downloader: {
        async withDownload(_input, _signal, consume) {
          controller.abort();
          return consume(byteStream(BUNDLE));
        },
      },
    });
    await expect(service.import(recipeInput(), OWNER, controller.signal)).rejects.toMatchObject({
      code: "UPSTREAM_IMPORT_CANCELLED",
    });
    expect(recipes.store.importBundle).not.toHaveBeenCalled();
  });

  test("cancellation after a blob receipt prevents later files and publication", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const original = f.store.upload.bind(f.store);
    const upload = mock(async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });
    f.store.upload = upload;
    await expect(f.service.import(f.input, OWNER, controller.signal)).rejects.toMatchObject({
      code: "UPSTREAM_IMPORT_CANCELLED",
    });
    expect(f.download.calls).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await readdir(f.root)).toContain("receipts");
    expect(await readdir(f.root)).not.toContain("manifests");
  });

  test("recipe cancellation after commit reports unknown without claiming rollback", async () => {
    const recipes = createStore();
    const controller = new AbortController();
    const original = recipes.store.importBundle.bind(recipes.store);
    recipes.store.importBundle = mock(async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });
    const service = new SpackUpstreamImportService({
      recipeStore: recipes.store,
      downloader: downloader().port,
    });
    await expect(service.import(recipeInput(), OWNER, controller.signal)).rejects.toMatchObject({
      status: 409,
      code: "UPSTREAM_IMPORT_RESULT_UNKNOWN",
    });
    expect(recipes.imports).toHaveLength(1);
  });

  test("material cancellation after real commit preserves the published manifest", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const original = f.store.publish.bind(f.store);
    let committed: Awaited<ReturnType<typeof original>> | undefined;
    f.store.publish = async (...args) => {
      committed = await original(...args);
      controller.abort();
      return committed;
    };
    await expect(f.service.import(f.input, OWNER, controller.signal)).rejects.toMatchObject({
      status: 409,
      code: "UPSTREAM_IMPORT_RESULT_UNKNOWN",
    });
    if (!committed) throw new Error("Expected committed manifest");
    expect(
      (await f.store.getManifest(committed.repositoryId, committed.manifestDigest)).manifest.spec,
    ).toBe(f.input.release.spec);
  });

  test("bounds complete imports separately and releases admission after failure", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const service = new SpackUpstreamImportService({
      recipeStore: f.recipes,
      materialStore: f.store,
      maxConcurrentImports: 1,
      downloader: {
        async withDownload() {
          entered.resolve();
          await release.promise;
          throw new SpackUpstreamError("http");
        },
      },
    });
    const first = service.import(recipeInput(), OWNER, f.signal);
    const failed = expect(first).rejects.toMatchObject({ code: "SPACK_UPSTREAM_HTTP" });
    await entered.promise;
    await expect(service.import(recipeInput(), OWNER, f.signal)).rejects.toMatchObject({
      status: 429,
    });
    release.resolve();
    await failed;
    await expect(service.import(recipeInput(), OWNER, f.signal)).rejects.toMatchObject({
      code: "SPACK_UPSTREAM_HTTP",
    });
  });

  test("one total deadline cancels later files and releases whole-import admission", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    let observed: AbortSignal | undefined;
    const service = new SpackUpstreamImportService({
      recipeStore: f.recipes,
      materialStore: {
        limits: f.store.limits,
        async upload(_repository, digest, stream) {
          await stream.cancel();
          return { digest, size: LOCK_BLOB.size };
        },
        publish: f.store.publish.bind(f.store),
      },
      maxConcurrentImports: 1,
      totalTimeoutMs: 100,
      downloader: {
        async withDownload(input, signal, consume) {
          if (input.url === LOCK_URL) return consume(byteStream(LOCK));
          observed = signal;
          entered.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
            if (signal.aborted) resolve();
          });
          throw new SpackUpstreamError("cancelled");
        },
      },
    });
    const pending = service.import(f.input, OWNER, f.signal);
    const failed = expect(pending).rejects.toMatchObject({
      status: 408,
      code: "UPSTREAM_IMPORT_TIMEOUT",
    });
    await entered.promise;
    await failed;
    expect(observed?.aborted).toBe(true);
    expect(f.signal.aborted).toBe(false);
    expect(await readdir(f.root)).not.toContain("manifests");
    await expect(service.import(recipeInput(), OWNER, f.signal)).rejects.toMatchObject({
      code: "UPSTREAM_IMPORT_TIMEOUT",
    });
  });

  test("rejects unbounded total import deadlines", () => {
    for (const totalTimeoutMs of [0, -1, Number.POSITIVE_INFINITY, 30 * 60_000 + 1]) {
      expect(
        () => new SpackUpstreamImportService({ downloader: downloader().port, totalTimeoutMs }),
      ).toThrow("Invalid upstream import total timeout");
    }
  });
});
