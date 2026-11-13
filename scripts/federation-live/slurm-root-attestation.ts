import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { canonicalJson, type SandboxUnsignedManifest } from "@kuintessence/shared";
import { type JobSpec, realSpawner, type Spawner } from "../../packages/agent/src/adapters/base";
import { SlurmAdapter } from "../../packages/agent/src/adapters/slurm";
import { loadAgentConfig } from "../../packages/agent/src/config";
import { buildSandboxCapability } from "../../packages/agent/src/sandbox/capability";
import { LocalSandboxAccountVerifier } from "../../packages/agent/src/sandbox/local-account-verifier";
import { SandboxManifestVerifier } from "../../packages/agent/src/sandbox/manifest-verifier";
import {
  attestSandboxRuntimeEnvironment,
  currentSandboxProcessIdentity,
} from "../../packages/agent/src/sandbox/runtime-attestation";
import { SandboxStager, validateSandboxOutputs } from "../../packages/agent/src/sandbox/stager";

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
const keys = generateKeyPairSync("ed25519");
const config = loadAgentConfig({
  ...(await Bun.file("/opt/kq/self-account-config.json").json()),
  AGENT_SANDBOX_ROOT: "/scratch/root-sif-attestation",
  AGENT_SANDBOX_PUBLIC_KEYS_JSON: JSON.stringify({
    lab: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }),
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

const identity = currentSandboxProcessIdentity();
assert(identity?.uid === 0);
const runtime = evidence.runtimeCache[digest];
assert(runtime);
const capability = buildSandboxCapability(config, "slurm", identity, evidence);
assert.equal(capability.readiness, "ready", JSON.stringify(capability.missingRequirements));
assert.equal(capability.runtimeCache[0]?.runtimeAttestationId, runtime.runtimeAttestationId);
const contentHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const consumed = new Set<string>();
const verifier = new SandboxManifestVerifier({
  publicKeys: { lab: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
  runtimeCache: evidence.runtimeCache,
  nonceConsumer: {
    consume: async (nonce) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  },
  accountVerifier: new LocalSandboxAccountVerifier(realSpawner),
  adapterType: "slurm",
  localExecutionMode: "RootImpersonation",
  processIdentity: identity,
  rootImpersonationEnabled: true,
  sharedServiceAllowed: false,
});
const input = "isolated-root-signed-input\n";
const content = `set -euo pipefail
[[ $(/usr/bin/cat /kq/inputs/input) == isolated-root-signed-input ]]
if (printf changed > /kq/inputs/input) 2>/dev/null; then exit 31; fi
status=$(/usr/bin/cat /proc/self/status)
[[ $status == *$'Seccomp:\\t2'* && $status == *$'NoNewPrivs:\\t1'* ]]
rc=0
error=$({ exec 3<>/dev/tcp/127.0.0.1/1; } 2>&1) || rc=$?
[[ $rc == 1 && $error == *'Operation not permitted'* ]]
printf '{"ok":true}\\n' >/kq/outputs/result
printf 'REAL_ROOT_EXECUTED\\n'
`;
const unsigned: SandboxUnsignedManifest = {
  jobId: crypto.randomUUID(),
  script: {
    language: "bash",
    entrypoint: "main.sh",
    contentBase64: Buffer.from(content).toString("base64"),
    sha256: contentHash(content),
    bundleSha256: contentHash(
      canonicalJson({ language: "bash", entrypoint: "main.sh", sha256: contentHash(content) }),
    ),
  },
  runtime: { profileId: crypto.randomUUID(), kind: "SIF", digest },
  executionMode: "RootImpersonation",
  runtimeAttestationId: runtime.runtimeAttestationId,
  identity: {
    mode: "MappedAccount",
    backend: "Unix",
    accountId: crypto.randomUUID(),
    username: "scientist",
    uid: 24001,
    gid: 24001,
    schedulerAccount: null,
    allowedQueues: ["sandbox"],
  },
  mounts: [
    {
      descriptor: "input",
      ioType: "Text",
      mode: "ReadOnly",
      relativePath: "inputs/input.txt",
      containerPath: "/kq/inputs/input",
      expectedSha256: contentHash(input),
      inlineContentBase64: Buffer.from(input).toString("base64"),
      batchEntries: [],
      sizeLimitBytes: 1024,
      required: true,
    },
    {
      descriptor: "result",
      ioType: "JSON",
      mode: "WriteOnly",
      relativePath: "outputs/result.json",
      containerPath: "/kq/outputs/result",
      expectedSha256: null,
      batchEntries: [],
      sizeLimitBytes: 1024,
      required: true,
    },
  ],
  resources: { cpus: 1, memoryMb: 128 },
  limits: { pids: 128, outputBytes: 16384, logBytes: 16384 },
  networkDisabled: true,
};
const payload = canonicalJson(unsigned);
const manifest = {
  ...unsigned,
  envelope: {
    keyId: "lab",
    nonce: crypto.randomUUID(),
    issuedAtUnixMs: Date.now(),
    expiresAtUnixMs: Date.now() + 60000,
    manifestSha256: contentHash(payload),
    signatureBase64: sign(null, Buffer.from(payload), keys.privateKey).toString("base64"),
  },
};
const verified = await verifier.verify(unsigned.jobId, manifest);
await assert.rejects(verifier.verify(unsigned.jobId, manifest), /nonce/i);
const staged = await new SandboxStager({
  root: config.AGENT_SANDBOX_ROOT,
  processIdentity: identity,
}).prepare(verified);
const spec: JobSpec = {
  jobId: unsigned.jobId,
  name: "root-signed-lab",
  command: "false",
  cpus: 1,
  memoryMb: 128,
  gpus: 0,
  wallTimeSec: 60,
  workingDir: staged.workingDir,
  envVars: {},
  sandbox: staged.sandbox,
  queueName: "sandbox",
};
const adapter = new SlurmAdapter("24.11.5", { terminalStatusBackend: "scontrol" });
assert.throws(() => adapter.buildSubmitScript({ ...spec, queueName: "unattested" }));
assert.throws(() => adapter.buildSubmitScript({ ...spec, memoryMb: 256 }));
const { schedulerJobId } = await adapter.submit(spec);
try {
  let status = await adapter.status(schedulerJobId);
  for (
    let attempt = 0;
    attempt < 120 && (status.status === "running" || status.status === "queued");
    attempt++
  ) {
    await Bun.sleep(500);
    status = await adapter.status(schedulerJobId);
  }
  const output = await readFile(
    `${staged.workingDir}/.scheduler-logs/kq-${spec.jobId}.out`,
    "utf8",
  );
  await writeFile("/scratch/job/root-signed-output.log", output);
  assert.equal(status.status, "completed", `${JSON.stringify(status)}\n${output}`);
  assert(output.includes("REAL_ROOT_EXECUTED"), output);
  await validateSandboxOutputs(staged.sandbox);
  const result = staged.sandbox.mounts.find((mount) => mount.descriptor === "result");
  assert(result);
  assert.deepEqual(JSON.parse(await readFile(result.hostPath, "utf8")), { ok: true });
  console.log(
    JSON.stringify({
      schedulerJobId,
      status,
      digest,
      runtimeAttestationId: runtime.runtimeAttestationId,
      queue: runtime.attestedQueue,
    }),
  );
  console.log("REAL_ROOT_SIGNED_EXECUTION_OK");
} finally {
  const status = await adapter.status(schedulerJobId);
  if (status.status === "running" || status.status === "queued")
    await adapter.cancel(schedulerJobId);
}
