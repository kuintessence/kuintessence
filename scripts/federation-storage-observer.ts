import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  loadStorageObserverKey,
  observeStorage,
  readStorageFile,
  StorageObserverConfigSchema,
  signStorageObservation,
} from "../packages/server/src/federation/storage-capacity";
import { writeStorageFile } from "../packages/server/src/federation/storage-files";

/** Publish only our signed report; no deletion, reservation or modification of storage data. */
export async function runStorageObserver(configFile: string, once = false) {
  const config = StorageObserverConfigSchema.parse(
    JSON.parse(await readStorageFile(configFile, 16384, true)),
  );
  const key = await loadStorageObserverKey(config.signingKeyFile);
  const parent = dirname(config.reportFile);
  const directory = await lstat(parent);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o002) !== 0
  )
    throw new Error(
      "Storage report directory must be owned by the observer and not world-writable",
    );
  do {
    const report = signStorageObservation(await observeStorage(config), key);
    await writeStorageFile(config.reportFile, report, 0o640);
    if (!once) await Bun.sleep(config.intervalSec * 1000);
  } while (!once);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 2 || (args[1] && args[1] !== "--once"))
    throw new Error(
      "Usage: bun scripts/federation-storage-observer.ts /absolute/observer.json [--once]",
    );
  await runStorageObserver(args[0], args[1] === "--once");
}
