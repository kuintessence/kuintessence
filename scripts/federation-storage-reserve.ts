import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  assertReserveControlDirectory,
  changeCompletionReserve,
  loadCompletionReserveConfig,
  type ReserveCommand,
} from "../packages/server/src/federation/storage-reserve";

/** flock owns crash-safe exclusion; no PID files or guessed stale-lock expiry. */
async function locked(configFile: string, command: ReserveCommand, quiet = false) {
  const config = await loadCompletionReserveConfig(configFile);
  await assertReserveControlDirectory(config);
  const lockFile = `${config.stateFile}.lock`;
  const file = await open(
    lockFile,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.nlink !== 1
    )
      throw new Error("Reserve lock must be a private owned regular file");
  } finally {
    await file.close();
  }
  const child = Bun.spawn(
    [
      "flock",
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      "--no-fork",
      lockFile,
      process.execPath,
      "--no-env-file",
      import.meta.filename,
      configFile,
      command,
      "--locked",
    ],
    { stdout: quiet ? "ignore" : "inherit", stderr: "inherit" },
  );
  return child.exited;
}

if (import.meta.main) {
  const [configFile, command, internal, ...extra] = process.argv.slice(2);
  const commands = ["provision", "restore", "release", "tick", "status"] as const;
  if (
    !configFile ||
    !command ||
    extra.length ||
    (internal && internal !== "--locked") ||
    (!commands.some((value) => value === command) && command !== "watch") ||
    (command === "watch" && internal)
  )
    throw new Error(
      "Usage: bun scripts/federation-storage-reserve.ts /absolute/reserve.json provision|restore|release|tick|status|watch",
    );
  if (command === "watch") {
    const config = await loadCompletionReserveConfig(configFile);
    while (true) {
      const result = await locked(configFile, "tick", true);
      if (result !== 0 && result !== 75)
        throw new Error("Reserve controller could not inspect storage");
      await Bun.sleep(config.intervalSec * 1000);
    }
  } else if (internal) {
    const result = await changeCompletionReserve(
      await loadCompletionReserveConfig(configFile),
      command as ReserveCommand,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else process.exitCode = await locked(configFile, command as ReserveCommand);
}
