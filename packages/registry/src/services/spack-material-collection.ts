import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open, opendir, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SpackMaterialBindingSchema,
  SpackMaterialBlobSchema,
  type SpackMaterialManifest,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import {
  ensureMaterialDirectory,
  isMissing,
  readMaterialMetadata,
  SpackMaterialError,
} from "./spack-material-storage";

// flock(2) belongs to the inherited open file description. Closing the last fd also
// releases it after a crash. All Registry processes sharing a material root lock its inode.
export async function withMaterialStorageLock<T>(
  root: string,
  exclusive: boolean,
  work: () => Promise<T>,
) {
  await ensureMaterialDirectory(root);
  const dir = await open(root, constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const lock = spawnSync("flock", [exclusive ? "-x" : "-s", "-n", "3"], {
      stdio: ["ignore", "ignore", "ignore", dir.fd],
    });
    if (lock.status !== 0) throw new SpackMaterialError(503, "Material storage lock unavailable");
    return await work();
  } finally {
    await dir.close();
  }
}

export async function releaseMaterialMetadata(path: string) {
  const folder = dirname(path);
  let parent: Awaited<ReturnType<typeof open>>;
  try {
    if ((await realpath(folder)) !== folder)
      throw new SpackMaterialError(500, "Invalid material directory binding");
    parent = await open(folder, constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try {
    await unlink(path).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function* members(dir: string, groups: RegExp, filenames: RegExp) {
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    if ((await realpath(dir)) !== dir)
      throw new SpackMaterialError(500, "Invalid material directory binding");
    directory = await opendir(dir);
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }
  for await (const group of directory) {
    if (!groups.test(group.name) || !group.isDirectory())
      throw new SpackMaterialError(500, "Invalid material storage directory");
    const folder = join(dir, group.name);
    for await (const entry of await opendir(folder)) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || !filenames.test(entry.name))
        throw new SpackMaterialError(500, "Invalid material storage entry");
      yield { group: group.name, name: entry.name, path: join(folder, entry.name) };
    }
  }
}

export function materialManifests(root: string) {
  return members(join(root, "manifests"), /^[a-f0-9]{64}$/, /^[a-f0-9]{64}\.json$/);
}

// Caller holds the exclusive root lock. Withdrawn manifests remain references until purged.
export async function collectMaterialBlobs(
  root: string,
  readManifest: (id: string, digest: string) => Promise<{ manifest: SpackMaterialManifest }>,
) {
  const live = new Set<string>();
  const manifests = new Set<string>();
  const repository = /^[a-f0-9]{64}$/;
  const metadata = /^[a-f0-9]{64}\.json$/;
  for await (const item of members(join(root, "receipts"), repository, metadata)) {
    const blob = SpackMaterialBlobSchema.parse(
      JSON.parse((await readMaterialMetadata(item.path)).toString("utf8")),
    );
    if (blob.digest.slice(7) !== item.name.slice(0, -5))
      throw new SpackMaterialError(500, "Corrupt material receipt");
    live.add(blob.digest.slice(7));
  }
  for await (const item of materialManifests(root)) {
    const { manifest } = await readManifest(item.group, `sha256:${item.name.slice(0, -5)}`);
    manifests.add(`${item.group}/${item.name}`);
    for (const blob of spackMaterialBlobs(manifest)) live.add(blob.digest.slice(7));
  }
  for await (const item of members(join(root, "imports"), repository, metadata)) {
    const binding = SpackMaterialBindingSchema.parse(
      JSON.parse((await readMaterialMetadata(item.path)).toString("utf8")),
    );
    if (binding.repositoryId !== item.group)
      throw new SpackMaterialError(500, "Invalid import receipt");
    if (!manifests.has(`${item.group}/${binding.manifestDigest.slice(7)}.json`))
      await releaseMaterialMetadata(item.path);
  }
  let removed = 0;
  for await (const item of members(join(root, "blobs"), /^[a-f0-9]{2}$/, repository)) {
    if (!item.name.startsWith(item.group)) throw new SpackMaterialError(500, "Invalid blob shard");
    if (live.has(item.name)) continue;
    await unlink(item.path);
    removed++;
  }
  return { removed };
}
