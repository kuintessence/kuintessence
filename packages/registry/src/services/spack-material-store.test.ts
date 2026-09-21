import { afterEach, describe, expect, mock, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  COMMIT,
  ORG,
  OTHER_ORG,
  OWNER,
  repository,
  SUPER,
  USER,
} from "../routes/spack-repositories.test-helpers";
import { materialDigest } from "./spack-material-storage";
import { SpackMaterialStore } from "./spack-material-store";

afterEach(cleanupMaterials);

describe("Spack material persistence and publication", () => {
  test("preflight reports static lock facts without generating archives or publishing", async () => {
    const f = await materialFixture();
    await f.seed();
    const report = await f.store.preflightLock(f.input, OWNER);
    expect(report).toMatchObject({ validation: "static-only", valid: true, nodeCount: 1 });
    expect(report.diagnostics.some((item) => item.severity === "warning")).toBe(true);
    expect(f.recipes.archive).not.toHaveBeenCalled();
    expect(await readdir(join(f.root, "manifests")).catch(() => [])).toEqual([]);
  });

  test.each([
    ["opaque", '{"opaque":"not a lock"}'],
    ["malformed", "invalid JSON"],
    ["wrong-spec", new TextDecoder().decode(LOCK).replace("hello@1.0", "other@1.0")],
  ])("rejects %s lock before archive generation or publication", async (_kind, text) => {
    const f = await materialFixture();
    await f.seed();
    const bytes = new TextEncoder().encode(text);
    const lockfile = await f.store.upload(
      f.input.repository,
      materialDigest(bytes),
      byteStream(bytes),
    );
    const input = { ...f.input, lockfile };
    expect((await f.store.preflightLock(input, OWNER)).valid).toBe(false);
    await expect(f.store.publish(input, OWNER)).rejects.toMatchObject({
      status: 422,
      lockPreflight: { validation: "static-only", valid: false },
    });
    expect(f.recipes.archive).not.toHaveBeenCalled();
    expect(await readdir(join(f.root, "manifests")).catch(() => [])).toEqual([]);
  });

  test("preflight requires namespace upload receipts and referenced recipe access", async () => {
    const f = await materialFixture();
    await f.seed();
    await expect(
      f.store.preflightLock({ ...f.input, repository: `org/${OTHER_ORG}/other` }, SUPER),
    ).rejects.toMatchObject({ status: 422 });
    f.recipe.repository = `org/${OTHER_ORG}/recipes`;
    await expect(f.store.preflightLock(f.input, USER)).rejects.toMatchObject({ status: 404 });
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("durable namespace receipts and exact immutable manifests survive restart", async () => {
    const f = await materialFixture();
    await f.seed();
    const restarted = new SpackMaterialStore(f.root, f.recipes);
    const binding = await restarted.publish(f.input, OWNER);
    expect(binding.repositoryId).toBe(SpackMaterialStore.repositoryId(f.input.repository));
    const again = new SpackMaterialStore(f.root, f.recipes);
    const stored = await again.getManifest(binding.repositoryId, binding.manifestDigest);
    expect(materialDigest(stored.bytes)).toBe(binding.manifestDigest);
    expect(stored.manifest.recipes[0]?.archive).toEqual({
      digest: materialDigest(new Uint8Array([0, 1, 254, 255])),
      size: 4,
    });
    expect(f.recipes.archive).toHaveBeenCalledWith(f.recipe.id, COMMIT);
    expect(await again.publish(f.input, OWNER)).toEqual(binding);
    expect((await again.getManifest(binding.repositoryId, binding.manifestDigest)).bytes).toEqual(
      stored.bytes,
    );
    const result = await again.getBlob(
      binding.repositoryId,
      binding.manifestDigest,
      LOCK_BLOB.digest,
      USER,
    );
    expect(new Uint8Array(await new Response(result.stream).arrayBuffer())).toEqual(LOCK);
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
    expect(await readdir(join(f.root, "manifests", binding.repositoryId))).toEqual([
      `${binding.manifestDigest.slice(7)}.json`,
    ]);
  });

  test("a guessed digest in another repository cannot substitute for a local upload receipt", async () => {
    const f = await materialFixture();
    await f.seed();
    for (const name of [`org/${ORG}/second`, `org/${OTHER_ORG}/foreign`, "public/other"]) {
      await expect(f.store.publish({ ...f.input, repository: name }, SUPER)).rejects.toMatchObject({
        status: 422,
      });
    }
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("rejects checksum mismatches and removes staging without issuing a receipt", async () => {
    const f = await materialFixture();
    await expect(
      f.store.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(LOCK)),
    ).rejects.toMatchObject({ status: 422 });
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
    await f.store.upload(f.input.repository, LOCK_BLOB.digest, byteStream(LOCK));
    await expect(f.store.publish(f.input, OWNER)).rejects.toMatchObject({ status: 422 });
  });

  test.each([
    "same-size",
    "truncated",
    "extended",
  ])("rejects a corrupted existing blob without issuing a new namespace receipt: %s", async (corruption) => {
    const f = await materialFixture();
    await f.store.upload("public/original", SOURCE_BLOB.digest, byteStream(SOURCE));
    const path = join(f.root, "blobs", SOURCE_BLOB.digest.slice(7, 9), SOURCE_BLOB.digest.slice(7));
    const corrupted =
      corruption === "truncated"
        ? SOURCE.slice(1)
        : corruption === "extended"
          ? new Uint8Array([...SOURCE, 0])
          : new Uint8Array(SOURCE.length).fill(120);
    await writeFile(path, corrupted);
    const restarted = new SpackMaterialStore(f.root, f.recipes);
    await expect(
      restarted.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(SOURCE)),
    ).rejects.toMatchObject({ status: 500 });
    expect((await f.upload()).status).toBe(500);
    await expect(
      readFile(
        join(
          f.root,
          "receipts",
          SpackMaterialStore.repositoryId(f.input.repository),
          `${SOURCE_BLOB.digest.slice(7)}.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(new Uint8Array(await readFile(path))).toEqual(corrupted);
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
  });

  test("verifies and reuses intact existing blobs for a new namespace receipt after restart", async () => {
    const f = await materialFixture();
    await f.store.upload("public/original", SOURCE_BLOB.digest, byteStream(SOURCE));
    const restarted = new SpackMaterialStore(f.root, f.recipes);
    expect(
      await restarted.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(SOURCE)),
    ).toEqual(SOURCE_BLOB);
    await restarted.upload(f.input.repository, LOCK_BLOB.digest, byteStream(LOCK));
    const binding = await restarted.publish(f.input, OWNER);
    const blob = await restarted.getBlob(
      binding.repositoryId,
      binding.manifestDigest,
      SOURCE_BLOB.digest,
      USER,
    );
    expect(new Uint8Array(await new Response(blob.stream).arrayBuffer())).toEqual(SOURCE);
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
  });

  test("rejects declared blob size mismatches and corrupted immutable manifests", async () => {
    const f = await materialFixture();
    await f.seed();
    await expect(
      f.store.publish({ ...f.input, lockfile: { ...LOCK_BLOB, size: LOCK_BLOB.size + 1 } }, OWNER),
    ).rejects.toMatchObject({ status: 422 });
    const binding = await f.store.publish(f.input, OWNER);
    const path = join(
      f.root,
      "manifests",
      binding.repositoryId,
      `${binding.manifestDigest.slice(7)}.json`,
    );
    await writeFile(path, `${await readFile(path, "utf8")} `);
    await expect(
      f.store.getManifest(binding.repositoryId, binding.manifestDigest),
    ).rejects.toMatchObject({ status: 500 });
  });

  test.each([
    "missing-root",
    "duplicate-root",
    "missing-commit",
    "diagnostics",
  ])("refuses unverified recipe selection: %s", async (kind) => {
    const f = await materialFixture();
    await f.seed();
    if (kind === "diagnostics") {
      f.recipe.snapshots[0]?.diagnostics.push({
        severity: "error",
        code: "BROKEN",
        message: "broken",
      });
    }
    const selection = f.input.recipes[0];
    if (!selection) throw new Error("Missing fixture selection");
    if (kind === "missing-root") selection.roots = ["other"];
    if (kind === "duplicate-root") selection.roots = ["repo", "repo"];
    if (kind === "missing-commit") selection.commit = "b".repeat(40);
    await expect(f.store.publish(f.input, OWNER)).rejects.toMatchObject({
      status: kind === "missing-commit" ? 404 : 422,
    });
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test.each([
    [`org/${ORG}/recipes`, "public/materials"],
    [`org/${ORG}/recipes`, `org/${OTHER_ORG}/materials`],
    ["user/publisher/recipes", "public/materials"],
    ["user/publisher/recipes", `org/${ORG}/materials`],
    ["user/publisher/recipes", "user/other/materials"],
  ])("does not widen %s to %s even for a super_admin", async (source, target) => {
    const f = await materialFixture({}, repository(source));
    await f.seed(target);
    await expect(f.store.publish({ ...f.input, repository: target }, SUPER)).rejects.toMatchObject({
      status: 403,
    });
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test.each([
    ["public/recipes", `org/${ORG}/materials`],
    ["public/recipes", "user/publisher/materials"],
    ["user/publisher/recipes", "user/publisher/materials"],
    [`org/${ORG}/recipes`, `org/${ORG}/materials`],
  ])("permits %s to %s without widening audience", async (source, target) => {
    const f = await materialFixture({}, repository(source));
    await f.seed(target);
    const binding = await f.store.publish({ ...f.input, repository: target }, OWNER);
    expect(binding.repositoryId).toBe(SpackMaterialStore.repositoryId(target));
  });

  test("rechecks referenced recipe namespace on delivery and rejects non-release blobs", async () => {
    const f = await materialFixture({}, repository("public/recipes"));
    await f.seed();
    const binding = await f.store.publish(f.input, SUPER);
    const unused = new TextEncoder().encode("not in this release");
    const blob = await f.store.upload(
      f.input.repository,
      materialDigest(unused),
      byteStream(unused),
    );
    await expect(
      f.store.getBlob(binding.repositoryId, binding.manifestDigest, blob.digest, USER),
    ).rejects.toMatchObject({ status: 404 });
    f.recipe.repository = `org/${OTHER_ORG}/recipes`;
    await expect(
      f.store.getBlob(binding.repositoryId, binding.manifestDigest, SOURCE_BLOB.digest, USER),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("an archive failure or wrong advertised size never publishes a release", async () => {
    const f = await materialFixture();
    await f.seed();
    f.recipes.archive.mockImplementation(async () => ({ stream: byteStream(SOURCE), size: 1 }));
    await expect(f.store.publish(f.input, OWNER)).rejects.toMatchObject({ status: 422 });
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
    expect(await readdir(join(f.root, "manifests")).catch(() => [])).toEqual([]);
  });
});

describe("material streaming bounds and cleanup", () => {
  test("enforces actual bytes and cancels rejected uploads", async () => {
    const f = await materialFixture({ maxBlobBytes: 4 });
    const cancel = mock(() => {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });
    await expect(
      f.store.upload(f.input.repository, SOURCE_BLOB.digest, stream),
    ).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
  });

  test.each([
    "idle",
    "total",
  ])("%s timeout frees capacity and removes temporary files", async (kind) => {
    const f = await materialFixture({
      idleTimeoutMs: kind === "idle" ? 15 : 1000,
      totalTimeoutMs: kind === "total" ? 30 : 1000,
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    const cancel = mock(() => {
      clearInterval(timer);
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "total") timer = setInterval(() => controller.enqueue(new Uint8Array([1])), 3);
      },
      cancel,
    });
    await expect(
      f.store.upload(f.input.repository, SOURCE_BLOB.digest, stream),
    ).rejects.toMatchObject({ status: 408 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
    expect(
      await f.store.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(SOURCE)),
    ).toEqual(SOURCE_BLOB);
  });

  test("bounds concurrent streams at four, cancels the fifth and permits later retries", async () => {
    const f = await materialFixture();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pending = Array.from({ length: 4 }, () =>
      f.store.upload(
        f.input.repository,
        SOURCE_BLOB.digest,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
        }),
      ),
    );
    const cancel = mock(() => {});
    await expect(
      f.store.upload(
        f.input.repository,
        SOURCE_BLOB.digest,
        new ReadableStream<Uint8Array>({ cancel }),
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(cancel).toHaveBeenCalledTimes(1);
    for (const controller of controllers) {
      controller.enqueue(SOURCE);
      controller.close();
    }
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => SOURCE_BLOB));
    expect(
      await f.store.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(SOURCE)),
    ).toEqual(SOURCE_BLOB);
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
  });

  test("source stream failure cleans staging and releases its slot", async () => {
    const f = await materialFixture();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("disconnected"));
      },
    });
    await expect(
      f.store.upload(f.input.repository, SOURCE_BLOB.digest, stream),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
    expect(
      await f.store.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(SOURCE)),
    ).toEqual(SOURCE_BLOB);
  });
});
