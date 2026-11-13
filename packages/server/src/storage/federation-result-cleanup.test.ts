import { expect, test } from "bun:test";
import {
  cleanupFederationInputKey,
  cleanupFederationResultKey,
  type FederationResultCleanupClient,
  findFederationInputUpload,
} from "./federation-result-cleanup";

function fixture(kind = "federation-results") {
  const key = `${kind}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  const uploads = new Map([
    ["lost-upload", key],
    ["known-upload", key],
    ["neighbor-upload", `${key}-neighbor`],
  ]);
  const versions = new Map([
    ["old-version", key],
    ["delete-marker", key],
    ["neighbor-version", `${key}-neighbor`],
  ]);
  const removed: string[] = [];
  const client: FederationResultCleanupClient = {
    listIncompleteUploads: async function* () {
      for (const [uploadId, item] of uploads) yield { uploadId, key: item };
    },
    listObjects: async function* (_bucket, _prefix, _recursive, options) {
      expect(options.IncludeVersion).toBe(true);
      for (const [versionId, name] of versions) yield { versionId, name };
    },
    abortMultipartUpload: async (_bucket, item, uploadId) => {
      expect(uploads.get(uploadId)).toBe(item);
      uploads.delete(uploadId);
      removed.push(uploadId);
    },
    removeObject: async (_bucket, item, { versionId }) => {
      expect(versions.get(versionId)).toBe(item);
      versions.delete(versionId);
      removed.push(versionId);
    },
  };
  return { key, client, uploads, versions, removed };
}

test("cleanup removes unknown upload IDs and all versions while preserving a neighboring prefix", async () => {
  const f = fixture();
  await cleanupFederationResultKey(f.client, "bucket", f.key);
  expect(f.removed).toEqual(["lost-upload", "known-upload", "old-version", "delete-marker"]);
  expect([...f.uploads.keys()]).toEqual(["neighbor-upload"]);
  expect([...f.versions.keys()]).toEqual(["neighbor-version"]);
  await cleanupFederationResultKey(f.client, "bucket", f.key);
  expect(f.removed).toHaveLength(4);
});

test("cleanup refuses broad paths, retains failure for incomplete deletion, and strips SDK secrets", async () => {
  const f = fixture();
  for (const key of ["federation-results/", `${f.key}/extra`, "netdrive/user/file"])
    await expect(cleanupFederationResultKey(f.client, "bucket", key)).rejects.toThrow(
      "INVALID_FEDERATION_STORAGE_KEY",
    );
  expect(f.removed).toEqual([]);
  f.client.abortMultipartUpload = async () => {};
  await expect(cleanupFederationResultKey(f.client, "bucket", f.key)).rejects.toThrow(
    "FEDERATION_STORAGE_CLEANUP_INCOMPLETE",
  );
  f.client.listIncompleteUploads = async function* () {
    yield { key: f.key, uploadId: "one" };
    throw new Error("https://private.example/?token=secret");
  };
  let error: unknown;
  try {
    await cleanupFederationResultKey(f.client, "bucket", f.key);
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toBe("Error: FEDERATION_STORAGE_CLEANUP_INCOMPLETE");
});

test("input cleanup uses a separate exact namespace and preserves adjacent attempts", async () => {
  const f = fixture("federation-inputs");
  await expect(cleanupFederationResultKey(f.client, "bucket", f.key)).rejects.toThrow(
    "INVALID_FEDERATION_STORAGE_KEY",
  );
  for (const key of [
    "federation-inputs/",
    `${f.key}/extra`,
    `netdrive/objects/${crypto.randomUUID()}`,
    f.key.replace("federation-inputs", "federation-results"),
  ])
    await expect(cleanupFederationInputKey(f.client, "bucket", key)).rejects.toThrow(
      "INVALID_FEDERATION_STORAGE_KEY",
    );
  await cleanupFederationInputKey(f.client, "bucket", f.key);
  expect(f.removed).toEqual(["lost-upload", "known-upload", "old-version", "delete-marker"]);
  expect([...f.uploads.keys()]).toEqual(["neighbor-upload"]);
  expect([...f.versions.keys()]).toEqual(["neighbor-version"]);
});

test("input allocation recovery returns only a unique exact-key upload without changing storage", async () => {
  const f = fixture("federation-inputs");
  await expect(findFederationInputUpload(f.client, "bucket", f.key)).rejects.toThrow(
    "FEDERATION_STORAGE_RECOVERY_UNCONFIRMED",
  );
  f.uploads.delete("known-upload");
  expect(await findFederationInputUpload(f.client, "bucket", f.key)).toBe("lost-upload");
  f.uploads.delete("lost-upload");
  expect(await findFederationInputUpload(f.client, "bucket", f.key)).toBeUndefined();
  expect(f.removed).toEqual([]);
  expect([...f.uploads.keys()]).toEqual(["neighbor-upload"]);
  expect(f.versions.size).toBe(3);
  for (const key of ["federation-inputs/", `${f.key}/extra`, f.key.replace("inputs", "results")])
    await expect(findFederationInputUpload(f.client, "bucket", key)).rejects.toThrow(
      "INVALID_FEDERATION_STORAGE_KEY",
    );
});

test("input allocation recovery waits for a complete bounded listing and strips storage errors", async () => {
  const f = fixture("federation-inputs");
  f.client.listIncompleteUploads = async function* () {
    yield { key: f.key, uploadId: "found" };
    throw new Error("private storage credentials");
  };
  await expect(findFederationInputUpload(f.client, "bucket", f.key)).rejects.toThrow(
    /^FEDERATION_STORAGE_RECOVERY_UNCONFIRMED$/,
  );
  f.client.listIncompleteUploads = async function* () {
    for (let i = 0; i < 1001; i++) yield { key: f.key, uploadId: "repeated" };
  };
  await expect(findFederationInputUpload(f.client, "bucket", f.key)).rejects.toThrow(
    "FEDERATION_STORAGE_RECOVERY_UNCONFIRMED",
  );
  f.client.listIncompleteUploads = async function* () {
    yield { key: f.key, uploadId: "" };
  };
  await expect(findFederationInputUpload(f.client, "bucket", f.key)).rejects.toThrow(
    "FEDERATION_STORAGE_RECOVERY_UNCONFIRMED",
  );
  expect(f.removed).toEqual([]);
});
