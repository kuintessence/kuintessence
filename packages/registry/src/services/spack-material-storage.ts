import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger, type SpackLockReport, type SpackMaterialBlob } from "@kuintessence/shared";

export const MATERIAL_METADATA_BYTES = 2 * 1024 ** 2;
export const MATERIAL_MAX_BLOB_BYTES = 16 * 1024 ** 3;
const logger = createLogger("registry-materials");

export class SpackMaterialError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 408 | 413 | 415 | 422 | 429 | 500 | 503,
    message: string,
    readonly lockPreflight?: SpackLockReport,
  ) {
    super(message);
    this.name = "SpackMaterialError";
  }
}

export interface MaterialStreamLimits {
  maxBytes: number;
  totalTimeoutMs: number;
  idleTimeoutMs: number;
}

export const DEFAULT_MATERIAL_TIMEOUTS = {
  totalTimeoutMs: 30 * 60_000,
  idleTimeoutMs: 30_000,
};

export interface MaterialReadLimits {
  lifetimeMs: number;
  idleTimeoutMs: number;
}

export function materialDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function cancelMaterialInput(input: { cancel(): Promise<void> }): void {
  // Cancellation must not mask the primary failure or wait forever on an uncooperative source.
  void input.cancel().catch(() => {
    logger.warn("Could not cancel material input stream");
  });
}

export async function consumeMaterialStream(
  input: ReadableStream<Uint8Array>,
  limits: MaterialStreamLimits,
  consume: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const reader = input.getReader();
  const deadline = Date.now() + limits.totalTimeoutMs;
  let lastProgress = Date.now();
  let total = 0;
  let finished = false;
  try {
    for (;;) {
      const remaining = Math.min(
        deadline - Date.now(),
        lastProgress + limits.idleTimeoutMs - Date.now(),
      );
      if (remaining <= 0) throw new SpackMaterialError(408, "Material upload timed out");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read().catch(() => {
            throw new SpackMaterialError(400, "Failed to read material upload");
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new SpackMaterialError(408, "Material upload timed out")),
              remaining,
            );
          }),
        ]);
        if (Date.now() > deadline) throw new SpackMaterialError(408, "Material upload timed out");
        if (result.done) {
          finished = true;
          return total;
        }
        total += result.value.byteLength;
        if (total > limits.maxBytes)
          throw new SpackMaterialError(413, "Material exceeds the byte limit");
        if (result.value.byteLength > 0) {
          lastProgress = Date.now();
          await consume(result.value);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (!finished) {
      // A hostile source may never settle cancel(); it must not retain an upload slot.
      cancelMaterialInput(reader);
    }
    reader.releaseLock();
  }
}

export async function readMaterialJson(input: ReadableStream<Uint8Array>): Promise<unknown> {
  const bytes = new Uint8Array(MATERIAL_METADATA_BYTES);
  let length = 0;
  await consumeMaterialStream(
    input,
    { maxBytes: MATERIAL_METADATA_BYTES, totalTimeoutMs: 60_000, idleTimeoutMs: 30_000 },
    async (chunk) => {
      bytes.set(chunk, length);
      length += chunk.byteLength;
    },
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    throw new SpackMaterialError(400, "Invalid JSON body");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  if (firstCreated) {
    let current = path;
    for (;;) {
      await syncDirectory(current);
      if (current === dirname(firstCreated)) break;
      current = dirname(current);
    }
  }
}

async function installImmutable(
  temporary: string,
  destination: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await ensureDirectory(dirname(destination));
  // This check is the last cancellation boundary before the atomic link commit.
  signal?.throwIfAborted();
  let installed = true;
  try {
    // A hard link publishes complete, fsynced bytes without replacing an existing release.
    await link(temporary, destination);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    installed = false;
  }
  await syncDirectory(dirname(destination));
  return installed;
}

export async function writeMaterialMetadata(
  path: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (bytes.byteLength > MATERIAL_METADATA_BYTES) {
    throw new SpackMaterialError(413, "Material metadata exceeds 2 MiB");
  }
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await installImmutable(temporary, path, signal);
    if (!(await readFile(path)).equals(Buffer.from(bytes))) {
      throw new SpackMaterialError(500, "Conflicting immutable material metadata");
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface MaterialMetadataReadOptions {
  checkpoint?: () => void;
  checkSize?: (size: number) => void;
  validatePath?: () => Promise<void>;
}

export async function readMaterialMetadata(
  path: string,
  options: MaterialMetadataReadOptions = {},
): Promise<Buffer> {
  options.checkpoint?.();
  await options.validatePath?.();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (hasCode(error, "ELOOP")) {
      throw new SpackMaterialError(500, "Invalid stored material metadata");
    }
    throw error;
  });
  try {
    options.checkpoint?.();
    await options.validatePath?.();
    const info = await file.stat();
    options.checkpoint?.();
    options.checkSize?.(info.size);
    if (!info.isFile() || info.size > MATERIAL_METADATA_BYTES) {
      throw new SpackMaterialError(500, "Invalid stored material metadata");
    }
    // Stat and read the same handle. A growing file cannot turn readFile into an unbounded read.
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      options.checkpoint?.();
      const { bytesRead } = await file.read(
        bytes,
        offset,
        Math.min(64 * 1024, bytes.length - offset),
        offset,
      );
      options.checkpoint?.();
      if (bytesRead === 0) throw new SpackMaterialError(500, "Truncated material metadata");
      offset += bytesRead;
    }
    const extra = await file.read(new Uint8Array(1), 0, 1, bytes.length);
    const finalInfo = await file.stat();
    options.checkpoint?.();
    options.checkSize?.(finalInfo.size);
    if (extra.bytesRead !== 0 || finalInfo.size !== info.size) {
      throw new SpackMaterialError(500, "Stored material metadata changed during read");
    }
    await options.validatePath?.();
    options.checkpoint?.();
    return bytes;
  } finally {
    await file.close();
  }
}

/** Isolated from the OCI BlobStore and its garbage collector. */
export class SpackMaterialBlobStore {
  private activeReads = 0;
  private readonly readLimits: MaterialReadLimits;

  constructor(
    private readonly root: string,
    readLimits: Partial<MaterialReadLimits> = {},
  ) {
    this.readLimits = { lifetimeMs: 5 * 60_000, idleTimeoutMs: 30_000, ...readLimits };
    if (
      Object.values(this.readLimits).some((value) => !Number.isSafeInteger(value) || value <= 0)
    ) {
      throw new Error("Invalid material read limits");
    }
  }

  private path(digest: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new SpackMaterialError(422, "Invalid material digest");
    }
    return join(this.root, "blobs", digest.slice(7, 9), digest.slice(7));
  }

  async put(
    input: ReadableStream<Uint8Array>,
    limits: MaterialStreamLimits,
    expectedDigest?: string,
    expectedSize?: number,
  ): Promise<SpackMaterialBlob> {
    await ensureDirectory(join(this.root, "staging"));
    const temporary = join(this.root, "staging", `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let size: number;
      try {
        size = await consumeMaterialStream(input, limits, async (chunk) => {
          hash.update(chunk);
          await file.writeFile(chunk);
        });
        if (size === 0) throw new SpackMaterialError(400, "Material blob is empty");
        await file.sync();
      } finally {
        await file.close();
      }
      const digest = `sha256:${hash.digest("hex")}`;
      if (expectedDigest !== undefined && expectedDigest !== digest) {
        throw new SpackMaterialError(422, "Material blob checksum mismatch");
      }
      if (expectedSize !== undefined && expectedSize !== size) {
        throw new SpackMaterialError(422, "Material blob size mismatch");
      }
      if (!(await installImmutable(temporary, this.path(digest)))) {
        await this.verify(digest, size);
      }
      return { digest, size };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async verify(digest: string, expectedSize: number): Promise<void> {
    const { stream } = await this.get(digest, expectedSize);
    const reader = stream.getReader();
    try {
      for (;;) {
        if ((await reader.read()).done) return;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async readMetadata(blob: SpackMaterialBlob, maximum: number): Promise<Uint8Array> {
    if (blob.size > maximum) throw new SpackMaterialError(413, "Spack lock exceeds the byte limit");
    const { stream } = await this.get(blob.digest, blob.size);
    const bytes = new Uint8Array(blob.size);
    let offset = 0;
    await consumeMaterialStream(
      stream,
      { maxBytes: blob.size, totalTimeoutMs: 60_000, idleTimeoutMs: 30_000 },
      async (chunk) => {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      },
    );
    if (offset !== blob.size) throw new SpackMaterialError(500, "Truncated material metadata");
    return bytes;
  }

  async get(
    digest: string,
    expectedSize: number,
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
    const path = this.path(digest);
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize <= 0 ||
      expectedSize > MATERIAL_MAX_BLOB_BYTES
    ) {
      throw new SpackMaterialError(422, "Invalid material blob size");
    }
    if (this.activeReads >= 4) throw new SpackMaterialError(429, "Too many material reads");
    this.activeReads += 1;
    let close: (() => Promise<void>) | undefined;
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let closing: Promise<void> | undefined;
      const cleanup = () => {
        clearTimeout(lifetime);
        clearTimeout(idle);
        closing ??= file.close().finally(() => {
          this.activeReads -= 1;
        });
        return closing;
      };
      close = cleanup;
      const info = await file.stat();
      if (!info.isFile() || info.size !== expectedSize) {
        throw new SpackMaterialError(500, "Corrupt material blob size or type");
      }
      const hash = createHash("sha256");
      let size = 0;
      let stopped = false;
      const fail = async (
        controller: ReadableStreamDefaultController<Uint8Array>,
        error: unknown,
      ) => {
        if (stopped) return;
        stopped = true;
        try {
          await cleanup();
        } catch {
          logger.warn("Could not close material read stream");
        }
        controller.error(error);
      };
      const resetIdle = (controller: ReadableStreamDefaultController<Uint8Array>) => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          void fail(controller, new SpackMaterialError(408, "Material read idle timeout"));
        }, this.readLimits.idleTimeoutMs);
        idle.unref();
      };
      const stream = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            lifetime = setTimeout(() => {
              void fail(controller, new SpackMaterialError(408, "Material read lifetime exceeded"));
            }, this.readLimits.lifetimeMs);
            lifetime.unref();
            resetIdle(controller);
          },
          pull: async (controller) => {
            if (stopped) return;
            try {
              const buffer = new Uint8Array(Math.min(64 * 1024, expectedSize - size));
              const { bytesRead } = await file.read(buffer);
              if (stopped) return;
              if (bytesRead === 0) throw new SpackMaterialError(500, "Truncated material blob");
              size += bytesRead;
              hash.update(buffer.subarray(0, bytesRead));
              if (size === expectedSize) {
                // Withhold the last chunk so Content-Length cannot complete before integrity checks.
                const extra = await file.read(new Uint8Array(1));
                if (stopped) return;
                if (extra.bytesRead !== 0 || `sha256:${hash.digest("hex")}` !== digest) {
                  throw new SpackMaterialError(500, "Corrupt material blob digest or size");
                }
                await file.sync();
                await cleanup();
                if (stopped) return;
                stopped = true;
                controller.enqueue(buffer.subarray(0, bytesRead));
                controller.close();
              } else {
                controller.enqueue(buffer.subarray(0, bytesRead));
                resetIdle(controller);
              }
            } catch (error) {
              await fail(controller, error);
            }
          },
          cancel: async () => {
            stopped = true;
            await cleanup();
          },
        },
        { highWaterMark: 0 },
      );
      return { stream, size: expectedSize };
    } catch (error) {
      if (close) await close();
      else this.activeReads -= 1;
      if (isMissing(error)) throw new SpackMaterialError(404, "Material blob not found");
      throw error;
    }
  }
}
