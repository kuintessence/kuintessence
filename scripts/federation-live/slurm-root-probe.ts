import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { type JobSpec, realSpawner, type Spawner } from "../../packages/agent/src/adapters/base";
import { SlurmAdapter } from "../../packages/agent/src/adapters/slurm";
import { buildSelfAccountCgroupCommand } from "../../packages/agent/src/sandbox/cgroup-command";
import { runNativeRuntimeProbe } from "../../packages/agent/src/sandbox/native-runtime-probe";

assert.equal(process.env.KQ_SLURM_ROOT_PROBE, "1");
assert.equal(process.getuid?.(), 0);
const root = "/scratch/root-attestation";
await mkdir(root, { mode: 0o711, recursive: true });
await chmod(root, 0o711);
const checkerPath = "/usr/libexec/kuintessence/kq-sandbox-cgroup-check";
const resourceCheck = buildSelfAccountCgroupCommand(
  {
    path: checkerPath,
    sha256: createHash("sha256")
      .update(await readFile(checkerPath))
      .digest("hex"),
  },
  { cpus: 1, memoryMb: 128 },
);
const accountSpawner: Spawner = {
  run: (command, options) =>
    realSpawner.run(
      [
        "setpriv",
        "--reuid=24001",
        "--regid=24001",
        "--init-groups",
        "--",
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "HOME=/home/scientist",
        "USER=scientist",
        "LOGNAME=scientist",
        ...command,
      ],
      { ...options, timeoutMs: 10_000 },
    ),
};
const probeAccount = { username: "scientist", uid: 24001, gid: 24001 };
const probeScript = `#!/bin/bash
set -euo pipefail
[[ $(id -u) == 24001 ]]
${resourceCheck}
printf 'KQ_ATTESTED_NODE=%s\\n' "$(hostname)"
`;
const nativeAdapter = (logDir: string) =>
  new SlurmAdapter("24.11.5", {
    spawner: accountSpawner,
    logDir,
    terminalStatusBackend: "scontrol",
  });
const crashMode = process.argv[2];
if (crashMode) {
  assert(["response-lost", "submitted"].includes(crashMode));
  let submittedSpec: JobSpec | undefined;
  let submittedId: string | undefined;
  const pauseAfterRunning = async () => {
    assert(submittedSpec && submittedId);
    let pid = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      pid = Number(
        await readFile(`${submittedSpec.workingDir}/probe.pid`, "utf8").catch(() => "0"),
      );
      if (pid > 1) break;
      await Bun.sleep(100);
    }
    assert(Number.isSafeInteger(pid) && pid > 1, "Original Slurm job must actually run");
    const ready = `/scratch/probe-crash-${crashMode}.json`;
    await writeFile(
      `${ready}.tmp`,
      JSON.stringify({ jobId: submittedSpec.jobId, schedulerJobId: submittedId, pid }),
    );
    await rename(`${ready}.tmp`, ready);
    await Bun.sleep(60_000);
    throw new Error("Parent did not kill the probe process");
  };
  await runNativeRuntimeProbe({
    root,
    queue: "sandbox",
    account: probeAccount,
    script: `#!/bin/bash
set -euo pipefail
${resourceCheck}
printf '%s' "$$" >probe.pid
exec /bin/sleep 120
`,
    adapter: (logDir) => {
      const native = nativeAdapter(logDir);
      return {
        type: native.type,
        version: native.version,
        submit: async (spec) => {
          submittedSpec = spec;
          const result = await native.submit(spec);
          submittedId = result.schedulerJobId;
          if (crashMode === "response-lost") await pauseAfterRunning();
          return result;
        },
        status: async (id) => {
          if (crashMode === "submitted") await pauseAfterRunning();
          return native.status(id);
        },
        cancel: (id) => native.cancel(id),
        confirmStopped: (id) => native.confirmStopped(id),
      };
    },
  });
  throw new Error("Crash worker unexpectedly completed");
}
const nodes = await runNativeRuntimeProbe({
  root,
  queue: "sandbox",
  account: { username: "scientist", uid: 24001, gid: 24001 },
  script: probeScript,
  adapter: nativeAdapter,
});
assert.deepEqual(nodes, ["slurm"]);
assert.deepEqual(
  (await readdir(root)).filter((name) => name !== ".attestation.lock"),
  [],
);
console.log("REAL_ROOT_SUBMITTED_NONROOT_PROBE_OK");

let spec: JobSpec | undefined;
let originalPid: number | undefined;
let originalId: string | undefined;
const cancelSpawner: Spawner = {
  run: async (command, options) => {
    if (command[0] === "scancel") {
      assert(spec && originalId);
      assert(command.includes(originalId));
      originalPid = Number(await readFile(`${spec.workingDir}/probe.pid`, "utf8"));
      assert(Number.isSafeInteger(originalPid) && originalPid > 1);
    }
    return accountSpawner.run(command, options);
  },
};
await assert.rejects(
  runNativeRuntimeProbe({
    root,
    queue: "sandbox",
    account: { username: "scientist", uid: 24001, gid: 24001 },
    timeoutMs: 5000,
    script: `#!/bin/bash
set -euo pipefail
${resourceCheck}
printf '%s' "$$" >probe.pid
exec /bin/sleep 120
`,
    adapter: (logDir) => {
      const native = new SlurmAdapter("24.11.5", {
        spawner: cancelSpawner,
        logDir,
        terminalStatusBackend: "scontrol",
      });
      return {
        type: native.type,
        version: native.version,
        submit: async (input) => {
          spec = input;
          const result = await native.submit(input);
          originalId = result.schedulerJobId;
          return result;
        },
        status: (id) => native.status(id),
        cancel: (id) => native.cancel(id),
        confirmStopped: (id) => native.confirmStopped(id),
      };
    },
  }),
  /Native Sandbox probe timed out/,
);
assert(originalPid && originalId);
const stoppedPid = originalPid;
assert.throws(() => process.kill(stoppedPid, 0), /ESRCH/);
assert.deepEqual(
  (await readdir(root)).filter((name) => name !== ".attestation.lock"),
  [],
);
console.log(JSON.stringify({ cancelledSchedulerJobId: originalId, stoppedPid: originalPid }));
console.log("REAL_NATIVE_PROBE_CANCEL_AND_CLEANUP_OK");

for (const mode of ["response-lost", "submitted"] as const) {
  assert(process.argv[1]);
  const worker = Bun.spawn([process.execPath, process.argv[1], mode], {
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    let ready = "";
    for (let attempt = 0; attempt < 150; attempt++) {
      ready = await readFile(`/scratch/probe-crash-${mode}.json`, "utf8").catch(() => "");
      if (ready) break;
      assert.equal(worker.exitCode, null, "Crash worker exited before readiness");
      await Bun.sleep(100);
    }
    assert(ready, "Crash worker must reach a running Slurm job");
    const original: { jobId: string; schedulerJobId: string; pid: number } = JSON.parse(ready);
    process.kill(original.pid, 0);
    const receipt = JSON.parse(await readFile(`${root}/.attest-active/job.json`, "utf8"));
    assert.equal(receipt.jobId, original.jobId);
    assert.equal(receipt.phase, mode === "response-lost" ? "submitting" : "submitted");
    assert.equal(
      receipt.schedulerJobId,
      mode === "submitted" ? original.schedulerJobId : undefined,
    );
    let lookups = 0,
      cancels = 0,
      submissions = 0;
    const recover = () =>
      runNativeRuntimeProbe({
        root,
        queue: "sandbox",
        account: probeAccount,
        script: probeScript,
        adapter: (logDir) => {
          const native = nativeAdapter(logDir);
          return {
            type: native.type,
            version: native.version,
            findByKuintessenceJobId: async (lookup) => {
              lookups++;
              assert.equal(lookup.jobId, original.jobId);
              const result = await native.findByKuintessenceJobId(lookup);
              assert.deepEqual(result, {
                status: "found",
                schedulerJobId: original.schedulerJobId,
              });
              return result;
            },
            confirmStopped: (id) => native.confirmStopped(id),
            cancel: async (id) => {
              cancels++;
              assert.equal(id, original.schedulerJobId);
              await native.cancel(id);
            },
            submit: async (spec) => {
              submissions++;
              assert.notEqual(spec.jobId, original.jobId);
              assert.equal(await native.confirmStopped(original.schedulerJobId), true);
              assert.throws(() => process.kill(original.pid, 0), /ESRCH/);
              return native.submit(spec);
            },
            status: (id) => native.status(id),
          };
        },
      });
    await assert.rejects(recover(), /another process holds its lock/);
    assert.deepEqual([lookups, cancels, submissions], [0, 0, 0]);
    worker.kill("SIGKILL");
    await worker.exited;
    process.kill(original.pid, 0);
    assert.deepEqual(await recover(), ["slurm"]);
    assert.deepEqual([lookups, cancels, submissions], [1, 1, 1]);
    assert.deepEqual(await readdir(root), [".attestation.lock"]);
    console.log(
      JSON.stringify({
        mode,
        originalSchedulerJobId: original.schedulerJobId,
        stoppedPid: original.pid,
      }),
    );
    console.log(`REAL_NATIVE_PROBE_CRASH_RECOVERY_OK=${mode}`);
  } finally {
    worker.kill("SIGKILL");
    await worker.exited;
  }
}
