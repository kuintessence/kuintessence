import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createPgDb } from "./pg";
import { SpackMaterialRollout } from "./pg/spack-material-rollout";
import { parseSpackMaterialRolloutCommand } from "./pg/spack-material-rollout-input";

const MAX_COMMAND_BYTES = 2 * 1024 ** 2;

export async function readRolloutCommand(path: string) {
  if (!isAbsolute(path)) throw new Error("An absolute command file is required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_COMMAND_BYTES) {
      throw new Error("Invalid rollout command file");
    }
    const buffer = Buffer.alloc(MAX_COMMAND_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > MAX_COMMAND_BYTES) throw new Error("Rollout command exceeds the byte limit");
    return parseSpackMaterialRolloutCommand(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    await file.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || !process.argv[2]) {
    throw new Error("Expected one command file");
  }
  const command = await readRolloutCommand(process.argv[2]);
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("Database configuration is required");
  const protocol = new URL(connection).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("Invalid database configuration");
  }
  const db = createPgDb(connection, { max: 1, idle_timeout: 5 });
  try {
    const result = await new SpackMaterialRollout(db).execute(command);
    // Only non-secret status and counts; never serialize the request or DB errors.
    console.log(JSON.stringify(result));
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const deadline = setTimeout(() => {
    console.error("Spack rollout: code=TIMEOUT");
    process.exit(1);
  }, 60_000);
  try {
    await main();
  } catch {
    console.error("Spack rollout: code=COMMAND_FAILED");
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}
