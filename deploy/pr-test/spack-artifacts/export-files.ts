import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SpackMaterialBlob } from "@kuintessence/shared";
import { openMaterialImportFile } from "../../../packages/registry/src/services/material-import-files";
import { requireExport } from "./export-contract";

export function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

export async function safeDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  requireExport(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o022) === 0 &&
      (await realpath(absolute)) === absolute,
    "Expected a canonical non-writable-by-others directory",
  );
  return absolute;
}

export async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  requireExport(false, "Export destination already exists");
}

export async function inputInventory(
  root: string,
  expectedFiles: ReadonlyMap<string, number>,
): Promise<Map<string, BigIntStats>> {
  const directories = new Set([""]);
  for (const path of expectedFiles.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      requireExport(!expectedFiles.has(prefix), "Overlapping input files");
      directories.add(prefix);
    }
  }
  const inventory = new Map<string, BigIntStats>();
  const pending = [""];
  while (pending.length) {
    const directory = pending.pop();
    requireExport(directory !== undefined, "Invalid input directory");
    const path = join(root, directory);
    await safeDirectory(path);
    inventory.set(directory, await lstat(path, { bigint: true }));
    const handle = await opendir(path);
    for await (const entry of handle) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      const maximum = expectedFiles.get(relative);
      requireExport(
        maximum !== undefined || directories.has(relative),
        "Unexpected prepared input entry",
      );
      if (maximum === undefined) {
        pending.push(relative);
      } else {
        const stat = await lstat(join(root, relative), { bigint: true });
        requireExport(
          stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.nlink === 1n &&
            (stat.mode & 0o022n) === 0n &&
            stat.size > 0n &&
            stat.size <= BigInt(maximum),
          "Unsafe or oversized prepared input file",
        );
        inventory.set(relative, stat);
      }
    }
  }
  requireExport(
    inventory.size === expectedFiles.size + directories.size,
    "Prepared input file is missing",
  );
  return inventory;
}

export async function verifyInventory(
  root: string,
  inventory: ReadonlyMap<string, BigIntStats>,
): Promise<void> {
  for (const [path, before] of inventory) {
    requireExport(
      unchanged(before, await lstat(join(root, path), { bigint: true })),
      "Prepared input changed during export",
    );
  }
  requireExport((await realpath(root)) === root, "Prepared input changed during export");
}

export async function readBounded(
  root: string,
  path: string,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const stream = await openMaterialImportFile(root, path, undefined, maximum, signal);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      requireExport(size <= maximum, "Input byte budget exceeded");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function copyHashed(
  root: string,
  path: string,
  destination: string,
  maximum: number,
  signal: AbortSignal,
): Promise<SpackMaterialBlob> {
  const output = await open(destination, "wx", 0o644);
  try {
    const stream = await openMaterialImportFile(root, path, undefined, maximum, signal);
    const reader = stream.getReader();
    const hash = createHash("sha256");
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        requireExport(size <= maximum, "Input byte budget exceeded");
        hash.update(item.value);
        await output.writeFile(item.value);
      }
      await output.chmod(0o644);
      return { digest: `sha256:${hash.digest("hex")}`, size };
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  } finally {
    await output.close();
  }
}
