import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { releaseMaterialMetadata, withMaterialStorageLock } from "./spack-material-collection";
import { ensureMaterialDirectory, isMissing, SpackMaterialError } from "./spack-material-storage";

const headerSize = 256;
const recordSize = 32;
const smallDirectory = 512;
const maxBuildEntries = 250_000;
const batch = 256;

function indexPath(root: string, id: string) {
  return join(root, "catalog-index", id);
}

/** Caller holds the material root lock through the subsequent manifest mutation. */
export function invalidateMaterialNameIndex(root: string, id: string) {
  return releaseMaterialMetadata(indexPath(root, id));
}

async function stamp(directory: string) {
  const st = await lstat(directory, { bigint: true });
  if (!st.isDirectory()) throw new SpackMaterialError(500, "Invalid material catalog directory");
  return `KQ1:${st.ino}/${st.mtimeNs}/${st.ctimeNs}`;
}

async function* scan(directory: string) {
  for await (const item of await opendir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(item.name)) {
      yield undefined;
      continue;
    }
    if (!item.isFile()) throw new SpackMaterialError(500, "Invalid material catalog file");
    yield item.name.slice(0, -5);
  }
}

async function readFully(file: FileHandle, bytes: Buffer, position: number) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesRead) throw new SpackMaterialError(500, "Truncated material catalog index");
    offset += bytesRead;
  }
}

async function openIndex(path: string, version: string) {
  let file: FileHandle;
  try {
    if ((await realpath(dirname(path))) !== dirname(path))
      throw new SpackMaterialError(500, "Invalid material index directory");
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new SpackMaterialError(500, "Invalid material catalog index");
    if (stat.size >= headerSize) {
      const header = Buffer.alloc(headerSize);
      await readFully(file, header, 0);
      const [savedVersion, count] = header.toString("ascii").trimEnd().split(" ");
      const records = Number(count);
      const blocks = Math.ceil(records / batch);
      if (
        savedVersion === version &&
        Number.isSafeInteger(records) &&
        records >= 0 &&
        records <= maxBuildEntries &&
        stat.size === headerSize + recordSize * (records + blocks)
      )
        return { file, records, blocks };
    }
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
}

async function build(
  root: string,
  directory: string,
  path: string,
  checkpoint: () => void,
  overBudget: () => Error,
) {
  return withMaterialStorageLock(root, true, async () => {
    const version = await stamp(directory);
    const ready = await openIndex(path, version);
    if (ready) return ready;
    const names: string[] = [];
    let entries = 0;
    for await (const digest of scan(directory)) {
      checkpoint();
      if (++entries > maxBuildEntries) throw overBudget();
      if (digest !== undefined) names.push(digest);
    }
    names.sort();
    checkpoint();
    await ensureMaterialDirectory(dirname(path));
    // The exclusive root lock lets a rebuild replace a temporary file left by a crashed builder.
    const temp = `${path}.tmp`;
    await rm(temp, { force: true });
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${version} ${names.length}`.padEnd(headerSize, " "));
      for (let i = 0; i < names.length; i += batch) {
        checkpoint();
        const data = Buffer.from(names.slice(i, i + batch).join(""), "hex");
        await file.writeFile(Buffer.concat([data, checksum(i / batch, data)]));
      }
      await file.sync();
      checkpoint();
      if ((await stamp(directory)) !== version)
        throw new SpackMaterialError(503, "Material directory changed while indexing");
      await rename(temp, path);
    } finally {
      try {
        await file.close();
      } finally {
        await rm(temp, { force: true });
      }
    }
    const result = await openIndex(path, version);
    if (!result) throw new SpackMaterialError(503, "Material catalog index unavailable");
    return result;
  });
}

function checksum(block: number, data: Buffer) {
  return createHash("sha256").update(String(block)).update(data).digest();
}

/** Short directories are scanned directly. The shared index stores only ordered SHA-256 values. */
export async function* indexedMaterialDigests(
  root: string,
  id: string,
  after: string | undefined,
  checkpoint: () => void,
  count: () => void,
  overBudget: () => Error,
) {
  const directory = join(root, "manifests", id);
  const path = indexPath(root, id);
  let index = await openIndex(path, await stamp(directory));
  if (!index) {
    let examined = 0;
    const names: string[] = [];
    // Stop even when the first entries are all temporary files.
    for await (const digest of scan(directory)) {
      checkpoint();
      if (++examined > smallDirectory) break;
      count();
      if (digest !== undefined) names.push(digest);
    }
    if (examined <= smallDirectory) {
      for (const digest of names.sort()) if (!after || digest > after) yield digest;
      return;
    }
    index = await build(root, directory, path, checkpoint, overBudget);
  }
  const { file, records, blocks } = index;
  const readBlock = async (block: number) => {
    checkpoint();
    const size = Math.min(batch, records - block * batch) * recordSize;
    const bytes = Buffer.alloc(size + recordSize);
    await readFully(file, bytes, headerSize + block * (batch + 1) * recordSize);
    const data = bytes.subarray(0, size);
    if (!checksum(block, data).equals(bytes.subarray(size))) {
      // A concurrent rebuild may already have installed a different inode.
      await withMaterialStorageLock(root, true, async () => {
        const current = await lstat(path, { bigint: true }).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
        const opened = await file.stat({ bigint: true });
        if (current?.dev === opened.dev && current.ino === opened.ino)
          await invalidateMaterialNameIndex(root, id);
      });
      throw new SpackMaterialError(503, "Material catalog index checksum failed; retry to rebuild");
    }
    return data;
  };
  try {
    let start = 0;
    if (after) {
      const key = Buffer.from(after, "hex");
      let end = blocks;
      while (start < end) {
        const mid = Math.floor((start + end) / 2);
        const block = await readBlock(mid);
        if (block.subarray(-recordSize).compare(key) <= 0) start = mid + 1;
        else end = mid;
      }
    }
    for (let i = start; i < blocks; i++) {
      const data = await readBlock(i);
      for (let offset = 0; offset < data.length; offset += recordSize) {
        const digest = data.toString("hex", offset, offset + recordSize);
        if (i === start && after && digest <= after) continue;
        count();
        yield digest;
      }
    }
  } finally {
    await file.close();
  }
}
