import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isSpackInstallRoot,
  type SpackInstallRecord,
  SpackInstallRecordSchema,
} from "./install-contract";

type CreateInput = Pick<
  SpackInstallRecord,
  "manifestDigest" | "manifestSize" | "siteProfileDigest" | "spec" | "rootHash"
>;
const MAX_BYTES = 2 * 1024 ** 2;
const MAX_RECORDS = 1024;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const ID = SpackInstallRecordSchema.shape.id;
const CreateSchema = SpackInstallRecordSchema.pick({
  manifestDigest: true,
  manifestSize: true,
  siteProfileDigest: true,
  spec: true,
  rootHash: true,
});
const NEXT: Record<SpackInstallRecord["state"], SpackInstallRecord["state"][]> = {
  building: ["verifying", "failed"],
  verifying: ["ready", "failed"],
  ready: ["unavailable", "removing"],
  unavailable: ["ready", "removing"],
  failed: ["removing"],
  removing: ["removed"],
  removed: [],
};
const IDENTITY = [
  "version",
  "id",
  "manifestDigest",
  "manifestSize",
  "siteProfileDigest",
  "spec",
  "rootHash",
] as const;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
async function optionalStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function assertDirectory(stat: Stats, owned = false, privateDirectory = false): void {
  const stickyAncestor = !owned && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.uid !== process.getuid?.() && (owned || stat.uid !== 0)) ||
    ((stat.mode & 0o022) !== 0 && !stickyAncestor) ||
    (privateDirectory && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("Unsafe Spack store directory ownership, permissions or symlink");
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, DIR_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
// Validate every ancestor before descending; never chmod an existing site directory.
async function directory(path: string, create = false, mode = 0o755): Promise<void> {
  let current = "/";
  assertDirectory(await lstat(current));
  for (const part of path.slice(1).split("/")) {
    current = join(current, part);
    let stat = await optionalStat(current);
    if (!stat && create) {
      let created = false;
      try {
        await mkdir(current, { mode: current === path ? mode : 0o755 });
        created = true;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      stat = await lstat(current);
      if (created) {
        const handle = await open(current, DIR_FLAGS);
        try {
          assertDirectory(await handle.stat(), true);
          await handle.chmod(current === path ? mode : 0o755);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(dirname(current));
      }
    }
    if (!stat) throw new Error("Missing Spack store directory");
    assertDirectory(stat, current === path, current === path && mode === 0o700);
  }
}
function assertRecordFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > MAX_BYTES ||
    stat.nlink !== 1
  ) {
    throw new Error("Unsafe Spack record file ownership, permissions, type or size");
  }
}

export class SpackInstallStore {
  private readonly context = new AsyncLocalStorage<symbol>();
  private active?: { token: symbol; stat: Stats };
  private busy = false;
  private writing = false;
  private readonly records: string;
  private readonly releases: string;
  private readonly lock: string;

  constructor(private readonly root: string) {
    if (!isSpackInstallRoot(root)) throw new Error("Invalid Spack installation store root");
    this.records = join(root, "records");
    this.releases = join(root, "releases");
    this.lock = join(root, ".writer-lock");
  }
  private async layout(create = false): Promise<void> {
    await directory(this.root, create);
    await directory(this.releases, create);
    await directory(this.records, create, 0o700);
  }
  async initialize(): Promise<void> {
    await this.layout(true);
  }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Spack writer lock is not reentrant");
    this.busy = true;
    let handle: FileHandle | undefined;
    let owned: Stats | undefined;
    try {
      await this.layout();
      await mkdir(this.lock, { mode: 0o700 });
      owned = await lstat(this.lock);
      assertDirectory(owned, true, true);
      handle = await open(this.lock, DIR_FLAGS);
      if (!sameFile(owned, await handle.stat())) throw new Error("Spack writer lock changed");
      await syncDirectory(this.root);
      const token = Symbol("writer");
      this.active = { token, stat: owned };
      return await this.context.run(token, fn);
    } finally {
      this.active = undefined;
      try {
        const current = owned && (await optionalStat(this.lock));
        if (owned && current && sameFile(owned, current)) {
          await rmdir(this.lock);
          await syncDirectory(this.root);
        }
      } finally {
        this.busy = false;
        await handle?.close();
      }
    }
  }
  private async assertLocked(): Promise<void> {
    if (!this.active || this.context.getStore() !== this.active.token) {
      throw new Error("Spack mutation requires the owning withLock context");
    }
    await this.layout();
    const current = await lstat(this.lock);
    assertDirectory(current, true, true);
    if (!sameFile(this.active.stat, current)) throw new Error("Spack writer lock changed");
  }
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (this.writing) throw new Error("Concurrent Spack mutations are not supported");
    this.writing = true;
    try {
      await this.assertLocked();
      return await fn();
    } finally {
      this.writing = false;
    }
  }
  path(id: string): string {
    return join(this.releases, ID.parse(id));
  }
  private recordPath(id: string): string {
    return join(this.records, `${ID.parse(id)}.json`);
  }
  private validate(value: unknown): SpackInstallRecord {
    const record = SpackInstallRecordSchema.parse(value);
    if (record.state === "ready") {
      const report = record.report;
      if (
        !report ||
        report.action !== "verify" ||
        report.root.hash !== record.rootHash ||
        report.root.spec !== record.spec ||
        report.manifestDigest !== record.manifestDigest ||
        report.siteProfileDigest !== record.siteProfileDigest ||
        report.storePath !== this.path(record.id)
      ) {
        throw new Error("Ready Spack record requires a matching verify report");
      }
    }
    return record;
  }
  private async read(id: string): Promise<SpackInstallRecord> {
    const path = this.recordPath(id);
    const entry = await lstat(path);
    assertRecordFile(entry);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      assertRecordFile(stat);
      if (!sameFile(entry, stat)) throw new Error("Spack record changed while opening");
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw new Error("Spack record size changed");
      const final = await handle.stat();
      assertRecordFile(final);
      if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs || final.mode !== stat.mode) {
        throw new Error("Spack record changed while reading");
      }
      const record = this.validate(JSON.parse(bytes.subarray(0, length).toString("utf8")));
      if (record.id !== id) throw new Error("Spack record filename identity mismatch");
      return record;
    } finally {
      await handle.close();
    }
  }
  async list(): Promise<SpackInstallRecord[]> {
    await this.layout();
    const ids: string[] = [];
    for await (const entry of await opendir(this.records)) {
      if (
        entry.name.startsWith(".") &&
        entry.name.endsWith(".tmp") &&
        ID.safeParse(entry.name.slice(1, -4)).success
      ) {
        assertRecordFile(await lstat(join(this.records, entry.name)));
        continue;
      }
      if (!entry.name.endsWith(".json")) throw new Error("Unexpected Spack record entry");
      ids.push(ID.parse(entry.name.slice(0, -5)));
      if (ids.length > MAX_RECORDS) throw new Error("Spack record limit exceeded");
    }
    const records: SpackInstallRecord[] = [];
    for (const id of ids.sort()) records.push(await this.read(id));
    return records;
  }
  private async write(record: SpackInstallRecord): Promise<void> {
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Spack record size limit exceeded");
    const temporary = join(this.records, `.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await this.assertLocked();
      await rename(temporary, this.recordPath(record.id));
      await syncDirectory(this.records);
    } finally {
      await handle.close();
      await unlink(temporary).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    }
  }
  async create(input: CreateInput): Promise<SpackInstallRecord> {
    return this.mutate(async () => {
      const record = this.validate({
        ...CreateSchema.parse(input),
        version: 1,
        id: randomUUID(),
        state: "building",
        updatedAt: new Date().toISOString(),
      });
      if ((await this.list()).length >= MAX_RECORDS) throw new Error("Spack record limit exceeded");
      await mkdir(this.path(record.id), { mode: 0o700 });
      await syncDirectory(this.releases);
      await this.write(record);
      return record;
    });
  }
  async save(value: SpackInstallRecord): Promise<void> {
    return this.mutate(async () => {
      const record = this.validate(value);
      const previous = await this.read(record.id);
      if (IDENTITY.some((key) => previous[key] !== record[key])) {
        throw new Error("Spack record identity is immutable");
      }
      if (record.state !== previous.state && !NEXT[previous.state].includes(record.state)) {
        throw new Error("Invalid Spack installation state transition");
      }
      await this.write(record);
    });
  }
  async removeFiles(id: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read(id);
      if (record.state !== "removing" && record.state !== "failed") {
        throw new Error("Spack files can only be removed in removing or failed state");
      }
      const path = this.path(id);
      const stat = await optionalStat(path);
      if (!stat) return;
      assertDirectory(stat, true);
      await rm(path, { recursive: true, force: false });
      await syncDirectory(this.releases);
    });
  }
  async publishFiles(id: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read(id);
      if (record.state !== "verifying")
        throw new Error("Spack publication requires verifying state");
      const path = this.path(id);
      const stat = await lstat(path);
      assertDirectory(stat, true);
      const handle = await open(path, DIR_FLAGS);
      try {
        if (!sameFile(stat, await handle.stat()))
          throw new Error("Spack release directory changed");
        await handle.chmod(0o755);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.releases);
    });
  }
}
