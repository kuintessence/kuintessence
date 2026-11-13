import { afterEach, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CompletionReserveConfigSchema,
  changeCompletionReserve,
  observeCompletionReserve,
} from "./storage-reserve";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const data = await mkdtemp("/dev/shm/kq-reserve-"),
    control = await mkdtemp(join(tmpdir(), "kq-reserve-"));
  cleanup.push(data, control);
  const reserveDirectory = join(data, "reserve");
  await mkdir(reserveDirectory, { mode: 0o700 });
  const config = CompletionReserveConfigSchema.parse({
    version: 1,
    volumeId: crypto.randomUUID(),
    storageId: crypto.randomUUID(),
    reserveId: crypto.randomUUID(),
    probeDirectory: data,
    reserveDirectory,
    stateFile: join(control, "state.json"),
    bytes: "1048576",
    releaseBelowBytes: "0",
    minAvailableAfterArmBytes: "1048576",
    intervalSec: 1,
  });
  await writeFile(join(data, ".kq-storage-id"), config.storageId);
  const configFile = join(control, "config.json");
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const expected = { ...config, device: (await stat(data, { bigint: true })).dev.toString() };
  const observation = () => observeCompletionReserve(configFile, expected);
  const allocation = async () => {
    const state = JSON.parse(await readFile(config.stateFile, "utf8"));
    return join(config.reserveDirectory, `reserve-${state.allocationId}.bin`);
  };
  return { config, configFile, data, control, observation, allocation };
}

test("completion reserve allocates physical blocks and its release latch survives reconstruction until explicit restore", async () => {
  const f = await fixture();
  expect((await f.observation()).state).toBe("unavailable");
  expect((await changeCompletionReserve(f.config, "provision")).state).toBe("armed");
  const first = await f.allocation();
  expect((await stat(first)).blocks * 512).toBeGreaterThanOrEqual(Number(f.config.bytes));
  expect((await f.observation()).allocatedBytes).toBe(f.config.bytes);
  await changeCompletionReserve({ ...f.config, releaseBelowBytes: "999999999999" }, "tick");
  expect((await f.observation()).state).toBe("released");
  expect(await readdir(f.config.reserveDirectory)).toHaveLength(0);
  expect((await changeCompletionReserve(f.config, "tick")).state).toBe("released");
  await expect(changeCompletionReserve(f.config, "provision")).rejects.toThrow(
    "restore explicitly",
  );
  await changeCompletionReserve(f.config, "restore");
  expect((await f.observation()).state).toBe("armed");
  expect(await f.allocation()).not.toBe(first);
  await changeCompletionReserve(f.config, "provision");
  expect(await readdir(f.config.reserveDirectory)).toHaveLength(1);
});

test("completion reserve rejects wrong volume, shared control filesystem and a missing block allocation", async () => {
  const f = await fixture();
  await expect(
    changeCompletionReserve(
      { ...f.config, stateFile: join(f.config.reserveDirectory, "state") },
      "provision",
    ),
  ).rejects.toThrow("independent");
  await writeFile(join(f.data, ".kq-storage-id"), crypto.randomUUID());
  await expect(changeCompletionReserve(f.config, "provision")).rejects.toThrow(
    "marked data filesystem",
  );
  await writeFile(join(f.data, ".kq-storage-id"), f.config.storageId);
  await changeCompletionReserve(f.config, "provision");
  const file = await open(await f.allocation(), "r+");
  try {
    await file.truncate(0);
    await file.truncate(Number(f.config.bytes));
  } finally {
    await file.close();
  }
  expect((await f.observation()).state).toBe("unavailable");
  await expect(changeCompletionReserve(f.config, "tick")).rejects.toThrow("physical blocks");
});

test("completion reserve never removes a substituted symlink or hard-linked file", async () => {
  const f = await fixture();
  await changeCompletionReserve(f.config, "provision");
  const path = await f.allocation(),
    other = join(f.data, "retained-data");
  await link(path, other);
  await expect(changeCompletionReserve(f.config, "release")).rejects.toThrow(
    "identity or permissions",
  );
  expect((await f.observation()).state).toBe("released");
  expect((await stat(other)).size).toBe(Number(f.config.bytes));
  await rm(path);
  await symlink(other, path);
  await expect(changeCompletionReserve(f.config, "release")).rejects.toThrow();
  expect((await stat(other)).size).toBe(Number(f.config.bytes));
});

test("completion reserve resumes interrupted allocation and finishes a latched release without rearming", async () => {
  const f = await fixture();
  await changeCompletionReserve(f.config, "provision");
  const path = await f.allocation();
  const state = JSON.parse(await readFile(f.config.stateFile, "utf8"));
  await writeFile(f.config.stateFile, JSON.stringify({ ...state, phase: "arming", inode: null }));
  const file = await open(path, "r+");
  try {
    await file.truncate(4096);
  } finally {
    await file.close();
  }
  expect((await f.observation()).state).toBe("arming");
  await changeCompletionReserve(f.config, "provision");
  expect(await f.allocation()).toBe(path);
  await writeFile(f.config.stateFile, JSON.stringify({ ...state, phase: "released" }));
  await changeCompletionReserve(f.config, "tick");
  expect(await readdir(f.config.reserveDirectory)).toHaveLength(0);
  expect((await f.observation()).state).toBe("released");
});

test("reserve CLI serializes concurrent provisioners and does not steal a live OS lock", async () => {
  const f = await fixture();
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../../../scripts/federation-storage-reserve.ts")],
    target: "bun",
    outdir: f.control,
  });
  expect(bundle.success).toBe(true);
  const cli = bundle.outputs[0]?.path;
  if (!cli) throw new Error("Missing bundled reserve CLI");
  const run = async (command: string) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, f.configFile, command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(child.stdout).text(),
      errors = new Response(child.stderr).text();
    const code = await child.exited;
    return { code, output: await output, errors: await errors };
  };
  const results = await Promise.all([run("provision"), run("provision"), run("provision")]);
  expect(results.some((r) => r.code === 0)).toBe(true);
  expect(results.every((r) => r.code === 0 || r.code === 75)).toBe(true);
  expect(await readdir(f.config.reserveDirectory)).toHaveLength(1);
  const holder = Bun.spawn(
    [
      "flock",
      "--no-fork",
      `${f.config.stateFile}.lock`,
      process.execPath,
      "-e",
      'console.log("locked"); await Bun.sleep(10000)',
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = holder.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    expect((await run("release")).code).toBe(75);
    expect((await f.observation()).state).toBe("armed");
  } finally {
    reader.releaseLock();
    holder.kill();
    await holder.exited;
  }
  expect((await run("release")).code).toBe(0);
  expect((await run("status")).output).toContain('"released"');
});

test("reserve state corruption cannot authorize deletion or silent recreation", async () => {
  const f = await fixture();
  await changeCompletionReserve(f.config, "provision");
  const path = await f.allocation();
  await writeFile(f.config.stateFile, "corrupt state");
  expect((await f.observation()).state).toBe("unavailable");
  await expect(changeCompletionReserve(f.config, "release")).rejects.toThrow();
  await expect(changeCompletionReserve(f.config, "provision")).rejects.toThrow();
  expect((await stat(path)).blocks * 512).toBeGreaterThanOrEqual(Number(f.config.bytes));
});
