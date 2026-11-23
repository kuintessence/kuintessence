import { constants } from "node:fs";
import { type FileHandle, mkdir, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

function checkPath(path: string) {
  if (path.split("/").includes(".kq-replicas")) throw new Error("Managed replicas are private");
}

/** Verify the object already opened, so changing an alias cannot redirect the transfer. */
export async function openTransferSource(path: string): Promise<FileHandle> {
  checkPath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    checkPath(await realpath(`/proc/self/fd/${file.fd}`));
    if (!(await file.stat()).isFile()) throw new Error("Transfer source must be a regular file");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function openTransferDirectory(path: string): Promise<FileHandle> {
  checkPath(path);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY;
  let directory = await open("/", flags);
  try {
    for (const component of resolve(path).split("/").filter(Boolean)) {
      const child = `/proc/self/fd/${directory.fd}/${component}`;
      const next = await open(child, flags).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        await mkdir(child, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "EEXIST") throw err;
        });
        return open(child, flags);
      });
      await directory.close();
      directory = next;
      checkPath(await realpath(`/proc/self/fd/${directory.fd}`));
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}
