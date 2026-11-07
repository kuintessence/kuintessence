import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { create } from "@bufbuild/protobuf";
import * as dbSchema from "@kuintessence/db";
import { runSqliteMigrations } from "@kuintessence/db";
import { DispatchJobSchema } from "@kuintessence/proto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SlurmAdapter } from "../packages/agent/src/adapters/slurm";
import { collectFederationAccounting } from "../packages/agent/src/federation/accounting";
import { preparedRemoteJobToJson } from "../packages/agent/src/queue/active-remote-jobs";
import { federationDispatchReceipt } from "../packages/agent/src/queue/federation-dispatch";
import { InboundAcks } from "../packages/agent/src/queue/inbound-acks";

assert.equal(process.env.KQ_ACCOUNTING_LAB, "1", "Isolated accounting lab only");
await mkdir("/scratch/accounting-probe", { recursive: true });
const observations: Awaited<ReturnType<SlurmAdapter["status"]>>[] = [];
const a = new SlurmAdapter("19.05.5", { logDir: "/scratch/accounting-probe" });
const submittedAt = new Date();
const spec = {
  federationDispatchEpoch: 1,
  schedulerName: "kf1",
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
};
const submitted = await a.submit(spec);
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
const sqlite = new Database("/scratch/accounting-probe/receipts.db");
runSqliteMigrations(sqlite);
let supplemental: Awaited<ReturnType<typeof collectFederationAccounting>>;
try {
  const receipts = new InboundAcks(drizzle(sqlite, { schema: dbSchema }), {
    now: () => submittedAt,
  });
  const dispatch = create(DispatchJobSchema, {
    jobId: spec.jobId,
    dispatchEpoch: 1n,
    federationExecution: true,
  });
  await receipts.persistInbound({
    dispatchId: `${spec.jobId}:1`,
    jobId: spec.jobId,
    payload: {
      federationExecution: true,
      federationSubmissionStarted: true,
      federationReceipt: federationDispatchReceipt(dispatch),
      federationSubmission: preparedRemoteJobToJson({ spec, expectedOutputs: [] }),
    },
  });
  supplemental = await collectFederationAccounting(
    new InboundAcks(drizzle(sqlite, { schema: dbSchema })),
    a,
    {
      version: 1,
      requestId: randomUUID(),
      jobId: spec.jobId,
      dispatchEpoch: 1,
      schedulerJobId: submitted.schedulerJobId,
      originalEvidenceDigest: `sha256:${"a".repeat(64)}`,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  );
  assert.equal(
    supplemental.state,
    "observed",
    "Original UUID/name must still resolve in real Slurm history",
  );
  if (supplemental.state !== "observed") throw new Error("No supplemental observation");
  assert.equal(
    supplemental.observation.accounting.cpuTimeMilliseconds,
    status.accounting.cpuTimeMilliseconds,
  );
} finally {
  sqlite.close();
}
console.log(
  JSON.stringify({
    schedulerJobId: submitted.schedulerJobId,
    status,
    observations,
    supplemental,
    raw: raw.stdout.toString(),
    verifiedOutput: true,
  }),
);
