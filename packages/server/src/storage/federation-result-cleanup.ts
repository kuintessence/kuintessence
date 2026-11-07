import { z } from "zod";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

const Upload = z.object({ key: z.string(), uploadId: z.string().min(1).max(2048) });
const Version = z.object({ name: z.string(), versionId: z.string().min(1).max(2048).nullable() });
export interface FederationResultCleanupClient {
  listIncompleteUploads(bucket: string, prefix: string, recursive: boolean): AsyncIterable<unknown>;
  listObjects(
    bucket: string,
    prefix: string,
    recursive: boolean,
    options: { IncludeVersion: boolean },
  ): AsyncIterable<unknown>;
  abortMultipartUpload(bucket: string, key: string, uploadId: string): Promise<unknown>;
  removeObject(bucket: string, key: string, options: { versionId: string }): Promise<unknown>;
}

/** Requires the caller to fence the attempt first; never accepts a prefix or a public NetDrive key. */
export async function cleanupFederationResultKey(
  client: FederationResultCleanupClient,
  bucket: string,
  key: string,
) {
  return cleanupFederationKey(client, bucket, key, "federation-results");
}

export function cleanupFederationInputKey(
  client: FederationResultCleanupClient,
  bucket: string,
  key: string,
) {
  return cleanupFederationKey(client, bucket, key, "federation-inputs");
}

/** Positive recovery only: an empty listing does not prove CreateMultipartUpload never ran. */
export async function findFederationInputUpload(
  client: Pick<FederationResultCleanupClient, "listIncompleteUploads">,
  bucket: string,
  key: string,
): Promise<string | undefined> {
  if (!new RegExp(`^federation-inputs/${uuid}/${uuid}$`).test(key))
    throw new Error("INVALID_FEDERATION_STORAGE_KEY");
  try {
    const ids = new Set<string>();
    let count = 0;
    for await (const raw of client.listIncompleteUploads(bucket, key, true)) {
      if (++count > 1000) throw new Error("RECOVERY_SCAN_LIMIT");
      const item = Upload.parse(raw);
      if (item.key === key) ids.add(item.uploadId);
      if (ids.size > 1) throw new Error("AMBIGUOUS_UPLOAD");
    }
    return ids.values().next().value;
  } catch {
    throw new Error("FEDERATION_STORAGE_RECOVERY_UNCONFIRMED");
  }
}

async function cleanupFederationKey(
  client: FederationResultCleanupClient,
  bucket: string,
  key: string,
  kind: "federation-results" | "federation-inputs",
) {
  const keyPattern = new RegExp(`^${kind}/${uuid}/${uuid}$`);
  if (!keyPattern.test(key)) throw new Error("INVALID_FEDERATION_STORAGE_KEY");
  const uploads = async () => {
    const found: string[] = [];
    let count = 0;
    for await (const raw of client.listIncompleteUploads(bucket, key, true)) {
      if (++count > 1000) throw new Error("CLEANUP_SCAN_LIMIT");
      const item = Upload.parse(raw);
      if (item.key === key) found.push(item.uploadId);
    }
    return found;
  };
  const versions = async () => {
    const found: string[] = [];
    let count = 0;
    for await (const raw of client.listObjects(bucket, key, true, { IncludeVersion: true })) {
      if (++count > 1000) throw new Error("CLEANUP_SCAN_LIMIT");
      const item = Version.parse(raw);
      if (item.name === key) found.push(item.versionId ?? "null");
    }
    return found;
  };
  try {
    for (const uploadId of await uploads())
      await client.abortMultipartUpload(bucket, key, uploadId);
    // Explicit versions also remove delete markers instead of creating another marker.
    for (const versionId of await versions()) await client.removeObject(bucket, key, { versionId });
    if ((await uploads()).length || (await versions()).length) throw new Error("CLEANUP_NOT_EMPTY");
  } catch {
    // SDK errors can contain signed URLs, bucket names or credentials.
    throw new Error("FEDERATION_STORAGE_CLEANUP_INCOMPLETE");
  }
}
