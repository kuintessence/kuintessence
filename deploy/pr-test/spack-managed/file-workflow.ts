import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { waitFor } from "../runtime";
import { jsonRequest } from "../spack-case/api";
import {
  assertFileWorkflowCompleted,
  expectedReport,
  FileWorkflowAssetsSchema,
  type FileWorkflowInput,
  FileWorkflowReceiptSchema,
  fileWorkflow,
  syntheticSam,
} from "./file-workflow-contract";
import {
  FileSnapshotSchema,
  type FileSnapshot,
  fileWorkflowNetdrive,
} from "./file-workflow-netdrive";
import { WorkflowDetailSchema, workflowJobFailureCode } from "./workflow-contract";

const origin = "https://server:3443";
const nodes = ["convert", "sort", "verify"] as const;
const artifacts = ["bam", "sorted", "index", "report"] as const;
const producer = { bam: "convert", sorted: "sort", index: "sort", report: "verify" } as const;
const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const JobSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string(),
  agentId: z.string().nullable(),
  schedulerJobId: z.string().nullable(),
  usecasePackageId: z.string().uuid().nullable(),
  workingDir: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  errorMessage: z.string().nullable().optional(),
});
export const FileWorkflowStateSchema = z.strictObject({
  receipt: FileWorkflowReceiptSchema,
  snapshots: z.strictObject({
    input: FileSnapshotSchema,
    bam: FileSnapshotSchema,
    sorted: FileSnapshotSchema,
    index: FileSnapshotSchema,
    report: FileSnapshotSchema,
  }),
});
export type FileWorkflowState = z.infer<typeof FileWorkflowStateSchema>;
type Receipt = z.infer<typeof FileWorkflowReceiptSchema>;
type Assets = z.infer<typeof FileWorkflowAssetsSchema>;
type Request = (path: string, body?: unknown) => Promise<unknown>;

function guard() {
  assert.equal(process.env.KQ_PR_TEST, "1");
  assert.equal(process.env.KQ_PR_SPACK_WORKFLOW, "1");
  assert.equal(process.env.KQ_PR_SPACK_FILE_WORKFLOW, "1");
  assert.equal(process.env.KQ_PR_SPACK_CASE, "samtools");
}

async function assets() {
  return FileWorkflowAssetsSchema.parse(
    JSON.parse(await readFile("/case-control/file-workflow-assets.json", "utf8")),
  );
}

function marker(stage: string) {
  console.log(`Spack file workflow: stage=${stage} code=OK`);
}

export function assertFileWorkflowIdentity(value: unknown, runId: string) {
  const run = WorkflowDetailSchema.parse(value);
  assert.equal(run.id, runId);
  return run;
}

export function invalidSamRejected(exitCode: number | null, text: string): boolean {
  const lines = new Set(text.split(/\r?\n/));
  return exitCode === 1 &&
    lines.has("KQ_FILE_WORKFLOW_CONVERT_STARTED") &&
    lines.has('[main_samview] fail to read the header from "input.sam".') &&
    !lines.has("KQ_FILE_WORKFLOW_CONVERT_OK");
}

async function verifyJobs(request: Request, receipt: Receipt, registered: Assets) {
  const directories = new Set<string>();
  const schedulerIds = new Set<string>();
  for (const node of nodes) {
    const job = JobSchema.parse(await request(`/jobs/${receipt.jobs[node]}`));
    assert.equal(job.id, receipt.jobs[node]);
    assert.equal(job.status, "completed");
    assert.equal(job.agentId, "pr-scheduler");
    assert.equal(job.name, `managed_file_${node}`);
    assert.equal(job.usecasePackageId, registered.usecases[node]);
    assert.equal(job.exitCode, 0);
    assert(job.schedulerJobId && /^[1-9][0-9]*$/.test(job.schedulerJobId));
    assert(job.workingDir !== null && job.workingDir.startsWith("/"));
    directories.add(job.workingDir);
    schedulerIds.add(job.schedulerJobId);
    await waitFor(
      "file workflow retained logs",
      async () => z.object({ text: z.string() }).parse(
        await request(`/jobs/${job.id}/logs?lines=50`),
      ),
      ({ text }) => text.split(/\r?\n/).includes(`KQ_FILE_WORKFLOW_${node.toUpperCase()}_OK`),
    );
    marker(`job-${node}`);
  }
  assert.equal(directories.size, 3);
  assert.equal(schedulerIds.size, 3);
  marker("distinct-workspaces");
}

export function assertArtifactBytes(kind: typeof artifacts[number], bytes: Buffer) {
  if (kind === "report") {
    assert.equal(bytes.toString("utf8"), expectedReport);
  } else if (kind === "index") {
    assert.equal(bytes.subarray(0, 4).toString("binary"), "BAI\x01");
    assert(bytes.length > 8);
    assert.equal(bytes.readInt32LE(4), 1);
  } else {
    const bam = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 });
    assert.equal(bam.subarray(0, 4).toString("binary"), "BAM\x01");
    assert(bam.includes(Buffer.from("chrSynthetic")));
    for (const read of ["read1", "read2", "read3"]) {
      assert(bam.includes(Buffer.from(`${read}\0`)));
    }
  }
}

async function verifyFiles(token: string, receipt: Receipt, previous?: FileWorkflowState) {
  const netdrive = fileWorkflowNetdrive(token);
  const input = await netdrive.download(receipt.input.fileMetadataId, previous?.snapshots.input);
  assert.equal(input.bytes.toString("utf8"), syntheticSam);
  const snapshots: Partial<Record<typeof artifacts[number], FileSnapshot>> = {};
  for (const kind of artifacts) {
    const ref = receipt.files[kind];
    const { snapshot, bytes } = await netdrive.download(
      ref.fileMetadataId, previous?.snapshots[kind],
    );
    assert.equal(snapshot.path,
      `workflow-runs/${receipt.runId}/jobs/${receipt.jobs[producer[kind]]}/${kind}-${ref.fileMetadataName}`);
    assertArtifactBytes(kind, bytes);
    snapshots[kind] = snapshot;
    marker(`download-${kind}`);
  }
  const listed = await netdrive.list(receipt.runId);
  assert.deepEqual(
    listed.map((file) => file.id).sort(),
    artifacts.map((kind) => receipt.files[kind].fileMetadataId).sort(),
  );
  return FileWorkflowStateSchema.parse({
    receipt,
    snapshots: { input: input.snapshot, ...snapshots },
  });
}

export async function verifyFileWorkflow(token: string, saved: FileWorkflowState) {
  guard();
  const request: Request = (path, body) => jsonRequest(origin, token, path, body);
  assert.deepEqual(
    assertFileWorkflowCompleted(
      await request(`/workflows/${saved.receipt.runId}`),
      saved.receipt.runId,
      saved.receipt.input,
    ),
    saved.receipt,
  );
  marker("readback-receipt");
  await verifyJobs(request, saved.receipt, await assets());
  assert.deepEqual(await verifyFiles(token, saved.receipt, saved), saved);
  marker("readback");
}

async function executeFileWorkflow(
  token: string, queueId: string, prefix: string, input: FileWorkflowInput,
) {
  const registered = await assets();
  const request: Request = (path, body) => jsonRequest(origin, token, path, body);
  const created = z.object({ runId: z.string().uuid() }).parse(
    await request("/workflows", {
      yaml: JSON.stringify(fileWorkflow(registered, queueId, prefix, input)),
    }),
  );
  marker("submit");
  let ended = false;
  try {
    const completed = await waitFor(
      "managed file workflow",
      async () => assertFileWorkflowIdentity(
        await request(`/workflows/${created.runId}`), created.runId,
      ),
      (run) => terminal(run.status),
      12 * 60_000,
    );
    ended = true;
    console.log(`Spack file workflow: stage=terminal status=${completed.status}`);
    if (completed.status !== "completed") {
      for (const node of nodes) {
        const id = completed.stepJobs[node];
        const code = id
          ? workflowJobFailureCode(JobSchema.parse(await request(`/jobs/${id}`)).errorMessage)
          : "JOB_NOT_CREATED";
        console.log(`Spack file workflow: stage=diagnostic node=${node} code=${code}`);
      }
    }
    return { completed, registered };
  } finally {
    if (!ended) {
      const current = WorkflowDetailSchema.parse(await request(`/workflows/${created.runId}`));
      if (!terminal(current.status)) {
        await request(`/workflows/${created.runId}/cancel`, {});
        await waitFor(
          "file workflow cancellation",
          async () => WorkflowDetailSchema.parse(await request(`/workflows/${created.runId}`)),
          (run) => terminal(run.status),
        );
      }
    }
  }
}

export async function runFileWorkflow(token: string, queueId: string, prefix: string) {
  guard();
  const input = await fileWorkflowNetdrive(token).upload(syntheticSam);
  marker("upload");
  const { completed, registered } = await executeFileWorkflow(token, queueId, prefix, input);
  const receipt = assertFileWorkflowCompleted(completed, completed.id, input);
  await verifyJobs((path, body) => jsonRequest(origin, token, path, body), receipt, registered);
  const saved = await verifyFiles(token, receipt);
  marker("execute");
  return saved;
}

export async function cleanupFileWorkflow(token: string, saved: FileWorkflowState) {
  guard();
  const netdrive = fileWorkflowNetdrive(token);
  for (const snapshot of Object.values(saved.snapshots)) {
    await netdrive.remove(snapshot.id);
  }
  assert.equal((await netdrive.list(saved.receipt.runId)).length, 0);
  marker("cleanup");
}

export async function rejectInvalidFileWorkflow(token: string, queueId: string, prefix: string) {
  guard();
  const netdrive = fileWorkflowNetdrive(token);
  const invalid = "not-a-SAM-record\n";
  const input = await netdrive.upload(invalid);
  const { completed } = await executeFileWorkflow(token, queueId, prefix, input);
  assert.equal(completed.status, "failed");
  assert.deepEqual(completed.result?.status, {
    convert: "Failed", sort: "Cancelled", verify: "Cancelled",
  });
  assert.deepEqual(Object.keys(completed.stepJobs), ["convert"]);
  const jobId = completed.stepJobs.convert;
  assert(jobId);
  const job = JobSchema.parse(await jsonRequest(origin, token, `/jobs/${jobId}`));
  assert.equal(job.status, "failed");
  assert.equal(job.agentId, "pr-scheduler");
  assert(job.schedulerJobId && /^[1-9][0-9]*$/.test(job.schedulerJobId));
  const { text } = z.object({ text: z.string() }).parse(
    await jsonRequest(origin, token, `/jobs/${jobId}/logs?lines=50`),
  );
  assert(invalidSamRejected(job.exitCode, text));
  assert.equal((await netdrive.list(completed.id)).length, 0);
  await netdrive.remove(input.fileMetadataId);
  marker("invalid-input-blocked");
}
