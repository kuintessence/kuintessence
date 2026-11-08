import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readStorageFile, syncStorageDirectory, writeStorageFile } from "./storage-files";

const Bytes = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const Path = z.string().startsWith("/").max(4096);
export const CompletionReserveConfigSchema = z
  .strictObject({
    version: z.literal(1),
    volumeId: z.uuid(),
    storageId: z.uuid(),
    reserveId: z.uuid(),
    probeDirectory: Path,
    reserveDirectory: Path,
    stateFile: Path,
    bytes: Bytes.refine((v) => BigInt(v) >= 4096n && BigInt(v) <= 64n * 1024n ** 3n),
    releaseBelowBytes: Bytes,
    minAvailableAfterArmBytes: Bytes,
    intervalSec: z.number().int().min(1).max(300),
  })
  .refine(
    (v) => BigInt(v.minAvailableAfterArmBytes) > BigInt(v.releaseBelowBytes),
    "Rearming must leave more available space than the release threshold",
  );
export type CompletionReserveConfig = z.infer<typeof CompletionReserveConfigSchema>;
const StateSchema = z.strictObject({
  version: z.literal(1),
  volumeId: z.uuid(),
  storageId: z.uuid(),
  reserveId: z.uuid(),
  allocationId: z.uuid(),
  bytes: Bytes,
  phase: z.enum(["arming", "armed", "released"]),
  device: Bytes,
  inode: Bytes.nullable(),
  updatedAt: z.iso.datetime(),
});
type State = z.infer<typeof StateSchema>;
export const CompletionReserveObservationSchema = z.strictObject({
  reserveId: z.uuid(),
  state: z.enum(["arming", "armed", "released", "unavailable"]),
  allocatedBytes: Bytes.nullable(),
});
export type CompletionReserveObservation = z.infer<typeof CompletionReserveObservationSchema>;
export type ReserveCommand = "provision" | "restore" | "release" | "tick" | "status";
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function loadCompletionReserveConfig(path: string) {
  return CompletionReserveConfigSchema.parse(JSON.parse(await readStorageFile(path, 16384, true)));
}

export async function assertReserveControlDirectory(config: CompletionReserveConfig) {
  const directory = dirname(config.stateFile);
  const metadata = await lstat(directory, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
    (metadata.mode & 0o077n) !== 0n ||
    (await realpath(directory)) !== directory
  )
    throw new Error("Reserve control directory must be a canonical private owned directory");
  return metadata;
}
async function storage(config: CompletionReserveConfig) {
  const control = await assertReserveControlDirectory(config);
  const data = await stat(config.probeDirectory, { bigint: true });
  const reserve = await lstat(config.reserveDirectory, { bigint: true });
  if (
    !data.isDirectory() ||
    !reserve.isDirectory() ||
    reserve.isSymbolicLink() ||
    (await realpath(config.reserveDirectory)) !== config.reserveDirectory ||
    reserve.uid !== BigInt(process.getuid?.() ?? -1) ||
    (reserve.mode & 0o077n) !== 0n ||
    reserve.dev !== data.dev ||
    control.dev === data.dev ||
    (await readStorageFile(join(config.probeDirectory, ".kq-storage-id"), 128)).trim() !==
      config.storageId
  )
    throw new Error(
      "Reserve must share the marked data filesystem, with independent private control storage",
    );
  return { device: data.dev.toString(), directoryInode: reserve.ino.toString() };
}
async function readState(config: CompletionReserveConfig): Promise<State | undefined> {
  let raw: string;
  try {
    raw = await readStorageFile(config.stateFile, 4096, true);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const state = StateSchema.parse(JSON.parse(raw));
  if (
    state.reserveId !== config.reserveId ||
    state.volumeId !== config.volumeId ||
    state.storageId !== config.storageId ||
    state.bytes !== config.bytes
  )
    throw new Error("Reserve state does not match its configuration");
  return state;
}
const reservePath = (config: CompletionReserveConfig, state: State) =>
  join(config.reserveDirectory, `reserve-${state.allocationId}.bin`);
async function persist(config: CompletionReserveConfig, state: State) {
  await writeStorageFile(
    config.stateFile,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }),
    0o600,
  );
}
async function reserveFile(config: CompletionReserveConfig, state: State, create = false) {
  const file = await open(
    reservePath(config, state),
    (create ? constants.O_RDWR : constants.O_RDONLY) |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (create ? constants.O_CREAT : 0),
    0o600,
  );
  try {
    const metadata = await file.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
      (metadata.mode & 0o077n) !== 0n ||
      metadata.nlink !== 1n ||
      metadata.dev.toString() !== state.device ||
      (state.inode !== null && metadata.ino.toString() !== state.inode)
    )
      throw new Error("Reserve file identity or permissions changed");
    return { file, metadata };
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function inspect(
  config: CompletionReserveConfig,
  state: State | undefined,
): Promise<CompletionReserveObservation> {
  if (!state) return { reserveId: config.reserveId, state: "unavailable", allocatedBytes: null };
  if (state.phase !== "armed")
    return { reserveId: config.reserveId, state: state.phase, allocatedBytes: null };
  const { file, metadata } = await reserveFile(config, state);
  try {
    const allocated = metadata.blocks * 512n;
    if (
      state.inode === null ||
      metadata.size !== BigInt(config.bytes) ||
      allocated < BigInt(config.bytes)
    )
      throw new Error("Reserve is missing physical blocks");
    return { reserveId: config.reserveId, state: "armed", allocatedBytes: config.bytes };
  } finally {
    await file.close();
  }
}

/** Observation never arms or frees anything, including after a controller restart. */
export async function observeCompletionReserve(
  configFile: string,
  expected: {
    volumeId: string;
    storageId: string;
    reserveId: string;
    device: string;
  },
): Promise<CompletionReserveObservation> {
  try {
    const config = await loadCompletionReserveConfig(configFile);
    const volume = await storage(config);
    if (
      config.volumeId !== expected.volumeId ||
      config.storageId !== expected.storageId ||
      config.reserveId !== expected.reserveId ||
      volume.device !== expected.device
    )
      throw new Error("Unexpected reserve identity");
    const state = await readState(config);
    if (state && state.device !== volume.device) throw new Error("Reserve backing device changed");
    const observation = await inspect(config, state);
    const current = await readState(config);
    if (
      JSON.stringify(current) !== JSON.stringify(state) ||
      (await storage(config)).directoryInode !== volume.directoryInode
    )
      throw new Error("Reserve changed during observation");
    return observation;
  } catch {
    return { reserveId: expected.reserveId, state: "unavailable", allocatedBytes: null };
  }
}

/** Called under the controller's OS flock; it only touches the allocation named in its durable journal. */
export async function changeCompletionReserve(
  config: CompletionReserveConfig,
  command: ReserveCommand,
) {
  const volume = await storage(config);
  let state = await readState(config);
  if (state && state.device !== volume.device) throw new Error("Reserve backing device changed");
  const release = async (original: State) => {
    const released: State = { ...original, phase: "released" };
    // Persist the admission latch before returning any blocks to the data filesystem.
    if (original.phase !== "released") await persist(config, released);
    let owned: Awaited<ReturnType<typeof reserveFile>>;
    try {
      owned = await reserveFile(config, released);
    } catch (error) {
      if (missing(error)) return released;
      throw error;
    }
    try {
      const current = await lstat(reservePath(config, released), { bigint: true });
      if (current.dev !== owned.metadata.dev || current.ino !== owned.metadata.ino)
        throw new Error("Reserve path changed before release");
      await rm(reservePath(config, released));
      await syncStorageDirectory(config.reserveDirectory);
    } finally {
      await owned.file.close();
    }
    return released;
  };
  if (command === "status") return inspect(config, state);
  if (command === "tick") {
    if (!state) return inspect(config, state);
    if (state.phase === "released") state = await release(state);
    else if (state.phase === "armed") {
      await inspect(config, state);
      const capacity = await statfs(config.probeDirectory, { bigint: true });
      if (capacity.bavail * capacity.bsize <= BigInt(config.releaseBelowBytes))
        state = await release(state);
    }
    return inspect(config, state);
  }
  if (command === "release") {
    if (!state) throw new Error("No provisioned reserve to release");
    return inspect(config, await release(state));
  }
  if (state?.phase === "armed") return inspect(config, state);
  if (state?.phase === "released") {
    if (command !== "restore")
      throw new Error("Reserve was released; restore explicitly after recovery");
    await release(state);
    state = undefined;
  }
  if (!state) {
    state = {
      version: 1,
      volumeId: config.volumeId,
      storageId: config.storageId,
      reserveId: config.reserveId,
      allocationId: randomUUID(),
      bytes: config.bytes,
      phase: "arming",
      device: volume.device,
      inode: null,
      updatedAt: new Date().toISOString(),
    };
    await persist(config, state);
  }
  const { file, metadata } = await reserveFile(config, state, true);
  try {
    const capacity = await statfs(config.probeDirectory, { bigint: true });
    if (
      capacity.bavail * capacity.bsize + metadata.blocks * 512n <
      BigInt(config.bytes) + BigInt(config.minAvailableAfterArmBytes)
    )
      throw new Error("Insufficient room to restore the reserve and admission margin");
    const child = Bun.spawn(
      ["fallocate", "--length", config.bytes, "--", `/proc/${process.pid}/fd/${file.fd}`],
      { stdout: "ignore", stderr: "pipe" },
    );
    const stderr = new Response(child.stderr).text();
    const exitCode = await child.exited;
    await stderr;
    if (exitCode !== 0) throw new Error("Physical reserve allocation failed");
    await file.sync();
    const after = await file.stat({ bigint: true });
    if (after.size !== BigInt(config.bytes) || after.blocks * 512n < BigInt(config.bytes))
      throw new Error("Filesystem did not allocate the requested physical blocks");
    if ((await storage(config)).directoryInode !== volume.directoryInode)
      throw new Error("Reserve directory changed during allocation");
    await syncStorageDirectory(config.reserveDirectory);
    state = { ...state, phase: "armed", inode: after.ino.toString() };
    await persist(config, state);
  } finally {
    await file.close();
  }
  return inspect(config, state);
}
