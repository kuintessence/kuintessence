import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import {
  softwareMirrorCache as cache,
  type PgDb,
  type PgTransaction,
  softwareAssets,
} from "@kuintessence/db";
import { AppError, DataAssetEntryPathSchema, ErrorCode } from "@kuintessence/shared";
import { siteFetch } from "@kuintessence/shared/site-transport";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

const FileSchema = z.strictObject({
  kind: z.enum(["source", "buildcache"]),
  path: DataAssetEntryPathSchema,
  sourceUrl: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const MirrorSyncSchema = z.strictObject({ files: z.array(FileSchema).min(1).max(10000) });
type Entry = z.infer<typeof FileSchema>;
const managed = sql`${cache.provenance}->>'producer' = 'mirror-sync'`;
function invalid(msg: string) {
  return new AppError(ErrorCode.VALIDATION_ERROR, msg, 400);
}
function missing() {
  return new AppError(ErrorCode.NOT_FOUND, "Mirror file is unavailable", 404);
}
function lock(tx: PgTransaction, id: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"software-mirror:" + id},0))`,
  );
}
async function remove(path: string) {
  await unlink(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}
function stamp(stat: BigIntStats) {
  return [stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join("/");
}
async function verifyFile(file: FileHandle, stat: BigIntStats, size: number, digest: string) {
  if (!stat.isFile() || Number(stat.size) !== size) return false;
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false }))
    hash.update(chunk);
  return hash.digest("hex") === digest && stamp(await file.stat({ bigint: true })) === stamp(stat);
}
async function objectStamp(dir: string, digest: string) {
  const file = await lstat(join(dir, digest), { bigint: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    },
  );
  return file?.isFile() ? stamp(file) : null;
}
function fileUrl(asset: string, path: string) {
  return `/api/software/mirror-cache/${asset}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export class SoftwareMirrorWorker {
  private readonly origins: Set<string>;
  private sweep?: Awaited<ReturnType<typeof opendir>>;
  constructor(
    private readonly db: PgDb,
    private readonly root: string,
    origins: string[],
    private readonly get: typeof siteFetch = siteFetch,
  ) {
    if (!isAbsolute(root)) throw new Error("SOFTWARE_MIRROR_DIR must be absolute");
    this.origins = new Set(
      origins.map((value) => {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.origin !== value)
          throw new Error("Expected an exact HTTPS mirror origin");
        return url.origin;
      }),
    );
  }
  private validateSource(value: string) {
    const url = new URL(value);
    if (!this.origins.has(url.origin) || url.username || url.password || url.search || url.hash)
      throw invalid("Mirror source requires a configured origin and a credential-free URL");
  }
  async enqueue(assetId: string, raw: unknown) {
    const { files } = MirrorSyncSchema.parse(raw);
    const paths = new Set(files.map((f) => f.path));
    if (paths.size !== files.length) throw invalid("Duplicate mirror path");
    for (const file of files) {
      this.validateSource(file.sourceUrl);
      if ((file.kind === "buildcache") !== file.path.startsWith("build_cache/"))
        throw invalid("Binary mirror members must use native build_cache paths");
      for (let i = file.path.indexOf("/"); i >= 0; i = file.path.indexOf("/", i + 1))
        if (paths.has(file.path.slice(0, i))) throw invalid("Mirror paths overlap");
    }
    return this.db.transaction(async (tx) => {
      const [asset] = await tx
        .select({ id: softwareAssets.id })
        .from(softwareAssets)
        .where(eq(softwareAssets.id, assetId))
        .for("update");
      if (!asset) throw missing();
      const prior = await tx
        .select()
        .from(cache)
        .where(and(managed, eq(cache.assetId, assetId)))
        .for("update");
      if (prior.length) {
        const byPath = new Map(files.map((f) => [f.path, f]));
        if (
          prior.length !== files.length ||
          prior.some((row) => {
            const f = byPath.get(String(row.provenance.path));
            return (
              !f ||
              row.sourceUrl !== f.sourceUrl ||
              row.kind !== f.kind ||
              row.sha256 !== f.sha256 ||
              row.provenance.sizeBytes !== f.sizeBytes
            );
          })
        )
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "A different mirror inventory is already bound to this asset",
            409,
          );
        const dir = await this.directory();
        const retry = [];
        for (const row of prior) {
          if (row.status === "syncing") continue;
          const f = byPath.get(String(row.provenance.path));
          if (!f) throw invalid("Mirror inventory changed");
          if (
            row.status !== "cached" ||
            !row.provenance.verifiedStamp ||
            row.provenance.verifiedStamp !== (await objectStamp(dir, f.sha256))
          )
            retry.push(row.id);
        }
        if (retry.length)
          await tx
            .update(cache)
            .set({ status: "syncing", error: null, updatedAt: new Date() })
            .where(inArray(cache.id, retry));
      } else {
        for (let i = 0; i < files.length; i += 500)
          await tx.insert(cache).values(
            files.slice(i, i + 500).map((f) => ({
              assetId,
              kind: f.kind,
              status: "syncing",
              sha256: f.sha256,
              sourceUrl: f.sourceUrl,
              provenance: { producer: "mirror-sync", path: f.path, sizeBytes: f.sizeBytes },
            })),
          );
      }
      return { assetId, files: files.length };
    });
  }
  async release(assetId: string) {
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: softwareAssets.id })
        .from(softwareAssets)
        .where(eq(softwareAssets.id, assetId))
        .for("update");
      await tx.delete(cache).where(and(managed, eq(cache.assetId, assetId)));
    });
  }
  private async directory() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await realpath(this.root)) !== this.root || !(await lstat(this.root)).isDirectory())
      throw new Error("Mirror root binding changed");
    const dir = join(this.root, "kq-mirror-objects");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await realpath(dir)) !== dir || ((await lstat(dir)).mode & 0o077) !== 0)
      throw new Error("Mirror object directory must be private");
    return dir;
  }
  private async validObject(dir: string, f: Entry) {
    const existing = await open(
      join(dir, f.sha256),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (!existing) return null;
    try {
      const stat = await existing.stat({ bigint: true });
      if (!stat.isFile()) throw new Error("Invalid mirror object");
      return (await verifyFile(existing, stat, f.sizeBytes, f.sha256)) ? stamp(stat) : null;
    } finally {
      await existing.close();
    }
  }
  private async fetchFile(dir: string, f: Entry) {
    this.validateSource(f.sourceUrl);
    const dest = join(dir, f.sha256),
      temp = dest + ".partial";
    const verified = await this.validObject(dir, f);
    if (verified) return verified;
    await remove(temp);
    const out = await open(temp, "wx", 0o600);
    try {
      const response = await this.get(f.sourceUrl, {
        signal: AbortSignal.timeout(30 * 60 * 1000),
        redirect: "error",
        headers: { "accept-encoding": "identity" },
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error("Upstream mirror unavailable");
      }
      const h = createHash("sha256");
      let n = 0;
      for await (const chunk of Readable.fromWeb(response.body)) {
        n += chunk.length;
        if (n > f.sizeBytes) throw new Error("Mirror byte count exceeded");
        h.update(chunk);
        await out.writeFile(chunk);
      }
      if (n !== f.sizeBytes || h.digest("hex") !== f.sha256)
        throw new Error("Mirror digest or size mismatch");
      await out.sync();
      await rename(temp, dest);
      const directory = await open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return stamp(await out.stat({ bigint: true }));
    } finally {
      await out.close();
      await remove(temp);
    }
  }
  async tick() {
    const dir = await this.directory();
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(cache)
        .where(and(managed, eq(cache.status, "syncing")))
        .orderBy(asc(cache.updatedAt), asc(cache.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return;
      const f = FileSchema.parse({
        path: row.provenance.path,
        sizeBytes: row.provenance.sizeBytes,
        kind: row.kind,
        sha256: row.sha256,
        sourceUrl: row.sourceUrl,
      });
      await lock(tx, f.sha256);
      let verifiedStamp: string;
      try {
        verifiedStamp = await this.fetchFile(dir, f);
      } catch {
        await tx
          .update(cache)
          .set({
            status: "failed",
            error: "Mirror transfer or verification failed",
            updatedAt: new Date(),
          })
          .where(eq(cache.id, row.id));
        return;
      }
      await tx
        .update(cache)
        .set({
          status: "cached",
          provenance: { ...row.provenance, verifiedStamp },
          localUrl: fileUrl(row.assetId ?? "", f.path),
          cachedAt: new Date(),
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(cache.id, row.id));
    });
    // Sweep a bounded number of names per tick, including abandoned partial writes.
    this.sweep ??= await opendir(dir);
    for (let i = 0; i < 32; i++) {
      const item = await this.sweep.read();
      if (!item) {
        await this.sweep.close();
        this.sweep = undefined;
        break;
      }
      if (!item.isFile() || !/^([a-f0-9]{64})(\.partial)?$/.test(item.name)) continue;
      const digest = item.name.slice(0, 64);
      await this.db.transaction(async (tx) => {
        if (
          !(
            await tx.execute<{ ok: boolean }>(
              sql`select pg_try_advisory_xact_lock(hashtextextended(${"software-mirror:" + digest},0)) as ok`,
            )
          )[0]?.ok
        )
          return;
        const [ref] = await tx
          .select({ id: cache.id })
          .from(cache)
          .where(eq(cache.sha256, digest))
          .limit(1);
        if (!ref || item.name.endsWith(".partial")) await remove(join(dir, item.name));
      });
    }
  }
  async openFile(assetId: string, path: string) {
    DataAssetEntryPathSchema.parse(path);
    const dir = await this.directory();
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(cache)
        .where(and(managed, eq(cache.assetId, assetId)))
        .for("share");
      const f = rows.find((row) => row.provenance.path === path);
      if (
        !f?.sha256 ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        rows.some((row) => row.status !== "cached")
      )
        throw missing();
      const file = await open(
        join(dir, f.sha256),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ELOOP") throw missing();
        throw err;
      });
      try {
        const stat = await file.stat({ bigint: true });
        const size = f.provenance.sizeBytes;
        if (!stat.isFile() || typeof size !== "number" || Number(stat.size) !== size)
          throw missing();
        if (
          f.provenance.verifiedStamp !== stamp(stat) &&
          !(await verifyFile(file, stat, size, f.sha256))
        )
          throw missing();
        return new Response(
          Readable.toWeb(file.createReadStream({ start: 0 })) as ReadableStream<Uint8Array>,
          {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(stat.size),
              etag: '"' + f.sha256 + '"',
              "cache-control": "private, no-store",
            },
          },
        );
      } catch (e) {
        await file.close();
        throw e;
      }
    });
  }
}
