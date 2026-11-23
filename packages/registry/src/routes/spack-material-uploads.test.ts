import { afterEach, expect, test } from "bun:test";
import { appendFile, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { SPACK_MATERIAL_CHUNK_BYTES as CHUNK } from "@kuintessence/shared";
import { materialDigest } from "../services/spack-material-storage";
import { SpackMaterialStore } from "../services/spack-material-store";
import {
  BASE,
  cleanupMaterials,
  materialApp,
  materialFixture,
} from "./spack-materials.test-helpers";
import { headers, OWNER, USER } from "./spack-repositories.test-helpers";

afterEach(cleanupMaterials);

async function fixture() {
  const f = await materialFixture();
  const bytes = Buffer.alloc(CHUNK + 17, 9);
  const blob = { digest: materialDigest(bytes), size: bytes.length };
  let app = f.app;
  const send = (
    offset?: number,
    data?: Uint8Array | ReadableStream<Uint8Array>,
    actor = OWNER,
    repository = f.input.repository,
    size = blob.size,
  ) =>
    app.request(
      `${BASE}/blob-uploads?repository=${encodeURIComponent(repository)}&digest=${blob.digest}&size=${size}`,
      {
        method: "POST",
        headers: {
          ...headers(actor, "application/octet-stream"),
          ...(offset === undefined ? {} : { "Upload-Offset": String(offset) }),
        },
        body: data instanceof Uint8Array ? new Blob([Buffer.from(data)]) : data,
      },
    );
  const restart = () => {
    app = materialApp(new SpackMaterialStore(f.root, f.recipes));
  };
  return { ...f, bytes, blob, send, restart };
}

test("resumes committed bytes on a rebuilt Registry, discards a crash tail and replays a lost receipt", async () => {
  const f = await fixture();
  expect(await (await f.send()).json()).toEqual({ offset: 0 });
  expect(await (await f.send(0, f.bytes.subarray(0, CHUNK))).json()).toEqual({ offset: CHUNK });
  const [dir] = await readdir(join(f.root, "partials"));
  if (!dir) throw new Error("Missing upload directory");
  await appendFile(join(f.root, "partials", dir, `${CHUNK}.part`), Buffer.alloc(101));
  f.restart();
  expect(await (await f.send()).json()).toEqual({ offset: CHUNK });
  expect(await (await f.send(0, f.bytes.subarray(0, CHUNK))).json()).toEqual({ offset: CHUNK });
  expect(await (await f.send(CHUNK, f.bytes.subarray(CHUNK))).json()).toEqual(f.blob);
  f.restart();
  expect(await (await f.send()).json()).toEqual(f.blob);
  const stored = await f.store.getUploadedBlob(f.input.repository, f.blob);
  expect(materialDigest(new Uint8Array(await new Response(stored.stream).arrayBuffer()))).toBe(
    f.blob.digest,
  );
});

test("isolates partial uploads by publisher, repository and size; rechecks write permission", async () => {
  const f = await fixture();
  await f.send(0, f.bytes.subarray(0, CHUNK));
  expect(await (await f.send(undefined, undefined, { ...OWNER, sub: "second" })).json()).toEqual({
    offset: 0,
  });
  expect(
    await (await f.send(undefined, undefined, OWNER, `${f.input.repository}-other`)).json(),
  ).toEqual({ offset: 0 });
  expect(
    await (await f.send(undefined, undefined, OWNER, f.input.repository, f.blob.size + 1)).json(),
  ).toEqual({ offset: 0 });
  expect((await f.send(CHUNK, f.bytes.subarray(CHUNK), USER)).status).toBe(403);
  expect((await f.send(undefined, undefined, { ...OWNER, orgIds: [] })).status).toBe(403);
  expect(await (await f.send()).json()).toEqual({ offset: CHUNK });
});

test("short, oversized, and incorrect final chunks cannot issue a receipt", async () => {
  const f = await fixture();
  expect((await f.send(0, f.bytes.subarray(0, 31))).status).toBe(400);
  expect((await f.send(0, f.bytes)).status).toBe(413);
  expect(await (await f.send()).json()).toEqual({ offset: 0 });
  await f.send(0, f.bytes.subarray(0, CHUNK));
  expect((await f.send(CHUNK, Buffer.alloc(17))).status).toBe(422);
  await expect(f.store.getUploadedBlob(f.input.repository, f.blob)).rejects.toMatchObject({
    status: 422,
  });
  expect(await (await f.send()).json()).toEqual({ offset: 0 });
});

test("concurrent writers and collection cannot change an active checkpoint", async () => {
  const f = await fixture();
  let started!: () => void;
  let finish!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        started();
        await gate;
        controller.enqueue(f.bytes.subarray(0, CHUNK));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const first = f.send(0, body);
  try {
    await active;
    f.restart();
    expect((await f.send(0, f.bytes.subarray(0, CHUNK))).status).toBe(503);
    await expect(f.store.collect()).rejects.toMatchObject({ status: 503 });
  } finally {
    finish();
  }
  expect(await (await first).json()).toEqual({ offset: CHUNK });
  await f.store.collect();
  expect(await (await f.send()).json()).toEqual({ offset: CHUNK });
  const [dir] = await readdir(join(f.root, "partials"));
  if (!dir) throw new Error("Missing upload directory");
  await utimes(join(f.root, "partials", dir), new Date(0), new Date(0));
  await f.store.collect();
  expect(await (await f.send()).json()).toEqual({ offset: 0 });
});

test("a completed checkpoint can finish issuing its receipt after a runtime interruption", async () => {
  const f = await fixture();
  await f.send(0, f.bytes.subarray(0, CHUNK));
  let checks = 0;
  const interrupted = new SpackMaterialStore(
    f.root,
    f.recipes,
    {},
    {
      async assertRuntime() {
        if (++checks > 1) throw new Error("runtime unavailable");
      },
    },
  );
  await expect(
    interrupted.resumeUpload(f.input.repository, OWNER.sub, f.blob, {
      offset: CHUNK,
      input: new Blob([f.bytes.subarray(CHUNK)]).stream(),
    }),
  ).rejects.toMatchObject({ status: 503 });
  await expect(f.store.getUploadedBlob(f.input.repository, f.blob)).rejects.toMatchObject({
    status: 422,
  });
  f.restart();
  expect(await (await f.send()).json()).toEqual(f.blob);
});
