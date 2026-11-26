import {
  RecipeRepositoryNameSchema,
  SPACK_MATERIAL_CHUNK_BYTES,
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  type SpackMaterialBlob,
  SpackMaterialBlobSchema,
  type SpackMaterialCatalog,
  type SpackMaterialCatalogQuery,
  SpackMaterialCatalogQuerySchema,
  SpackMaterialCatalogSchema,
  SpackMaterialImportStatusSchema,
  type SpackMaterialManifest,
  SpackMaterialManifestSchema,
  type SpackMaterialPublish,
  SpackMaterialPublishSchema,
  SpackMaterialUploadProgressSchema,
  spackMaterialCatalogPosition,
  spackMaterialInputBlobs,
} from "@kuintessence/shared/browser";
import { requestSoftwareJson, SoftwareError, softwareWriteHeaders } from "./software-client";

const BASE = "/spack/material-repositories";
const MAX_PUBLISH_BYTES = 2 * 1024 ** 2;

function parse<T>(
  body: unknown,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  status: 422 | 502 = 502,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new SoftwareError(
      status,
      status === 422 ? "VALIDATION_ERROR" : "REGISTRY_INVALID_RESPONSE",
      status === 422 ? "Invalid Spack material input" : "Invalid Spack material response",
    );
  }
  return parsed.data;
}

async function requestMaterial(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  try {
    const body = await requestSoftwareJson<unknown>(path, {
      ...init,
      signal,
      redirect: "error",
    });
    signal?.throwIfAborted();
    return body;
  } catch (error) {
    // The shared client wraps fetch and body failures, including cancellation.
    signal?.throwIfAborted();
    throw error;
  }
}

export async function listSpackMaterials(
  query: SpackMaterialCatalogQuery = {},
  signal?: AbortSignal,
): Promise<SpackMaterialCatalog> {
  signal?.throwIfAborted();
  const { repository, limit, after } = parse(query, SpackMaterialCatalogQuerySchema, 422);
  const params = new URLSearchParams();
  if (repository !== undefined) params.set("repository", repository);
  if (limit !== undefined) params.set("limit", String(limit));
  if (after) params.set("after", after);
  const suffix = params.toString();
  const catalog = parse(
    await requestMaterial(
      `${BASE}${suffix ? `?${suffix}` : ""}`,
      { method: "GET", cache: "no-store" },
      signal,
    ),
    SpackMaterialCatalogSchema,
  );
  if (
    repository !== undefined &&
    catalog.releases.some((release) => release.repository !== repository)
  ) {
    throw new SoftwareError(
      502,
      "REGISTRY_INVALID_RESPONSE",
      "Material catalog does not match requested repository",
    );
  }
  if (catalog.nextCursor && limit === undefined)
    throw new SoftwareError(
      502,
      "REGISTRY_INVALID_RESPONSE",
      "Unexpected paginated material catalog",
    );
  if (limit !== undefined) {
    const positions = catalog.releases.map(spackMaterialCatalogPosition);
    if (
      positions.length > limit ||
      positions.some((position, index) => position <= (positions[index - 1] ?? after ?? "")) ||
      (catalog.nextCursor &&
        (positions.length !== limit || catalog.nextCursor !== positions.at(-1)))
    )
      throw new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "Invalid material catalog page");
  }
  return catalog;
}

export async function uploadSpackMaterial(
  repository: string,
  blob: SpackMaterialBlob,
  file: File,
  signal?: AbortSignal,
  checkAccess?: (repository: string) => void,
): Promise<SpackMaterialBlob> {
  signal?.throwIfAborted();
  const name = parse(repository, RecipeRepositoryNameSchema, 422);
  const expected = parse(blob, SpackMaterialBlobSchema, 422);
  if (file?.size !== expected.size) {
    throw new SoftwareError(422, "VALIDATION_ERROR", "File size does not match material blob");
  }
  const query = `repository=${encodeURIComponent(name)}&digest=${encodeURIComponent(expected.digest)}`;
  const headers = { ...softwareWriteHeaders(), "Content-Type": "application/octet-stream" };
  let uploaded: SpackMaterialBlob;
  if (expected.size > SPACK_MATERIAL_CHUNK_BYTES) {
    const path = `${BASE}/blob-uploads?${query}&size=${expected.size}`;
    let progress = parse(
      await requestMaterial(path, { method: "POST", headers }, signal),
      SpackMaterialUploadProgressSchema,
    );
    let previous = -1;
    while ("offset" in progress) {
      const offset = progress.offset;
      if (
        offset <= previous ||
        offset >= expected.size ||
        offset % SPACK_MATERIAL_CHUNK_BYTES !== 0
      )
        throw new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "Invalid material upload offset");
      checkAccess?.(name);
      previous = offset;
      progress = parse(
        await requestMaterial(
          path,
          {
            method: "POST",
            headers: { ...headers, "Upload-Offset": String(offset) },
            body: file.slice(offset, offset + SPACK_MATERIAL_CHUNK_BYTES),
          },
          signal,
        ),
        SpackMaterialUploadProgressSchema,
      );
    }
    uploaded = progress;
  } else {
    uploaded = parse(
      await requestMaterial(
        `${BASE}/blobs?${query}`,
        {
          method: "POST",
          headers,
          body: file,
        },
        signal,
      ),
      SpackMaterialBlobSchema,
    );
  }
  if (uploaded.digest !== expected.digest || uploaded.size !== expected.size) {
    throw new SoftwareError(
      502,
      "REGISTRY_INVALID_RESPONSE",
      "Uploaded material digest or size does not match",
    );
  }
  return uploaded;
}

function releaseBody(input: SpackMaterialPublish) {
  const body = JSON.stringify(parse(input, SpackMaterialPublishSchema, 422));
  if (new TextEncoder().encode(body).byteLength > MAX_PUBLISH_BYTES) {
    throw new SoftwareError(413, "PAYLOAD_TOO_LARGE", "Material release exceeds 2 MiB");
  }
  return body;
}

export async function getSpackMaterialImportStatus(
  input: SpackMaterialPublish,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const status = parse(
    await requestMaterial(
      `${BASE}/imports/status`,
      {
        method: "POST",
        headers: softwareWriteHeaders(),
        cache: "no-store",
        body: releaseBody(input),
      },
      signal,
    ),
    SpackMaterialImportStatusSchema,
  );
  if (status.state === "pending") {
    const references = new Set(spackMaterialInputBlobs(input).map((blob) => blob.digest));
    if (status.missing.some((digest) => !references.delete(digest)))
      throw new SoftwareError(
        502,
        "REGISTRY_INVALID_RESPONSE",
        "Unexpected missing material digest",
      );
  }
  return status;
}

export async function publishSpackMaterial(
  input: SpackMaterialPublish,
  signal?: AbortSignal,
): Promise<SpackMaterialBinding> {
  signal?.throwIfAborted();
  const body = releaseBody(input);
  return parse(
    await requestMaterial(
      `${BASE}/releases`,
      { method: "POST", headers: softwareWriteHeaders(), body },
      signal,
    ),
    SpackMaterialBindingSchema,
  );
}

export async function getSpackMaterial(
  binding: SpackMaterialBinding,
  signal?: AbortSignal,
): Promise<SpackMaterialManifest> {
  signal?.throwIfAborted();
  const { repositoryId, manifestDigest } = parse(binding, SpackMaterialBindingSchema, 422);
  return parse(
    await requestMaterial(
      `${BASE}/${encodeURIComponent(repositoryId)}/releases/${encodeURIComponent(manifestDigest)}`,
      { method: "GET" },
      signal,
    ),
    SpackMaterialManifestSchema,
  );
}
