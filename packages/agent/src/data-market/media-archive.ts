import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  FEDERATION_MEDIA_MAX_BYTES,
  type FederationMediaManifest,
  FederationMediaManifestSchema,
} from "@kuintessence/shared/federation";
import type { AgentDataRoots } from "./local-data-security";

const BLOCK = 512;
const CHUNK = 64 * 1024;
const MAX_MANIFEST = 524_288;
const zeros = Buffer.alloc(BLOCK * 2);
type ManifestVerifier = (jws: string) => Promise<FederationMediaManifest>;

/** Restricted ustar: fixed index names, regular files only, GNU base-256 sizes above 8 GiB. */
export function mediaTarHeader(name: string, size: number): Buffer {
  if (
    !/^(manifest\.jws|files\/[0-9]{6})$/.test(name) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > FEDERATION_MEDIA_MAX_BYTES
  ) {
    throw new Error("MEDIA_ARCHIVE_HEADER_INVALID");
  }
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "ascii");
  header.write("0000600\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  if (size < 8 ** 11) {
    header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  } else {
    header[124] = 0x80;
    header.writeBigUInt64BE(BigInt(size), 128);
  }
  header.write("00000000000\0", 136, "ascii");
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

type ArchiveSource = {
  signedManifest: string;
  verifyManifest: ManifestVerifier;
  signal?: AbortSignal;
};
type MediaFile = FederationMediaManifest["files"][number];

export async function* exportMediaArchive(
  options: ArchiveSource & {
    roots: AgentDataRoots;
    managedRootId: string;
    relativePath: string;
  },
): AsyncGenerator<Uint8Array> {
  let source: string | undefined;
  yield* exportMediaArchiveFromFiles({
    ...options,
    readFile: async function* (file) {
      source ??= await options.roots.resolveManagedDataPath(
        options.managedRootId,
        options.relativePath,
      );
      const path = await regularSource(source, file.path);
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.sizeBytes)
          throw new Error("MEDIA_SOURCE_CHANGED");
        let offset = 0;
        while (offset < file.sizeBytes) {
          options.signal?.throwIfAborted();
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK, file.sizeBytes - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) throw new Error("MEDIA_SOURCE_CHANGED");
          offset += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
        const after = await handle.stat();
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new Error("MEDIA_SOURCE_CHANGED");
      } finally {
        await handle.close();
      }
    },
  });
}

/** Reader receives only the verified inventory member; it must independently enforce current authority. */
export async function* exportMediaArchiveFromFiles(
  options: ArchiveSource & {
    readFile(file: MediaFile, index: number): AsyncIterable<Uint8Array>;
  },
): AsyncGenerator<Uint8Array> {
  const signed = Buffer.from(options.signedManifest, "utf8");
  if (!signed.length || signed.length > MAX_MANIFEST) throw new Error("MEDIA_MANIFEST_TOO_LARGE");
  const manifest = FederationMediaManifestSchema.parse(
    await options.verifyManifest(options.signedManifest),
  );
  options.signal?.throwIfAborted();
  yield mediaTarHeader("manifest.jws", signed.length);
  yield signed;
  yield zeros.subarray(0, padding(signed.length));
  for (const [index, file] of manifest.files.entries()) {
    options.signal?.throwIfAborted();
    yield mediaTarHeader(entryName(index), file.sizeBytes);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of options.readFile(structuredClone(file), index)) {
      options.signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > file.sizeBytes) throw new Error("MEDIA_SOURCE_CHANGED");
      hash.update(chunk);
      yield chunk;
    }
    if (size !== file.sizeBytes || hash.digest("hex") !== file.sha256)
      throw new Error("MEDIA_SOURCE_CHANGED");
    yield zeros.subarray(0, padding(file.sizeBytes));
  }
  options.signal?.throwIfAborted();
  yield zeros;
}

/** Returns quarantine only. The caller must finish age authentication and reauthorize before publication. */
export async function quarantineMediaArchive(options: {
  stream: AsyncIterable<Uint8Array>;
  quarantineRoot: string;
  maxBytes: number;
  reserveBytes: number;
  verifyManifest: ManifestVerifier;
  signal?: AbortSignal;
}): Promise<{ directory: string; manifest: FederationMediaManifest; signedManifest: string }> {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    options.maxBytes > FEDERATION_MEDIA_MAX_BYTES ||
    !Number.isSafeInteger(options.reserveBytes) ||
    options.reserveBytes < 1024 * 1024
  )
    throw new Error("MEDIA_STORAGE_LIMIT_INVALID");
  const reader = new ArchiveReader(options.stream, options.signal);
  let directory: string | undefined;
  try {
    const header = await reader.read(BLOCK);
    const sizeText = header.subarray(124, 136).toString("ascii");
    if (!/^[0-7]{11}\0$/.test(sizeText)) throw new Error("MEDIA_MANIFEST_HEADER_INVALID");
    const size = Number.parseInt(sizeText, 8);
    if (!size || size > MAX_MANIFEST || !header.equals(mediaTarHeader("manifest.jws", size)))
      throw new Error("MEDIA_MANIFEST_HEADER_INVALID");
    const signedManifest = new TextDecoder("utf-8", { fatal: true }).decode(
      await reader.read(size),
    );
    const manifest = FederationMediaManifestSchema.parse(
      await options.verifyManifest(signedManifest),
    );
    await reader.expect(zeros.subarray(0, padding(size)));
    const total = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total > options.maxBytes) throw new Error("MEDIA_STORAGE_LIMIT_EXCEEDED");
    const root = await privateMediaDirectory(options.quarantineRoot);
    const space = await statfs(root, { bigint: true });
    const parents = new Set(
      manifest.files.flatMap((file) =>
        file.path
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
      ),
    );
    const inodes = BigInt(manifest.files.length + parents.size + 2);
    // Include block rounding and metadata overhead, also for empty files and deep directories.
    const required =
      BigInt(total) +
      BigInt(size) +
      BigInt(options.reserveBytes) +
      (inodes * 2n + BigInt(manifest.files.length)) * space.bsize;
    if (space.bavail * space.bsize < required || space.ffree < inodes)
      throw new Error("MEDIA_STORAGE_INSUFFICIENT");
    directory = await mkdtemp(join(root, ".media-quarantine-"));
    const dataRoot = join(directory, "files");
    await mkdir(dataRoot, { mode: 0o700 });
    for (const [index, file] of manifest.files.entries()) {
      await reader.expect(mediaTarHeader(entryName(index), file.sizeBytes));
      const target = join(dataRoot, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", 0o600);
      try {
        const hash = createHash("sha256");
        let remaining = file.sizeBytes;
        while (remaining > 0) {
          const bytes = await reader.read(Math.min(CHUNK, remaining));
          hash.update(bytes);
          await handle.writeFile(bytes);
          remaining -= bytes.length;
        }
        if (hash.digest("hex") !== file.sha256) throw new Error("MEDIA_FILE_DIGEST_INVALID");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await reader.expect(zeros.subarray(0, padding(file.sizeBytes)));
    }
    await reader.expect(zeros);
    await reader.end();
    options.signal?.throwIfAborted();
    await reader.close();
    return { directory, manifest, signedManifest };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await reader.close();
  }
}

export async function privateMediaDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("MEDIA_ROOT_INVALID");
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== path ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("MEDIA_ROOT_INVALID");
  return canonical;
}

async function regularSource(root: string, path: string): Promise<string> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("MEDIA_SOURCE_INVALID");
  const parts = path.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    )
      throw new Error("MEDIA_SOURCE_INVALID");
  }
  return current;
}

function entryName(index: number): string {
  return `files/${index.toString().padStart(6, "0")}`;
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

class ArchiveReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private closed = false;
  constructor(
    stream: AsyncIterable<Uint8Array>,
    private readonly signal?: AbortSignal,
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async read(size: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      this.signal?.throwIfAborted();
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        this.signal?.throwIfAborted();
        if (next.done) throw new Error("MEDIA_ARCHIVE_TRUNCATED");
        if (next.value.length > 1024 * 1024) throw new Error("MEDIA_STREAM_CHUNK_TOO_LARGE");
        this.chunk = next.value;
        this.offset = 0;
        if (this.chunk.length === 0) continue;
      }
      const count = Math.min(size - written, this.chunk.length - this.offset);
      result.set(this.chunk.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
    }
    return result;
  }
  async expect(expected: Uint8Array): Promise<void> {
    if (!(await this.read(expected.length)).equals(expected))
      throw new Error("MEDIA_ARCHIVE_FORMAT_INVALID");
  }
  async end(): Promise<void> {
    if (this.offset !== this.chunk.length) throw new Error("MEDIA_ARCHIVE_TRAILING_DATA");
    while (true) {
      this.signal?.throwIfAborted();
      const next = await this.iterator.next();
      if (next.done) return;
      if (next.value.length) throw new Error("MEDIA_ARCHIVE_TRAILING_DATA");
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.iterator.return?.();
  }
}
