import { afterEach, describe, expect, mock, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupMaterials,
  LOCK,
  LOCK_BLOB,
  materialFixture,
  SOURCE,
  SOURCE_BLOB,
} from "../routes/spack-materials.test-helpers";
import { byteStream, OWNER, USER } from "../routes/spack-repositories.test-helpers";
import { SpackMaterialError } from "./spack-material-storage";
import { SpackMaterialStore } from "./spack-material-store";

afterEach(cleanupMaterials);

const UNAVAILABLE = {
  status: 503,
  message: "Material repository storage is unavailable",
  lockPreflight: undefined,
};

async function expectUnavailable(result: Promise<unknown>): Promise<void> {
  await expect(result).rejects.toBeInstanceOf(SpackMaterialError);
  await expect(result).rejects.toMatchObject(UNAVAILABLE);
  await expect(result).rejects.not.toHaveProperty("cause");
}

async function fencedFixture() {
  const f = await materialFixture();
  const state: { denied: boolean; failure: unknown } = {
    denied: false,
    failure: new Error("rollout paused"),
  };
  const assertRuntime = mock(async () => {
    if (state.denied) throw state.failure;
  });
  const store = new SpackMaterialStore(f.root, f.recipes, {}, { assertRuntime });
  const seed = async () => {
    await store.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(SOURCE));
    await store.upload(f.input.repository, LOCK_BLOB.digest, byteStream(LOCK));
  };
  return { ...f, store, seed, state, assertRuntime };
}

async function publishedFixture() {
  const f = await fencedFixture();
  await f.seed();
  const binding = await f.store.publish(f.input, OWNER);
  const { manifest } = await f.store.getManifest(binding.repositoryId, binding.manifestDigest);
  const operations = {
    list: () => f.store.list({}, USER),
    upload: () => f.store.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(SOURCE)),
    publish: () => f.store.publish(f.input, OWNER),
    preflightLock: () => f.store.preflightLock(f.input, OWNER),
    getManifest: () => f.store.getManifest(binding.repositoryId, binding.manifestDigest),
    authorizeManifest: () => f.store.authorizeManifest(manifest, USER),
    getBlob: async () => {
      const blob = await f.store.getBlob(
        binding.repositoryId,
        binding.manifestDigest,
        SOURCE_BLOB.digest,
        USER,
      );
      expect(new Uint8Array(await new Response(blob.stream).arrayBuffer())).toEqual(SOURCE);
    },
  };
  return { ...f, binding, operations };
}

describe("material runtime admissions", () => {
  test.each([
    "list",
    "upload",
    "publish",
    "preflightLock",
    "getManifest",
    "authorizeManifest",
    "getBlob",
  ] as const)("%s rechecks the same instance after denial and recovery", async (entrypoint) => {
    const f = await publishedFixture();
    const operation = f.operations[entrypoint];
    await operation();
    f.assertRuntime.mockClear();
    f.recipes.get.mockClear();
    f.recipes.archive.mockClear();

    f.state.denied = true;
    await expectUnavailable(operation());
    expect(f.assertRuntime).toHaveBeenCalledTimes(1);
    expect(f.recipes.get).not.toHaveBeenCalled();
    expect(f.recipes.archive).not.toHaveBeenCalled();

    f.state.denied = false;
    await operation();
    expect(f.assertRuntime.mock.calls.length).toBeGreaterThan(1);
  });

  test("an empty catalog cannot bypass an unavailable fence", async () => {
    const f = await fencedFixture();
    f.state.denied = true;
    await expectUnavailable(f.store.list({}, USER));
    expect(await readdir(f.root)).toEqual([]);
    f.state.denied = false;
    expect(await f.store.list({}, USER)).toEqual({ releases: [] });
  });

  test("blob admission precedes digest validation and nested manifest reads", async () => {
    const f = await publishedFixture();
    f.state.denied = true;
    f.assertRuntime.mockClear();
    await expectUnavailable(
      f.store.getBlob(f.binding.repositoryId, f.binding.manifestDigest, "invalid", USER),
    );
    expect(f.assertRuntime).toHaveBeenCalledTimes(1);
  });

  test.each([
    new Error("database unavailable at internal-host:5432"),
    new SpackMaterialError(404, "private rollout journal missing"),
    new SpackMaterialError(503, "configured epoch differs from private journal epoch"),
    "private database failure",
    { message: "private query", status: 500 },
    null,
    undefined,
  ])("sanitizes any rejected fence value: %j", async (failure) => {
    const f = await fencedFixture();
    f.state.denied = true;
    f.state.failure = failure;
    await expectUnavailable(f.store.list({}, USER));

    const cancel = mock(() => {});
    const pull = mock(() => {});
    const input = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    await expectUnavailable(f.store.upload(f.input.repository, SOURCE_BLOB.digest, input));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
    expect(input.locked).toBe(false);
    expect(await readdir(f.root)).toEqual([]);
  });

  test("sanitizes a synchronous fence failure and cancels its upload", async () => {
    const f = await materialFixture();
    const store = new SpackMaterialStore(f.root, f.recipes, {}, {
      assertRuntime() {
        throw new Error("private synchronous fence failure");
      },
    });
    const cancel = mock(() => {});
    await expectUnavailable(
      store.upload(
        f.input.repository,
        SOURCE_BLOB.digest,
        new ReadableStream<Uint8Array>({ cancel }),
      ),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test.each([
    "reject",
    "pending",
  ])("upload cancellation may %s without masking denial", async (kind) => {
    const f = await fencedFixture();
    f.state.denied = true;
    const cancel = mock(() =>
      kind === "reject"
        ? Promise.reject(new Error("private cancellation failure"))
        : new Promise<void>(() => {}),
    );
    await expectUnavailable(
      f.store.upload(
        f.input.repository,
        SOURCE_BLOB.digest,
        new ReadableStream<Uint8Array>({ cancel }),
      ),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("a delivered blob stream is not drained when later admissions are denied", async () => {
    const f = await publishedFixture();
    const blob = await f.store.getBlob(
      f.binding.repositoryId,
      f.binding.manifestDigest,
      SOURCE_BLOB.digest,
      USER,
    );
    f.state.denied = true;
    f.assertRuntime.mockClear();
    expect(new Uint8Array(await new Response(blob.stream).arrayBuffer())).toEqual(SOURCE);
    expect(f.assertRuntime).not.toHaveBeenCalled();
    await expectUnavailable(f.operations.getBlob());
  });

  test("legacy three-argument construction still supports fixture publication", async () => {
    const f = await materialFixture();
    await f.seed();
    const store = new SpackMaterialStore(f.root, f.recipes, { maxBlobBytes: 1024 });
    const binding = await store.publish(f.input, OWNER);
    expect(await store.getManifest(binding.repositoryId, binding.manifestDigest)).toMatchObject({
      manifest: { repository: f.input.repository },
    });
  });
});

describe("material metadata commit admissions", () => {
  test.each([
    new Error("rollout paused during upload"),
    new Error("database became unavailable during upload"),
  ])("upload rechecks after streaming before issuing its receipt: %j", async (failure) => {
    const f = await fencedFixture();
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(SOURCE);
          controller.close();
          f.state.failure = failure;
          f.state.denied = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expectUnavailable(f.store.upload(f.input.repository, SOURCE_BLOB.digest, input));
    expect(f.assertRuntime).toHaveBeenCalledTimes(2);
    const receipt = join(
      f.root,
      "receipts",
      SpackMaterialStore.repositoryId(f.input.repository),
      `${SOURCE_BLOB.digest.slice(7)}.json`,
    );
    await expect(readFile(receipt)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
    expect(input.locked).toBe(false);
    // Admission failure leaves verified bytes, but never a new namespace receipt.
    expect(
      new Uint8Array(
        await readFile(
          join(f.root, "blobs", SOURCE_BLOB.digest.slice(7, 9), SOURCE_BLOB.digest.slice(7)),
        ),
      ),
    ).toEqual(SOURCE);

    f.state.denied = false;
    expect(
      await f.store.upload(f.input.repository, SOURCE_BLOB.digest, byteStream(SOURCE)),
    ).toEqual(SOURCE_BLOB);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(SOURCE_BLOB);
  });

  test.each([
    new Error("rollout paused during archive"),
    new Error("database became unavailable during archive"),
  ])("publish rechecks after archive streaming before committing a manifest: %j", async (failure) => {
    const f = await fencedFixture();
    await f.seed();
    f.assertRuntime.mockClear();
    f.recipes.archive.mockImplementationOnce(async () => ({
      stream: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array([0, 1, 254, 255]));
            controller.close();
            f.state.failure = failure;
            f.state.denied = true;
          },
        },
        { highWaterMark: 0 },
      ),
      size: 4,
    }));
    await expectUnavailable(f.store.publish(f.input, OWNER));
    expect(f.assertRuntime).toHaveBeenCalledTimes(2);
    expect(f.recipes.archive).toHaveBeenCalledTimes(1);
    await expect(readdir(join(f.root, "manifests"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(f.root, "staging"))).toEqual([]);

    f.state.denied = false;
    const binding = await f.store.publish(f.input, OWNER);
    expect(await readdir(join(f.root, "manifests", binding.repositoryId))).toEqual([
      `${binding.manifestDigest.slice(7)}.json`,
    ]);
  });
});
