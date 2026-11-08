import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile } from "node:fs/promises";
import { type JobSpec, realSpawner, type Spawner } from "../../packages/agent/src/adapters/base";
import { SlurmAdapter } from "../../packages/agent/src/adapters/slurm";
import { buildSelfAccountCgroupCommand } from "../../packages/agent/src/sandbox/cgroup-command";
import { runNativeRuntimeProbe } from "../../packages/agent/src/sandbox/native-runtime-probe";

assert.equal(process.env.KQ_SLURM_ROOT_PROBE, "1");
assert.equal(process.getuid?.(), 0);
const root = "/scratch/root-attestation";
await mkdir(root, { mode: 0o711 });
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
const nodes = await runNativeRuntimeProbe({
  root,
  queue: "sandbox",
  account: { uid: 24001, gid: 24001 },
  script: `#!/bin/bash
set -euo pipefail
[[ $(id -u) == 24001 ]]
${resourceCheck}
printf 'KQ_ATTESTED_NODE=%s\\n' "$(hostname)"
`,
  adapter: (logDir) =>
    new SlurmAdapter("24.11.5", {
      spawner: accountSpawner,
      logDir,
      terminalStatusBackend: "scontrol",
    }),
});
assert.deepEqual(nodes, ["slurm"]);
assert.deepEqual(await readdir(root), []);
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
    account: { uid: 24001, gid: 24001 },
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
assert.deepEqual(await readdir(root), []);
console.log(JSON.stringify({ cancelledSchedulerJobId: originalId, stoppedPid: originalPid }));
console.log("REAL_NATIVE_PROBE_CANCEL_AND_CLEANUP_OK");
