import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realSpawner, type Spawner } from "../../packages/agent/src/adapters/base";
import { loadAgentConfig } from "../../packages/agent/src/config";
import {
  attestSandboxRuntimeEnvironment,
  currentSandboxProcessIdentity,
} from "../../packages/agent/src/sandbox/runtime-attestation";

assert.equal(process.env.KQ_SLURM_ROOT_ATTESTATION, "1");
assert.equal(process.getuid?.(), 0);
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const privateKeys = "/opt/kq/root-probe-keys";
await copyFile("/lab-runtime/bash.sif", "/opt/kq/root.sif");
await chmod("/opt/kq/root.sif", 0o644);
await copyFile("/lab-runtime/bash.sif", "/opt/kq/unsigned.sif");
await chmod("/opt/kq/unsigned.sif", 0o444);
async function command(args: string[], stdin?: string) {
  const result = await realSpawner.run(
    ["env", `APPTAINER_KEYSDIR=${privateKeys}`, "/usr/bin/apptainer", ...args],
    { timeoutMs: 30_000, ...(stdin ? { stdin } : {}) },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}
let fingerprint: string | undefined;
try {
  await command([
    "key",
    "newpair",
    "--bit-length",
    "2048",
    "--name",
    "KQ isolated root probe",
    "--email",
    "lab@test.invalid",
    "--comment",
    "Disposable acceptance",
    "--password=",
    "--push=false",
  ]);
  await command(["sign", "--keyidx", "0", "/opt/kq/root.sif"]);
  fingerprint = /Fingerprint:\s*([A-F0-9]{40})/.exec(
    await command(["verify", "--local", "/opt/kq/root.sif"]),
  )?.[1];
  assert(fingerprint);
  await command(["key", "export", "/opt/kq/root-public.asc"], "0\n");
  await command(["key", "import", "--global", "/opt/kq/root-public.asc"]);
} finally {
  await rm(privateKeys, { recursive: true, force: true });
}
await chmod("/opt/kq/root.sif", 0o444);
await writeFile(
  "/etc/apptainer/ecl.toml",
  `activated = true\n[[execgroup]]\ntagname = "root-probe"\nmode = "whitestrict"\ndirpath = "/opt/kq"\nkeyfp = ["${fingerprint}"]\n`,
  { mode: 0o644 },
);
await mkdir("/scratch/root-sif-attestation", { mode: 0o711 });
const digest = `sha256:${await hash("/opt/kq/root.sif")}`;
const config = loadAgentConfig({
  ...(await Bun.file("/opt/kq/self-account-config.json").json()),
  AGENT_SANDBOX_ROOT: "/scratch/root-sif-attestation",
  AGENT_SANDBOX_EXECUTION_MODE: "root-impersonation",
  AGENT_SANDBOX_ROOT_IMPERSONATION: "true",
  AGENT_SANDBOX_ATTESTATION_ACCOUNT: "scientist",
  AGENT_SANDBOX_ECL_PATH: "/etc/apptainer/ecl.toml",
  AGENT_SANDBOX_ECL_SHA256: await hash("/etc/apptainer/ecl.toml"),
  AGENT_SANDBOX_ECL_NEGATIVE_PROBE_SIF_PATH: "/opt/kq/unsigned.sif",
  AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH: undefined,
  AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256: undefined,
  AGENT_SANDBOX_SIF_PGP_FINGERPRINT: fingerprint,
  AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
    [digest]: { kind: "SIF", localPath: "/opt/kq/root.sif", signatureVerified: false },
  }),
});
let logPath: string | undefined;
const spawner: Spawner = {
  run: async (args, options) => {
    if (args.includes("sbatch"))
      logPath = /^#SBATCH --output=(.+)$/m.exec(options?.stdin ?? "")?.[1];
    const result = await realSpawner.run(args, options);
    if (result.exitCode !== 0) console.error(result.stderr);
    if (logPath && /FAILED|COMPLETED/.test(result.stdout)) {
      console.log(await readFile(logPath, "utf8").catch(() => "Native probe log unavailable"));
    }
    return result;
  },
};
const evidence = await attestSandboxRuntimeEnvironment(
  config,
  "slurm",
  spawner,
  currentSandboxProcessIdentity(),
);
console.log(JSON.stringify(evidence));
assert.deepEqual(evidence.missingRequirements, []);
assert(
  evidence.ecl &&
    evidence.seccomp &&
    evidence.cgroups &&
    evidence.networkIsolation &&
    evidence.sifSignatureVerification,
);
assert.deepEqual(evidence.runtimeCache[digest]?.attestedNodes, ["slurm"]);
console.log("REAL_ROOT_SIF_ECL_ATTESTATION_OK");
