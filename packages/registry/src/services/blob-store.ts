// OCI content-addressed blobs and resumable upload staging.
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface BlobStat {
  size: number;
}

export interface BlobReadResult {
  stream: ReadableStream<Uint8Array>;
  size: number;
}

/**
 * Content-addressed blob store. All keys are full digests in the
 * `sha256:<hex>` form to stay consistent with OCI. Implementations MUST
 * be idempotent on repeated `put` of the same digest.
 */
export interface BlobStore {
  /**
   * Store the bytes from `stream`. If `expectedDigest` is provided, the
   * implementation MUST verify that the streamed bytes match and reject
   * a mismatch. Otherwise the digest is computed and returned.
   */
  put(
    stream: ReadableStream<Uint8Array> | Uint8Array,
    expectedDigest?: string,
  ): Promise<{ digest: string; size: number }>;

  /** Return a fresh ReadableStream over the bytes plus the recorded size. */
  get(digest: string): Promise<BlobReadResult>;

  head(digest: string): Promise<BlobStat | null>;

  exists(digest: string): Promise<boolean>;

  delete(digest: string): Promise<void>;

  startUpload(uploadId: string): Promise<void>;

  appendUpload(
    uploadId: string,
    source: ReadableStream<Uint8Array> | Uint8Array,
    maxBytes: number,
    committedOffset?: number,
  ): Promise<number>;

  completeUpload(
    uploadId: string,
    expectedDigest: string,
    retainStaging?: boolean,
  ): Promise<{ digest: string; size: number }>;

  cancelUpload(uploadId: string): Promise<void>;
}

export class BlobNotFoundError extends Error {
  constructor(public readonly digest: string) {
    super(`blob not found: ${digest}`);
    this.name = "BlobNotFoundError";
  }
}

export class BlobDigestMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`blob digest mismatch: expected ${expected} got ${actual}`);
    this.name = "BlobDigestMismatchError";
  }
}

export class BlobUploadTooLargeError extends Error {
  constructor(
    public readonly limit: number,
    public readonly attemptedSize: number,
  ) {
    super(`blob upload exceeds ${limit} bytes`);
    this.name = "BlobUploadTooLargeError";
  }
}

const HEX_RE = /^sha256:[0-9a-f]{64}$/;

function assertDigestForm(digest: string): void {
  if (!HEX_RE.test(digest)) {
    throw new BlobDigestMismatchError(digest, "<malformed>");
  }
}

async function consumeStream(source: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  const chunks: Uint8Array[] = [];
  const reader = source.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function forEachChunk(
  source: ReadableStream<Uint8Array> | Uint8Array,
  consume: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  if (source instanceof Uint8Array) {
    if (source.byteLength > 0) await consume(source);
    return;
  }
  const reader = source.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) await consume(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * In-memory implementation. Tests live exclusively against this.
 *
 * Clones the buffer on `put` and slices a fresh view on `get` so callers
 * cannot mutate stored bytes — the registry's content-addressing promise
 * is a hard immutability guarantee.
 */
export class InMemoryBlobStore implements BlobStore {
  private readonly data = new Map<string, Uint8Array>();
  private readonly uploads = new Map<string, { chunks: Uint8Array[]; size: number }>();

  async put(
    stream: ReadableStream<Uint8Array> | Uint8Array,
    expectedDigest?: string,
  ): Promise<{ digest: string; size: number }> {
    const bytes = await consumeStream(stream);
    const digest = digestOf(bytes);
    if (expectedDigest && expectedDigest !== digest) {
      throw new BlobDigestMismatchError(expectedDigest, digest);
    }
    if (!this.data.has(digest)) {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      this.data.set(digest, copy);
    }
    return { digest, size: bytes.byteLength };
  }

  async get(digest: string): Promise<BlobReadResult> {
    const bytes = this.data.get(digest);
    if (!bytes) throw new BlobNotFoundError(digest);
    const view = new Uint8Array(bytes.byteLength);
    view.set(bytes);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(view);
        controller.close();
      },
    });
    return { stream, size: bytes.byteLength };
  }

  async head(digest: string): Promise<BlobStat | null> {
    const bytes = this.data.get(digest);
    return bytes ? { size: bytes.byteLength } : null;
  }

  async exists(digest: string): Promise<boolean> {
    return this.data.has(digest);
  }

  async delete(digest: string): Promise<void> {
    this.data.delete(digest);
  }

  async startUpload(uploadId: string): Promise<void> {
    this.uploads.set(uploadId, { chunks: [], size: 0 });
  }

  async appendUpload(
    uploadId: string,
    source: ReadableStream<Uint8Array> | Uint8Array,
    maxBytes: number,
    committedOffset?: number,
  ): Promise<number> {
    if (committedOffset === 0) this.uploads.set(uploadId, { chunks: [], size: 0 });
    const upload = this.uploads.get(uploadId);
    if (!upload || (committedOffset !== undefined && upload.size < committedOffset))
      throw new BlobNotFoundError(uploadId);
    if (committedOffset !== undefined && upload.size > committedOffset) {
      let kept = 0;
      upload.chunks = upload.chunks.flatMap((chunk) => {
        const length = Math.max(0, Math.min(chunk.length, committedOffset - kept));
        kept += length;
        return length ? [chunk.subarray(0, length)] : [];
      });
      upload.size = kept;
    }
    await forEachChunk(source, async (chunk) => {
      const attemptedSize = upload.size + chunk.byteLength;
      if (attemptedSize > maxBytes) {
        throw new BlobUploadTooLargeError(maxBytes, attemptedSize);
      }
      upload.chunks.push(chunk.slice());
      upload.size = attemptedSize;
    });
    return upload.size;
  }

  async completeUpload(
    uploadId: string,
    expectedDigest: string,
    retainStaging?: boolean,
  ): Promise<{ digest: string; size: number }> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new BlobNotFoundError(uploadId);
    const bytes = new Uint8Array(upload.size);
    let offset = 0;
    for (const chunk of upload.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const stored = await this.put(bytes, expectedDigest);
    if (!retainStaging) this.uploads.delete(uploadId);
    return stored;
  }

  async cancelUpload(uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
  }
}

/**
 * Filesystem implementation. Files are stored under
 * `<root>/<algo>/<hash[0:2]>/<hash>` to keep directory fan-out bounded.
 *
 */
export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private pathFor(digest: string): { dir: string; file: string } {
    assertDigestForm(digest);
    const hex = digest.slice("sha256:".length);
    const prefix = hex.slice(0, 2);
    const dir = join(this.root, "sha256", prefix);
    return { dir, file: join(dir, hex) };
  }

  private uploadPath(uploadId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) {
      throw new BlobNotFoundError(uploadId);
    }
    return join(this.root, "_uploads", `${uploadId}.part`);
  }

  async put(
    source: ReadableStream<Uint8Array> | Uint8Array,
    expectedDigest?: string,
  ): Promise<{ digest: string; size: number }> {
    const uploadId = randomUUID();
    await this.startUpload(uploadId);
    try {
      await this.appendUpload(uploadId, source, Number.MAX_SAFE_INTEGER);
      const digest = expectedDigest ?? (await this.digestUpload(uploadId)).digest;
      return await this.completeUpload(uploadId, digest);
    } catch (error) {
      await this.cancelUpload(uploadId);
      throw error;
    }
  }

  async get(digest: string): Promise<BlobReadResult> {
    const { file } = this.pathFor(digest);
    if (!existsSync(file)) throw new BlobNotFoundError(digest);
    const fileStat = await stat(file);
    return { stream: Bun.file(file).stream(), size: fileStat.size };
  }

  async head(digest: string): Promise<BlobStat | null> {
    const { file } = this.pathFor(digest);
    if (!existsSync(file)) return null;
    const s = await stat(file);
    return { size: s.size };
  }

  async exists(digest: string): Promise<boolean> {
    const { file } = this.pathFor(digest);
    return existsSync(file);
  }

  async delete(digest: string): Promise<void> {
    const { file } = this.pathFor(digest);
    if (existsSync(file)) await rm(file);
  }

  async startUpload(uploadId: string): Promise<void> {
    const file = this.uploadPath(uploadId);
    await mkdir(join(this.root, "_uploads"), { recursive: true });
    const handle = await open(file, "wx");
    await handle.close();
  }

  async appendUpload(
    uploadId: string,
    source: ReadableStream<Uint8Array> | Uint8Array,
    maxBytes: number,
    committedOffset?: number,
  ): Promise<number> {
    const file = this.uploadPath(uploadId);
    if (committedOffset === 0) await mkdir(join(this.root, "_uploads"), { recursive: true });
    if (committedOffset !== 0 && !existsSync(file)) throw new BlobNotFoundError(uploadId);
    const handle = await open(file, "a+");
    try {
      let size = (await handle.stat()).size;
      if (committedOffset !== undefined) {
        if (size < committedOffset)
          throw new Error("Upload staging is shorter than its committed offset");
        if (size > committedOffset) await handle.truncate(committedOffset);
        size = committedOffset;
      }
      await forEachChunk(source, async (chunk) => {
        const attemptedSize = size + chunk.byteLength;
        if (attemptedSize > maxBytes) {
          throw new BlobUploadTooLargeError(maxBytes, attemptedSize);
        }
        let written = 0;
        while (written < chunk.byteLength) {
          const result = await handle.write(chunk.subarray(written));
          written += result.bytesWritten;
        }
        size = attemptedSize;
      });
      await handle.sync();
      return size;
    } finally {
      await handle.close();
    }
  }

  async completeUpload(
    uploadId: string,
    expectedDigest: string,
    retainStaging?: boolean,
  ): Promise<{ digest: string; size: number }> {
    assertDigestForm(expectedDigest);
    const actual = await this.digestUpload(uploadId);
    if (actual.digest !== expectedDigest) {
      throw new BlobDigestMismatchError(expectedDigest, actual.digest);
    }
    const source = this.uploadPath(uploadId);
    const { dir, file } = this.pathFor(actual.digest);
    await mkdir(dir, { recursive: true });
    if (retainStaging) {
      if (!existsSync(file)) {
        const temp = source + ".publish";
        await copyFile(source, temp, constants.COPYFILE_FICLONE);
        await rename(temp, file);
      }
    } else if (existsSync(file)) await rm(source, { force: true });
    else await rename(source, file);
    return actual;
  }

  async cancelUpload(uploadId: string): Promise<void> {
    const path = this.uploadPath(uploadId);
    await rm(path, { force: true });
    await rm(path + ".publish", { force: true });
  }

  private async digestUpload(uploadId: string): Promise<{ digest: string; size: number }> {
    const file = this.uploadPath(uploadId);
    if (!existsSync(file)) throw new BlobNotFoundError(uploadId);
    const hash = createHash("sha256");
    let size = 0;
    const reader = Bun.file(file).stream().getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          hash.update(value);
          size += value.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
    }
    return { digest: `sha256:${hash.digest("hex")}`, size };
  }
}
