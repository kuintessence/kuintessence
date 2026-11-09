import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FederationMediaManifestSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { AgentDataRoots } from "../packages/agent/src/data-market/local-data-security";
import { quarantineMediaArchive } from "../packages/agent/src/data-market/media-archive";
import { exportFederationMedia } from "../packages/agent/src/data-market/media-export";
import { mediaExportFixture } from "../packages/agent/src/data-market/media-test-fixtures";
import { signedDownloadExpiry } from "../packages/server/src/federation/download-credential";
import {
  createRealMinioBackend,
  loadMinioConfigFromEnv,
} from "../packages/server/src/storage/minio-client";

const run = process.env.KQ_MEDIA_OBJECT_STORAGE_INTEGRATION === "1" ? test : test.skip;
run(
  "real versioned S3 presigned GET exports the approved older object into an age package",
  async () => {
    const config = loadMinioConfigFromEnv();
    const caRoot = process.env.KQ_MEDIA_OBJECT_TLS_DIRECTORY;
    if (
      !config.bucket.startsWith("kq-federation-result-test-") ||
      !caRoot?.startsWith("/tmp/kq-media-object-s3-")
    )
      throw new Error("Disposable storage and trusted TLS fixture required");
    const backend = await createRealMinioBackend(config);
    const key = `federation-results/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const f = await mediaExportFixture();
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    try {
      await backend.putBlob(key, f.bytes, "application/octet-stream");
      const pinned = await backend.head(key);
      if (!pinned?.versionId || pinned.versionId === "null") throw new Error("Versioning required");
      const versionId = pinned.versionId;
      await backend.putBlob(key, Buffer.from("newer object must not be exported"), "text/plain");
      let reads = 0,
        grants = 0;
      proxy = Bun.serve({
        hostname: "localhost",
        port: 0,
        tls: { key: Bun.file(join(caRoot, "key.pem")), cert: Bun.file(join(caRoot, "cert.pem")) },
        fetch: async (request) => {
          const url = new URL(request.url);
          if (request.method !== "GET" || url.pathname !== `/${config.bucket}/${key}`)
            return new Response(null, { status: 403 });
          expect(url.searchParams.get("versionId")).toBe(versionId);
          reads++;
          const response = await fetch(
            `${config.useSSL ? "https" : "http"}://${config.endpoint}:${config.port}${url.pathname}${url.search}`,
            { headers: request.headers, redirect: "error", signal: request.signal },
          );
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        },
      });
      const signed = await createRealMinioBackend({ ...config, publicUrl: proxy.url.origin });
      const manifest = FederationMediaManifestSchema.parse({
        ...f.manifest,
        subject: {
          kind: "task-input",
          operationId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          attempt: 1,
          requestDigest: `sha256:${"a".repeat(64)}`,
          contentDigest: `sha256:${"b".repeat(64)}`,
        },
        files: f.manifest.files.map((file) => ({ ...file, path: "objects/000000" })),
      });
      const signedManifest = await signFederationMessage(FederationMediaManifestSchema, manifest, {
        siteId: manifest.senderSiteId,
        keyId: f.options.task.signingKey.keyId,
        privateKey: f.keyPair.privateKey,
      });
      const { managedRootId: _root, relativePath: _path, ...common } = f.options.task;
      const task = {
        ...common,
        signedManifest,
        manifestDigest: (await f.verify(signedManifest)).digest,
        objects: manifest.files.map(({ path, sizeBytes, sha256 }) => ({
          path,
          sizeBytes,
          sha256,
          versionId,
        })),
      };
      const receipt = await exportFederationMedia({
        ...f.options,
        task,
        roots: new AgentDataRoots({
          datasetRoot: "/no-local-source",
          jobWorkRoot: "/unused-work",
          managedRoots: {},
        }),
        allowedSourceOrigins: [proxy.url.origin],
        authorizeObject: async (binding) => {
          expect(federationCanonicalJson(binding)).toBe(
            federationCanonicalJson({
              generation: task.generation,
              packageId: task.packageId,
              manifestDigest: task.manifestDigest,
              fileIndex: 0,
              ...task.objects[0],
            }),
          );
          grants++;
          const now = Date.now();
          const url = await signed.presignDownload(key, 20, undefined, versionId);
          return { binding, url, expiresAt: signedDownloadExpiry(url, Date.now(), now + 30_000) };
        },
      });
      expect(grants).toBe(2);
      expect(reads).toBe(1);
      const target = join(f.options.mediaDirectory, "outbox", task.packageId, "bundle.age");
      expect((await readFile(target)).length).toBe(receipt.sizeBytes);
      const imported = await quarantineMediaArchive({
        stream: f.age.decrypt(target, f.identity.identity, f.options.signal),
        quarantineRoot: join(f.root, "quarantine"),
        maxBytes: f.bytes.length,
        reserveBytes: 1024 * 1024,
        verifyManifest: async (jws) => (await f.verify(jws)).payload,
        signal: f.options.signal,
      });
      expect(await readFile(join(imported.directory, "files", "objects/000000"))).toEqual(f.bytes);
      expect((await backend.head(key))?.versionId).not.toBe(versionId);
    } finally {
      proxy?.stop(true);
      await backend.cleanupFederationResult?.(key);
      await f.cleanup();
    }
  },
  30_000,
);
