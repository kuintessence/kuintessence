import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  createUsecaseExecutor,
  runWorkflow,
  SPACK_EXECUTION_PLACEHOLDER,
  type UsecaseExecutorDeps,
  usecase,
  workflowDsl,
} from "@kuintessence/shared";
import { selectedCase } from "../spack-case/fixture";
import {
  assertFileWorkflowCompleted,
  type FileRef,
  FileRefSchema,
  FileWorkflowAssetsSchema,
  FileWorkflowInputSchema,
  type FileWorkflowNodeId,
  FileWorkflowReceiptSchema,
  expectedReport,
  fileWorkflow,
  fileWorkflowNodes,
  fileWorkflowPackage,
  syntheticSam,
} from "./file-workflow-contract";

const previous = process.env.KQ_PR_SPACK_CASE;
const assets = {
  softwareRevisionId: randomUUID(),
  usecases: { convert: randomUUID(), sort: randomUUID(), verify: randomUUID() },
};
const queueId = randomUUID();
const prefix = "/srv/kq/spack/releases/11111111-1111-4111-8111-111111111111/root";
const file = (fileMetadataName: string): FileRef => ({ fileMetadataId: randomUUID(), fileMetadataName });
const input = file("synthetic.sam");
const uploadedInput = {
  ...input,
  hash: createHash("sha256").update(syntheticSam, "utf8").digest("hex"),
  size: Buffer.byteLength(syntheticSam, "utf8"),
};
const files = {
  bam: file("unsorted.bam"),
  sorted: file("sorted.bam"),
  index: file("sorted.bam.bai"),
  report: file("report.txt"),
};

beforeEach(() => {
  process.env.KQ_PR_SPACK_CASE = "samtools";
});
afterEach(() => {
  if (previous === undefined) delete process.env.KQ_PR_SPACK_CASE;
  else process.env.KQ_PR_SPACK_CASE = previous;
});

function nodeInputs(nodeId: FileWorkflowNodeId) {
  const workflow = fileWorkflow(assets, queueId, prefix, uploadedInput);
  const script = workflow.parameters.find((parameter) => parameter.name === `${nodeId}Script`)?.default;
  if (typeof script !== "string") throw new Error("Missing script parameter");
  const references: Record<FileWorkflowNodeId, Record<string, FileRef>> = {
    convert: { sam: input },
    sort: { bam: files.bam },
    verify: { sorted: files.sorted, index: files.index },
  };
  return { script, prefix, ...references[nodeId] };
}

function completed() {
  return {
    id: randomUUID(),
    status: "completed",
    stepJobs: { convert: randomUUID(), sort: randomUUID(), verify: randomUUID() },
    result: {
      status: { convert: "Succeeded", sort: "Succeeded", verify: "Succeeded" },
      values: {
        convert: { status: "Succeeded", values: { bam: files.bam } },
        sort: { status: "Succeeded", values: { sorted: files.sorted, index: files.index } },
        verify: { status: "Succeeded", values: { report: files.report, count: 3, region: 2 } },
      },
    },
  };
}

describe("managed samtools file workflow contract", () => {
  test("exports the unsorted three-read SAM and binds its exact bytes as static contents", () => {
    const lines = syntheticSam.trimEnd().split("\n");
    expect(lines.slice(0, 2)).toEqual(["@HD\tVN:1.6\tSO:unsorted", "@SQ\tSN:chrSynthetic\tLN:200"]);
    expect(lines.slice(2).map((line) => line.split("\t")[3])).toEqual(["100", "10", "30"]);
    expect(lines.slice(2).every((line) => line.split("\t").length === 11)).toBe(true);
    const workflow = fileWorkflow(assets, queueId, prefix, uploadedInput);
    const node = workflow.spec.nodeDrafts[0];
    if (node?.type !== "SoftwareUsecaseComputing") throw new Error("Missing convert node");
    expect(node.inputSlots?.find((slot) => slot.descriptor === "sam")).toMatchObject({
      type: "File",
      isBatch: false,
      contents: [{
        ...input,
        hash: createHash("sha256").update(syntheticSam, "utf8").digest("hex"),
        size: Buffer.byteLength(syntheticSam, "utf8"),
      }],
    });
    expect(workflow.spec.nodeRelations).toEqual([
      { fromId: "convert", toId: "sort", slotRelations: [] },
      { fromId: "sort", toId: "verify", slotRelations: [] },
    ]);
    const fileBindings = workflow.spec.nodeDrafts.flatMap((draft) =>
      draft.type === "SoftwareUsecaseComputing"
        ? (draft.inputSlots ?? []).filter((slot) => slot.type === "File" && slot.from)
        : [],
    );
    expect(fileBindings.map((slot) => ({ descriptor: slot.descriptor, from: slot.from }))).toEqual([
      { descriptor: "bam", from: { node: "convert", output: "bam" } },
      { descriptor: "sorted", from: { node: "sort", output: "sorted" } },
      { descriptor: "index", from: { node: "sort", output: "index" } },
    ]);
  });

  test("preserves uploaded negative-fixture metadata but never includes it in the receipt", () => {
    const text = "not-a-SAM-record\n";
    const negativeInput = {
      ...input,
      hash: createHash("sha256").update(text, "utf8").digest("hex"),
      size: Buffer.byteLength(text, "utf8"),
    };
    const workflow = fileWorkflow(assets, queueId, prefix, negativeInput);
    const node = workflow.spec.nodeDrafts[0];
    if (node?.type !== "SoftwareUsecaseComputing") throw new Error("Missing convert node");
    expect(node.inputSlots?.find((slot) => slot.descriptor === "sam")).toMatchObject({
      contents: [negativeInput],
    });
    const value = completed();
    expect(assertFileWorkflowCompleted(value, value.id, negativeInput).input).toEqual(input);
    expect(negativeInput.hash).not.toBe(createHash("sha256").update(syntheticSam, "utf8").digest("hex"));
    expect(FileWorkflowInputSchema.safeParse({ ...input, hash: negativeInput.hash }).success).toBe(false);
    expect(FileWorkflowInputSchema.safeParse(input).success).toBe(false);
    expect(() => fileWorkflow(assets, queueId, prefix, { ...negativeInput, hash: "invalid" })).toThrow();
  });

  test("bounds the supplied byte size to one MiB", () => {
    const limit = 1024 * 1024;
    expect(FileWorkflowInputSchema.safeParse({ ...uploadedInput, size: limit }).success).toBe(true);
    for (const size of [-1, 0.5, limit + 1]) {
      expect(() => fileWorkflow(assets, queueId, prefix, { ...uploadedInput, size })).toThrow();
    }
  });

  test.each(fileWorkflowNodes)("%s materializes governed paths without requiring a registration prefix", (nodeId) => {
    const pkg = fileWorkflowPackage(nodeId);
    expect(usecase.GovernedUsecasePackageSchema.safeParse(pkg).success).toBe(true);
    expect(pkg.software).toEqual({ kind: "Spack", name: selectedCase().spec, argumentList: [] });
    expect(pkg.softwareRef).toEqual({ source: "platform-fork", name: "samtools", version: "1.19.2" });
    expect(JSON.stringify(pkg)).not.toContain(prefix);
    const inputs = nodeInputs(nodeId);
    const task = usecase.materialize({ ...pkg, inputs });
    expect(task.argv).toEqual([
      "/bin/bash", "--noprofile", "--norc", "-c", inputs.script, "kq-file-workflow", prefix,
    ]);
    const staging = {
      convert: [{ fileMetadataId: input.fileMetadataId, stagePath: "input.sam" }],
      sort: [{ fileMetadataId: files.bam.fileMetadataId, stagePath: "unsorted.bam" }],
      verify: [
        { fileMetadataId: files.sorted.fileMetadataId, stagePath: "sorted.bam" },
        { fileMetadataId: files.index.fileMetadataId, stagePath: "sorted.bam.bai" },
      ],
    };
    const outputs = {
      convert: [{ descriptor: "bam", path: "unsorted.bam", isBatch: false }],
      sort: [
        { descriptor: "sorted", path: "sorted.bam", isBatch: false },
        { descriptor: "index", path: "sorted.bam.bai", isBatch: false },
      ],
      verify: [{ descriptor: "report", path: "report.txt", isBatch: false }],
    };
    expect(task.inputStaging).toEqual(staging[nodeId]);
    expect(task.expectedOutputs).toEqual(outputs[nodeId]);
    expect(inputs.script).toContain('binary="$(command -v samtools)"');
    expect(inputs.script).toContain('test "$binary" = "$1/bin/samtools"');
    expect(inputs.script).toContain('test "$version" = "samtools 1.19.2"');
    expect(inputs.script.split("\n").at(-1)).toBe(
      `printf '%s\\n' 'KQ_FILE_WORKFLOW_${nodeId.toUpperCase()}_OK'`,
    );
    for (const forbidden of [prefix, "mktemp", "cd ", "spack load", "export PATH"]) {
      expect(inputs.script).not.toContain(forbidden);
    }
  });

  test("passes actual File outputs along both dependencies with deferred managed activation", async () => {
    const calls: string[] = [];
    const result = await runWorkflow(fileWorkflow(assets, queueId, prefix, uploadedInput), createUsecaseExecutor({
      deferSpackActivation: true,
      resolvePackage: async (usecaseId, revisionId) => {
        expect(revisionId).toBe(assets.softwareRevisionId);
        const nodeId = fileWorkflowNodes.find((id) => assets.usecases[id] === usecaseId);
        if (!nodeId) throw new Error("Unknown usecase");
        return fileWorkflowPackage(nodeId);
      },
      submitJob: async (job): ReturnType<UsecaseExecutorDeps["submitJob"]> => {
        calls.push(job.nodeId);
        expect(job.name).toBe(`managed_file_${job.nodeId}`);
        expect(job.command).toBe(SPACK_EXECUTION_PLACEHOLDER);
        expect(job.spackExecution?.spec).toBe(selectedCase().spec);
        expect(job.schedulingStrategy).toEqual({ queueId });
        expect(job.spackExecution?.command).toContain("samtools 1.19.2");
        if (job.nodeId === "convert") {
          expect(job.inputStaging).toEqual([{ fileMetadataId: input.fileMetadataId, stagePath: "input.sam" }]);
          expect(job.expectedOutputs).toEqual([
            { descriptor: "bam", path: "unsorted.bam", isBatch: false, pathsOnly: true },
          ]);
          expect(job.fileOutputDescriptors).toEqual(["bam"]);
          return { jobId: randomUUID(), status: "completed", collected: {}, collectedFiles: { bam: files.bam } };
        }
        if (job.nodeId === "sort") {
          expect(calls).toEqual(["convert", "sort"]);
          expect(job.inputStaging).toEqual([{ fileMetadataId: files.bam.fileMetadataId, stagePath: "unsorted.bam" }]);
          expect(job.expectedOutputs).toEqual([
            { descriptor: "sorted", path: "sorted.bam", isBatch: false, pathsOnly: true },
            { descriptor: "index", path: "sorted.bam.bai", isBatch: false, pathsOnly: true },
          ]);
          expect(job.fileOutputDescriptors).toEqual(["sorted", "index"]);
          return {
            jobId: randomUUID(), status: "completed", collected: {},
            collectedFiles: { sorted: files.sorted, index: files.index },
          };
        }
        expect(job.nodeId).toBe("verify");
        expect(calls).toEqual(["convert", "sort", "verify"]);
        expect(job.inputStaging).toEqual([
          { fileMetadataId: files.sorted.fileMetadataId, stagePath: "sorted.bam" },
          { fileMetadataId: files.index.fileMetadataId, stagePath: "sorted.bam.bai" },
        ]);
        expect(job.expectedOutputs).toEqual([{ descriptor: "report", path: "report.txt", isBatch: false }]);
        expect(job.fileOutputDescriptors).toEqual(["report"]);
        return {
          jobId: randomUUID(), status: "completed", collected: { report: expectedReport },
          collectedFiles: { report: files.report },
        };
      },
    }));
    expect(calls).toEqual(["convert", "sort", "verify"]);
    expect(result).toEqual(completed().result);
  });

  test("does not advance when the producer omits its declared BAM", async () => {
    const calls: string[] = [];
    const result = await runWorkflow(fileWorkflow(assets, queueId, prefix, uploadedInput), createUsecaseExecutor({
      deferSpackActivation: true,
      resolvePackage: async () => fileWorkflowPackage("convert"),
      submitJob: async (job) => {
        calls.push(job.nodeId);
        return { jobId: randomUUID(), status: "completed", collected: {}, collectedFiles: {} };
      },
    }));
    expect(result.status.convert).toBe("Failed");
    expect(calls).toEqual(["convert"]);
  });

  test("marks convert start only after preflight and cancels downstream nodes on software failure", async () => {
    const script = nodeInputs("convert").script;
    const started = "printf '%s\\n' 'KQ_FILE_WORKFLOW_CONVERT_STARTED'";
    const view = '"$binary" view -b -o unsorted.bam input.sam 2>&1';
    expect(script).toContain(started);
    for (const preflight of [
      'test "$binary" = "$1/bin/samtools"',
      'test "$version" = "samtools 1.19.2"',
      "test -s input.sam",
    ]) {
      expect(script.indexOf(preflight)).toBeGreaterThanOrEqual(0);
      expect(script.indexOf(preflight)).toBeLessThan(script.indexOf(started));
    }
    expect(script.indexOf(started)).toBeLessThan(script.indexOf(view));
    expect(script.indexOf(view)).toBeLessThan(script.indexOf("KQ_FILE_WORKFLOW_CONVERT_OK"));
    const calls: string[] = [];
    const result = await runWorkflow(fileWorkflow(assets, queueId, prefix, uploadedInput), createUsecaseExecutor({
      deferSpackActivation: true,
      resolvePackage: async () => fileWorkflowPackage("convert"),
      submitJob: async (job) => {
        calls.push(job.nodeId);
        return {
          jobId: randomUUID(), status: "failed", exitCode: 1,
          collected: { stdout: "KQ_FILE_WORKFLOW_CONVERT_STARTED\n" },
        };
      },
    }));
    expect(calls).toEqual(["convert"]);
    expect(result.status).toEqual({ convert: "Failed", sort: "Cancelled", verify: "Cancelled" });
    for (const nodeId of fileWorkflowNodes) expect(result.values[nodeId]?.values).toEqual({});
  });

  test("extracts typed values only from the exact report, never loose stdout markers", () => {
    const outputs = fileWorkflowPackage("verify").valueOutputs;
    expect(expectedReport).toBe("count=3\nregion=2\n");
    expect(usecase.extractValues({ report: expectedReport }, outputs)).toEqual({ count: 3, region: 2 });
    for (const report of [
      "", expectedReport.trimEnd(), `${expectedReport}\n`,
      `untrusted\n${expectedReport}`, `${expectedReport}extra`,
      expectedReport.replace("count=3", "count=4"),
      expectedReport.replace("region=2", "region=3"),
    ]) {
      expect(() => usecase.extractValues({ report }, outputs)).toThrow();
    }
    expect(() => usecase.extractValues({ stdout: expectedReport }, outputs)).toThrow();
    const script = nodeInputs("verify").script;
    expect(script).toContain('"$binary" quickcheck -v sorted.bam');
    expect(script).toContain('test "$count" = 3');
    expect(script).toContain('test "$region" = 2');
    expect(script).toContain('"$count" "$region" > report.txt');
  });

  test("keeps unreferenced metadata and shell-looking argv values out of the script", () => {
    const inputs = nodeInputs("convert");
    const untrusted = "$(touch /tmp/not-executed) ' $& $` $'";
    const task = usecase.materialize({
      ...fileWorkflowPackage("convert"),
      inputs: {
        ...inputs, prefix: untrusted, unused: untrusted,
        sam: { fileMetadataId: input.fileMetadataId, fileMetadataName: untrusted },
      },
    });
    expect(task.argv[4]).toBe(inputs.script);
    expect(task.argv.at(-1)).toBe(untrusted);
    expect(task.argv).toHaveLength(7);
    expect(task.inputStaging).toEqual([{ fileMetadataId: input.fileMetadataId, stagePath: "input.sam" }]);
    expect(task.envVars).toEqual({});
    expect(inputs.script).not.toContain(untrusted);
    expect(() => fileWorkflow(assets, queueId, untrusted, uploadedInput)).toThrow();
  });

  test("returns only exact public receipt identities and rejects invalid result mappings", () => {
    const value = completed();
    const receipt = assertFileWorkflowCompleted(value, value.id, input);
    expect(receipt).toEqual({ runId: value.id, jobs: value.stepJobs, files, input });
    expect(FileWorkflowReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    for (const change of [
      { status: "failed" },
      { stepJobs: { ...value.stepJobs, verify: value.stepJobs.sort } },
      { stepJobs: { ...value.stepJobs, unexpected: randomUUID() } },
      { result: null },
      { result: { ...value.result, status: { ...value.result.status, verify: "Skipped" } } },
      { result: { ...value.result, values: { ...value.result.values, verify: { status: "Succeeded", values: { report: files.report, count: "3", region: 2 } } } } },
      { result: { ...value.result, values: { ...value.result.values, sort: { status: "Succeeded", values: { sorted: files.index, index: files.sorted } } } } },
      { result: { ...value.result, values: { ...value.result.values, verify: { status: "Succeeded", values: { report: { ...files.report, url: "https://example.invalid/private" }, count: 3, region: 2 } } } } },
    ]) {
      expect(() => assertFileWorkflowCompleted({ ...value, ...change }, value.id, input)).toThrow();
    }
    expect(() => assertFileWorkflowCompleted(value, randomUUID(), input)).toThrow();
    expect(FileWorkflowReceiptSchema.safeParse({
      ...receipt, input: { ...input, fileMetadataId: files.bam.fileMetadataId },
    }).success).toBe(false);
  });

  test("rejects invalid schemas, mixed static/dynamic File bindings and the wrong fixture", () => {
    expect(FileWorkflowAssetsSchema.safeParse({ ...assets, softwareRevisionId: "invalid" }).success).toBe(false);
    expect(FileWorkflowAssetsSchema.safeParse({ ...assets, usecases: { convert: randomUUID() } }).success).toBe(false);
    expect(FileWorkflowAssetsSchema.safeParse({ ...assets, token: "secret" }).success).toBe(false);
    for (const fileMetadataName of ["", "../input.sam", "https://example.invalid/input.sam", "input\n.sam"]) {
      expect(FileRefSchema.safeParse({ ...input, fileMetadataName }).success).toBe(false);
    }
    expect(FileRefSchema.safeParse({ ...input, url: "https://example.invalid" }).success).toBe(false);
    expect(() => fileWorkflow(assets, "invalid", prefix, uploadedInput)).toThrow();
    expect(() => fileWorkflow(assets, queueId, "/srv/../tmp", uploadedInput)).toThrow();
    expect(workflowDsl.NodeInputSlotSchema.safeParse({
      type: "File", descriptor: "bam", from: { node: "convert", output: "bam" },
      contents: [{ ...input, hash: "a".repeat(64), size: 1 }],
    }).success).toBe(false);
    process.env.KQ_PR_SPACK_CASE = "hello";
    expect(() => fileWorkflowPackage("convert")).toThrow("samtools acceptance case");
    expect(() => fileWorkflow(assets, queueId, prefix, uploadedInput)).toThrow("samtools acceptance case");
  });
});
