import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { SlurmAdapter } from "../packages/agent/src/adapters/slurm";

assert.equal(process.env.KQ_ACCOUNTING_LAB, "1", "Isolated accounting lab only");
await mkdir("/scratch/accounting-probe", { recursive: true });
const observations: Awaited<ReturnType<SlurmAdapter["status"]>>[] = [];
const a = new SlurmAdapter("19.05.5", { logDir: "/scratch/accounting-probe" });
const submitted = await a.submit({
  jobId: randomUUID(),
  name: "accounting-probe",
  command: `python3 - <<'PY'
import time
end=time.process_time()+2
n=0
while time.process_time()<end: n+=1
print('accounting-probe-complete')
PY`,
  cpus: 1,
  memoryMb: 64,
  gpus: 0,
  wallTimeSec: 60,
  workingDir: "",
  envVars: {},
});
const deadline = Date.now() + 60000;
let status: Awaited<ReturnType<SlurmAdapter["status"]>> | undefined;
while (Date.now() < deadline) {
  status = await a.status(submitted.schedulerJobId);
  observations.push(status);
  if (status.status === "completed" && status.accounting?.cpuTimeMilliseconds) break;
  if (status.status === "failed") throw new Error("Scheduler task failed");
  await Bun.sleep(1000);
}
assert(status && status.status === "completed");
assert(status.accounting?.cpuTimeMilliseconds);
assert(BigInt(status.accounting.cpuTimeMilliseconds) >= 1500n);
assert.equal(status.accounting.allocatedCpus, "1");
assert(BigInt(status.accounting.elapsedMilliseconds ?? "-1") >= 1000n);
const logs = await a.getJobLogs(submitted.schedulerJobId, 50);
assert(logs.includes("accounting-probe-complete"));
const raw = Bun.spawnSync([
  "sacct",
  "-j",
  submitted.schedulerJobId,
  "--format=JobIDRaw,State,ElapsedRaw,AllocCPUS,TotalCPU",
  "--noheader",
  "--parsable2",
]);
assert.equal(raw.exitCode, 0);
console.log(
  JSON.stringify({
    schedulerJobId: submitted.schedulerJobId,
    status,
    observations,
    raw: raw.stdout.toString(),
    verifiedOutput: true,
  }),
);
