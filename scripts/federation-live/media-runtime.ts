import assert from "node:assert/strict";
import { createSqliteDb } from "@kuintessence/db";
import { realSpawner } from "../../packages/agent/src/adapters/base";
import { PbsProAdapter } from "../../packages/agent/src/adapters/pbs-pro";
import { SlurmAdapter } from "../../packages/agent/src/adapters/slurm";
import { InboundAcks } from "../../packages/agent/src/queue/inbound-acks";

assert.equal(process.env.LAB_MEDIA_RUNTIME_PROBE, "1");
const [jobId, epoch, schedulerJobId] = process.argv.slice(2);
assert(jobId && /^[0-9a-f-]{36}$/.test(jobId));
assert(epoch && /^[1-9][0-9]*$/.test(epoch));
const scheduler = process.env.LAB_MEDIA_EXECUTION;
assert(scheduler === "slurm" || scheduler === "pbs-pro");
assert(
  schedulerJobId &&
    (scheduler === "slurm" ? /^[0-9]+$/ : /^[0-9]+\.[A-Za-z0-9._-]+$/).test(schedulerJobId),
);
const inbox = new InboundAcks(createSqliteDb("/var/lib/kuintessence/agent.db"));
const dispatchId = `${jobId}:${epoch}`;
const row = await inbox.get(dispatchId);
const adapter =
  scheduler === "slurm"
    ? new SlurmAdapter("lab", { terminalStatusBackend: "scontrol" })
    : new PbsProAdapter("23.06.06");
const status = await adapter.status(schedulerJobId);
let schedulerState: string | undefined;
if (scheduler === "pbs-pro") {
  const history = await realSpawner.run(["qstat", "-xf", "-F", "json", schedulerJobId]);
  assert.equal(history.exitCode, 0, "PBS must retain the original scheduler record");
  schedulerState = JSON.parse(history.stdout).Jobs?.[schedulerJobId]?.job_state;
  assert(typeof schedulerState === "string");
}
const sleep = await realSpawner.run(["pgrep", "-u", "24001", "-f", "^/bin/sleep 300$"]);
assert(sleep.exitCode === 0 || sleep.exitCode === 1, "Unable to inspect mapped task process");
console.log(
  JSON.stringify({
    schedulerJobId,
    schedulerState,
    status,
    runtime: row?.payload.federationRuntime ?? null,
    stopConfirmed: await inbox.hasConfirmedRuntimeStop(dispatchId, schedulerJobId),
    readChecksPassed: sleep.exitCode === 0,
  }),
);
