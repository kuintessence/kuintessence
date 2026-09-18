import {
  RecipeRepositoryNameSchema,
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  type SpackMaterialBlob,
  SpackMaterialBlobSchema,
  type SpackMaterialCatalog,
  type SpackMaterialCatalogQuery,
  SpackMaterialCatalogQuerySchema,
  SpackMaterialCatalogSchema,
  type SpackMaterialManifest,
  SpackMaterialManifestSchema,
  type SpackMaterialPublish,
  SpackMaterialPublishSchema,
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
  const { repository } = parse(query, SpackMaterialCatalogQuerySchema, 422);
  const params = new URLSearchParams();
  if (repository !== undefined) params.set("repository", repository);
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
  return catalog;
}

export async function uploadSpackMaterial(
  repository: string,
  blob: SpackMaterialBlob,
  file: File,
  signal?: AbortSignal,
): Promise<SpackMaterialBlob> {
  signal?.throwIfAborted();
  const name = parse(repository, RecipeRepositoryNameSchema, 422);
  const expected = parse(blob, SpackMaterialBlobSchema, 422);
  if (file?.size !== expected.size) {
    throw new SoftwareError(422, "VALIDATION_ERROR", "File size does not match material blob");
  }
  const body = await requestMaterial(
    `${BASE}/blobs?repository=${encodeURIComponent(name)}&digest=${encodeURIComponent(expected.digest)}`,
    {
      method: "POST",
      headers: { ...softwareWriteHeaders(), "Content-Type": "application/octet-stream" },
      body: file,
    },
    signal,
  );
  const uploaded = parse(body, SpackMaterialBlobSchema);
  if (uploaded.digest !== expected.digest || uploaded.size !== expected.size) {
    throw new SoftwareError(
      502,
      "REGISTRY_INVALID_RESPONSE",
      "Uploaded material digest or size does not match",
    );
  }
  return uploaded;
}

export async function publishSpackMaterial(
  input: SpackMaterialPublish,
  signal?: AbortSignal,
): Promise<SpackMaterialBinding> {
  signal?.throwIfAborted();
  const body = JSON.stringify(parse(input, SpackMaterialPublishSchema, 422));
  if (new TextEncoder().encode(body).byteLength > MAX_PUBLISH_BYTES) {
    throw new SoftwareError(413, "PAYLOAD_TOO_LARGE", "Material release exceeds 2 MiB");
  }
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
