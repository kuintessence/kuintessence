import { lstat, mkdir, mkdtemp, realpath, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  FederationDataOriginSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import type { z } from "zod";
import type { HttpClient } from "../staging/http-client";
import {
  type MultipartFromFileSource,
  multipartUploadFromFile,
} from "../staging/multipart-upload-from-file";
import { resumableDownload } from "../staging/resumable-download";

export class FederationFileTransferError extends Error {
  constructor(
    readonly code:
      | "INVALID_TASK"
      | "INVALID_GRANT"
      | "POLICY_DENIED"
      | "GRANT_UNAVAILABLE"
      | "GRANT_EXPIRED"
      | "UNTRUSTED_ORIGIN"
      | "STAGING_UNAVAILABLE"
      | "TRANSFER_CANCELLED"
      | "TRANSFER_IO_FAILED",
  ) {
    super(code);
  }
}
export interface FederationFileBinding {
  sizeBytes: number;
  sha256: string;
}
export interface FederationFileCopyGrant<B extends FederationFileBinding> {
  binding: B;
  direction: "download" | "upload";
  partNumber?: number;
  url: string;
  expiresAt: string;
}
export interface FederationFileCopyOptions<B extends FederationFileBinding> {
  binding: B;
  partSize: number;
  availableUntil: string;
  grantSchema: z.ZodType<FederationFileCopyGrant<B>>;
  /** Private directory/config supplied by the Agent operator, never by the peer. */
  stagingRoot: string;
  maxStagingBytes: number;
  allowedSourceOrigins: readonly string[];
  allowedDestinationOrigins: readonly string[];
  /** The Server verifies current authority and binds each fresh grant to this attempt. */
  authorize: (
    binding: B,
    direction: "download" | "upload",
    partNumber: number | undefined,
    signal: AbortSignal,
  ) => Promise<FederationFileCopyGrant<B>>;
  signal?: AbortSignal;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Internal byte movement for validated input/result tasks; never publishes a usable replica. */
export async function copyFederationFile<B extends FederationFileBinding>(
  opts: FederationFileCopyOptions<B>,
) {
  const binding = structuredClone(opts.binding);
  if (
    Date.parse(opts.availableUntil) <= Date.now() ||
    binding.sizeBytes > 5 * 1024 ** 4 ||
    Math.ceil(binding.sizeBytes / opts.partSize) > 10_000
  )
    throw new FederationFileTransferError("INVALID_TASK");
  const sourceOrigins = origins(opts.allowedSourceOrigins),
    destinationOrigins = origins(opts.allowedDestinationOrigins);
  let directory: string | undefined;
  try {
    opts.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(opts.maxStagingBytes) ||
      opts.maxStagingBytes < binding.sizeBytes ||
      !isAbsolute(opts.stagingRoot)
    )
      throw new FederationFileTransferError("STAGING_UNAVAILABLE");
    await mkdir(opts.stagingRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(opts.stagingRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      (root.mode & 0o077) !== 0 ||
      (await realpath(opts.stagingRoot)) !== resolve(opts.stagingRoot)
    )
      throw new FederationFileTransferError("STAGING_UNAVAILABLE");
    const capacity = await statfs(opts.stagingRoot, { bigint: true });
    if (capacity.bavail * capacity.bsize < BigInt(binding.sizeBytes) + 16n * 1024n * 1024n)
      throw new FederationFileTransferError("STAGING_UNAVAILABLE");
    directory = await mkdtemp(join(opts.stagingRoot, "transfer-"));
    const path = join(directory, "content");
    const authorize = (direction: "download" | "upload", partNumber?: number) =>
      fileGrant(
        opts,
        binding,
        direction,
        partNumber,
        direction === "download" ? sourceOrigins : destinationOrigins,
        (signal) => opts.authorize(structuredClone(binding), direction, partNumber, signal),
      );
    const fetcher = opts.fetcher ?? fetch;
    const http: HttpClient = async (request) => {
      const grant = await authorize("download");
      // URLs are deliberately excluded from every returned error and receipt.
      const response = await fetcher(grant.url, {
        method: "GET",
        headers: request.headers,
        redirect: "error",
        signal: grant.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        body: response.body,
        status: response.status,
        ok: response.ok,
        headers,
        text: () => response.text(),
        arrayBuffer: () => response.arrayBuffer(),
        json: <T>() => response.json() as Promise<T>,
      };
    };
    // Empty files still require current source authority even though no Range is necessary.
    if (binding.sizeBytes === 0) await authorize("download");
    await resumableDownload({
      downloadUrl: "https://unused.invalid/",
      localPath: path,
      size: binding.sizeBytes,
      sha256: binding.sha256,
      window: 1024 * 1024,
      http,
      signal: opts.signal,
    });
    return await uploadFederationFile({
      ...opts,
      binding,
      filePath: path,
      authorize: (partNumber, signal) =>
        opts.authorize(structuredClone(binding), "upload", partNumber, signal),
    });
  } catch (error) {
    if (opts.signal?.aborted) throw new FederationFileTransferError("TRANSFER_CANCELLED");
    if (error instanceof FederationFileTransferError) throw error;
    throw new FederationFileTransferError("TRANSFER_IO_FAILED");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
export function origins(values: readonly string[]) {
  try {
    if (!values.length) throw new Error("Empty origins");
    return new Set(
      values.map((value) => {
        const url = new URL(FederationDataOriginSchema.parse(value));
        return url.origin;
      }),
    );
  } catch {
    throw new FederationFileTransferError("UNTRUSTED_ORIGIN");
  }
}
export async function boundedAuthorization<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new FederationFileTransferError("GRANT_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, stopped]);
  } catch (error) {
    if (error instanceof FederationFileTransferError) throw error;
    throw new FederationFileTransferError("GRANT_UNAVAILABLE");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export type FederationFileUploadOptions<B extends FederationFileBinding> = MultipartFromFileSource &
  Pick<
    FederationFileCopyOptions<B>,
    | "binding"
    | "partSize"
    | "availableUntil"
    | "grantSchema"
    | "allowedDestinationOrigins"
    | "signal"
    | "fetcher"
  > & {
    authorize(partNumber: number, signal: AbortSignal): Promise<FederationFileCopyGrant<B>>;
    authorizeRead?: () => Promise<void>;
  };

/** Upload only; the caller owns an existing private file and publication remains a Server operation. */
export async function uploadFederationFile<B extends FederationFileBinding>(
  opts: FederationFileUploadOptions<B>,
) {
  const binding = structuredClone(opts.binding);
  const destinationOrigins = origins(opts.allowedDestinationOrigins);
  if (
    !Number.isFinite(Date.parse(opts.availableUntil)) ||
    Date.parse(opts.availableUntil) <= Date.now() ||
    !Number.isSafeInteger(binding.sizeBytes) ||
    binding.sizeBytes < 0 ||
    binding.sizeBytes > 5 * 1024 ** 4 ||
    !Number.isSafeInteger(opts.partSize) ||
    opts.partSize < 1 ||
    opts.partSize > 5 * 1024 ** 3 ||
    Math.ceil(binding.sizeBytes / opts.partSize) > 10_000
  )
    throw new FederationFileTransferError("INVALID_TASK");
  try {
    const authorize = (partNumber: number) =>
      fileGrant(opts, binding, "upload", partNumber, destinationOrigins, (signal) =>
        opts.authorize(partNumber, signal),
      );
    let partGrant: Awaited<ReturnType<typeof authorize>> | undefined;
    const uploaded = await multipartUploadFromFile({
      ...(opts.fileHandle ? { fileHandle: opts.fileHandle } : { filePath: opts.filePath }),
      size: binding.sizeBytes,
      partSize: opts.partSize,
      signal: opts.signal,
      maxRetries: 0,
      authorizeRead: opts.authorizeRead,
      getPartUrls: async ([partNumber]) => {
        if (partNumber === undefined) throw new FederationFileTransferError("INVALID_TASK");
        partGrant = await authorize(partNumber);
        return [{ partNumber, url: partGrant.url }];
      },
      put: async (url, body) => {
        if (!partGrant || partGrant.url !== url || partGrant.signal.aborted)
          throw new FederationFileTransferError("GRANT_EXPIRED");
        const response = await (opts.fetcher ?? fetch)(url, {
          method: "PUT",
          body,
          redirect: "error",
          signal: partGrant.signal,
          headers: {
            "Content-Length": String(body.size),
            "Content-Type": "application/octet-stream",
          },
        });
        const etag = response.headers.get("etag") ?? "";
        await response.body?.cancel();
        partGrant.signal.throwIfAborted();
        return { ok: response.ok, status: response.status, etag };
      },
    });
    opts.signal?.throwIfAborted();
    if (uploaded.sha256 !== binding.sha256 || uploaded.size !== binding.sizeBytes)
      throw new FederationFileTransferError("TRANSFER_IO_FAILED");
    return { binding, parts: uploaded.parts, sizeBytes: uploaded.size, sha256: uploaded.sha256 };
  } catch (error) {
    if (opts.signal?.aborted) throw new FederationFileTransferError("TRANSFER_CANCELLED");
    if (error instanceof FederationFileTransferError) throw error;
    throw new FederationFileTransferError("TRANSFER_IO_FAILED");
  }
}

async function fileGrant<B extends FederationFileBinding>(
  opts: Pick<FederationFileCopyOptions<B>, "grantSchema" | "availableUntil" | "signal">,
  binding: B,
  direction: "download" | "upload",
  partNumber: number | undefined,
  allowedOrigins: ReadonlySet<string>,
  request: (signal: AbortSignal) => Promise<FederationFileCopyGrant<B>>,
) {
  const timeout = AbortSignal.timeout(10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const response = await boundedAuthorization(request(signal), signal);
  const checked = opts.grantSchema.safeParse(response);
  if (
    !checked.success ||
    federationCanonicalJson(checked.data.binding) !== federationCanonicalJson(binding) ||
    checked.data.direction !== direction ||
    checked.data.partNumber !== partNumber
  )
    throw new FederationFileTransferError("INVALID_GRANT");
  const grant = checked.data,
    expires = Date.parse(grant.expiresAt);
  if (
    expires <= Date.now() ||
    expires > Date.now() + 60_000 ||
    expires > Date.parse(opts.availableUntil)
  )
    throw new FederationFileTransferError("GRANT_EXPIRED");
  const url = new URL(grant.url);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.protocol !== "https:" ||
    !allowedOrigins.has(url.origin)
  )
    throw new FederationFileTransferError("UNTRUSTED_ORIGIN");
  const lease = AbortSignal.timeout(Math.max(1, expires - Date.now()));
  return { ...grant, signal: opts.signal ? AbortSignal.any([opts.signal, lease]) : lease };
}
