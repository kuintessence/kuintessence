import assert from "node:assert/strict";
import { usecase, workflowDsl } from "@kuintessence/shared";
import { z } from "zod";
import { selectedCase } from "../spack-case/fixture";
import { buildManagedWorkflowScript } from "./jobs";

export const WorkflowAssetsSchema = z.strictObject({
  usecaseId: z.string().uuid(),
  softwareRevisionId: z.string().uuid(),
});
export type WorkflowAssets = z.infer<typeof WorkflowAssetsSchema>;
export const WorkflowReceiptSchema = z.strictObject({
  runId: z.string().uuid(),
  jobs: z.strictObject({ compute: z.string().uuid(), verify: z.string().uuid() }),
});
export type WorkflowReceipt = z.infer<typeof WorkflowReceiptSchema>;
export const WorkflowDetailSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "submitted", "queued", "awaiting_approval", "running", "cancelling",
    "completed", "failed", "cancelled",
  ]),
  stepJobs: z.record(z.string(), z.string().uuid()),
  result: z.object({
    status: z.record(z.string(), z.string()),
    values: z.record(z.string(), z.object({
      status: z.string(),
      values: z.record(z.string(), z.unknown()),
    })),
  }).nullable(),
});

export function managedWorkflowPackage() {
  const fixture = selectedCase();
  return usecase.GovernedUsecasePackageSchema.parse({
    usecase: {
      commandFile: "/bin/bash",
      inputSlots: [
        { kind: "Text", descriptor: "script", refMaterials: [{ kind: "ArgRef", descriptor: "script", sort: 0 }] },
        { kind: "Text", descriptor: "prior", refMaterials: [{ kind: "ArgRef", descriptor: "prior", sort: 1 }] },
      ],
    },
    software: { kind: "Spack", name: fixture.spec, argumentList: [] },
    arguments: [
      { descriptor: "script", valueFormat: "--noprofile --norc -c {} kq-workflow" },
      { descriptor: "prior", valueFormat: "{}" },
    ],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [{
      descriptor: "count", type: "int",
      from: { collectedOutDescriptor: "stdout" },
      extract: { kind: "Regex", pattern: "KQ_WORKFLOW_VALUE=([0-9]+)", group: 1 },
      onMissing: "Fail",
    }],
    description: `Managed ${fixture.name} two-node workflow acceptance`,
    domain: "HPC",
    tags: ["spack", "managed", "acceptance"],
    citations: [],
    softwareRef: { source: "platform-fork", name: fixture.name, version: fixture.version },
    inputs: [
      { descriptor: "script", type: "String", required: true },
      { descriptor: "prior", type: "Integer", required: true },
    ],
    outputs: [{ descriptor: "count", type: "Integer", validators: [] }],
    resources: { cpu: 2, memoryMiB: 1024, walltimeSeconds: 120 },
    materialMappings: [
      { kind: "argv", descriptor: "script", template: "--noprofile --norc -c {} kq-workflow" },
      { kind: "argv", descriptor: "prior", template: "{}" },
    ],
    licenseRequirements: [],
  });
}

export function managedWorkflow(assets: WorkflowAssets, queueId: string, prefix: string) {
  WorkflowAssetsSchema.parse(assets);
  z.string().uuid().parse(queueId);
  const script = buildManagedWorkflowScript(prefix);
  return workflowDsl.WorkflowSchema.parse({
    name: `pr_managed_${selectedCase().id}_workflow`,
    parameters: [
      { name: "script", type: "string", default: script },
    ],
    spec: {
      nodeDrafts: ["compute", "verify"].map((id) => ({
        type: "SoftwareUsecaseComputing",
        id,
        name: `managed_${id}`,
        usecaseVersionId: assets.usecaseId,
        softwareVersionId: assets.softwareRevisionId,
        schedulingStrategy: { type: "Manual", queues: [queueId] },
        requirements: { cpuCores: 2, maxWallTime: 120 },
        inputSlots: [
          {
            type: "Text", descriptor: "script",
            // The second node must consume the first result, not just depend on its status.
            from: { expr: id === "compute"
              ? "'set -e; test \"$1\" = 0; ' + params.script"
              : "'set -e; test \"$1\" = 3; ' + params.script" },
          },
          {
            type: "Text", descriptor: "prior",
            from: id === "compute" ? { expr: "0" } : { node: "compute", output: "count" },
          },
        ],
      })),
      nodeRelations: [{ fromId: "compute", toId: "verify", slotRelations: [] }],
    },
  });
}

export function assertWorkflowCompleted(value: unknown, runId: string): WorkflowReceipt {
  const run = WorkflowDetailSchema.parse(value);
  assert.equal(run.id, runId);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.result?.status, { compute: "Succeeded", verify: "Succeeded" });
  assert.deepEqual(Object.keys(run.result?.values ?? {}).sort(), ["compute", "verify"]);
  for (const id of ["compute", "verify"]) {
    assert.equal(run.result?.values[id]?.status, "Succeeded");
    assert.deepEqual(run.result?.values[id]?.values, { count: 3 });
  }
  assert.deepEqual(Object.keys(run.stepJobs).sort(), ["compute", "verify"]);
  assert.notEqual(run.stepJobs.compute, run.stepJobs.verify);
  return WorkflowReceiptSchema.parse({ runId, jobs: run.stepJobs });
}
