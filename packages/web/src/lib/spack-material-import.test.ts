import type { SpackMaterialBlob, SpackMaterialImport } from "@kuintessence/shared/browser";
import { describe, expect, test, vi } from "vitest";
import {
  type MaterialImportProgress,
  matchMaterialFiles,
  readMaterialPack,
  runMaterialImport,
} from "./spack-material-import";

function materialPackFixture(repository = "public/materials") {
  const source = { digest: `sha256:${"a".repeat(64)}`, size: 6 };
  const lock = { digest: `sha256:${"b".repeat(64)}`, size: 4 };
  const pack: SpackMaterialImport = {
    version: 1,
    files: [
      { path: "source.tar.gz", blob: source },
      { path: "root.lock", blob: lock },
    ],
    releases: [
      {
        version: 1,
        repository,
        spec: "hello@1.0",
        spackVersion: "1.0.0",
        target: "linux-ubuntu24.04-x86_64",
        redistribution: "unrestricted",
        lockfile: lock,
        sources: [{ path: "hello/source.tar.gz", blob: source }],
        recipes: [{ repositoryId: "c".repeat(64), commit: "d".repeat(40), roots: ["."] }],
      },
    ],
  };
  const sourceFile = new File(["source"], "source.tar.gz");
  const lockFile = new File(["lock"], "root.lock");
  const files = new Map([
    [source.digest, sourceFile],
    [lock.digest, lockFile],
  ]);
  return {
    pack,
    source,
    lock,
    sourceFile,
    lockFile,
    files,
    manifest: new File([JSON.stringify(pack)], "manifest.json"),
    binding: { repositoryId: "e".repeat(64), manifestDigest: `sha256:${"f".repeat(64)}` },
  };
}

describe("browser material pack inputs", () => {
  test("only reads the bounded manifest and rejects invalid encoding/schema", async () => {
    const f = materialPackFixture();
    expect(await readMaterialPack(f.manifest)).toEqual(f.pack);
    for (const file of [
      new File([""], "empty.json"),
      new File([" ".repeat(2 * 1024 ** 2 + 1)], "large.json"),
      new File([new Uint8Array([0xff])], "invalid.json"),
      new File(['{"version":2}'], "schema.json"),
    ])
      await expect(readMaterialPack(file)).rejects.toMatchObject({ code: "invalidManifest" });
    await expect(readMaterialPack(f.manifest, AbortSignal.abort())).rejects.toThrow();
  });

  test("matches flat files without reading source contents", () => {
    const f = materialPackFixture();
    const read = vi.spyOn(f.sourceFile, "arrayBuffer");
    expect(
      matchMaterialFiles(f.pack, [f.sourceFile, f.lockFile], "files", "manifest.json"),
    ).toEqual(f.files);
    expect(read).not.toHaveBeenCalled();
  });

  test("strips exactly one selected directory and accepts its manifest, never basename fallbacks", () => {
    const f = materialPackFixture();
    f.pack.files[0] = { path: "blobs/source.tar.gz", blob: f.source };
    Object.defineProperty(f.sourceFile, "webkitRelativePath", {
      value: "pack/blobs/source.tar.gz",
    });
    Object.defineProperty(f.lockFile, "webkitRelativePath", { value: "pack/root.lock" });
    Object.defineProperty(f.manifest, "webkitRelativePath", { value: "pack/manifest.json" });
    expect(
      matchMaterialFiles(
        f.pack,
        [f.manifest, f.sourceFile, f.lockFile],
        "directory",
        "manifest.json",
      ),
    ).toEqual(f.files);
    expect(() =>
      matchMaterialFiles(f.pack, [f.sourceFile, f.lockFile], "files", "manifest.json"),
    ).toThrow();
  });

  test("rejects missing, duplicate, extra, mismatched-size and unsafe selected paths", () => {
    const f = materialPackFixture();
    for (const selected of [
      [f.sourceFile],
      [f.sourceFile, f.sourceFile, f.lockFile],
      [f.sourceFile, f.lockFile, new File(["extra"], "extra")],
      [new File(["bad"], "source.tar.gz"), f.lockFile],
    ])
      expect(() => matchMaterialFiles(f.pack, selected, "files", "manifest.json")).toThrow();
    for (const path of [
      "pack/../source.tar.gz",
      "pack/.git/source.tar.gz",
      "/source.tar.gz",
      "source.tar.gz",
    ]) {
      const file = new File(["source"], "source.tar.gz");
      Object.defineProperty(file, "webkitRelativePath", { value: path });
      expect(() =>
        matchMaterialFiles(f.pack, [file, f.lockFile], "directory", "manifest.json"),
      ).toThrow();
    }
  });
});

describe("browser material import queue", () => {
  function setup() {
    const f = materialPackFixture();
    const controller = new AbortController();
    const progress: MaterialImportProgress[] = [];
    const upload = vi.fn(async (_repository: string, blob: SpackMaterialBlob) => blob);
    const publish = vi.fn(async () => f.binding);
    const canWriteRepository = vi.fn(() => true);
    const options = {
      pack: f.pack,
      files: f.files,
      indices: [0],
      signal: controller.signal,
      canWriteRepository,
      onProgress: (event: MaterialImportProgress) => progress.push(event),
    };
    return { ...f, controller, progress, upload, publish, canWriteRepository, options };
  }

  test("uploads original Files sequentially, then publishes with the same signal", async () => {
    const f = setup();
    await runMaterialImport(f.options, { upload: f.upload, publish: f.publish });
    expect(f.upload.mock.calls.map((call) => call[1])).toEqual([f.lock, f.source]);
    expect(f.upload).toHaveBeenNthCalledWith(
      1,
      "public/materials",
      f.lock,
      f.lockFile,
      f.controller.signal,
    );
    expect(f.publish).toHaveBeenCalledWith(f.pack.releases[0], f.controller.signal);
    expect(f.progress.at(-1)).toMatchObject({ index: 0, status: "published", binding: f.binding });
  });

  test("validates all files and pending destinations before any upload", async () => {
    const f = setup();
    f.canWriteRepository.mockReturnValue(false);
    await expect(
      runMaterialImport(f.options, { upload: f.upload, publish: f.publish }),
    ).rejects.toThrow();
    f.canWriteRepository.mockReturnValue(true);
    f.files.delete(f.source.digest);
    await expect(
      runMaterialImport(f.options, { upload: f.upload, publish: f.publish }),
    ).rejects.toThrow();
    expect(f.upload).not.toHaveBeenCalled();
  });

  test("continues after a rejected release and deduplicates only within each namespace", async () => {
    const f = setup();
    const first = f.pack.releases[0];
    if (!first) throw new Error("Missing fixture");
    f.pack.releases.push({ ...first, spec: "other@1.0" }, { ...first, repository: "public/other" });
    f.options.indices = [0, 1, 2];
    f.publish.mockRejectedValueOnce({ status: 422 });
    await runMaterialImport(f.options, { upload: f.upload, publish: f.publish });
    expect(f.upload).toHaveBeenCalledTimes(4);
    expect(
      f.progress
        .filter((item) => ["failed", "published"].includes(item.status))
        .map((item) => item.status),
    ).toEqual(["failed", "published", "published"]);
  });

  test("a retry uploads only selected releases and revalidates their receipts", async () => {
    const f = setup();
    const first = f.pack.releases[0];
    if (!first) throw new Error("Missing fixture");
    f.pack.releases.push({ ...first, repository: "public/other" });
    f.options.indices = [1];
    await runMaterialImport(f.options, { upload: f.upload, publish: f.publish });
    expect(f.upload).toHaveBeenCalledTimes(2);
    expect(f.upload.mock.calls.every((call) => call[0] === "public/other")).toBe(true);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  test("cancellation after upload prevents publication and all later requests", async () => {
    const f = setup();
    f.upload.mockImplementationOnce(async (_repository, blob) => {
      f.controller.abort();
      return blob;
    });
    await expect(
      runMaterialImport(f.options, { upload: f.upload, publish: f.publish }),
    ).rejects.toThrow();
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.progress.at(-1)?.status).toBe("interrupted");
  });

  test("marks an interrupted or lost publication response as uncertain, never rolled back", async () => {
    const f = setup();
    f.publish.mockImplementationOnce(async () => {
      f.controller.abort();
      return f.binding;
    });
    await expect(
      runMaterialImport(f.options, { upload: f.upload, publish: f.publish }),
    ).rejects.toThrow();
    expect(f.progress.at(-1)?.status).toBe("uncertain");
    const retry = setup();
    retry.publish.mockRejectedValueOnce({ status: 503 });
    await runMaterialImport(retry.options, { upload: retry.upload, publish: retry.publish });
    expect(retry.progress.at(-1)?.status).toBe("uncertain");
  });

  test.each([401, 403])("stops the queue on server authorization status %s", async (status) => {
    const f = setup();
    f.upload.mockRejectedValueOnce({ status });
    await expect(
      runMaterialImport(f.options, { upload: f.upload, publish: f.publish }),
    ).rejects.toThrow();
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });

  test("session/context loss after an upload prevents further writes", async () => {
    const f = setup();
    f.upload.mockImplementationOnce(async (_repository, blob) => {
      f.canWriteRepository.mockReturnValue(false);
      return blob;
    });
    await expect(
      runMaterialImport(f.options, { upload: f.upload, publish: f.publish }),
    ).rejects.toThrow();
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
});
