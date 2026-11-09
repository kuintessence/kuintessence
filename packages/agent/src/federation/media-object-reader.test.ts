import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FederationMediaManifestSchema,
  type FederationMediaObjectBinding,
  FederationMediaObjectBindingSchema,
  FederationMediaObjectGrantSchema,
} from "@kuintessence/shared/federation";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { exportMediaArchiveFromFiles, quarantineMediaArchive } from "../data-market/media-archive";
import { mediaExportFixture } from "../data-market/media-test-fixtures";
import type { HttpClient } from "../staging/http-client";
import { readFederationMediaObject } from "./media-object-reader";

let root: string, ca: string, server: ReturnType<typeof Bun.serve>;
let content = Buffer.alloc(0);
let mode: string, requests: number, ranges: string[];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kq-media-object-"));
  const key = join(root, "tls.key"),
    cert = join(root, "tls.pem");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (generated.exitCode !== 0) throw new Error("Test TLS setup failed");
  ca = await readFile(cert, "utf8");
  server = Bun.serve({
    hostname: "localhost",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch: (request) => {
      requests++;
      if (mode === "redirect") return Response.redirect(`${server.url}redirected`);
      const headers: Record<string, string> = {
        "x-amz-version-id": mode === "version" ? "v2" : "v1",
      };
      if (mode === "unversioned") delete headers["x-amz-version-id"];
      if (!content.length && !request.headers.has("range"))
        return new Response(null, {
          headers: { ...headers, "content-length": String(content.length) },
        });
      const range = request.headers.get("range") ?? "";
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return new Response(null, { status: 416 });
      const offset = Number(match[1]),
        end = Number(match[2]);
      headers["content-range"] = `bytes ${offset}-${end}/${content.length}`;
      if (mode === "bad-range") headers["content-range"] = `bytes 0-${end}/${content.length}`;
      if (mode === "encoded") headers["content-encoding"] = "gzip";
      if (mode === "stall")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(content.subarray(offset, offset + 1));
            },
          }),
          { status: 206, headers },
        );
      const body = content.subarray(offset, end + 1);
      return new Response(
        mode === "extra"
          ? Buffer.concat([body, Buffer.from("x")])
          : mode === "short"
            ? body.subarray(1)
            : body,
        { status: mode === "ignore-range" ? 200 : 206, headers },
      );
    },
  });
});
afterAll(async () => {
  server?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  content = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
  mode = "normal";
  requests = 0;
  ranges = [];
});
const http: HttpClient = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    redirect: request.redirect,
    tls: { ca },
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers),
    body: response.body,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
    json: <T>() => response.json() as Promise<T>,
  };
};
function binding(): FederationMediaObjectBinding {
  return {
    generation: crypto.randomUUID(),
    packageId: crypto.randomUUID(),
    manifestDigest: `sha256:${"a".repeat(64)}`,
    fileIndex: 0,
    path: "objects/000000",
    sizeBytes: content.length,
    sha256: hash(content),
    versionId: "v1",
  };
}
function options() {
  const value = binding();
  return {
    binding: value,
    availableUntil: new Date(Date.now() + 60_000).toISOString(),
    allowedSourceOrigins: [server.url.origin],
    signal: AbortSignal.timeout(20_000),
    http,
    authorize: async (current: FederationMediaObjectBinding) => ({
      binding: current,
      url: `${server.url}object?versionId=v1&private-token=not-for-logs`,
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    }),
  };
}
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("HTTPS object reader uses bounded exact ranges, pins version and rechecks final authority", async () => {
  const opts = options();
  let permits = 0;
  const bytes = await collect(
    readFederationMediaObject({
      ...opts,
      authorize: async (binding) => {
        permits++;
        return opts.authorize(binding);
      },
    }),
  );
  expect(bytes).toEqual(content);
  expect(permits).toBe(2);
  expect(ranges).toEqual(["bytes=0-1048575", "bytes=1048576-2097151", "bytes=2097152-2097168"]);
});
test("empty object still requires a versioned empty GET and final authority", async () => {
  content = Buffer.alloc(0);
  const opts = options();
  let permits = 0;
  expect(
    await collect(
      readFederationMediaObject({
        ...opts,
        authorize: async (binding) => {
          permits++;
          return opts.authorize(binding);
        },
      }),
    ),
  ).toEqual(content);
  expect(requests).toBe(1);
  expect(permits).toBe(2);
  expect(ranges).toEqual([]);
});
test.each([
  "version",
  "unversioned",
  "redirect",
  "bad-range",
  "ignore-range",
  "extra",
  "short",
  "encoded",
])("object reader rejects %s without exposing credential URLs", async (failure) => {
  mode = failure;
  await expect(collect(readFederationMediaObject(options()))).rejects.toThrow(
    /INVALID_GRANT|TRANSFER_IO_FAILED|GRANT_UNAVAILABLE/,
  );
  if (failure === "redirect") expect(requests).toBe(1);
});
test("changed bytes and denial during final recheck cannot complete an object", async () => {
  const opts = options();
  content[0] = (content[0] ?? 0) ^ 1;
  await expect(collect(readFederationMediaObject(opts))).rejects.toThrow("TRANSFER_IO_FAILED");
  const good = options();
  let permits = 0;
  await expect(
    collect(
      readFederationMediaObject({
        ...good,
        authorize: async (binding) => {
          if (++permits > 1) throw new Error("secret-bearing authorization failure");
          return good.authorize(binding);
        },
      }),
    ),
  ).rejects.toThrow("GRANT_UNAVAILABLE");
});
test("grant binding, local origin and lifetime checks occur before any object request", async () => {
  const opts = options(),
    grant = await opts.authorize(opts.binding);
  for (const changed of [
    { ...grant, binding: { ...grant.binding, packageId: crypto.randomUUID() } },
    { ...grant, binding: { ...grant.binding, versionId: "v2" } },
    { ...grant, binding: { ...grant.binding, fileIndex: 1 } },
    { ...grant, binding: { ...grant.binding, generation: crypto.randomUUID() } },
    { ...grant, url: "https://elsewhere.invalid/private" },
    { ...grant, url: `${server.url}file#secret` },
    { ...grant, expiresAt: new Date(Date.now() - 1).toISOString() },
    { ...grant, expiresAt: new Date(Date.now() + 31_000).toISOString() },
  ])
    await expect(
      collect(readFederationMediaObject({ ...opts, authorize: async () => changed })),
    ).rejects.toThrow();
  expect(requests).toBe(0);
});
test("stalled object body stops at cancellation; cancelled authorization does not make a request", async () => {
  mode = "stall";
  await expect(
    collect(readFederationMediaObject({ ...options(), signal: AbortSignal.timeout(100) })),
  ).rejects.toThrow("TRANSFER_CANCELLED");
  requests = 0;
  await expect(
    collect(
      readFederationMediaObject({
        ...options(),
        signal: AbortSignal.timeout(100),
        authorize: async () => new Promise(() => {}),
      }),
    ),
  ).rejects.toThrow("TRANSFER_CANCELLED");
  expect(requests).toBe(0);
});
test("short grant expires while a body stalls even without user cancellation", async () => {
  mode = "stall";
  const opts = options();
  await expect(
    collect(
      readFederationMediaObject({
        ...opts,
        authorize: async (binding) => ({
          ...(await opts.authorize(binding)),
          expiresAt: new Date(Date.now() + 100).toISOString(),
        }),
      }),
    ),
  ).rejects.toThrow("TRANSFER_IO_FAILED");
});
test("object schema rejects mutable or missing versions and credential fields in a binding", () => {
  const value = binding();
  for (const patch of [
    { versionId: "null" },
    { versionId: "" },
    { fileIndex: 1000 },
    { sizeBytes: -1 },
    { path: "../escape" },
    { url: "https://secret.invalid" },
  ])
    expect(FederationMediaObjectBindingSchema.safeParse({ ...value, ...patch }).success).toBe(
      false,
    );
  expect(
    FederationMediaObjectGrantSchema.safeParse({
      binding: value,
      url: "http://insecure.invalid",
      expiresAt: new Date().toISOString(),
    }).success,
  ).toBe(false);
});

const live = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;
live.each(["task-input", "task-result"] as const)(
  "real age streams %s objects into an encrypted archive and restores exact metadata",
  async (kind) => {
    const f = await mediaExportFixture();
    try {
      const manifest = FederationMediaManifestSchema.parse({
        ...f.manifest,
        subject: {
          kind,
          operationId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          attempt: 2,
          requestDigest: `sha256:${"c".repeat(64)}`,
          contentDigest: `sha256:${"d".repeat(64)}`,
        },
        files: [
          {
            path: "objects/000000",
            sizeBytes: content.length,
            sha256: hash(content),
            license: "CC-BY-4.0",
            provenance: { source: "authorized private task", revision: 2 },
          },
        ],
      });
      const signedManifest = await signFederationMessage(FederationMediaManifestSchema, manifest, {
        siteId: f.options.task.sourceSiteId,
        keyId: f.options.task.signingKey.keyId,
        privateKey: f.keyPair.privateKey,
      });
      const verified = await f.verify(signedManifest),
        opts = options();
      const archive = exportMediaArchiveFromFiles({
        signedManifest,
        verifyManifest: async (jws) => (await f.verify(jws)).payload,
        signal: f.options.signal,
        readFile: (file, index) =>
          readFederationMediaObject({
            ...opts,
            signal: f.options.signal,
            binding: {
              ...opts.binding,
              packageId: manifest.packageId,
              manifestDigest: verified.digest,
              fileIndex: index,
              path: file.path,
              sizeBytes: file.sizeBytes,
              sha256: file.sha256,
            },
          }),
      });
      const encrypted = await collect(
        f.age.encrypt(archive, f.identity.recipient, f.options.signal),
      );
      expect(encrypted.includes(Buffer.from(signedManifest))).toBe(false);
      const file = join(f.root, "private.age");
      await Bun.write(file, encrypted);
      const received = await quarantineMediaArchive({
        stream: f.age.decrypt(file, f.identity.identity, f.options.signal),
        quarantineRoot: join(f.root, "quarantine"),
        maxBytes: content.length,
        reserveBytes: 1024 * 1024,
        verifyManifest: async (jws) => (await f.verify(jws)).payload,
        signal: f.options.signal,
      });
      expect(received.manifest).toEqual(manifest);
      expect(await readFile(join(received.directory, "files", "objects", "000000"))).toEqual(
        content,
      );
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test("slow archive consumption refreshes an expired grant before the next range", async () => {
  const opts = options();
  let permits = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of readFederationMediaObject({
    ...opts,
    authorize: async (binding) => {
      permits++;
      return {
        ...(await opts.authorize(binding)),
        expiresAt: new Date(Date.now() + 150).toISOString(),
      };
    },
  })) {
    chunks.push(chunk);
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  expect(Buffer.concat(chunks)).toEqual(content);
  expect(permits).toBe(4);
});
test("an empty-object response containing bytes cannot complete", async () => {
  content = Buffer.alloc(0);
  const opts = options();
  const unexpected: HttpClient = async () => ({
    status: 200,
    ok: true,
    headers: { "x-amz-version-id": "v1", "content-length": "0" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("unexpected"));
        controller.close();
      },
    }),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async <T>() => JSON.parse("null") as T,
  });
  await expect(collect(readFederationMediaObject({ ...opts, http: unexpected }))).rejects.toThrow(
    "TRANSFER_IO_FAILED",
  );
});
