import {
  type SpackMaterialManagementCatalog,
  SpackMaterialManagementCatalogSchema,
  type SpackMaterialManagementQuery,
  SpackMaterialManagementQuerySchema,
} from "@kuintessence/shared/browser";
import { requestSoftwareJson, SoftwareError } from "./software-client";

function invalidResponse(): SoftwareError {
  return new SoftwareError(
    502,
    "REGISTRY_INVALID_RESPONSE",
    "Invalid Spack material management response",
  );
}

export async function listSpackMaterialManagement(
  query: Pick<SpackMaterialManagementQuery, "repository"> &
    Partial<Omit<SpackMaterialManagementQuery, "repository">>,
  signal?: AbortSignal,
): Promise<SpackMaterialManagementCatalog> {
  signal?.throwIfAborted();
  const parsed = SpackMaterialManagementQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new SoftwareError(422, "VALIDATION_ERROR", "Invalid Spack material management input");
  }
  const { repository, state, after, limit } = parsed.data;
  const params = new URLSearchParams({ repository, state, limit: String(limit) });
  if (after !== undefined) params.set("after", after);
  try {
    const body = await requestSoftwareJson<unknown>(
      `/spack/material-repositories/management?${params}`,
      { method: "GET", signal, redirect: "error", cache: "no-store" },
    );
    signal?.throwIfAborted();
    const result = SpackMaterialManagementCatalogSchema.safeParse(body);
    if (!result.success || result.data.releases.length > limit) throw invalidResponse();
    let digest: ArrayBuffer;
    try {
      digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repository));
    } catch {
      signal?.throwIfAborted();
      throw invalidResponse();
    }
    signal?.throwIfAborted();
    const repositoryId = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    let previous: string | undefined;
    for (const release of result.data.releases) {
      if (
        release.repository !== repository ||
        release.repositoryId !== repositoryId ||
        (state !== "all" && release.state !== state) ||
        (previous !== undefined && release.manifestDigest <= previous)
      ) {
        throw invalidResponse();
      }
      previous = release.manifestDigest;
    }
    const { nextCursor } = result.data;
    // Opaque cursors may advance across an empty filtered page; never compare them to digests.
    if (nextCursor !== null && nextCursor === after) {
      throw invalidResponse();
    }
    return result.data;
  } catch (error) {
    // The shared transport wraps fetch/body cancellation; preserve the caller's signal.
    signal?.throwIfAborted();
    throw error;
  }
}
