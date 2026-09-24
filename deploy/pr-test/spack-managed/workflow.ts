import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { waitFor } from "../runtime";
import { jsonRequest } from "../spack-case/api";
import { selectedCase } from "../spack-case/fixture";
import { managedJobOutputAccepted } from "./jobs";
import {
  assertWorkflowCompleted,
  managedWorkflow,
  WorkflowAssetsSchema,
  WorkflowDetailSchema,
  workflowJobFailureCode,
  type WorkflowReceipt,
} from "./workflow-contract";

const origin = "https://server:3443";
const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const JobSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string(),
  agentId: z.string().nullable(),
  schedulerJobId: z.string().nullable(),
  usecasePackageId: z.string().uuid().nullable(),
  errorMessage: z.string().nullable().optional(),
});
type Request = (path: string, body?: unknown) => Promise<unknown>;

async function verifyJobs(request: Request, receipt: WorkflowReceipt) {
  const assets = WorkflowAssetsSchema.parse(
    JSON.parse(await readFile("/case-control/workflow-assets.json", "utf8")),
  );
  const marker = selectedCase().id === "hello" ? "KQ_MANAGED_HELLO_OK" : "KQ_MANAGED_SAMTOOLS_OK";
  for (const [nodeId, jobId] of Object.entries(receipt.jobs)) {
    const job = JobSchema.parse(await request(`/jobs/${jobId}`));
    assert.equal(job.id, jobId);
    assert.equal(job.status, "completed");
    assert.equal(job.agentId, "pr-scheduler");
    assert.equal(job.name, `managed_${nodeId}`);
    assert.equal(job.usecasePackageId, assets.usecaseId);
    assert(job.schedulerJobId !== null && /^[1-9][0-9]*$/.test(job.schedulerJobId));
    await waitFor(
      "workflow result logs through Server",
      async () => z.object({ text: z.string() }).parse(await request(`/jobs/${jobId}/logs?lines=50`)),
      ({ text }) => managedJobOutputAccepted(text, marker) &&
        text.split(/\r?\n/).includes("KQ_WORKFLOW_VALUE=3"),
    );
  }
}

export async function verifyManagedWorkflow(token: string, receipt: WorkflowReceipt) {
  const request: Request = (path, body) => jsonRequest(origin, token, path, body);
  assert.deepEqual(
    assertWorkflowCompleted(await request(`/workflows/${receipt.runId}`), receipt.runId),
    receipt,
  );
  await verifyJobs(request, receipt);
  console.log("Spack managed workflow: stage=readback code=OK");
}

export async function runManagedWorkflow(token: string, queueId: string, prefix: string) {
  assert.equal(process.env.KQ_PR_TEST, "1");
  assert.equal(process.env.KQ_PR_SPACK_WORKFLOW, "1");
  const request: Request = (path, body) => jsonRequest(origin, token, path, body);
  const assets = WorkflowAssetsSchema.parse(
    JSON.parse(await readFile("/case-control/workflow-assets.json", "utf8")),
  );
  const workflow = managedWorkflow(assets, queueId, prefix);
  const created = z.object({ runId: z.string().uuid() }).parse(
    await request("/workflows", { yaml: JSON.stringify(workflow) }),
  );
  console.log("Spack managed workflow: stage=submit code=OK");
  let ended = false;
  try {
    const completed = await waitFor(
      "managed two-node workflow",
      async () => WorkflowDetailSchema.parse(await request(`/workflows/${created.runId}`)),
      (run) => terminal(run.status),
      8 * 60_000,
    );
    ended = true;
    console.log(`Spack managed workflow: stage=terminal status=${completed.status}`);
    if (completed.status !== "completed") {
      for (const nodeId of ["compute", "verify"]) {
        const jobId = completed.stepJobs[nodeId];
        let code = "JOB_NOT_CREATED";
        if (jobId) {
          try {
            const job = JobSchema.parse(await request(`/jobs/${jobId}`));
            code = workflowJobFailureCode(job.errorMessage);
          } catch {
            code = "DIAGNOSTIC_UNAVAILABLE";
          }
        }
        console.log(`Spack managed workflow: stage=diagnostic node=${nodeId} code=${code}`);
      }
    }
    const receipt = assertWorkflowCompleted(completed, created.runId);
    await verifyJobs(request, receipt);
    console.log("Spack managed workflow: stage=execute code=OK");
    return receipt;
  } finally {
    if (!ended) {
      const current = WorkflowDetailSchema.parse(await request(`/workflows/${created.runId}`));
      if (!terminal(current.status)) {
        await request(`/workflows/${created.runId}/cancel`, {});
        await waitFor(
          "workflow cleanup cancellation",
          async () => WorkflowDetailSchema.parse(await request(`/workflows/${created.runId}`)),
          (run) => terminal(run.status),
        );
      }
    }
  }
}
