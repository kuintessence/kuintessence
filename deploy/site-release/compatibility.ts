import { z } from "zod";
import { SpackInstallSiteProfileSchema } from "../../packages/agent/src/spack/install-contract";

const version = z
  .string()
  .regex(/^\d+\.\d+(?:\.\d+){0,2}$/)
  .max(40);
const moduleName = z.string().min(1).max(200);
const observedTool = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not-tested") }),
  z.strictObject({ status: z.literal("failed"), command: z.string().max(32).optional() }),
  z.strictObject({
    status: z.literal("passed"),
    command: z.enum(["cc", "gcc", "clang", "icx", "icc", "mpirun", "mpiexec"]),
    module: moduleName,
    version,
  }),
]);

const capabilityStatus = z.strictObject({ status: z.enum(["passed", "failed", "not-tested"]) });
const managedCapabilities = z.strictObject({
  observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  partition: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_.-]*$/),
  memoryMib: z.number().int().min(1024).max(1048576).nullable(),
  runtimeSifSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  abi: capabilityStatus,
  userManager: capabilityStatus,
  isolation: capabilityStatus,
  scratch: z.strictObject({
    status: z.enum(["passed", "failed", "not-tested"]),
    availableMib: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    requiredMib: z.number().int().min(1).max(1048576).optional(),
  }),
});

export const computeInventorySchema = z.strictObject({
  managedCapabilities: managedCapabilities.optional(),
  schemaVersion: z.literal(1),
  kind: z.literal("kq-compute-inventory"),
  ok: z.literal(true),
  sum: z.literal(4950),
  os: z.strictObject({
    ID: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
    VERSION_ID: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
  }),
  arch: z.enum(["x86_64", "aarch64"]),
  libc: z.strictObject({ name: z.literal("glibc"), version }),
  cpu: z.strictObject({ supportedFlags: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(128) }),
  python: z.strictObject({ status: z.literal("passed"), version, module: moduleName }),
  compiler: observedTool,
  mpi: observedTool,
  shared: z.strictObject({
    workingDirectoryInsideShared: z.literal(true),
    writeReadDelete: z.literal("passed"),
  }),
});

interface CompatibilityRequest {
  architecture: "x86_64" | "aarch64";
  minGlibc: string;
  cpuFlags: string[];
  buildTarget: "bun-linux-x64" | "bun-linux-x64-baseline" | "bun-linux-arm64";
}

export function validateComputeInventory(value: unknown, request: CompatibilityRequest) {
  const inventory = computeInventorySchema.parse(value);
  if (inventory.arch !== request.architecture)
    throw new Error("Inventory architecture differs from release");
  if (inventory.compiler.status === "failed" || inventory.mpi.status === "failed")
    throw new Error("Selected inventory compiler/MPI probe failed");
  if (
    (inventory.compiler.status === "passed" &&
      !["cc", "gcc", "clang", "icx", "icc"].includes(inventory.compiler.command)) ||
    (inventory.mpi.status === "passed" && !["mpirun", "mpiexec"].includes(inventory.mpi.command))
  )
    throw new Error("Inventory tool command does not match compiler/MPI probe");
  const observed = inventory.libc.version.split(".").map(BigInt);
  const minimum = request.minGlibc.split(".").map(BigInt);
  if (
    (minimum[0] ?? 0n) > (observed[0] ?? 0n) ||
    ((minimum[0] ?? 0n) === (observed[0] ?? 0n) && (minimum[1] ?? 0n) > (observed[1] ?? 0n))
  )
    throw new Error("Release minGlibc exceeds observed glibc");
  const baseline = ["sse4_2", "ssse3", "popcnt"];
  const targetFlags =
    request.buildTarget === "bun-linux-arm64"
      ? ["asimd"]
      : request.buildTarget === "bun-linux-x64"
        ? [...baseline, "avx", "avx2"]
        : baseline;
  if (targetFlags.some((flag) => !request.cpuFlags.includes(flag)))
    throw new Error("Release cpuFlags must declare Bun target requirements");
  if (
    [...request.cpuFlags, ...targetFlags].some(
      (flag) => !inventory.cpu.supportedFlags.includes(flag),
    )
  )
    throw new Error("Inventory lacks declared or Bun target CPU flags");
  return inventory;
}

export function validateSpackProfile(
  value: unknown,
  architecture: CompatibilityRequest["architecture"],
  runtimeSifSha256: string,
) {
  const profile = SpackInstallSiteProfileSchema.parse(value);
  if (profile.runtimeSifSha256 !== runtimeSifSha256)
    throw new Error("Site profile runtime SIF digest differs from trusted input");
  const target = profile.target.split("-").at(-1) ?? "";
  const x64 = new Set([
    "x86_64",
    "x86_64_v2",
    "x86_64_v3",
    "x86_64_v4",
    "nocona",
    "core2",
    "nehalem",
    "westmere",
    "sandybridge",
    "ivybridge",
    "haswell",
    "broadwell",
    "skylake",
    "skylake_avx512",
    "cannonlake",
    "cascadelake",
    "icelake",
    "icelake_client",
    "icelake_server",
    "sapphirerapids",
    "zen",
    "zen2",
    "zen3",
    "zen4",
    "zen5",
    "bulldozer",
    "piledriver",
    "steamroller",
    "excavator",
  ]);
  const arm64 = new Set([
    "aarch64",
    "armv8.1a",
    "armv8.2a",
    "armv8.3a",
    "armv8.4a",
    "armv8.5a",
    "armv8.6a",
    "armv9.0a",
    "a64fx",
    "thunderx",
    "thunderx2",
    "neoverse_n1",
    "neoverse_n2",
    "neoverse_v1",
    "neoverse_v2",
    "graviton",
    "graviton2",
    "graviton3",
    "graviton4",
  ]);
  const family = x64.has(target) ? "x86_64" : arm64.has(target) ? "aarch64" : undefined;
  if (!family)
    throw new Error(
      "Unknown site profile target architecture; explicit archspec verification and mapping are required",
    );
  if (family !== architecture)
    throw new Error("Site profile target architecture differs from release");
  return profile;
}
