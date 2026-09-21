import {
  SPACK_UPSTREAM_IMPORT_MAX_BYTES,
  type SpackUpstreamImport,
  type SpackUpstreamImportResult,
  SpackUpstreamImportResultSchema,
  SpackUpstreamImportSchema,
} from "@kuintessence/shared/browser";
import { requestSoftwareJson, SoftwareError, softwareWriteHeaders } from "./software-client";

export function parseSpackUpstreamImport(input: unknown): SpackUpstreamImport {
  const parsed = SpackUpstreamImportSchema.safeParse(input);
  if (!parsed.success) {
    throw new SoftwareError(422, "VALIDATION_ERROR", "Invalid online import manifest");
  }
  return parsed.data;
}

export async function readSpackUpstreamManifest(
  file: File,
  signal?: AbortSignal,
): Promise<SpackUpstreamImport> {
  signal?.throwIfAborted();
  if (file.size === 0 || file.size > SPACK_UPSTREAM_IMPORT_MAX_BYTES) {
    throw new SoftwareError(422, "VALIDATION_ERROR", "Invalid online import manifest size");
  }
  try {
    const bytes = await file.arrayBuffer();
    signal?.throwIfAborted();
    if (bytes.byteLength !== file.size) throw new Error("Manifest size mismatch");
    return parseSpackUpstreamImport(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    signal?.throwIfAborted();
    throw new SoftwareError(422, "VALIDATION_ERROR", "Invalid online import manifest");
  }
}

export async function importSpackUpstream(
  input: SpackUpstreamImport,
  signal?: AbortSignal,
): Promise<SpackUpstreamImportResult> {
  signal?.throwIfAborted();
  const request = parseSpackUpstreamImport(input);
  const body = JSON.stringify(request);
  if (new TextEncoder().encode(body).byteLength > SPACK_UPSTREAM_IMPORT_MAX_BYTES) {
    throw new SoftwareError(413, "PAYLOAD_TOO_LARGE", "Online import manifest exceeds 2 MiB");
  }
  try {
    const response = await requestSoftwareJson<unknown>("/spack/upstream-imports", {
      method: "POST",
      headers: softwareWriteHeaders(),
      body,
      signal,
      redirect: "error",
    });
    signal?.throwIfAborted();
    const parsed = SpackUpstreamImportResultSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.kind !== request.kind ||
      (parsed.data.kind === "recipe" &&
        request.kind === "recipe" &&
        parsed.data.repository.repository !== request.repository)
    ) {
      throw new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "Invalid online import receipt");
    }
    if (request.kind === "material" && parsed.data.kind === "material") {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(request.release.repository),
      );
      signal?.throwIfAborted();
      const repositoryId = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (parsed.data.binding.repositoryId !== repositoryId) {
        throw new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "Invalid online import receipt");
      }
    }
    return parsed.data;
  } catch (error) {
    // The shared transport wraps fetch/body cancellation; preserve the caller's signal.
    signal?.throwIfAborted();
    throw error;
  }
}
