import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFederationResultFile } from "../packages/agent/src/federation/result-verify";
import {
  createRealMinioBackend,
  loadMinioConfigFromEnv,
} from "../packages/server/src/storage/minio-client";

const run = process.env.KQ_FEDERATION_STORAGE_INTEGRATION === "1" ? test : test.skip;

run("real completed multipart is re-read over HTTPS using its version and SHA-256", async () => {
  const config = loadMinioConfigFromEnv();
  if (!config.bucket.startsWith("kq-federation-result-test-"))
    throw new Error("Disposable federation result bucket required");
  const backend = await createRealMinioBackend(config);
  const key = `federation-results/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  const root = await mkdtemp(join(tmpdir(), "kq-result-verify-tls-"));
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  try {
    const tlsKey = join(root, "key.pem"),
      cert = join(root, "cert.pem");
    const made = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        tlsKey,
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
    if (made.exitCode !== 0) throw new Error("Test TLS certificate failed");
    const bytes = Buffer.alloc(1024 * 1024 + 37, 42);
    const upload = await backend.createMultipartUpload(key, "application/octet-stream");
    const put = await fetch(await backend.presignUploadPart(key, upload.uploadId, 1, 30), {
      method: "PUT",
      body: bytes,
    });
    expect(put.ok).toBe(true);
    const etag = put.headers.get("etag")?.replaceAll('"', "");
    await put.body?.cancel();
    if (!etag) throw new Error("Missing S3 part ETag");
    const completed = await backend.completeMultipartUpload(key, upload.uploadId, [
      { partNumber: 1, etag },
    ]);
    const pinned = await backend.head(key, completed.versionId);
    if (!pinned?.versionId) throw new Error("Expected versioned test object");
    expect(completed.versionId).toBe(pinned.versionId);
    expect(pinned.etag).toBe(completed.etag);
    await backend.putBlob(key, Buffer.from("later object version"), "text/plain");
    let reads = 0;
    proxy = Bun.serve({
      hostname: "localhost",
      port: 0,
      tls: { key: Bun.file(tlsKey), cert: Bun.file(cert) },
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.pathname !== `/${config.bucket}/${key}`)
          return new Response(null, { status: 403 });
        reads++;
        const upstream = new URL(
          `${config.useSSL ? "https" : "http"}://${config.endpoint}:${config.port}${url.pathname}${url.search}`,
        );
        // Preserve the public signed Host while forwarding only this isolated test object's GETs.
        const response = await fetch(upstream, {
          headers: request.headers,
          redirect: "error",
          signal: request.signal,
        });
        return new Response(response.body, { status: response.status, headers: response.headers });
      },
    });
    const signed = await createRealMinioBackend({ ...config, publicUrl: proxy.url.origin });
    const task = {
      binding: {
        transferId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        manifestDigest: `sha256:${"1".repeat(64)}`,
        outputId: `sha256:${"2".repeat(64)}`,
        path: "result",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        partSize: 5 * 1024 * 1024,
      },
      object: { versionId: pinned.versionId, etag: pinned.etag },
      availableUntil: new Date(Date.now() + 90_000).toISOString(),
    };
    const ca = await readFile(cert, "utf8");
    const verified = await verifyFederationResultFile({
      task,
      allowedDestinationOrigins: [proxy.url.origin],
      signal: new AbortController().signal,
      fetcher: (url, init) => fetch(url, { ...init, tls: { ca } }),
      authorize: async (input) => ({
        ...input,
        direction: "verify",
        url: await signed.presignDownload(key, 30, undefined, pinned.versionId),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    });
    expect(verified.sha256).toBe(task.binding.sha256);
    expect(verified.sizeBytes).toBe(bytes.length);
    expect(reads).toBe(2);
    expect((await backend.head(key))?.versionId).not.toBe(pinned.versionId);
  } finally {
    proxy?.stop(true);
    await rm(root, { recursive: true, force: true });
    await backend.cleanupFederationResult?.(key);
  }
});
