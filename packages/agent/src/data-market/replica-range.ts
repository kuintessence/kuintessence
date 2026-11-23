import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { create } from "@bufbuild/protobuf";
import {
  REPLICA_RANGE_BYTES,
  type ReplicaRangeRead,
  ReplicaRangeResultSchema,
} from "@kuintessence/proto";
import type { AgentDataRoots } from "./local-data-security";

const digest = (data: Buffer) => createHash("sha256").update(data).digest();
const HASH_WINDOW = 65536;

async function readBlock(file: FileHandle, offset: number, size: number) {
  const buffer = Buffer.allocUnsafe(Math.min(REPLICA_RANGE_BYTES, size - offset));
  for (let done = 0; done < buffer.length; ) {
    const { bytesRead } = await file.read(buffer, done, buffer.length - done, offset + done);
    if (!bytesRead) throw new Error("Replica source truncated");
    done += bytesRead;
  }
  return buffer;
}

export class ManagedReplicaReader {
  private cache?: { sha256: string; first: number; hashes: Buffer[] };
  private scan?: {
    binding: string;
    next: number;
    hash: ReturnType<typeof createHash>;
    cache: { sha256: string; first: number; hashes: Buffer[] };
  };
  private busy = false;
  constructor(private readonly roots: AgentDataRoots) {}

  async read(input: ReplicaRangeRead) {
    const { range } = input;
    const result = create(ReplicaRangeResultSchema, { range, outcome: "retry" });
    if (this.busy || !range || input.expiresAtUnixMs <= BigInt(Date.now())) return result;
    this.busy = true;
    try {
      const size = Number(input.sizeBytes),
        offset = Number(range.offset);
      if (
        !Number.isSafeInteger(size) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (size === 0 ? offset !== 0 : offset >= size)
      )
        throw new Error("Invalid range");
      const block = Math.floor(offset / REPLICA_RANGE_BYTES);
      const file = await this.roots.openReplicaSource(
        input.managedRootId,
        input.datasetPath,
        range.path,
      );
      try {
        const stat = await file.stat({ bigint: true });
        if (stat.size !== input.sizeBytes) throw new Error("Replica size changed");
        if (!size) {
          if (digest(Buffer.alloc(0)).toString("hex") !== input.sha256)
            throw new Error("Empty source digest changed");
          result.outcome = "read";
          return result;
        }
        let cache = this.cache;
        if (!cache || cache.sha256 !== input.sha256 || !cache.hashes[block - cache.first]) {
          // Verify the complete scanned version before releasing any part of a mutable local file.
          const binding = [input.sha256, stat.dev, stat.ino, stat.ctimeNs, stat.size, block].join(
            ":",
          );
          if (this.scan?.binding !== binding)
            this.scan = {
              binding,
              next: 0,
              hash: createHash("sha256"),
              cache: { sha256: input.sha256, first: block, hashes: [] },
            };
          const scan = this.scan;
          cache = scan.cache;
          while (scan.next * REPLICA_RANGE_BYTES < size) {
            if (input.expiresAtUnixMs <= BigInt(Date.now())) return result;
            const bytes = await readBlock(file, scan.next * REPLICA_RANGE_BYTES, size);
            scan.hash.update(bytes);
            if (scan.next >= block && scan.next - block < HASH_WINDOW)
              cache.hashes.push(digest(bytes));
            scan.next++;
          }
          this.scan = undefined;
          if (scan.hash.digest("hex") !== input.sha256) throw new Error("Replica digest changed");
          this.cache = cache;
        }
        const bytes = await readBlock(file, block * REPLICA_RANGE_BYTES, size);
        if (!cache.hashes[block - cache.first]?.equals(digest(bytes)))
          throw new Error("Replica block changed");
        if (input.expiresAtUnixMs <= BigInt(Date.now())) return result;
        result.data = bytes.subarray(offset % REPLICA_RANGE_BYTES);
        result.outcome = "read";
        return result;
      } finally {
        await file.close();
      }
    } catch {
      result.outcome = "mismatch";
      return result;
    } finally {
      this.busy = false;
    }
  }
}
