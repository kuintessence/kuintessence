import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { inflate } from "node:zlib";
import { RecipeStoreError, type RecipeStoreLimits } from "./recipe-git";

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_LINE_BYTES = 4096;
const SHA1_BYTES = 20;
const MAX_DELTA_DEPTH = 64;
const BASE_OBJECT_NAMES: Readonly<Record<number, string>> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

function malformed(message: string): never {
  throw new RecipeStoreError(422, `Invalid recipe bundle: ${message}`);
}

function overBudget(): never {
  throw new RecipeStoreError(
    413,
    "Git pack exceeds the configured object or size limit; export a current-tree-only bundle",
  );
}

class Cursor {
  constructor(
    readonly bytes: Buffer,
    public offset = 0,
  ) {}

  byte(): number {
    const value = this.bytes[this.offset++];
    if (value === undefined) malformed("truncated object header");
    return value;
  }

  skip(size: number): void {
    if (size > this.bytes.length - this.offset) malformed("truncated delta base reference");
    this.offset += size;
  }

  size(value = 0, bits = 0): number {
    for (; bits < 53; bits += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** bits;
      if (!Number.isSafeInteger(value)) malformed("object size overflow");
      if (!(byte & 128)) return value;
    }
    malformed("unterminated object size");
  }

  distance(): number {
    let byte = this.byte();
    let value = byte & 127;
    // OFS_DELTA uses a biased, big-endian encoding, unlike object size varints.
    for (let length = 1; byte & 128; length++) {
      if (length >= 8) malformed("delta offset overflow");
      byte = this.byte();
      value = (value + 1) * 128 + (byte & 127);
      if (!Number.isSafeInteger(value)) malformed("delta offset overflow");
    }
    return value;
  }
}

async function readBundle(path: string, limit: number, checkDeadline: () => void): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    checkDeadline();
    const metadata = await file.stat();
    checkDeadline();
    if (!metadata.isFile()) malformed("expected a regular staged file");
    if (metadata.size > limit) overBudget();
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      checkDeadline();
      if (bytesRead === 0) malformed("staged file was truncated");
      offset += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      malformed("staged file changed during preflight");
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function packOffset(bytes: Buffer): number {
  const bounded = bytes.subarray(0, MAX_HEADER_BYTES);
  const end = bounded.indexOf("\n\n");
  if (end < 0) malformed("missing or oversized bundle header");
  const lines = bounded.subarray(0, end).toString("latin1").split("\n");
  const signature = lines.shift();
  if (signature !== "# v2 git bundle" && signature !== "# v3 git bundle") {
    malformed("only v2/v3 SHA-1 bundles are supported");
  }
  let formatSeen = false;
  let refsSeen = false;
  for (const line of lines) {
    if (line.length > MAX_HEADER_LINE_BYTES) malformed("oversized bundle header line");
    if (line.startsWith("@")) {
      if (
        signature !== "# v3 git bundle" ||
        refsSeen ||
        formatSeen ||
        line !== "@object-format=sha1"
      ) {
        malformed("unsupported or misplaced bundle capability");
      }
      formatSeen = true;
    } else {
      // latin1 preserves bytes: Unicode whitespace rules would reject UTF-8 continuations.
      // Prerequisites are excluded; Git validates ref semantics after this ASCII framing check.
      if (
        !/^[a-f0-9]{40} /.test(line) ||
        line.length <= 41 ||
        Array.from(line.slice(41)).some(
          (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        )
      ) {
        malformed("invalid reference or non-self-contained bundle");
      }
      refsSeen = true;
    }
  }
  if (!refsSeen) malformed("missing bundle references");
  return end + 2;
}

interface InflatedObject {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

function isInflatedObject(value: unknown): value is InflatedObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "buffer" in value &&
    Buffer.isBuffer(value.buffer) &&
    "engine" in value &&
    typeof value.engine === "object" &&
    value.engine !== null &&
    "bytesWritten" in value.engine &&
    typeof value.engine.bytesWritten === "number"
  );
}

async function inflateObject(
  bytes: Buffer,
  size: number,
): Promise<{ body: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    // info returns the consumed compressed length, not the full remainder supplied as input.
    // zlib requires a positive limit even for a valid zero-byte object.
    inflate(bytes, { info: true, maxOutputLength: Math.max(1, size) }, (error, result: unknown) => {
      if (error) {
        reject(
          new RecipeStoreError(
            "code" in error && error.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 422,
            "Git pack object exceeds its inflated size or contains invalid compressed data",
          ),
        );
        return;
      }
      if (
        !isInflatedObject(result) ||
        !Number.isSafeInteger(result.engine.bytesWritten) ||
        result.engine.bytesWritten <= 0 ||
        result.engine.bytesWritten > bytes.length ||
        result.buffer.length !== size
      ) {
        reject(new RecipeStoreError(422, "Git pack object size or compressed boundary is invalid"));
        return;
      }
      resolve({ body: result.buffer, consumed: result.engine.bytesWritten });
    });
  });
}

interface DepthNode {
  baseOffset?: number;
  refId?: string;
  depth: number;
  root: number | null;
}

class DeltaDepthBudget {
  private readonly objects = new Map<number, DepthNode>();
  readonly fullObjectIds = new Set<string>();

  add(offset: number, baseOffset?: number, refId?: string): void {
    if (baseOffset !== undefined && !this.objects.has(baseOffset)) {
      malformed("delta offset does not point to a preceding object");
    }
    this.objects.set(offset, { baseOffset, refId, depth: 0, root: null });
  }

  async check(checkDeadline: () => void): Promise<void> {
    const refSegments = new Map<number, number>();
    let baseDepth = 0;
    let refDepth = 0;
    let index = 0;
    // A full base can occur after its REF deltas; resolve only after scanning the pack.
    for (const [offset, node] of this.objects) {
      if (index++ % 64 === 0) await yieldToEventLoop();
      checkDeadline();
      if (node.baseOffset !== undefined) {
        const base = this.objects.get(node.baseOffset);
        if (!base) malformed("missing delta base");
        node.depth = base.depth + 1;
        node.root = base.root;
      } else if (node.refId !== undefined) {
        node.depth = 1;
        node.root = this.fullObjectIds.has(node.refId) ? null : offset;
      }
      if (node.root === null) {
        baseDepth = Math.max(baseDepth, node.depth);
      } else {
        const previous = refSegments.get(node.root) ?? 0;
        if (node.depth > previous) {
          refDepth += node.depth - previous;
          refSegments.set(node.root, node.depth);
        }
      }
      // REF deltas on known full objects are independent depth-one roots. Only
      // unresolved REF-rooted OFS segments are conservatively joined into one chain.
      if (baseDepth + refDepth > MAX_DELTA_DEPTH) {
        throw new RecipeStoreError(
          413,
          "Git pack exceeds the conservative delta depth limit of 64",
        );
      }
    }
  }
}

async function hashBytes(bytes: Buffer, checkDeadline: () => void, prefix = ""): Promise<Buffer> {
  const hash = createHash("sha1").update(prefix);
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    checkDeadline();
    hash.update(bytes.subarray(offset, offset + 1024 * 1024));
    if (offset + 1024 * 1024 < bytes.length) await yieldToEventLoop();
  }
  checkDeadline();
  return hash.digest();
}

/**
 * Resource precheck only, on an immutable staged upload. Git must still verify HEAD,
 * object identities, delta instructions/base resolution and repository semantics.
 */
export async function preflightRecipeBundle(
  path: string,
  limits: RecipeStoreLimits,
): Promise<void> {
  for (const value of [
    limits.maxBundleBytes,
    limits.maxFileBytes,
    limits.maxExpandedBytes,
    limits.maxFiles,
    limits.maxFiles * 10,
    limits.gitTimeoutMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RecipeStoreError(500, "Invalid recipe preflight resource limits");
    }
  }
  const expires = performance.now() + limits.gitTimeoutMs;
  const timeoutError = () =>
    new RecipeStoreError(422, "Recipe bundle preflight exceeded its processing deadline");
  let timedOut = false;
  const checkDeadline = () => {
    if (timedOut || performance.now() >= expires) throw timeoutError();
  };
  checkDeadline();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      inspectBundle(path, limits, checkDeadline),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            reject(timeoutError());
          },
          Math.min(limits.gitTimeoutMs, 2_147_483_647),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function inspectBundle(
  path: string,
  limits: RecipeStoreLimits,
  checkDeadline: () => void,
): Promise<void> {
  const bytes = await readBundle(path, limits.maxBundleBytes, checkDeadline);
  checkDeadline();
  const start = packOffset(bytes);
  const end = bytes.length - SHA1_BYTES;
  if (end - start < 12) malformed("truncated pack header or checksum");
  const pack = bytes.subarray(start, end);
  if (pack.toString("latin1", 0, 4) !== "PACK") malformed("missing PACK signature");
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) malformed("unsupported pack version");
  const count = pack.readUInt32BE(8);
  if (count > limits.maxFiles * 10) overBudget();
  if (!(await hashBytes(pack, checkDeadline)).equals(bytes.subarray(end))) {
    malformed("pack SHA-1 checksum mismatch");
  }

  let remaining = limits.maxExpandedBytes;
  const checkSize = (size: number) => {
    if (size > limits.maxFileBytes) overBudget();
  };
  const charge = (size: number) => {
    checkSize(size);
    if (size > remaining) overBudget();
    remaining -= size;
  };
  const cursor = new Cursor(pack, 12);
  const depthBudget = new DeltaDepthBudget();
  for (let index = 0; index < count; index++) {
    if (index % 64 === 0) await yieldToEventLoop();
    checkDeadline();
    const objectOffset = cursor.offset;
    const first = cursor.byte();
    const type = (first >> 4) & 7;
    if (![1, 2, 3, 4, 6, 7].includes(type)) malformed("unsupported packed object type");
    const size = first & 128 ? cursor.size(first & 15, 4) : first & 15;
    // For deltas this is the instruction stream size, NOT the reconstructed size.
    charge(size);
    let baseOffset: number | undefined;
    let refId: string | undefined;
    if (type === 6) {
      const distance = cursor.distance();
      baseOffset = objectOffset - distance;
    } else if (type === 7) {
      refId = pack.toString("hex", cursor.offset, cursor.offset + SHA1_BYTES);
      cursor.skip(SHA1_BYTES);
    }
    depthBudget.add(objectOffset, baseOffset, refId);
    const { body, consumed } = await inflateObject(pack.subarray(cursor.offset), size);
    // A timed-out native inflate may finish, but cannot start another object.
    checkDeadline();
    cursor.skip(consumed);
    if (type === 6 || type === 7) {
      const delta = new Cursor(body);
      const sourceSize = delta.size();
      const targetSize = delta.size();
      checkSize(sourceSize);
      // Count every target (including intermediate deltas) plus its instruction bytes.
      charge(targetSize);
    } else {
      const oid = await hashBytes(body, checkDeadline, `${BASE_OBJECT_NAMES[type]} ${size}\0`);
      depthBudget.fullObjectIds.add(oid.toString("hex"));
    }
  }
  checkDeadline();
  if (cursor.offset !== pack.length) malformed("trailing pack data or incorrect object count");
  await depthBudget.check(checkDeadline);
}
