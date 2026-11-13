import { expect, test } from "bun:test";
import { validateComputeInventory, validateSpackProfile } from "./compatibility";

const request = {
  architecture: "x86_64" as const,
  minGlibc: "2.28",
  cpuFlags: ["sse4_2", "ssse3", "popcnt"],
  buildTarget: "bun-linux-x64-baseline" as const,
};
const inventory = {
  schemaVersion: 1,
  kind: "kq-compute-inventory",
  ok: true,
  sum: 4950,
  os: { ID: "rocky", VERSION_ID: "9.4" },
  arch: "x86_64",
  libc: { name: "glibc", version: "2.34" },
  cpu: { supportedFlags: ["sse4_2", "ssse3", "popcnt"] },
  python: { status: "passed", version: "3.11.9", module: "python/3.11" },
  compiler: { status: "not-tested" },
  mpi: { status: "not-tested" },
  shared: { workingDirectoryInsideShared: true, writeReadDelete: "passed" },
};

test("inventory validates observed compatibility without inventing optional tool success", () => {
  expect(validateComputeInventory(inventory, request).mpi.status).toBe("not-tested");
  expect(() => validateComputeInventory(inventory, { ...request, minGlibc: "2.35" })).toThrow(
    "glibc",
  );
  expect(() =>
    validateComputeInventory(inventory, { ...request, architecture: "aarch64" }),
  ).toThrow("architecture");
  expect(() => validateComputeInventory(inventory, { ...request, cpuFlags: [] })).toThrow(
    "declare",
  );
  expect(() =>
    validateComputeInventory(inventory, {
      ...request,
      cpuFlags: [...request.cpuFlags, "avx2"],
      buildTarget: "bun-linux-x64",
    }),
  ).toThrow();
  expect(() =>
    validateComputeInventory({ ...inventory, compiler: { status: "passed" } }, request),
  ).toThrow();
});

test.each([
  { schemaVersion: 2 },
  { kind: "other" },
  { ok: false },
  { libc: { name: "musl", version: "1.2" } },
  { os: {} },
  { cpu: { supportedFlags: ["sse4_2"] } },
  { compiler: { status: "failed" } },
  { mpi: { status: "failed", command: "mpirun" } },
  { shared: { workingDirectoryInsideShared: false, writeReadDelete: "passed" } },
  { shared: { workingDirectoryInsideShared: true, writeReadDelete: "failed" } },
  { hostname: "unnecessary-private-name" },
])("rejects unproven inventory fields %j", (change) => {
  expect(() => validateComputeInventory({ ...inventory, ...change }, request)).toThrow();
});

test("inventory accepts proven arm64 and actual successful tool versions", () => {
  const observed = {
    ...inventory,
    arch: "aarch64",
    cpu: { supportedFlags: ["asimd", "atomics"] },
    compiler: { status: "passed", command: "gcc", module: "gcc/12", version: "12.3.0" },
    mpi: { status: "passed", command: "mpirun", module: "openmpi/4", version: "4.1.6" },
  };
  expect(
    validateComputeInventory(observed, {
      architecture: "aarch64",
      minGlibc: "2.28",
      cpuFlags: ["asimd"],
      buildTarget: "bun-linux-arm64",
    }).arch,
  ).toBe("aarch64");
  expect(() =>
    validateComputeInventory(
      { ...observed, mpi: { ...observed.mpi, command: "gcc" } },
      {
        architecture: "aarch64",
        minGlibc: "2.28",
        cpuFlags: ["asimd"],
        buildTarget: "bun-linux-arm64",
      },
    ),
  ).toThrow("command");
});

const profile = {
  version: 1,
  storeRoot: "/shared/site/spack",
  target: "linux-rocky9-haswell",
  runtimeSifSha256: "a".repeat(64),
  osReleaseSha256: "b".repeat(64),
  hostFiles: [{ path: "/etc/os-release", sha256: "c".repeat(64) }],
  externals: [],
  sharedStoreConfirmed: true,
  compatibleComputeNodesConfirmed: true,
  trustedRecipesConfirmed: true,
  quotaEnforcedBySite: true,
};

test("Spack profile binds trusted runtime, known target family and existing explicit confirmations", () => {
  expect(validateSpackProfile(profile, "x86_64", "a".repeat(64)).target).toBe(profile.target);
  expect(
    validateSpackProfile({ ...profile, target: "linux-rocky9-zen2" }, "x86_64", "a".repeat(64))
      .target,
  ).toBe("linux-rocky9-zen2");
  expect(() => validateSpackProfile(profile, "aarch64", "a".repeat(64))).toThrow("architecture");
  expect(() => validateSpackProfile(profile, "x86_64", "d".repeat(64))).toThrow("digest");
  expect(() =>
    validateSpackProfile(
      { ...profile, target: "linux-rocky9-futurecpu" },
      "x86_64",
      "a".repeat(64),
    ),
  ).toThrow("archspec");
  for (const key of [
    "sharedStoreConfirmed",
    "compatibleComputeNodesConfirmed",
    "trustedRecipesConfirmed",
    "quotaEnforcedBySite",
  ]) {
    expect(() =>
      validateSpackProfile({ ...profile, [key]: false }, "x86_64", "a".repeat(64)),
    ).toThrow();
  }
});

test("optional managed capability observations preserve unknown state before a runtime is published", () => {
  const managedCapabilities = {
    observedAt: 100000,
    partition: "cn",
    memoryMib: 32768,
    abi: { status: "passed" },
    userManager: { status: "failed" },
    isolation: { status: "not-tested" },
    scratch: { status: "not-tested" },
  };
  expect(
    validateComputeInventory({ ...inventory, managedCapabilities }, request).managedCapabilities
      ?.isolation.status,
  ).toBe("not-tested");
  for (const change of [
    { memoryMib: 1048577 },
    { memoryMib: 1.5 },
    { isolation: { status: "available" } },
    { runtimeSifSha256: "wrong" },
    { hostname: "private" },
  ]) {
    expect(() =>
      validateComputeInventory(
        { ...inventory, managedCapabilities: { ...managedCapabilities, ...change } },
        request,
      ),
    ).toThrow();
  }
});
