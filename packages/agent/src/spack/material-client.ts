import { createHash } from "node:crypto";
import {
  type SpackMaterialBlob,
  SpackMaterialDigestSchema,
  type SpackMaterialManifest,
  SpackMaterialManifestSchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { SpackMaterialCache, type SpackMaterialCacheRef } from "./material-cache";

const MAX_MANIFEST_BYTES = 2 * 1024 ** 2;
const MAX_TOTAL_BYTES = 512 * 1024 ** 3;
const MAX_CONCURRENT_PREPARES = 2;
const REQUEST_TIMEOUT_MS = 60_000;
const PREPARE_TIMEOUT_MS = 10 * 60_000;

export type SpackMaterialFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SpackMaterialContext {
  operationId: string;
  ticket?: string;
  manifestDigest?: string;
}

export interface SpackMaterialPrepareInput {
  operationId: string;
  ticket: string;
  manifestDigest: string;
  spec: string;
  spackVersion: string;
  signal?: AbortSignal;
}

export interface PreparedSpackMaterials {
  manifest: SpackMaterialManifest;
  manifestDigest: string;
  manifestPath: string;
  manifestSize: number;
  blobs: SpackMaterialCacheRef[];
}

export interface SpackMaterialProvider {
  prepare(input: SpackMaterialPrepareInput): Promise<PreparedSpackMaterials>;
}

export function configureSpackMaterialClient(options: {
  enabled: boolean;
  serverUrl?: string;
  cacheDir?: string;
}): { client?: SpackMaterialClient; unavailableReason?: string } {
  if (!options.enabled) return {};
  if (!options.serverUrl || !options.cacheDir) {
    return {
      unavailableReason:
        "Spack material delivery requires SERVER_HTTP_URL and AGENT_SPACK_CACHE_DIR",
    };
  }
  try {
    return {
      client: new SpackMaterialClient({ serverUrl: options.serverUrl, cacheDir: options.cacheDir }),
    };
  } catch {
    // Legacy HTTP deployments may still run the Agent, but must never send material tickets.
    return {
      unavailableReason:
        "Spack material delivery is unavailable: invalid Server origin or cache directory",
    };
  }
}

export function spackMaterialServerOrigin(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    !/^https?:\/\/[^\s/?#\\]+\/?$/i.test(value) ||
    value.includes("@") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("Spack material Server URL must be an HTTPS origin (HTTP only on loopback)");
  }
  return url.origin;
}

// Also bound injected fetch/read implementations that do not honor AbortSignal themselves.
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Spack material transfer canceled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class SpackMaterialClient implements SpackMaterialProvider {
  private readonly origin: string;
  private readonly cache: SpackMaterialCache;
  private readonly fetch: SpackMaterialFetch;
  private readonly requestTimeoutMs: number;
  private activePrepares = 0;

  constructor(options: {
    serverUrl: string;
    cacheDir: string;
    fetch?: SpackMaterialFetch;
    /** May shorten, but not extend, the per-request deadline. */
    requestTimeoutMs?: number;
  }) {
    this.origin = spackMaterialServerOrigin(options.serverUrl);
    this.cache = new SpackMaterialCache(options.cacheDir);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    if (
      !Number.isInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0 ||
      this.requestTimeoutMs > REQUEST_TIMEOUT_MS
    ) {
      throw new Error("Spack material request timeout must be between 1 and 60000 ms");
    }
  }

  async prepare(input: SpackMaterialPrepareInput): Promise<PreparedSpackMaterials> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.operationId)) {
      throw new Error("Invalid Spack material operation ID");
    }
    if (
      !input.ticket ||
      input.ticket.length > 16_384 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(input.ticket)
    ) {
      throw new Error("Spack material ticket is missing or invalid");
    }
    SpackMaterialDigestSchema.parse(input.manifestDigest);
    if (this.activePrepares >= MAX_CONCURRENT_PREPARES) {
      throw new Error("Spack material preparation concurrency limit reached");
    }
    this.activePrepares++;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), PREPARE_TIMEOUT_MS);
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline.signal])
      : deadline.signal;
    try {
      signal.throwIfAborted();
      await this.cache.initialize();
      const base = `${this.origin}/api/agent/spack/operations/${input.operationId}`;
      const manifestBuffer = Buffer.alloc(MAX_MANIFEST_BYTES);
      let manifestSize = 0;
      await this.download(
        `${base}/manifest`,
        input.ticket,
        MAX_MANIFEST_BYTES,
        signal,
        async (chunk) => {
          manifestBuffer.set(chunk, manifestSize);
          manifestSize += chunk.byteLength;
        },
      );
      const bytes = manifestBuffer.subarray(0, manifestSize);
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== input.manifestDigest) {
        throw new Error("Spack material manifest SHA-256 mismatch");
      }
      const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const manifest = SpackMaterialManifestSchema.parse(decoded);
      if (
        manifest.spec !== input.spec ||
        manifest.spackVersion !== input.spackVersion ||
        typeof decoded !== "object" ||
        decoded === null ||
        !("spec" in decoded) ||
        decoded.spec !== input.spec
      ) {
        throw new Error("Spack material manifest spec/Spack version binding mismatch");
      }
      const unique = new Map<string, SpackMaterialBlob>();
      let total = 0;
      for (const blob of spackMaterialBlobs(manifest)) {
        const existing = unique.get(blob.digest);
        if (existing && existing.size !== blob.size) {
          throw new Error("Spack material digest has conflicting declared sizes");
        }
        if (!existing) {
          total += blob.size;
          unique.set(blob.digest, blob);
        }
      }
      if (total > MAX_TOTAL_BYTES) throw new Error("Spack material total size exceeds limit");
      const cachedManifest = await this.cache.store(
        { digest: input.manifestDigest, size: bytes.byteLength },
        signal,
        (write) => write(bytes),
      );
      const blobs: SpackMaterialCacheRef[] = [];
      // Sequential blobs plus a bounded prepare count cap sockets and memory usage.
      for (const blob of unique.values()) {
        blobs.push(
          await this.cache.store(blob, signal, (write) =>
            this.download(`${base}/blobs/${blob.digest}`, input.ticket, blob.size, signal, write),
          ),
        );
      }
      signal.throwIfAborted();
      // This verifies bytes and bindings only, not lockfile semantics or concretization.
      return {
        manifest,
        manifestDigest: input.manifestDigest,
        manifestPath: cachedManifest.path,
        manifestSize: bytes.byteLength,
        blobs,
      };
    } finally {
      clearTimeout(timer);
      deadline.abort();
      this.activePrepares--;
    }
  }

  private async download(
    url: string,
    ticket: string,
    maximum: number,
    parentSignal: AbortSignal,
    write: (chunk: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    let response: Response | undefined;
    let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | undefined;
    try {
      signal.throwIfAborted();
      response = await abortable(
        this.fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${ticket}`, "Accept-Encoding": "identity" },
          redirect: "error",
          signal,
        }),
        signal,
      );
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new Error("Spack material redirect rejected");
      }
      if (response.url && response.url !== url) {
        throw new Error("Spack material response URL does not match the Server endpoint");
      }
      if (response.status !== 200) throw new Error(`Spack material HTTP ${response.status}`);
      const encoding = response.headers.get("Content-Encoding");
      if (encoding && encoding.toLowerCase() !== "identity") {
        throw new Error("Spack material encoded response rejected");
      }
      const length = response.headers.get("Content-Length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
        throw new Error("Spack material response size exceeds limit");
      }
      if (!response.body) throw new Error("Spack material response body is missing");
      reader = response.body.getReader();
      let received = 0;
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > maximum) throw new Error("Spack material response size exceeds limit");
        await write(chunk.value);
      }
      if (length !== null && Number(length) !== received) {
        throw new Error("Spack material response size differs from Content-Length");
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Cancel without waiting for an uncooperative remote stream's cancellation hook.
      const cancellation = reader ? reader.cancel() : response?.body?.cancel();
      if (cancellation) void cancellation.catch(() => undefined);
    }
  }
}
