import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  FederationDigestSchema,
  FederationResultReportSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { z } from "zod";
import type { HttpClient } from "../staging/http-client";
import { multipartUploadFromFile } from "../staging/multipart-upload-from-file";
import { resumableDownload } from "../staging/resumable-download";

const TaskSchema = z.strictObject({
  transferId: z.uuid(),
  generation: z.uuid(),
  report: FederationResultReportSchema,
  outputId: FederationDigestSchema,
  path: z.string().min(1).max(255),
  partSize: z
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .max(5 * 1024 * 1024 * 1024),
});
export type FederationResultCopyTask = z.infer<typeof TaskSchema>;
const BindingSchema = z.strictObject({
  transferId: z.uuid(),
  generation: z.uuid(),
  operationId: z.uuid(),
  manifestDigest: FederationDigestSchema,
  outputId: FederationDigestSchema,
  path: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  partSize: TaskSchema.shape.partSize,
});
export type FederationResultCopyBinding = z.infer<typeof BindingSchema>;
const GrantSchema = z
  .strictObject({
    binding: BindingSchema,
    direction: z.enum(["download", "upload"]),
    partNumber: z.number().int().min(1).max(10_000).optional(),
    url: z.string().max(8192),
    expiresAt: z.iso.datetime(),
  })
  .refine((v) => (v.direction === "upload") === (v.partNumber !== undefined));
export type FederationResultCopyGrant = z.infer<typeof GrantSchema>;
export class FederationResultCopyError extends Error {
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
export interface FederationResultCopyOptions {
  task: FederationResultCopyTask;
  /** Private directory/config supplied by the Agent operator, never by the peer. */
  stagingRoot: string;
  maxStagingBytes: number;
  allowedSourceOrigins: readonly string[];
  allowedDestinationOrigins: readonly string[];
  /** The Server must verify current bilateral authority and bind each fresh grant to this attempt. */
  authorize: (
    binding: FederationResultCopyBinding,
    direction: "download" | "upload",
    partNumber: number | undefined,
    signal: AbortSignal,
  ) => Promise<FederationResultCopyGrant>;
  signal?: AbortSignal;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Agent-side byte movement only: returns uncommitted S3 parts, never publishes a usable replica. */
export async function copyFederationResultFile(opts: FederationResultCopyOptions) {
  const parsed = TaskSchema.safeParse(opts.task);
  if (!parsed.success) throw new FederationResultCopyError("INVALID_TASK");
  const task = parsed.data;
  const digest = `sha256:${createHash("sha256").update(federationCanonicalJson(task.report.manifest)).digest("hex")}`;
  const output = task.report.manifest.outputs.find((item) => item.outputId === task.outputId);
  const member = output?.files.find((item) => item.path === task.path);
  if (
    !member ||
    digest !== task.report.manifestDigest ||
    Date.parse(task.report.manifest.availableUntil) <= Date.now() ||
    member.sizeBytes > 5 * 1024 ** 4 ||
    Math.ceil(member.sizeBytes / task.partSize) > 10_000
  )
    throw new FederationResultCopyError("INVALID_TASK");
  const binding = BindingSchema.parse({
    transferId: task.transferId,
    generation: task.generation,
    operationId: task.report.operationId,
    manifestDigest: digest,
    outputId: task.outputId,
    path: task.path,
    sizeBytes: member.sizeBytes,
    sha256: member.sha256,
    partSize: task.partSize,
  });
  const sourceOrigins = origins(opts.allowedSourceOrigins),
    destinationOrigins = origins(opts.allowedDestinationOrigins);
  let directory: string | undefined;
  try {
    opts.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(opts.maxStagingBytes) ||
      opts.maxStagingBytes < member.sizeBytes ||
      !isAbsolute(opts.stagingRoot)
    )
      throw new FederationResultCopyError("STAGING_UNAVAILABLE");
    await mkdir(opts.stagingRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(opts.stagingRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      (root.mode & 0o077) !== 0 ||
      (await realpath(opts.stagingRoot)) !== resolve(opts.stagingRoot)
    )
      throw new FederationResultCopyError("STAGING_UNAVAILABLE");
    const capacity = await statfs(opts.stagingRoot, { bigint: true });
    if (capacity.bavail * capacity.bsize < BigInt(member.sizeBytes) + 16n * 1024n * 1024n)
      throw new FederationResultCopyError("STAGING_UNAVAILABLE");
    directory = await mkdtemp(join(opts.stagingRoot, "result-"));
    const path = join(directory, "content");
    const authorize = async (direction: "download" | "upload", partNumber?: number) => {
      const timeout = AbortSignal.timeout(10_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const response = await boundedAuthorization(
        opts.authorize(structuredClone(binding), direction, partNumber, signal),
        signal,
      );
      const checked = GrantSchema.safeParse(response);
      if (
        !checked.success ||
        federationCanonicalJson(checked.data.binding) !== federationCanonicalJson(binding) ||
        checked.data.direction !== direction ||
        checked.data.partNumber !== partNumber
      )
        throw new FederationResultCopyError("INVALID_GRANT");
      const grant = checked.data,
        expires = Date.parse(grant.expiresAt);
      if (
        expires <= Date.now() ||
        expires > Date.now() + 60_000 ||
        expires > Date.parse(task.report.manifest.availableUntil)
      )
        throw new FederationResultCopyError("GRANT_EXPIRED");
      const url = new URL(grant.url);
      if (
        url.username ||
        url.password ||
        url.hash ||
        url.protocol !== "https:" ||
        !(direction === "download" ? sourceOrigins : destinationOrigins).has(url.origin)
      )
        throw new FederationResultCopyError("UNTRUSTED_ORIGIN");
      const lease = AbortSignal.timeout(Math.max(1, expires - Date.now()));
      return { ...grant, signal: opts.signal ? AbortSignal.any([opts.signal, lease]) : lease };
    };
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
    if (member.sizeBytes === 0) await authorize("download");
    await resumableDownload({
      downloadUrl: "https://unused.invalid/",
      localPath: path,
      size: member.sizeBytes,
      sha256: member.sha256,
      window: 1024 * 1024,
      http,
      signal: opts.signal,
    });
    let partGrant: Awaited<ReturnType<typeof authorize>> | undefined;
    const uploaded = await multipartUploadFromFile({
      filePath: path,
      size: member.sizeBytes,
      partSize: task.partSize,
      signal: opts.signal,
      maxRetries: 0,
      getPartUrls: async ([partNumber]) => {
        if (partNumber === undefined) throw new FederationResultCopyError("INVALID_TASK");
        partGrant = await authorize("upload", partNumber);
        return [{ partNumber, url: partGrant.url }];
      },
      put: async (url, body) => {
        if (!partGrant || partGrant.url !== url || partGrant.signal.aborted)
          throw new FederationResultCopyError("GRANT_EXPIRED");
        const response = await fetcher(url, {
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
      throw new FederationResultCopyError("TRANSFER_IO_FAILED");
    return { binding, parts: uploaded.parts, sizeBytes: uploaded.size, sha256: uploaded.sha256 };
  } catch (error) {
    if (opts.signal?.aborted) throw new FederationResultCopyError("TRANSFER_CANCELLED");
    if (error instanceof FederationResultCopyError) throw error;
    throw new FederationResultCopyError("TRANSFER_IO_FAILED");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
function origins(values: readonly string[]) {
  try {
    if (!values.length) throw new Error("Empty origins");
    return new Set(
      values.map((value) => {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        )
          throw new Error("Invalid origin");
        return url.origin;
      }),
    );
  } catch {
    throw new FederationResultCopyError("UNTRUSTED_ORIGIN");
  }
}
async function boundedAuthorization<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new FederationResultCopyError("GRANT_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, stopped]);
  } catch (error) {
    if (error instanceof FederationResultCopyError) throw error;
    throw new FederationResultCopyError("GRANT_UNAVAILABLE");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
