import { expect, test } from "bun:test";
import { assertStorageCapacity, normalizeStorageCapacityError } from "./storage-capacity";

const env = { AGENT_STORAGE_RESERVE_MIB: "1", AGENT_STORAGE_RESERVE_INODES: "2" };
const observe = async () => ({ bsize: 1024n, bavail: 1025n, ffree: 3n });

test("admits the exact block and inode boundary without numeric overflow", async () => {
  await assertStorageCapacity({ path: "/stage", additionalBytes: 1024 }, { env, observe });
  await expect(
    assertStorageCapacity({ path: "/stage", additionalBytes: 1025 }, { env, observe }),
  ).rejects.toThrow("STORAGE_CAPACITY_BYTES");
  await expect(
    assertStorageCapacity(
      { path: "/stage", additionalBytes: 1024, additionalInodes: 2 },
      { env, observe },
    ),
  ).rejects.toThrow("STORAGE_CAPACITY_INODES");
  await assertStorageCapacity(
    { path: "/stage", additionalBytes: Number.MAX_SAFE_INTEGER },
    {
      env,
      observe: async () => ({ bsize: 2n ** 60n, bavail: 2n ** 60n, ffree: 3n }),
    },
  );
});

test("rejects invalid policies and dimensions before observing the filesystem", async () => {
  const observe = async () => {
    throw new Error("must not observe");
  };
  for (const additionalBytes of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(
      assertStorageCapacity({ path: "/stage", additionalBytes }, { env, observe }),
    ).rejects.toThrow("STORAGE_CAPACITY_INVALID");
  }
  for (const policy of [
    { AGENT_STORAGE_RESERVE_MIB: "-1" },
    { AGENT_STORAGE_RESERVE_MIB: "1048577" },
    { AGENT_STORAGE_RESERVE_INODES: "1.5" },
    { AGENT_STORAGE_RESERVE_INODES: "Infinity" },
  ]) {
    await expect(
      assertStorageCapacity(
        { path: "/stage", additionalBytes: 0 },
        { env: { ...env, ...policy }, observe },
      ),
    ).rejects.toThrow("STORAGE_CAPACITY_INVALID");
  }
});

test("finds the nearest existing mount and fails closed on inaccessible or unknown counters", async () => {
  const paths: string[] = [];
  await assertStorageCapacity(
    { path: "/stage/new/file", additionalBytes: 0 },
    {
      env,
      observe: async (path) => {
        paths.push(path);
        if (path !== "/stage") throw Object.assign(new Error("hidden"), { code: "ENOENT" });
        return observe();
      },
    },
  );
  expect(paths).toEqual(["/stage/new/file", "/stage/new", "/stage"]);
  for (const value of [
    { bsize: 0n, bavail: 1n, ffree: 1n },
    { bsize: 1n, bavail: -1n, ffree: 1n },
  ]) {
    await expect(
      assertStorageCapacity(
        { path: "/stage", additionalBytes: 0 },
        { env, observe: async () => value },
      ),
    ).rejects.toThrow("STORAGE_CAPACITY_UNAVAILABLE");
  }
  await expect(
    assertStorageCapacity(
      { path: "/stage", additionalBytes: 0 },
      {
        env,
        observe: async () => {
          throw new Error("secret URL");
        },
      },
    ),
  ).rejects.toThrow("STORAGE_CAPACITY_UNAVAILABLE");
});

test("full disks and quota rejection return fixed codes without OS paths", () => {
  for (const [code, expected] of [
    ["ENOSPC", "STORAGE_CAPACITY_BYTES"],
    ["EDQUOT", "STORAGE_CAPACITY_QUOTA"],
  ]) {
    expect(
      normalizeStorageCapacityError(Object.assign(new Error("secret URL and path"), { code })),
    ).toEqual(new Error(expected));
  }
  const other = new Error("interrupted");
  expect(normalizeStorageCapacityError(other)).toBe(other);
});
