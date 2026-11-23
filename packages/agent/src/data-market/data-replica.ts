import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { create } from "@bufbuild/protobuf";
import {
  type DataReplicaCommand,
  type DataReplicaEntry,
  DataReplicaReceiptSchema,
  REPLICA_RANGE_BYTES,
  type ReplicaRange,
  type ReplicaRangeResult,
  ReplicaRangeSchema,
} from "@kuintessence/proto";
import { DataAssetEntryPathSchema } from "@kuintessence/shared";
import { siteFetch } from "@kuintessence/shared/site-transport";
import { z } from "zod";
import { type AgentDataRoots, ensurePrivateDirectory, scanFiles } from "./local-data-security";

import { ManagedReplicaReader } from "./replica-range";

class DigestMismatch extends Error {}
class InterruptedDownload extends Error {}

export class AgentReplicaStore {
  private readonly active = new Map<string, { task: Promise<unknown>; abort: AbortController }>();
  readonly reader: ManagedReplicaReader;
  constructor(
    private readonly roots: AgentDataRoots,
    private readonly download: (url: string, init: RequestInit) => Promise<Response> = siteFetch,
  ) {
    this.reader = new ManagedReplicaReader(roots);
  }

  execute(
    command: DataReplicaCommand,
    readRange?: (range: ReplicaRange, signal: AbortSignal) => Promise<ReplicaRangeResult>,
  ) {
    const previous = this.active.get(command.replicaId);
    if (command.release) previous?.abort.abort();
    const abort = new AbortController();
    const task = Promise.resolve(previous?.task)
      .then(async () => {
        const receipt = create(DataReplicaReceiptSchema, {
          replicaId: command.replicaId,
          attemptId: command.attemptId,
          outcome: "failed",
        });
        try {
          z.uuid().parse(command.replicaId);
          z.uuid().parse(command.attemptId);
          const remaining = Number(command.expiresAtUnixMs) - Date.now();
          if (!(remaining > 0 && remaining <= 3_600_000)) return receipt;
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(remaining)]);
          const root = await this.roots.replicaDirectory(command.managedRootId);
          const staging = join(root, `${command.replicaId}.partial`);
          const target = join(root, command.replicaId);
          if (command.release) {
            await rm(staging, { force: true, recursive: true });
            await rm(target, { force: true, recursive: true });
            receipt.outcome = "released";
            return receipt;
          }
          const expected = new Map(
            command.entries.map((entry) => [DataAssetEntryPathSchema.parse(entry.path), entry]),
          );
          if (!expected.size || expected.size !== command.entries.length)
            throw new DigestMismatch();
          const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return null;
          });
          if (existing && !existing.isDirectory()) throw new DigestMismatch();
          try {
            if (!existing) {
              await ensurePrivateDirectory(staging);
              for (const entry of command.entries)
                await this.copyEntry(staging, entry, signal, command, readRange);
            }
            const directory = existing ? target : staging;
            const files = await scanFiles(directory, directory);
            if (
              files.length !== expected.size ||
              files.some((file) => {
                const entry = expected.get(file.path);
                return (
                  !entry ||
                  entry.sha256 !== file.sha256 ||
                  entry.sizeBytes !== BigInt(file.sizeBytes)
                );
              })
            )
              throw new DigestMismatch();
            signal.throwIfAborted();
            if (!existing) await rename(staging, target);
            return create(DataReplicaReceiptSchema, {
              replicaId: command.replicaId,
              attemptId: command.attemptId,
              outcome: "copied",
              files: files.map((file) => ({
                relativePath: file.path,
                sizeBytes: BigInt(file.sizeBytes),
                sha256: file.sha256,
              })),
            });
          } catch (error) {
            if (!(error instanceof InterruptedDownload) && !signal.aborted)
              await rm(staging, { force: true, recursive: true });
            if (signal.aborted) throw new InterruptedDownload();
            throw error;
          }
        } catch (error) {
          receipt.outcome =
            error instanceof DigestMismatch
              ? "mismatch"
              : error instanceof InterruptedDownload
                ? "retry"
                : "failed";
          return receipt;
        }
      })
      .finally(() => {
        if (this.active.get(command.replicaId)?.abort === abort)
          this.active.delete(command.replicaId);
      });
    this.active.set(command.replicaId, { task, abort });
    return task;
  }
  private async copyEntry(
    staging: string,
    entry: DataReplicaEntry,
    signal: AbortSignal,
    command: DataReplicaCommand,
    readRange?: (range: ReplicaRange, signal: AbortSignal) => Promise<ReplicaRangeResult>,
  ) {
    if (
      (!command.managedSource && !/^https?:$/.test(new URL(entry.downloadUrl).protocol)) ||
      entry.sizeBytes < 0n
    )
      throw new Error("Invalid object source");
    const parts = entry.path.split("/");
    const name = parts.pop();
    if (!name) throw new Error("Missing file name");
    let parent = staging;
    for (const part of parts) parent = await ensurePrivateDirectory(join(parent, part));
    const handle = await open(
      join(parent, name),
      constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size > entry.sizeBytes)
        throw new DigestMismatch();
      if (info.size === entry.sizeBytes && !(command.managedSource && entry.sizeBytes === 0n))
        return;
      let offset = info.size;
      if (command.managedSource) {
        if (!readRange) throw new Error("Replica range channel unavailable");
        do {
          signal.throwIfAborted();
          const range = create(ReplicaRangeSchema, {
            requestId: randomUUID(),
            replicaId: command.replicaId,
            attemptId: command.attemptId,
            path: entry.path,
            offset,
          });
          const reply = await readRange(range, signal).catch(() => {
            throw new InterruptedDownload();
          });
          signal.throwIfAborted();
          if (reply.outcome === "retry") throw new InterruptedDownload();
          const bytes = reply.data;
          if (
            reply.outcome !== "read" ||
            reply.range?.requestId !== range.requestId ||
            reply.range.path !== range.path ||
            reply.range.replicaId !== range.replicaId ||
            reply.range.attemptId !== range.attemptId ||
            reply.range.offset !== offset ||
            (!bytes.length && entry.sizeBytes !== 0n) ||
            bytes.length > REPLICA_RANGE_BYTES ||
            offset + BigInt(bytes.length) > entry.sizeBytes
          )
            throw new DigestMismatch();
          for (let pos = 0; pos < bytes.length; ) {
            const { bytesWritten } = await handle.write(
              bytes,
              pos,
              bytes.length - pos,
              Number(offset) + pos,
            );
            if (!bytesWritten) throw new InterruptedDownload();
            pos += bytesWritten;
          }
          offset += BigInt(bytes.length);
        } while (offset < entry.sizeBytes);
        return;
      }
      const response = await this.download(entry.downloadUrl, {
        signal,
        redirect: "error",
        headers: offset ? { Range: `bytes=${offset}-` } : {},
      }).catch(() => {
        throw new InterruptedDownload();
      });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        throw new InterruptedDownload();
      }
      if (response.status === 200 && offset) {
        await handle.truncate(0);
        offset = 0n;
      } else if (
        response.status !== 200 &&
        (response.status !== 206 ||
          response.headers.get("content-range") !==
            `bytes ${offset}-${entry.sizeBytes - 1n}/${entry.sizeBytes}`)
      ) {
        await response.body?.cancel();
        throw new Error("Object range rejected");
      }
      if (!response.body) throw new InterruptedDownload();
      let bytes = offset;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += BigInt(chunk.length);
          if (bytes > entry.sizeBytes) done(new DigestMismatch());
          else done(null, chunk);
        },
      });
      const output = handle.createWriteStream({ start: Number(offset), autoClose: true });
      try {
        await pipeline(Readable.from(response.body), limit, output, { signal });
      } catch (error) {
        if (error instanceof DigestMismatch) throw error;
        throw new InterruptedDownload();
      }
      if (bytes !== entry.sizeBytes) throw new InterruptedDownload();
    } finally {
      await handle.close();
    }
  }
}
