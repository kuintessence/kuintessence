import { statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const StorageCapacityConfigSchema = z.object({
  AGENT_STORAGE_RESERVE_MIB: z.preprocess(
    (value) => (typeof value === "string" && !/^[0-9]+$/.test(value) ? NaN : value),
    z.coerce.number().int().min(0).max(1048576).default(1024),
  ),
  AGENT_STORAGE_RESERVE_INODES: z.preprocess(
    (value) => (typeof value === "string" && !/^[0-9]+$/.test(value) ? NaN : value),
    z.coerce.number().int().min(0).max(1000000000).default(128),
  ),
});

export interface StorageCapacityRequest {
  path: string;
  additionalBytes: number;
  additionalInodes?: number;
}

export interface StorageCapacityDeps {
  env?: Record<string, string | undefined>;
  observe?: (path: string) => Promise<{ bsize: bigint; bavail: bigint; ffree: bigint }>;
}

/** Mount availability only: this neither reserves blocks nor observes a user's quota. */
export async function assertStorageCapacity(
  request: StorageCapacityRequest,
  deps: StorageCapacityDeps = {},
): Promise<void> {
  const config = StorageCapacityConfigSchema.safeParse(deps.env ?? process.env);
  const inodes = request.additionalInodes ?? 1;
  if (
    !config.success ||
    !Number.isSafeInteger(request.additionalBytes) ||
    request.additionalBytes < 0 ||
    !Number.isSafeInteger(inodes) ||
    inodes < 0
  )
    throw new Error("STORAGE_CAPACITY_INVALID");
  let path = resolve(request.path);
  const observe = deps.observe ?? ((value: string) => statfs(value, { bigint: true }));
  let available: Awaited<ReturnType<typeof observe>>;
  while (true) {
    try {
      available = await observe(path);
      break;
    } catch (error) {
      const parent = dirname(path);
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT" ||
        parent === path
      )
        throw new Error("STORAGE_CAPACITY_UNAVAILABLE");
      path = parent;
    }
  }
  if (
    typeof available.bsize !== "bigint" ||
    typeof available.bavail !== "bigint" ||
    typeof available.ffree !== "bigint" ||
    available.bsize <= 0n ||
    available.bavail < 0n ||
    available.ffree < 0n
  )
    throw new Error("STORAGE_CAPACITY_UNAVAILABLE");
  const required =
    BigInt(request.additionalBytes) + BigInt(config.data.AGENT_STORAGE_RESERVE_MIB) * 1024n ** 2n;
  if (available.bavail * available.bsize < required) throw new Error("STORAGE_CAPACITY_BYTES");
  if (available.ffree < BigInt(inodes) + BigInt(config.data.AGENT_STORAGE_RESERVE_INODES))
    throw new Error("STORAGE_CAPACITY_INODES");
}

/** Preserve non-storage errors while keeping OS quota/full-disk diagnostics out of transfer reports. */
export function normalizeStorageCapacityError(error: unknown): unknown {
  if (error instanceof Error && "code" in error) {
    if (error.code === "ENOSPC") return new Error("STORAGE_CAPACITY_BYTES");
    if (error.code === "EDQUOT") return new Error("STORAGE_CAPACITY_QUOTA");
  }
  return error;
}
