import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { SpackMaterialPathSchema } from "@kuintessence/shared";

const CHUNK = 64 * 1024;
const error = () => new Error("Material import input is unavailable, unsafe, or changed");

function stable(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.nlink === after.nlink
  );
}

async function snapshot(root: string, path: string, size: number | undefined, maximum: number) {
  if (!isAbsolute(root) || resolve(root) !== root || (await realpath(root)) !== root) throw error();
  const parsed = SpackMaterialPathSchema.safeParse(path);
  if (!parsed.success) throw error();
  const directories = new Map<string, BigIntStats>();
  const parts = path.split("/");
  let directory = root;
  for (let index = 0; index < parts.length; index++) {
    const stat = await lstat(directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022n) !== 0n ||
      (await realpath(directory)) !== directory
    )
      throw error();
    directories.set(directory, stat);
    const part = parts[index];
    if (!part) throw error();
    directory = join(directory, part);
  }
  const stat = await lstat(directory, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (stat.mode & 0o022n) !== 0n ||
    stat.size <= 0n ||
    stat.size > BigInt(maximum) ||
    (size !== undefined && BigInt(size) !== stat.size)
  )
    throw error();
  return { path: directory, stat, directories };
}

async function unchanged(input: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
  for (const [path, stat] of input.directories) {
    if (!stable(stat, await lstat(path, { bigint: true })) || (await realpath(path)) !== path)
      throw error();
  }
  if (!stable(input.stat, await lstat(input.path, { bigint: true }))) throw error();
}

export async function inspectMaterialImportFile(
  root: string,
  path: string,
  size: number | undefined,
  maximum: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await snapshot(root, path, size, maximum);
  signal.throwIfAborted();
}

export async function openMaterialImportFile(
  root: string,
  path: string,
  size: number | undefined,
  maximum: number,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  signal.throwIfAborted();
  const input = await snapshot(root, path, size, maximum);
  const handle = await open(
    input.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= handle.close());
  try {
    signal.throwIfAborted();
    if (!stable(input.stat, await handle.stat({ bigint: true }))) throw error();
    await unchanged(input);
    let bytes = 0;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const buffer = new Uint8Array(Math.min(CHUNK, Number(input.stat.size) - bytes + 1));
            const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, bytes);
            signal.throwIfAborted();
            bytes += bytesRead;
            if (BigInt(bytes) > input.stat.size) throw error();
            if (!bytesRead) {
              if (
                BigInt(bytes) !== input.stat.size ||
                !stable(input.stat, await handle.stat({ bigint: true }))
              )
                throw error();
              await unchanged(input);
              await close();
              controller.close();
            } else {
              controller.enqueue(buffer.subarray(0, bytesRead));
            }
          } catch {
            try {
              await close();
            } finally {
              controller.error(error());
            }
          }
        },
        cancel: close,
      },
      { highWaterMark: 0 },
    );
  } catch {
    await close();
    throw error();
  }
}

export async function readMaterialImportManifest(
  root: string,
  path: string,
  maximum: number,
  signal: AbortSignal,
): Promise<unknown> {
  const stream = await openMaterialImportFile(root, path, undefined, maximum, signal);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) throw error();
      parts.push(item.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, size)));
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
