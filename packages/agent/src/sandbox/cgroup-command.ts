import { type SandboxComputeResources, SandboxComputeResourcesSchema } from "@kuintessence/shared";
import { z } from "zod";
import { shellQuote } from "../adapters/base";

export const SandboxCgroupCheckSchema = z.object({
  path: z
    .string()
    .regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/)
    .refine((path) => !path.split("/").some((part) => part === "." || part === "..")),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type SandboxCgroupCheck = z.infer<typeof SandboxCgroupCheckSchema>;

// Load the verified bytes once, so a pathname replacement cannot change the
// checker between verification and execution on the selected compute node.
const pinnedLoader = `import hashlib, pathlib, stat, sys
try:
    path = pathlib.Path(sys.argv[1])
    expected = sys.argv[2]
    if str(path.resolve(strict=True)) != str(path):
        raise ValueError('noncanonical checker path')
    for entry in [path, *path.parents]:
        info = entry.lstat()
        valid_type = stat.S_ISREG(info.st_mode) if entry == path else stat.S_ISDIR(info.st_mode)
        if not valid_type or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('checker path is not root-protected')
    source = path.read_bytes()
    if hashlib.sha256(source).hexdigest() != expected:
        raise ValueError('checker SHA-256 mismatch')
except (ValueError, OSError) as error:
    print('kq-sandbox-cgroup-check: ' + str(error), file=sys.stderr)
    sys.exit(126)
sys.argv = [str(path), *sys.argv[3:]]
exec(compile(source, str(path), 'exec'), {'__name__': '__main__', '__file__': str(path)})`;

/** SelfAccount is Slurm-only; the native ID must also match the kernel cgroup. */
export function buildSelfAccountCgroupCommand(
  checker: SandboxCgroupCheck | undefined,
  resources: SandboxComputeResources | undefined,
): string {
  return buildHpcCgroupCommand(checker, resources, "slurm");
}

export function buildHpcCgroupCommand(
  checker: SandboxCgroupCheck | undefined,
  resources: SandboxComputeResources | undefined,
  scheduler: "slurm" | "pbs-pro" | "torque",
): string {
  if (!["slurm", "pbs-pro", "torque"].includes(scheduler))
    throw new Error("Unsupported cgroup scheduler");
  const checked = SandboxCgroupCheckSchema.parse(checker);
  const { cpus, memoryMb } = SandboxComputeResourcesSchema.parse(resources);
  const argv = [
    "/usr/bin/python3",
    "-I",
    "-c",
    pinnedLoader,
    checked.path,
    checked.sha256,
    "--scheduler",
    scheduler,
    "--cpus",
    String(cpus),
    "--memory-mb",
    String(memoryMb),
  ];
  const jobId = scheduler === "slurm" ? "SLURM_JOB_ID" : "PBS_JOBID";
  return `${argv.map(shellQuote).join(" ")} --job-id "\${${jobId}:?native ${scheduler === "slurm" ? "Slurm" : "PBS"} job ID required}"`;
}
