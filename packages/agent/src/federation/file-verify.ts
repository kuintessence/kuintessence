import { createHash } from "node:crypto";
import { federationCanonicalJson } from "@kuintessence/shared/federation";
import type { z } from "zod";
import type { HttpResponse } from "../staging/http-client";
import { readBoundedResponse, readDownloadRange } from "../staging/resumable-download";
import {
  boundedAuthorization,
  type FederationFileBinding,
  FederationFileTransferError,
  origins,
} from "./file-copy";

export interface FederationFileVerifyTask<B extends FederationFileBinding> {
  binding: B;
  object: { versionId: string | null; etag: string };
  availableUntil: string;
}
export interface FederationFileVerificationGrant {
  direction: "verify";
  url: string;
  expiresAt: string;
}
export interface FederationFileVerifyOptions<
  T extends FederationFileVerifyTask<FederationFileBinding>,
> {
  task: T;
  taskSchema: z.ZodType<T>;
  grantSchema: z.ZodType<T & FederationFileVerificationGrant>;
  allowedDestinationOrigins: readonly string[];
  authorize: (task: T, signal: AbortSignal) => Promise<T & FederationFileVerificationGrant>;
  signal: AbortSignal;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Re-read the completed object: neither multipart receipts nor HEAD prove its hash. */
export async function verifyFederationFile<
  T extends FederationFileVerifyTask<FederationFileBinding>,
>(options: FederationFileVerifyOptions<T>) {
  try {
    const parsed = options.taskSchema.safeParse(options.task);
    if (!parsed.success) throw new FederationFileTransferError("INVALID_TASK");
    const task = parsed.data;
    const allowed = origins(options.allowedDestinationOrigins);
    const hash = createHash("sha256");
    if (task.binding.sizeBytes > 5 * 1024 ** 4 || Date.parse(task.availableUntil) <= Date.now())
      throw new FederationFileTransferError("INVALID_TASK");
    let offset = 0;
    do {
      options.signal.throwIfAborted();
      const authorizationSignal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
      const checked = options.grantSchema.safeParse(
        await boundedAuthorization(
          options.authorize(structuredClone(task), authorizationSignal),
          authorizationSignal,
        ),
      );
      if (!checked.success) throw new FederationFileTransferError("INVALID_GRANT");
      const grant = checked.data;
      if (
        federationCanonicalJson({
          binding: grant.binding,
          object: grant.object,
          availableUntil: grant.availableUntil,
        }) !== federationCanonicalJson(task)
      )
        throw new FederationFileTransferError("INVALID_GRANT");
      const expires = Date.parse(grant.expiresAt);
      if (
        expires <= Date.now() ||
        expires > Date.now() + 60_000 ||
        expires > Date.parse(task.availableUntil)
      )
        throw new FederationFileTransferError("GRANT_EXPIRED");
      const url = new URL(grant.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !allowed.has(url.origin)
      )
        throw new FederationFileTransferError("UNTRUSTED_ORIGIN");
      if (
        (task.object.versionId !== null &&
          (url.searchParams.get("versionId") !== task.object.versionId ||
            url.searchParams.getAll("versionId").length !== 1)) ||
        (task.object.versionId === null && url.searchParams.has("versionId"))
      )
        throw new FederationFileTransferError("INVALID_GRANT");
      const signal = AbortSignal.any([
        options.signal,
        AbortSignal.timeout(Math.max(1, expires - Date.now())),
      ]);
      const end = Math.min(offset + 1024 * 1024, task.binding.sizeBytes) - 1;
      const response = await (options.fetcher ?? fetch)(grant.url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: {
          "If-Match": `"${task.object.etag}"`,
          ...(task.binding.sizeBytes ? { Range: `bytes=${offset}-${end}` } : {}),
        },
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const res: HttpResponse = {
        headers,
        body: response.body,
        status: response.status,
        ok: response.ok,
        text: () => response.text(),
        arrayBuffer: () => response.arrayBuffer(),
        json: <T>() => response.json() as Promise<T>,
      };
      if (
        headers.etag !== `"${task.object.etag}"` ||
        (task.object.versionId !== null && headers["x-amz-version-id"] !== task.object.versionId) ||
        (task.object.versionId === null &&
          !!headers["x-amz-version-id"] &&
          headers["x-amz-version-id"] !== "null")
      ) {
        await response.body?.cancel();
        throw new FederationFileTransferError("INVALID_GRANT");
      }
      let bytes: Buffer;
      if (task.binding.sizeBytes)
        bytes = await readDownloadRange(res, offset, end, task.binding.sizeBytes, signal);
      else {
        if (
          response.status !== 200 ||
          (headers["content-length"] !== undefined && headers["content-length"] !== "0") ||
          (headers["content-encoding"] && headers["content-encoding"] !== "identity")
        ) {
          await response.body?.cancel();
          throw new FederationFileTransferError("TRANSFER_IO_FAILED");
        }
        bytes = await readBoundedResponse(res, 0, signal);
      }
      signal.throwIfAborted();
      hash.update(bytes);
      offset += bytes.length;
    } while (offset < task.binding.sizeBytes);
    options.signal.throwIfAborted();
    const sha256 = hash.digest("hex");
    if (sha256 !== task.binding.sha256) throw new FederationFileTransferError("TRANSFER_IO_FAILED");
    return { ...task, sizeBytes: offset, sha256 };
  } catch (error) {
    if (options.signal.aborted) throw new FederationFileTransferError("TRANSFER_CANCELLED");
    if (error instanceof FederationFileTransferError) throw error;
    throw new FederationFileTransferError("TRANSFER_IO_FAILED");
  }
}
