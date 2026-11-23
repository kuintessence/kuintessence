import { type BigIntStats, constants, lstatSync, unlinkSync } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { uploadCheckpointInUse } from "./multipart-upload-from-file";

const checkpointName =
  /^([a-f0-9]{64})\.json(?:\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp)?$/;
const scanInterval = 60 * 60_000;

function identity(info: BigIntStats) {
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !info.isFile() ||
    info.uid !== BigInt(uid) ||
    info.nlink !== 1n ||
    info.mode & 0o077n
  )
    return undefined;
  return `${info.dev}/${info.ino}/${info.ctimeNs}`;
}

async function openPrivateDirectory(path: string) {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = await dir.stat();
    if (st.uid !== process.getuid?.() || st.mode & 0o077)
      throw new Error("Upload checkpoint directory must be private");
    return dir;
  } catch (error) {
    await dir.close();
    throw error;
  }
}

type Candidate = { key: string; name: string; identity: string };

async function* scan(directory: string): AsyncGenerator<Candidate[]> {
  const root = await openPrivateDirectory(directory).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  if (!root) return;
  try {
    const pinned = `/proc/self/fd/${root.fd}`;
    let files: Candidate[] = [];
    let examined = 0;
    for await (const entry of await opendir(pinned)) {
      const key = checkpointName.exec(entry.name)?.[1];
      if (key && entry.isFile() && !uploadCheckpointInUse(join(directory, `${key}.json`))) {
        const stat = await lstat(join(pinned, entry.name), { bigint: true }).catch(
          (err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          },
        );
        const id = stat && identity(stat);
        if (id) files.push({ key, name: entry.name, identity: id });
      }
      if (++examined === 64) {
        yield files;
        files = [];
        examined = 0;
      }
    }
    if (files.length) yield files;
  } finally {
    await root.close();
  }
}

/** Only release the same local files offered on the acknowledged heartbeat. */
export class UploadCheckpointGc {
  private cursor?: AsyncGenerator<Candidate[]>;
  private nextScan = 0;
  private offered?: { sequence: bigint; files: Candidate[] };

  constructor(private readonly directory: string) {}

  async inventory(sequence: bigint, now = Date.now()): Promise<string[]> {
    this.offered = undefined;
    if (sequence === 0n || (!this.cursor && now < this.nextScan)) return [];
    this.cursor ??= scan(this.directory);
    const cursor = this.cursor;
    try {
      const page = await cursor.next();
      if (page.done) {
        this.nextScan = now + scanInterval;
        this.cursor = undefined;
        return [];
      }
      this.offered = { sequence, files: page.value };
      return [...new Set(page.value.map((file) => file.key))];
    } catch (error) {
      this.cursor = undefined;
      this.nextScan = now + scanInterval;
      throw error;
    }
  }

  async close() {
    const cursor = this.cursor;
    this.cursor = undefined;
    await cursor?.return(undefined);
    this.offered = undefined;
  }

  async release(sequence: bigint, keys: string[]) {
    const offered = this.offered;
    if (!offered || offered.sequence !== sequence) return;
    this.offered = undefined;
    if (!keys.length || keys.length > 64) return;
    const confirmed = new Set(keys);
    const dir = await openPrivateDirectory(this.directory);
    try {
      for (const file of offered.files) {
        if (!confirmed.has(file.key)) continue;
        const path = join(`/proc/self/fd/${dir.fd}`, file.name);
        try {
          const current = identity(lstatSync(path, { bigint: true }));
          if (
            current === file.identity &&
            !uploadCheckpointInUse(join(this.directory, `${file.key}.json`))
          )
            unlinkSync(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    } finally {
      await dir.close();
    }
  }
}
