import { expect, test } from "bun:test";
import { createRealMinioBackend, loadMinioConfigFromEnv } from "./minio-client";

const enabled = process.env.KQ_FEDERATION_STORAGE_INTEGRATION === "1";
const run = enabled ? test : test.skip;
run(
  "real input allocation recovery finds a lost upload and refuses ambiguous or unrelated keys",
  async () => {
    const config = loadMinioConfigFromEnv();
    if (!config.bucket.startsWith("kq-federation-result-test-"))
      throw new Error("Disposable federation result bucket required");
    const backend = await createRealMinioBackend(config);
    const key = `federation-inputs/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const neighbor = `federation-inputs/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    if (!backend.findFederationInputUpload || !backend.cleanupFederationInput)
      throw new Error("Input recovery backend required");
    try {
      expect(await backend.findFederationInputUpload(key)).toBeUndefined();
      const other = await backend.createMultipartUpload(neighbor, "application/octet-stream");
      expect(await backend.findFederationInputUpload(key)).toBeUndefined();
      const first = await backend.createMultipartUpload(key, "application/octet-stream");
      expect(await backend.findFederationInputUpload(key)).toBe(first.uploadId);
      await backend.createMultipartUpload(key, "application/octet-stream");
      await expect(backend.findFederationInputUpload(key)).rejects.toThrow(
        "FEDERATION_STORAGE_RECOVERY_UNCONFIRMED",
      );
      await backend.putBlob(key, Buffer.from("input version"), "text/plain");
      const pinned = await backend.head(key);
      if (!pinned?.versionId) throw new Error("Versioned input storage required");
      await backend.putBlob(key, Buffer.from("replacement"), "text/plain");
      const response = await fetch(
        await backend.presignDownload(key, 30, undefined, pinned.versionId),
      );
      expect(response.ok).toBe(true);
      expect(await response.text()).toBe("input version");
      await backend.delete(key);
      await backend.cleanupFederationInput(key);
      expect(await backend.head(key, pinned.versionId)).toBeNull();
      expect(await backend.findFederationInputUpload(key)).toBeUndefined();
      expect(await backend.findFederationInputUpload(neighbor)).toBe(other.uploadId);
      await expect(backend.findFederationInputUpload("netdrive/")).rejects.toThrow(
        "INVALID_FEDERATION_STORAGE_KEY",
      );
    } finally {
      await Promise.all([
        backend.cleanupFederationInput(key),
        backend.cleanupFederationInput(neighbor),
      ]);
    }
  },
);

run(
  "real S3 cleanup removes lost multipart uploads, versions and delete markers without touching neighbors",
  async () => {
    const config = loadMinioConfigFromEnv();
    if (!config.bucket.startsWith("kq-federation-result-test-"))
      throw new Error("Disposable federation result bucket required");
    const backend = await createRealMinioBackend(config);
    const key = `federation-results/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const neighbor = `${key}-neighbor`;
    const cleanup = backend.cleanupFederationResult;
    if (!cleanup) throw new Error("Cleanup backend unavailable");
    await backend.putBlob(neighbor, Buffer.from("keep"), "text/plain");
    const first = await backend.createMultipartUpload(key, "application/octet-stream");
    const second = await backend.createMultipartUpload(key, "application/octet-stream");
    const put = await backend.presignUploadPart(key, first.uploadId, 1, 30);
    expect((await fetch(put, { method: "PUT", body: "partial-data" })).ok).toBe(true);
    await backend.putBlob(key, Buffer.from("old-version"), "text/plain");
    const old = await backend.head(key);
    await backend.putBlob(key, Buffer.from("new-version"), "text/plain");
    const current = await backend.head(key);
    expect(old?.versionId).toBeTruthy();
    expect(current?.versionId).toBeTruthy();
    expect(old?.versionId).not.toBe(current?.versionId);
    await backend.delete(key);
    await cleanup(key);
    expect(await backend.head(key)).toBeNull();
    expect(await backend.head(key, old?.versionId)).toBeNull();
    expect(await backend.head(key, current?.versionId)).toBeNull();
    await expect(backend.listUploadParts(key, first.uploadId)).rejects.toThrow();
    await expect(backend.listUploadParts(key, second.uploadId)).rejects.toThrow();
    expect((await fetch(put, { method: "PUT", body: "late-part" })).ok).toBe(false);
    expect(await backend.getBlob(neighbor)).toEqual(Buffer.from("keep"));
    await cleanup(key);
  },
);

run(
  "real storage role can read pinned versions but cannot enumerate or erase ordinary NetDrive history",
  async () => {
    const config = loadMinioConfigFromEnv();
    if (!config.bucket.startsWith("kq-federation-result-test-"))
      throw new Error("Disposable federation result bucket required");
    const { Client } = await import("minio");
    const client = new Client({
      endPoint: config.endpoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
    });
    const backend = await createRealMinioBackend(config);
    const key = `netdrive/${crypto.randomUUID()}/file`;
    await backend.putBlob(key, Buffer.from("versioned-data"), "text/plain");
    const version = (await backend.head(key))?.versionId;
    if (!version) throw new Error("Versioned bucket required");
    const url = await backend.presignDownload(key, 30, undefined, version);
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("versioned-data");
    await expect(
      client.removeObject(config.bucket, key, { versionId: version }),
    ).rejects.toMatchObject({ code: "AccessDenied" });
    for (const stream of [
      client.listObjects(config.bucket, "netdrive/", true, { IncludeVersion: true }),
      client.listIncompleteUploads(config.bucket, "netdrive/", true),
    ]) {
      await expect(
        (async () => {
          for await (const entry of stream) void entry;
        })(),
      ).rejects.toMatchObject({ code: "AccessDenied" });
    }
    expect(await backend.getBlob(key)).toEqual(Buffer.from("versioned-data"));
  },
);
