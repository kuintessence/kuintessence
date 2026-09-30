import assert from "node:assert/strict";
import { usecase, workflowDsl } from "@kuintessence/shared";
import { z } from "zod";
import { SpackInstallPathSchema } from "../../../packages/agent/src/spack/install-contract";
import { selectedCase } from "../spack-case/fixture";
import { WorkflowDetailSchema } from "./workflow-contract";

export const fileWorkflowNodes = ["convert", "sort", "verify"] as const;
export type FileWorkflowNodeId = (typeof fileWorkflowNodes)[number];
const NodeIdSchema = z.enum(fileWorkflowNodes);
export const FileRefSchema = z.strictObject({
  fileMetadataId: z.string().uuid(),
  fileMetadataName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
});
export type FileRef = z.infer<typeof FileRefSchema>;
export const FileWorkflowInputSchema = FileRefSchema.extend({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().max(1024 * 1024),
});
export type FileWorkflowInput = z.infer<typeof FileWorkflowInputSchema>;
const ReceiptInputSchema = z.union([FileRefSchema, FileWorkflowInputSchema]);
export const FileWorkflowAssetsSchema = z.strictObject({
  softwareRevisionId: z.string().uuid(),
  usecases: z.strictObject({
    convert: z.string().uuid(),
    sort: z.string().uuid(),
    verify: z.string().uuid(),
  }),
});
export type FileWorkflowAssets = z.infer<typeof FileWorkflowAssetsSchema>;
export const FileWorkflowReceiptSchema = z.strictObject({
  runId: z.string().uuid(),
  jobs: z.strictObject({
    convert: z.string().uuid(),
    sort: z.string().uuid(),
    verify: z.string().uuid(),
  }),
  files: z.strictObject({
    bam: FileRefSchema.extend({ fileMetadataName: z.literal("unsorted.bam") }),
    sorted: FileRefSchema.extend({ fileMetadataName: z.literal("sorted.bam") }),
    index: FileRefSchema.extend({ fileMetadataName: z.literal("sorted.bam.bai") }),
    report: FileRefSchema.extend({ fileMetadataName: z.literal("report.txt") }),
  }),
  input: FileRefSchema,
}).refine((value) => new Set(Object.values(value.jobs)).size === 3, {
  message: "File workflow requires three distinct jobs",
}).refine((value) => new Set([
  value.input.fileMetadataId,
  ...Object.values(value.files).map((file) => file.fileMetadataId),
]).size === 5, {
  message: "File workflow requires distinct input and output file identities",
});
export type FileWorkflowReceipt = z.infer<typeof FileWorkflowReceiptSchema>;

export const syntheticSam = [
  "@HD\tVN:1.6\tSO:unsorted",
  "@SQ\tSN:chrSynthetic\tLN:200",
  "read3\t0\tchrSynthetic\t100\t60\t10M\t*\t0\t0\tGGGGGTTTTT\tIIIIIIIIII",
  "read1\t0\tchrSynthetic\t10\t60\t10M\t*\t0\t0\tACGTACGTAA\tIIIIIIIIII",
  "read2\t0\tchrSynthetic\t30\t60\t10M\t*\t0\t0\tTTGCAACGTT\tIIIIIIIIII",
  "",
].join("\n");
export const expectedReport = "count=3\nregion=2\n";

const inputFiles: Record<FileWorkflowNodeId, Record<string, string>> = {
  convert: { sam: "input.sam" },
  sort: { bam: "unsorted.bam" },
  verify: { sorted: "sorted.bam", index: "sorted.bam.bai" },
};
const outputFiles: Record<FileWorkflowNodeId, Record<string, string>> = {
  convert: { bam: "unsorted.bam" },
  sort: { sorted: "sorted.bam", index: "sorted.bam.bai" },
  verify: { report: "report.txt" },
};

function samtoolsFixture() {
  const fixture = selectedCase();
  assert.equal(fixture.id, "samtools", "File workflow requires the samtools acceptance case");
  assert.equal(fixture.version, "1.19.2");
  return fixture;
}

function fileWorkflowScript(nodeId: FileWorkflowNodeId): string {
  const commands: Record<FileWorkflowNodeId, string[]> = {
    convert: [
      'test -s input.sam',
      "printf '%s\\n' 'KQ_FILE_WORKFLOW_CONVERT_STARTED'",
      '"$binary" view -b -o unsorted.bam input.sam 2>&1',
      'test -s unsorted.bam',
    ],
    sort: [
      'test -s unsorted.bam',
      '"$binary" sort -@ 1 -m 64M -T ./sort-tmp -o sorted.bam unsorted.bam',
      '"$binary" index -@ 1 sorted.bam',
      'test -s sorted.bam',
      'test -s sorted.bam.bai',
    ],
    verify: [
      'test -s sorted.bam',
      'test -s sorted.bam.bai',
      '"$binary" quickcheck -v sorted.bam',
      'count="$("$binary" view -c sorted.bam)"',
      'region="$("$binary" view -c sorted.bam chrSynthetic:1-50)"',
      'test "$count" = 3',
      'test "$region" = 2',
      'printf \'count=%s\\nregion=%s\\n\' "$count" "$region" > report.txt',
    ],
  };
  return [
    "set -euo pipefail",
    "umask 077",
    "export LANG=C LC_ALL=C",
    'binary="$(command -v samtools)"',
    'test "$binary" = "$1/bin/samtools"',
    'test -x "$binary"',
    '"$binary" --version > version.txt',
    "IFS= read -r version < version.txt",
    'test "$version" = "samtools 1.19.2"',
    ...commands[nodeId],
    `printf '%s\\n' 'KQ_FILE_WORKFLOW_${nodeId.toUpperCase()}_OK'`,
  ].join("\n");
}

export function fileWorkflowPackage(nodeId: FileWorkflowNodeId) {
  NodeIdSchema.parse(nodeId);
  const fixture = samtoolsFixture();
  const inputs = Object.entries(inputFiles[nodeId]);
  const outputs = Object.entries(outputFiles[nodeId]);
  return usecase.GovernedUsecasePackageSchema.parse({
    usecase: {
      commandFile: "/bin/bash",
      inputSlots: [
        { kind: "Text", descriptor: "script", refMaterials: [{ kind: "ArgRef", descriptor: "script", sort: 0 }] },
        { kind: "Text", descriptor: "prefix", refMaterials: [{ kind: "ArgRef", descriptor: "prefix", sort: 1 }] },
        ...inputs.map(([descriptor]) => ({
          kind: "File", descriptor, refMaterials: [{ kind: "FileInputRef", descriptor }],
        })),
      ],
    },
    software: { kind: "Spack", name: fixture.spec, argumentList: [] },
    arguments: [
      { descriptor: "script", valueFormat: "--noprofile --norc -c {} kq-file-workflow" },
      { descriptor: "prefix", valueFormat: "{}" },
    ],
    environments: [],
    filesomeInputs: inputs.map(([descriptor, name]) => ({
      descriptor, fileKind: { kind: "Normal", name },
    })),
    filesomeOutputs: outputs.map(([descriptor, name]) => ({
      descriptor, fileKind: { kind: "Normal", name },
    })),
    valueOutputs: nodeId === "verify" ? ["count", "region"].map((descriptor, index) => ({
      descriptor,
      type: "int",
      from: { collectedOutDescriptor: "report" },
      // Unlike $, this end assertion also rejects an extra trailing newline.
      extract: {
        kind: "Regex",
        pattern: "^count=(3)\\nregion=(2)\\n(?![\\s\\S])",
        group: index + 1,
      },
      onMissing: "Fail",
    })) : [],
    description: `Managed samtools ${nodeId} file workflow acceptance`,
    domain: "HPC",
    tags: ["spack", "managed", "file-workflow"],
    citations: [],
    softwareRef: { source: "platform-fork", name: fixture.name, version: fixture.version },
    inputs: [
      { descriptor: "script", type: "String", required: true },
      { descriptor: "prefix", type: "String", required: true },
      ...inputs.map(([descriptor]) => ({ descriptor, type: "File", required: true })),
    ],
    outputs: [
      ...outputs.map(([descriptor]) => ({ descriptor, type: "File", validators: [] })),
      ...(nodeId === "verify"
        ? ["count", "region"].map((descriptor) => ({ descriptor, type: "Integer", validators: [] }))
        : []),
    ],
    resources: { cpu: 2, memoryMiB: 1024, walltimeSeconds: 120 },
    materialMappings: [
      { kind: "argv", descriptor: "script", template: "--noprofile --norc -c {} kq-file-workflow" },
      { kind: "argv", descriptor: "prefix", template: "{}" },
      ...inputs.map(([descriptor, path]) => ({ kind: "file", descriptor, path, direction: "input" })),
      ...outputs.map(([descriptor, path]) => ({ kind: "file", descriptor, path, direction: "output" })),
    ],
    licenseRequirements: [],
  });
}

export function fileWorkflow(
  assets: FileWorkflowAssets,
  queueId: string,
  prefix: string,
  inputRef: FileWorkflowInput,
) {
  const checkedAssets = FileWorkflowAssetsSchema.parse(assets);
  z.string().uuid().parse(queueId);
  SpackInstallPathSchema.parse(prefix);
  const input = FileWorkflowInputSchema.parse(inputRef);
  samtoolsFixture();
  const fileSlots = {
    convert: [{
      type: "File", descriptor: "sam", isBatch: false,
      contents: [input],
    }],
    sort: [{
      type: "File", descriptor: "bam", isBatch: false,
      from: { node: "convert", output: "bam" },
    }],
    verify: ["sorted", "index"].map((descriptor) => ({
      type: "File", descriptor, isBatch: false, from: { node: "sort", output: descriptor },
    })),
  };
  return workflowDsl.WorkflowSchema.parse({
    name: "pr_managed_samtools_file_workflow",
    parameters: [
      { name: "prefix", type: "string", default: prefix },
      ...fileWorkflowNodes.map((nodeId) => ({
        name: `${nodeId}Script`, type: "string", default: fileWorkflowScript(nodeId),
      })),
    ],
    spec: {
      nodeDrafts: fileWorkflowNodes.map((nodeId) => ({
        type: "SoftwareUsecaseComputing",
        id: nodeId,
        name: `managed_file_${nodeId}`,
        usecaseVersionId: checkedAssets.usecases[nodeId],
        softwareVersionId: checkedAssets.softwareRevisionId,
        schedulingStrategy: { type: "Manual", queues: [queueId] },
        requirements: { cpuCores: 2, maxWallTime: 120 },
        inputSlots: [
          { type: "Text", descriptor: "script", from: { param: `${nodeId}Script` } },
          { type: "Text", descriptor: "prefix", from: { param: "prefix" } },
          ...fileSlots[nodeId],
        ],
        outputSlots: Object.keys(outputFiles[nodeId]).map((descriptor) => ({
          type: "File", descriptor, optional: false, origin: "UsecaseOut", isBatch: false,
        })),
      })),
      nodeRelations: [
        { fromId: "convert", toId: "sort", slotRelations: [] },
        { fromId: "sort", toId: "verify", slotRelations: [] },
      ],
    },
  });
}

const ResultValuesSchema = z.strictObject({
  convert: z.strictObject({
    status: z.literal("Succeeded"),
    values: z.strictObject({ bam: FileRefSchema }),
  }),
  sort: z.strictObject({
    status: z.literal("Succeeded"),
    values: z.strictObject({ sorted: FileRefSchema, index: FileRefSchema }),
  }),
  verify: z.strictObject({
    status: z.literal("Succeeded"),
    values: z.strictObject({ report: FileRefSchema, count: z.literal(3), region: z.literal(2) }),
  }),
});

export function assertFileWorkflowCompleted(
  value: unknown,
  runId: string,
  inputRef: FileRef | FileWorkflowInput,
): FileWorkflowReceipt {
  const run = WorkflowDetailSchema.parse(value);
  assert.equal(run.id, runId);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.result?.status, { convert: "Succeeded", sort: "Succeeded", verify: "Succeeded" });
  const values = ResultValuesSchema.parse(run.result?.values);
  const input = ReceiptInputSchema.parse(inputRef);
  return FileWorkflowReceiptSchema.parse({
    runId,
    jobs: run.stepJobs,
    files: {
      bam: values.convert.values.bam,
      sorted: values.sort.values.sorted,
      index: values.sort.values.index,
      report: values.verify.values.report,
    },
    input: { fileMetadataId: input.fileMetadataId, fileMetadataName: input.fileMetadataName },
  });
}
