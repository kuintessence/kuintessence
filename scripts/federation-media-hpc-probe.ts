import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { create } from "@bufbuild/protobuf";
import { createSqliteDb } from "@kuintessence/db";
import { DispatchJobSchema } from "@kuintessence/proto";
import { canonicalJson, type SandboxUnsignedManifest } from "@kuintessence/shared";
import {
  cancelAndConfirmStopped,
  type JobSpec,
  realSpawner,
} from "../packages/agent/src/adapters/base";
import { PbsProAdapter } from "../packages/agent/src/adapters/pbs-pro";
import { SlurmAdapter } from "../packages/agent/src/adapters/slurm";
import { importFederationMedia } from "../packages/agent/src/data-market/media-import";
import { mediaImportFixture } from "../packages/agent/src/data-market/media-import-test-fixture";
import {
  federationDispatchReceipt,
  federationSchedulerName,
} from "../packages/agent/src/queue/federation-dispatch";
import { InboundAcks } from "../packages/agent/src/queue/inbound-acks";
import { downloadSandboxInput } from "../packages/agent/src/sandbox/input-downloader";
import { LocalSandboxAccountVerifier } from "../packages/agent/src/sandbox/local-account-verifier";
import { SandboxManifestVerifier } from "../packages/agent/src/sandbox/manifest-verifier";
import { SandboxStager } from "../packages/agent/src/sandbox/stager";

assert.equal(process.env.KQ_MEDIA_HPC_LAB, "1", "Use the isolated media HPC lab runner");
assert.equal(process.getuid?.(), 0);
const scheduler = process.env.KQ_MEDIA_SCHEDULER ?? "slurm";
assert(scheduler === "slurm" || scheduler === "pbs-pro", "Unsupported lab scheduler");
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
async function command(argv: string[]) {
  const result = await realSpawner.run(argv, { timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

// This ephemeral lab key establishes actual SIF verification, not a cached boolean fixture.
const sifKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
await writeFile("/opt/kq/sif.key", sifKey.privateKey.export({ type: "pkcs8", format: "pem" }), {
  mode: 0o600,
});
await writeFile("/opt/kq/sif.pub", sifKey.publicKey.export({ type: "spki", format: "pem" }), {
  mode: 0o644,
});
try {
  await command(["apptainer", "sign", "--key", "/opt/kq/sif.key", "/opt/kq/bash.sif"]);
} finally {
  await rm("/opt/kq/sif.key", { force: true });
}
await command(["apptainer", "verify", "--key", "/opt/kq/sif.pub", "/opt/kq/bash.sif"]);
await chmod("/opt/kq/bash.sif", 0o444);
const seccompPath = "/etc/kuintessence/restricted-seccomp.json";
const seccomp = await readFile(
  "/workspace/deploy/schedulers/k3s/seccomp-kubernetes-no-network.json",
);
await writeFile(seccompPath, seccomp, { mode: 0o644 });
const profile = {
  profileId: crypto.randomUUID(),
  apptainerCanonicalPath: "/usr/bin/apptainer",
  apptainerSha256: hash(await readFile("/usr/bin/apptainer")),
  sifCanonicalPath: "/opt/kq/bash.sif",
  sifSha256: hash(await readFile("/opt/kq/bash.sif")),
  trustedWrapperCanonicalPath: "/usr/libexec/kuintessence/kq-sandbox-wrapper",
  trustedWrapperSha256: hash(await readFile("/usr/libexec/kuintessence/kq-sandbox-wrapper")),
};
await writeFile(
  "/etc/kuintessence/restricted-execution-profile.conf",
  Object.entries({
    KQ_PROFILE_ID: profile.profileId,
    KQ_APPTAINER_PATH: profile.apptainerCanonicalPath,
    KQ_APPTAINER_SHA256: profile.apptainerSha256,
    KQ_SIF_PATH: profile.sifCanonicalPath,
    KQ_SIF_SHA256: profile.sifSha256,
    KQ_WRAPPER_PATH: profile.trustedWrapperCanonicalPath,
    KQ_WRAPPER_SHA256: profile.trustedWrapperSha256,
    KQ_SECCOMP_PATH: seccompPath,
    KQ_SECCOMP_SHA256: hash(seccomp),
  })
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n"),
  { mode: 0o644 },
);
await command([profile.trustedWrapperCanonicalPath, "--check-profile"]);
const adapter =
  scheduler === "slurm"
    ? new SlurmAdapter("real", { terminalStatusBackend: "scontrol" })
    : new PbsProAdapter("23.06.06");
const databasePath = process.env.AGENT_DB_PATH;
assert(databasePath, "The lab Agent database path is required");
const inbox = new InboundAcks(createSqliteDb(databasePath));
for (let attempt = 0; ; attempt++) {
  try {
    await inbox.assertWatchdogReady(scheduler);
    break;
  } catch (error) {
    if (attempt >= 30) throw error;
    await Bun.sleep(250);
  }
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const consumed = new Set<string>();
const verifier = new SandboxManifestVerifier({
  publicKeys: { test: publicKey.export({ type: "spki", format: "pem" }).toString() },
  runtimeCache: {
    [`sha256:${profile.sifSha256}`]: {
      kind: "SIF",
      localPath: profile.sifCanonicalPath,
      signatureVerified: true,
    },
  },
  nonceConsumer: {
    consume: async (nonce) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  },
  accountVerifier: new LocalSandboxAccountVerifier(realSpawner),
  adapterType: scheduler,
  localExecutionMode: "RootImpersonation",
  processIdentity: { username: "root", uid: 0, gid: 0 },
  rootImpersonationEnabled: true,
  sharedServiceAllowed: false,
  restrictedExecutionProfile: profile,
});

const cases = ["complete", "stop", "agent-crash"] as const;
const selected = process.env.KQ_MEDIA_HPC_CASE;
assert(!selected || cases.some((mode) => mode === selected), "Unknown lab case");
for (const mode of cases.filter((mode) => !selected || mode === selected)) {
  const media = await mediaImportFixture();
  const jobId = crypto.randomUUID();
  const epoch = 11n;
  const dispatchId = `${jobId}:${epoch}`;
  const stager = new SandboxStager({
    root: "/scratch/media-sandbox",
    downloadInput: (input) => downloadSandboxInput({ ...input, roots: media.options.roots }),
  });
  let schedulerJobId: string | undefined;
  let suspendedSupervisor: number | undefined;
  try {
    await importFederationMedia(media.options);
    const content = `set -eu
input=$(/usr/bin/cat /kq/inputs/input)
[[ \${#input} -eq ${media.bytes.length} ]]
if (printf changed > /kq/inputs/input) 2>/dev/null; then exit 31; fi
routes=$(/usr/bin/cat /proc/net/route)
[[ $routes != *$'\\t00000000\\t'* ]]
status=$(/usr/bin/cat /proc/self/status)
[[ $status == *$'Seccomp:\\t2'* ]]
[[ $status == *$'NoNewPrivs:\\t1'* ]]
# EPERM proves the socket syscall was filtered, beyond merely having no route.
socket_error=$({ : >/dev/tcp/127.0.0.1/9; } 2>&1) && exit 32
[[ $socket_error == *'Operation not permitted'* ]]
printf 'IMPORTED_DATA_READ%4096s\\n' ''
${mode === "complete" ? "" : "/bin/sleep 120"}
`;
    const script = {
      language: "bash" as const,
      entrypoint: "main.sh",
      contentBase64: Buffer.from(content).toString("base64"),
      sha256: hash(content),
      bundleSha256: hash(
        canonicalJson({ language: "bash", entrypoint: "main.sh", sha256: hash(content) }),
      ),
    };
    const unsigned: SandboxUnsignedManifest = {
      jobId,
      script,
      runtime: {
        profileId: crypto.randomUUID(),
        kind: "SIF",
        digest: `sha256:${profile.sifSha256}`,
      },
      executionMode: "RootImpersonation",
      identity: {
        mode: "MappedAccount",
        backend: "Unix",
        accountId: crypto.randomUUID(),
        username: "scientist",
        uid: 24001,
        gid: 24001,
        schedulerAccount: null,
        allowedQueues: [scheduler === "slurm" ? "debug" : "workq"],
      },
      mounts: [
        {
          descriptor: "input",
          ioType: "File",
          mode: "ReadOnly",
          relativePath: "inputs/nested/input.dat",
          containerPath: "/kq/inputs/input",
          expectedSha256: hash(media.bytes),
          batchEntries: [],
          sizeLimitBytes: media.bytes.length,
          required: true,
        },
      ],
      limits: { pids: 128, outputBytes: 1048576, logBytes: 16384 },
      networkDisabled: true,
      executionProfile: profile,
    };
    const json = canonicalJson(unsigned);
    const signed = {
      ...unsigned,
      envelope: {
        keyId: "test",
        nonce: crypto.randomUUID(),
        issuedAtUnixMs: Date.now(),
        expiresAtUnixMs: Date.now() + 60000,
        manifestSha256: hash(json),
        signatureBase64: sign(null, Buffer.from(json), privateKey).toString("base64"),
      },
    };
    const verified = await verifier.verify(jobId, signed);
    const staged = await stager.prepare(verified, [
      {
        stagePath: "inputs/nested/input.dat",
        sourceUrl: "",
        deliveryLeaseId: crypto.randomUUID(),
        deliveryLeaseExpiresAtUnixMs: BigInt(Date.now() + 60000),
        localDataSource: {
          locationId: crypto.randomUUID(),
          managedRootId: media.options.task.managedRootId,
          relativePath: `.federation-media/${media.manifest.packageId}/files/input.dat`,
        },
      },
    ]);
    const spec: JobSpec = {
      jobId,
      name: "media-probe",
      schedulerName: federationSchedulerName(epoch),
      federationDispatchEpoch: Number(epoch),
      command: "false",
      cpus: 1,
      memoryMb: 128,
      gpus: 0,
      wallTimeSec: 180,
      workingDir: staged.workingDir,
      envVars: {},
      sandbox: staged.sandbox,
      restrictedNoEgress: true,
    };
    const dispatch = create(DispatchJobSchema, {
      jobId,
      dispatchEpoch: epoch,
      federationExecution: true,
    });
    await inbox.persistInbound({
      dispatchId,
      jobId,
      payload: {
        federationExecution: true,
        federationReceipt: federationDispatchReceipt(dispatch),
      },
    });
    await inbox.markSubmissionStarted(
      dispatchId,
      { spec, expectedOutputs: [] },
      {
        owner: "lab",
        expiresAt: Date.now() + (mode === "agent-crash" ? 15_000 : 30_000),
        state: "active",
      },
    );
    schedulerJobId = (await adapter.submit(spec)).schedulerJobId;
    await inbox.markAcked(dispatchId);
    const log = `${staged.workingDir}/.scheduler-logs/kq-${scheduler === "pbs-pro" ? "pbs-" : ""}${jobId}.out`;
    assert(/^[0-9]+(?:\.[A-Za-z0-9_.-]+)?$/.test(schedulerJobId));
    const readExecutionLog = async () => {
      // PBS copies stdout to its destination only at exit; observe its real local MOM spool.
      const path = scheduler === "pbs-pro" ? `/var/spool/pbs/spool/${schedulerJobId}.OU` : log;
      return readFile(path, "utf8").catch(() => readFile(log, "utf8").catch(() => ""));
    };
    for (let i = 0; ; i++) {
      if ((await readExecutionLog()).includes("IMPORTED_DATA_READ")) break;
      const state = await adapter.status(schedulerJobId);
      assert.notEqual(state.status, "failed", await readExecutionLog());
      assert(i < 30, "Script did not read the imported input");
      await Bun.sleep(500);
    }
    if (mode === "stop") {
      // Inject the persisted stop decision; source policy/mTLS is tested separately.
      assert(await inbox.setRuntimeState(dispatchId, "lab", "stopping"));
    } else if (mode === "agent-crash") {
      suspendedSupervisor = Number(
        await command([
          "python3",
          "-c",
          `import os,signal,pathlib
found=False
for p in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  args=(p/'cmdline').read_bytes().split(b'\\0')
  if len(args)>1 and args[0].endswith(b'bun') and args[1]==b'/workspace/packages/agent/src/index.ts' and b'--federation-watchdog' not in args:
   parent=int((p/'status').read_text().split('PPid:')[1].split()[0])
   assert b'kq-supervise-agent.py' in pathlib.Path(f'/proc/{parent}/cmdline').read_bytes()
   os.kill(parent,signal.SIGSTOP)
   os.kill(int(p.name),signal.SIGKILL)
   print(parent)
   found=True
 except (FileNotFoundError,ProcessLookupError): pass
assert found, 'Agent process not found'
`,
        ]),
      );
      assert(Number.isSafeInteger(suspendedSupervisor) && suspendedSupervisor > 1);
    }
    for (let i = 0; ; i++) {
      const state = await adapter.status(schedulerJobId);
      if (mode === "complete" && state.status === "completed") {
        assert.equal(state.exitCode, 0);
        await inbox.setRuntimeState(dispatchId, "lab", "finished");
        break;
      }
      if (
        mode !== "complete" &&
        (await inbox.hasConfirmedRuntimeStop(dispatchId, schedulerJobId))
      ) {
        assert.equal(state.status, "failed");
        if (scheduler === "slurm") assert.match(state.message ?? "", /CANCELLED/);
        else assert.notEqual(state.exitCode, 0);
        break;
      }
      assert(i < 50, `No expected scheduler outcome for ${mode}`);
      await Bun.sleep(500);
    }
    assert.equal(
      hash(await readFile(`${staged.workingDir}/inputs/nested/input.dat`)),
      hash(media.bytes),
    );
    assert.match(await adapter.getJobLogs(schedulerJobId, 10, jobId), /IMPORTED_DATA_READ/);
    console.log(
      JSON.stringify({
        scheduler,
        mode,
        schedulerJobId,
        inputBytes: media.bytes.length,
        result: "PASS",
      }),
    );
  } finally {
    if (suspendedSupervisor) process.kill(suspendedSupervisor, "SIGCONT");
    if (schedulerJobId && !(await adapter.confirmStopped(schedulerJobId)))
      await cancelAndConfirmStopped(adapter, schedulerJobId, {
        jobId,
        federationDispatchEpoch: Number(epoch),
      });
    await stager.cleanup(jobId);
    await media.cleanup();
  }
}
