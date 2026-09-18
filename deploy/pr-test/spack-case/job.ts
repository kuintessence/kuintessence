import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { queueInventoryReady, waitFor } from "../runtime";
import { caseDirectory, jsonRequest, login } from "./api";

assert.equal(process.env.KQ_PR_TEST, "1");
const origin = "https://server:3443";
const token = await login(origin);
const result = z.object({
  prefix: z.string().regex(/^\/scratch\/kq-spack-case\/native\/[A-Za-z0-9_./-]+$/),
  spec: z.string(),
  target: z.string(),
  rootHash: z.string().regex(/^[a-z2-7]{32}$/),
}).parse(JSON.parse(await readFile(`${caseDirectory}/native/result.json`, "utf8")));
assert(!result.prefix.split("/").includes(".."));
await waitFor(
  "Slurm queue after Agent startup",
  () => jsonRequest(origin, token, "/admin/agents/pr-scheduler/queue-inventory"),
  (value) => queueInventoryReady(value, "debug"),
);
const context = z.object({
  providerOrgs: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
}).parse(await jsonRequest(origin, token, "/cp/agent-registration-context"));
const provider = context.providerOrgs.find((org) => org.name === "Development Compute Provider");
assert(provider);
const queueId = randomUUID();
await jsonRequest(origin, token, "/admin/queues", {
  queueId,
  name: `PR GNU Hello ${queueId}`,
  providerOrgId: provider.id,
  visibleOrgIds: [provider.id],
  agentId: "pr-scheduler",
  schedulerType: "slurm",
  queueName: "debug",
  enabled: true,
  qos: null,
  policyTags: [],
});
const JobSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  schedulerJobId: z.string().nullable(),
});
const created = JobSchema.parse(await jsonRequest(origin, token, "/jobs", {
  name: "pr_spack_hello_single_step",
  command: `'${result.prefix}/bin/hello'`,
  resources: { cpus: 1, memoryMb: 128, wallTimeSec: 60 },
  schedulingStrategy: { queueId },
}));
const completed = await waitFor(
  "GNU Hello single-step job",
  async () => JobSchema.parse(await jsonRequest(origin, token, `/jobs/${created.id}`)),
  (job) => ["completed", "failed", "cancelled"].includes(job.status),
);
assert.equal(completed.status, "completed");
assert(completed.schedulerJobId, "Expected a real Slurm job ID");
const logs = await waitFor(
  "GNU Hello stdout through Server",
  async () => z.object({ text: z.string() }).parse(
    await jsonRequest(origin, token, `/jobs/${created.id}/logs?lines=50`),
  ),
  (value) => value.text.includes("Hello, world!"),
);
assert.match(logs.text, /(?:^|\n)Hello, world!\r?(?:\n|$)/);
console.log(`Spack case: ${result.spec} ${result.target} -> Slurm completed -> Hello, world!`);
