import { spawnSync } from "node:child_process";
import { type BigIntStats, constants, fstatSync, lstatSync, unlinkSync } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { transferDownloadPartials as partials, type SqliteDb } from "@kuintessence/db";
import { and, eq, isNull, lte, or } from "drizzle-orm";

const retentionMs = 7 * 24 * 60 * 60_000;
type Entry = typeof partials.$inferSelect;

function lock(fd: number) {
  const result = spawnSync("flock", ["-xn", "3"], {
    stdio: ["ignore", "ignore", "ignore", fd],
    timeout: 2000,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
  if (result.status === 1) return false;
  if (result.error || result.status !== 0) throw new Error("Download partial lock unavailable");
  return true;
}

function identity(dir: BigIntStats, file: BigIntStats) {
  return `${dir.dev}/${dir.ino}/${file.dev}/${file.ino}/${file.birthtimeNs}`;
}

export class DownloadPartials {
  constructor(
    private readonly db: SqliteDb,
    private readonly now = Date.now,
  ) {}

  async track(path: string, file: FileHandle, created: boolean) {
    const locked = lock(file.fd);
    if (locked === false) throw new Error("Download partial is already in use");
    const parent = await realpath(dirname(path));
    const [dir, current, opened] = await Promise.all([
      lstat(parent, { bigint: true }),
      lstat(path, { bigint: true }),
      file.stat({ bigint: true }),
    ]);
    if (current.dev !== opened.dev || current.ino !== opened.ino)
      throw new Error("Download partial changed before staging");
    const entry = {
      path: join(parent, basename(path)),
      identity: identity(dir, opened),
      version: opened.birthtimeNs ? null : String(opened.ctimeNs),
      touchedAt: this.now(),
    };
    if (locked === undefined) {
      // Without flock this file can still resume, but must leave the GC ledger before writing.
      this.forget(entry);
      const named = await lstat(path, { bigint: true });
      if (named.dev !== opened.dev || named.ino !== opened.ino)
        throw new Error("Download partial changed before staging");
      return undefined;
    }
    if (created) {
      this.db
        .insert(partials)
        .values(entry)
        .onConflictDoUpdate({ target: partials.path, set: entry })
        .run();
    } else {
      const row = this.db
        .update(partials)
        .set({ touchedAt: entry.touchedAt, version: entry.version })
        .where(
          and(
            eq(partials.path, entry.path),
            eq(partials.identity, entry.identity),
            or(isNull(partials.version), eq(partials.version, String(opened.ctimeNs))),
          ),
        )
        .returning()
        .get();
      if (!row) return undefined;
    }
    return entry;
  }

  async retain(entry: Entry, file: FileHandle) {
    const current = await file.stat({ bigint: true });
    this.db
      .update(partials)
      .set({ touchedAt: this.now(), version: String(current.ctimeNs) })
      .where(and(eq(partials.path, entry.path), eq(partials.identity, entry.identity)))
      .run();
  }

  forget(entry: Entry) {
    this.db
      .delete(partials)
      .where(and(eq(partials.path, entry.path), eq(partials.identity, entry.identity)))
      .run();
  }

  async sweep() {
    const cutoff = this.now() - retentionMs;
    const entries = this.db
      .select()
      .from(partials)
      .where(lte(partials.touchedAt, cutoff))
      .orderBy(partials.touchedAt)
      .limit(64)
      .all();
    let failure: unknown;
    for (const entry of entries) {
      const match = and(
        eq(partials.path, entry.path),
        eq(partials.identity, entry.identity),
        eq(partials.touchedAt, entry.touchedAt),
        entry.version === null ? isNull(partials.version) : eq(partials.version, entry.version),
      );
      try {
        const busy = await this.removeIfExpired(entry);
        if (busy) {
          this.db.update(partials).set({ touchedAt: this.now() }).where(match).run();
          continue;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") {
          this.db.update(partials).set({ touchedAt: this.now() }).where(match).run();
          failure = error;
          continue;
        }
      }
      this.db.delete(partials).where(match).run();
    }
    if (failure) throw failure;
  }
  /** A busy partial stays registered for a later sweep. */
  private async removeIfExpired(entry: Entry): Promise<boolean> {
    const name = basename(entry.path);
    if (!/\.kq-sha256-[a-f0-9]{64}\.part$/.test(name)) return false;
    const dir = await open(
      dirname(entry.path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const parent = await dir.stat({ bigint: true });
      const uid = process.getuid?.();
      if (uid === undefined || parent.uid !== BigInt(uid) || parent.mode & 0o022n) return false;
      const path = join(`/proc/self/fd/${dir.fd}`, name);
      const matches = (file: BigIntStats) =>
        file.isFile() &&
        file.uid === BigInt(uid) &&
        file.nlink === 1n &&
        !(file.mode & 0o077n) &&
        identity(parent, file) === entry.identity &&
        (entry.version === null || entry.version === String(file.ctimeNs));
      if (!matches(await lstat(path, { bigint: true }))) return false;
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!lock(file.fd)) return true;
        // Serialize the final name removal with a writer withdrawing its GC registration.
        this.db.transaction(
          (tx) => {
            const current = tx.select().from(partials).where(eq(partials.path, entry.path)).get();
            if (
              current?.identity === entry.identity &&
              current.touchedAt === entry.touchedAt &&
              current.version === entry.version &&
              !(fstatSync(dir.fd).mode & 0o022) &&
              matches(fstatSync(file.fd, { bigint: true })) &&
              matches(lstatSync(path, { bigint: true }))
            )
              unlinkSync(path);
          },
          { behavior: "immediate" },
        );
      } finally {
        await file.close();
      }
    } finally {
      await dir.close();
    }
    return false;
  }
}
