import assert from "node:assert/strict";
import { createSqliteDb } from "@kuintessence/db";
import { realSpawner } from "../../packages/agent/src/adapters/base";
import { SlurmAdapter } from "../../packages/agent/src/adapters/slurm";
import { InboundAcks } from "../../packages/agent/src/queue/inbound-acks";

assert.equal(process.env.LAB_MEDIA_RUNTIME_PROBE, "1");
const [jobId, epoch, schedulerJobId] = process.argv.slice(2);
assert(jobId && /^[0-9a-f-]{36}$/.test(jobId));
assert(epoch && /^[1-9][0-9]*$/.test(epoch));
assert(schedulerJobId && /^[0-9]+$/.test(schedulerJobId));
const inbox = new InboundAcks(createSqliteDb("/var/lib/kuintessence/agent.db"));
const dispatchId = `${jobId}:${epoch}`;
const row = await inbox.get(dispatchId);
const status = await new SlurmAdapter("lab", { terminalStatusBackend: "scontrol" }).status(
  schedulerJobId,
);
const sleep = await realSpawner.run(["pgrep", "-u", "24001", "-f", "^/bin/sleep 300$"]);
assert(sleep.exitCode === 0 || sleep.exitCode === 1, "Unable to inspect mapped task process");
console.log(
  JSON.stringify({
    schedulerJobId,
    status,
    runtime: row?.payload.federationRuntime ?? null,
    stopConfirmed: await inbox.hasConfirmedRuntimeStop(dispatchId, schedulerJobId),
    readChecksPassed: sleep.exitCode === 0,
  }),
);
