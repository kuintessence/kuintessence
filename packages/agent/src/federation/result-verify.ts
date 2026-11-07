import { createHash } from "node:crypto";
import {
  type FederationResultVerificationGrant,
  FederationResultVerificationGrantSchema,
  type FederationResultVerifyTask,
  FederationResultVerifyTaskSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import type { HttpResponse } from "../staging/http-client";
import { readBoundedResponse, readDownloadRange } from "../staging/resumable-download";
import { boundedAuthorization, FederationResultCopyError, origins } from "./result-copy";

/** Re-reads the completed destination object; neither an upload receipt nor HEAD proves its hash. */
export async function verifyFederationResultFile(options: {
  task: FederationResultVerifyTask;
  allowedDestinationOrigins: readonly string[];
  authorize: (
    task: FederationResultVerifyTask,
    signal: AbortSignal,
  ) => Promise<FederationResultVerificationGrant>;
  signal: AbortSignal;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}) {
  try {
    const task = FederationResultVerifyTaskSchema.parse(options.task);
    const allowed = origins(options.allowedDestinationOrigins);
    const hash = createHash("sha256");
    if (task.binding.sizeBytes > 5 * 1024 ** 4 || Date.parse(task.availableUntil) <= Date.now())
      throw new FederationResultCopyError("INVALID_TASK");
    let offset = 0;
    do {
      options.signal.throwIfAborted();
      const authorizationSignal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
      const grant = FederationResultVerificationGrantSchema.parse(
        await boundedAuthorization(
          options.authorize(structuredClone(task), authorizationSignal),
          authorizationSignal,
        ),
      );
      if (
        federationCanonicalJson({
          binding: grant.binding,
          object: grant.object,
          availableUntil: grant.availableUntil,
        }) !== federationCanonicalJson(task)
      )
        throw new FederationResultCopyError("INVALID_GRANT");
      const expires = Date.parse(grant.expiresAt);
      if (
        expires <= Date.now() ||
        expires > Date.now() + 60_000 ||
        expires > Date.parse(task.availableUntil)
      )
        throw new FederationResultCopyError("GRANT_EXPIRED");
      const url = new URL(grant.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !allowed.has(url.origin)
      )
        throw new FederationResultCopyError("UNTRUSTED_ORIGIN");
      if (
        (task.object.versionId !== null &&
          (url.searchParams.get("versionId") !== task.object.versionId ||
            url.searchParams.getAll("versionId").length !== 1)) ||
        (task.object.versionId === null && url.searchParams.has("versionId"))
      )
        throw new FederationResultCopyError("INVALID_GRANT");
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
        throw new FederationResultCopyError("INVALID_GRANT");
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
          throw new FederationResultCopyError("TRANSFER_IO_FAILED");
        }
        bytes = await readBoundedResponse(res, 0, signal);
      }
      signal.throwIfAborted();
      hash.update(bytes);
      offset += bytes.length;
    } while (offset < task.binding.sizeBytes);
    options.signal.throwIfAborted();
    const sha256 = hash.digest("hex");
    if (sha256 !== task.binding.sha256) throw new FederationResultCopyError("TRANSFER_IO_FAILED");
    return { ...task, sizeBytes: offset, sha256 };
  } catch (error) {
    if (options.signal.aborted) throw new FederationResultCopyError("TRANSFER_CANCELLED");
    if (error instanceof FederationResultCopyError) throw error;
    throw new FederationResultCopyError("TRANSFER_IO_FAILED");
  }
}
