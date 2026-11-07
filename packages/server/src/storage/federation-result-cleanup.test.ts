import { expect, test } from "bun:test";
import {
  cleanupFederationResultKey,
  type FederationResultCleanupClient,
} from "./federation-result-cleanup";

function fixture() {
  const key = `federation-results/${crypto.randomUUID()}/${crypto.randomUUID()}`;
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
