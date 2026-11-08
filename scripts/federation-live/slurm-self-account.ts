import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson, type SandboxUnsignedManifest } from "@kuintessence/shared";
import { type JobSpec, realSpawner, type Spawner } from "../../packages/agent/src/adapters/base";
import { SlurmAdapter } from "../../packages/agent/src/adapters/slurm";
import { loadAgentConfig } from "../../packages/agent/src/config";
import { LocalSandboxAccountVerifier } from "../../packages/agent/src/sandbox/local-account-verifier";
import { SandboxManifestVerifier } from "../../packages/agent/src/sandbox/manifest-verifier";
import {
  attestSandboxRuntimeEnvironment,
  currentSandboxProcessIdentity,
} from "../../packages/agent/src/sandbox/runtime-attestation";
import { SandboxStager, validateSandboxOutputs } from "../../packages/agent/src/sandbox/stager";

assert.equal(process.env.KQ_SLURM_SELFACCOUNT, "1");
const identity = currentSandboxProcessIdentity();
assert(identity);
assert.deepEqual(identity, { username: "scientist", uid: 24001, gid: 24001 });
const config = loadAgentConfig(await Bun.file("/opt/kq/self-account-config.json").json());
const probeSpawner: Spawner = {
  run: async (command, options) => {
    const result = await realSpawner.run(command, options);
    if (command[0] === "sbatch" && result.exitCode !== 0) {
      for (const argument of command.filter((part) => /^--(output|error)=/.test(part))) {
        const path = argument.slice(argument.indexOf("=") + 1);
        console.error(await readFile(path, "utf8").catch(() => "probe log unavailable"));
      }
      console.error(result.stderr);
    }
    return result;
  },
};
const evidence = await attestSandboxRuntimeEnvironment(config, "slurm", probeSpawner, identity);
await writeFile("/scratch/job/attestation.json", JSON.stringify(evidence, null, 2));
assert.deepEqual(evidence.missingRequirements, [], "Real SelfAccount startup attestation failed");
assert(
  evidence.networkIsolation &&
    evidence.cgroups &&
    evidence.seccomp &&
    evidence.sifSignatureVerification,
);
const entry = Object.entries(evidence.runtimeCache)[0];
assert(entry);
const [digest, runtime] = entry;
assert.equal(runtime.attestedQueue, "sandbox");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const keys = generateKeyPairSync("ed25519");
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
  localExecutionMode: "SelfAccount",
  processIdentity: identity,
  rootImpersonationEnabled: false,
  sharedServiceAllowed: false,
});
const input = "isolated-self-account-input\n";
const content = `set -euo pipefail
[[ $(/usr/bin/cat /kq/inputs/input) == isolated-self-account-input ]]
if (printf changed > /kq/inputs/input) 2>/dev/null; then exit 31; fi
status=$(/usr/bin/cat /proc/self/status)
[[ $status == *$'Seccomp:\\t2'* && $status == *$'NoNewPrivs:\\t1'* ]]
rc=0
error=$({ exec 3<>/dev/tcp/127.0.0.1/1; } 2>&1) || rc=$?
[[ $rc == 1 && $error == *'Operation not permitted'* ]]
printf '{"ok":true}\\n' >/kq/outputs/result
printf 'REAL_SELFACCOUNT_EXECUTED\\n'
`;
const unsigned: SandboxUnsignedManifest = {
  jobId: crypto.randomUUID(),
  script: {
    language: "bash",
    entrypoint: "main.sh",
    contentBase64: Buffer.from(content).toString("base64"),
    sha256: hash(content),
    bundleSha256: hash(
      canonicalJson({ language: "bash", entrypoint: "main.sh", sha256: hash(content) }),
    ),
  },
  runtime: { profileId: crypto.randomUUID(), kind: "SIF", digest },
  executionMode: "SelfAccount",
  runtimeAttestationId: runtime.runtimeAttestationId,
  identity: {
    mode: "MappedAccount",
    backend: "Unix",
    accountId: crypto.randomUUID(),
    ...identity,
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
      expectedSha256: hash(input),
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
    manifestSha256: hash(payload),
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
  name: "self-account-lab",
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
  await writeFile("/scratch/job/self-account-output.log", output);
  assert.equal(status.status, "completed", `${JSON.stringify(status)}\n${output}`);
  assert(output.includes("REAL_SELFACCOUNT_EXECUTED"), output);
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
  console.log("REAL_SELFACCOUNT_SIGNED_EXECUTION_OK");
} finally {
  const status = await adapter.status(schedulerJobId);
  if (status.status === "running" || status.status === "queued")
    await adapter.cancel(schedulerJobId);
}
