import { createHash } from "node:crypto";
import {
  type FederationMediaObjectBinding,
  FederationMediaObjectBindingSchema,
  FederationMediaObjectGrantSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { createDefaultHttpClient, type HttpClient } from "../staging/http-client";
import { readBoundedResponse, readDownloadRange } from "../staging/resumable-download";
import { boundedAuthorization, FederationFileTransferError, origins } from "./file-copy";

const WINDOW = 1024 * 1024;

/** Streams one pinned object into age; never stages a plaintext file or follows a storage redirect. */
export async function* readFederationMediaObject(options: {
  binding: FederationMediaObjectBinding;
  availableUntil: string;
  allowedSourceOrigins: readonly string[];
  authorize(binding: FederationMediaObjectBinding, signal: AbortSignal): Promise<unknown>;
  signal: AbortSignal;
  http?: HttpClient;
}): AsyncGenerator<Uint8Array> {
  const parsed = FederationMediaObjectBindingSchema.safeParse(options.binding);
  const deadline = Date.parse(options.availableUntil);
  if (!parsed.success || !Number.isFinite(deadline) || deadline <= Date.now())
    throw new FederationFileTransferError("INVALID_TASK");
  const binding = parsed.data,
    allowed = origins(options.allowedSourceOrigins);
  const http = options.http ?? createDefaultHttpClient();
  let cached: { url: string; expires: number } | undefined;
  async function grant(force = false) {
    options.signal.throwIfAborted();
    if (deadline <= Date.now()) throw new FederationFileTransferError("GRANT_EXPIRED");
    if (force || !cached || cached.expires <= Date.now() + 1000) {
      const signal = AbortSignal.any([
        options.signal,
        AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
      ]);
      const raw = await boundedAuthorization(
        options.authorize(structuredClone(binding), signal),
        signal,
      );
      const value = FederationMediaObjectGrantSchema.safeParse(raw);
      if (
        !value.success ||
        federationCanonicalJson(value.data.binding) !== federationCanonicalJson(binding)
      )
        throw new FederationFileTransferError("INVALID_GRANT");
      const expires = Date.parse(value.data.expiresAt);
      if (expires <= Date.now() || expires > Date.now() + 30_000 || expires > deadline)
        throw new FederationFileTransferError("GRANT_EXPIRED");
      if (!allowed.has(new URL(value.data.url).origin))
        throw new FederationFileTransferError("UNTRUSTED_ORIGIN");
      cached = { url: value.data.url, expires };
    }
    return cached;
  }
  try {
    const hash = createHash("sha256");
    let offset = 0;
    do {
      const permit = await grant();
      const remaining = permit.expires - Date.now();
      if (remaining <= 0) throw new FederationFileTransferError("GRANT_EXPIRED");
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(remaining)]);
      const end = Math.min(offset + WINDOW, binding.sizeBytes) - 1;
      const response = await boundedAuthorization(
        http({
          method: "GET",
          url: permit.url,
          headers:
            binding.sizeBytes === 0
              ? {}
              : { Range: `bytes=${offset}-${end}`, "Accept-Encoding": "identity" },
          redirect: "error",
          signal,
        }),
        signal,
      );
      try {
        signal.throwIfAborted();
        if (response.headers["x-amz-version-id"] !== binding.versionId)
          throw new FederationFileTransferError("INVALID_GRANT");
        if (!binding.sizeBytes) {
          if (
            response.status !== 200 ||
            (response.headers["content-length"] !== undefined &&
              response.headers["content-length"] !== "0") ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity")
          )
            throw new FederationFileTransferError("TRANSFER_IO_FAILED");
          await readBoundedResponse(response, 0, signal);
          signal.throwIfAborted();
          break;
        }
        const chunk = await readDownloadRange(response, offset, end, binding.sizeBytes, signal);
        signal.throwIfAborted();
        hash.update(chunk);
        offset += chunk.length;
        yield chunk;
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    } while (offset < binding.sizeBytes);
    if (hash.digest("hex") !== binding.sha256)
      throw new FederationFileTransferError("TRANSFER_IO_FAILED");
    await grant(true);
  } catch (error) {
    if (options.signal.aborted) throw new FederationFileTransferError("TRANSFER_CANCELLED");
    if (error instanceof FederationFileTransferError) throw error;
    throw new FederationFileTransferError("TRANSFER_IO_FAILED");
  }
}
