import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "@kuintessence/db";
import {
  type JobStatusName,
  type JobSubmission,
  type WorkflowRunGraph,
  type WorkflowRunRecordResult,
  type WorkflowRunStore,
  workflowDsl,
} from "@kuintessence/shared";
import type { SchedulerAdapter } from "../adapters/base";
import { LocalPackageStore } from "./local-package-store";
import type { LaunchOutcome } from "./local-workflow";
import { type LocalJobLauncher, LocalWorkflowRunner, PoolJobLauncher } from "./local-workflow";
import { SqliteWorkflowRunStore } from "./sqlite-run-store";

const USECASE_A = "11111111-1111-1111-1111-111111111111";
const USECASE_B = "22222222-2222-2222-2222-222222222222";
const SW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const suc = (id: string, usecaseVersionId: string) => ({
  type: "SoftwareUsecaseComputing",
  id,
  name: id,
  usecaseVersionId,
  softwareVersionId: SW,
});

function linearWorkflow(): workflowDsl.Workflow {
  return workflowDsl.WorkflowSchema.parse({
    name: "two-node-linear",
    parameters: [],
    spec: {
      nodeDrafts: [suc("a", USECASE_A), suc("b", USECASE_B)],
      nodeRelations: [{ fromId: "a", toId: "b", slotRelations: [] }],
    },
  });
}

/** Two Bare packages with distinguishable commandFiles → distinct commands. */
function catalog(): LocalPackageStore {
  return LocalPackageStore.fromEntries({
    [USECASE_A]: {
      usecase: { commandFile: "run-a", inputSlots: [] },
      software: { kind: "Bare" },
    },
    [USECASE_B]: {
      usecase: { commandFile: "run-b", inputSlots: [] },
      software: { kind: "Bare" },
    },
  });
}

class RecordingLauncher implements LocalJobLauncher {
  readonly commands: string[] = [];
  constructor(private readonly outcome: (cmd: string) => JobStatusName) {}
  async submitJob(
    spec: JobSubmission,
  ): Promise<{ jobId: string; status: JobStatusName; collected: Record<string, string> }> {
    this.commands.push(spec.command);
    return { jobId: spec.name, status: this.outcome(spec.command), collected: {} };
  }
  async submitAndWait(): Promise<LaunchOutcome> {
    throw new Error("RecordingLauncher uses submitJob directly");
  }
}

class FakeRunStore implements WorkflowRunStore {
  readonly recorded: {
    name: string;
    submittedBy: string;
    result: WorkflowRunRecordResult;
    graph: WorkflowRunGraph;
  }[] = [];
  async recordRun(
    name: string,
    submittedBy: string,
    result: WorkflowRunRecordResult,
    graph: WorkflowRunGraph,
  ): Promise<string> {
    this.recorded.push({ name, submittedBy, result, graph });
    return "run-id";
  }
}

describe("LocalWorkflowRunner.run", () => {
  test("runs both nodes in dependency order and records a succeeded run", async () => {
    const launcher = new RecordingLauncher(() => "completed");
    const runStore = new FakeRunStore();
    const runner = new LocalWorkflowRunner({ launcher, runStore, packageStore: catalog() });

    const { runId, result } = await runner.run(linearWorkflow(), "tester");

    expect(runId).toBe("run-id");
    expect(launcher.commands).toEqual(["run-a", "run-b"]);
    expect(result.status.a).toBe("Succeeded");
    expect(result.status.b).toBe("Succeeded");

    expect(runStore.recorded).toHaveLength(1);
    const rec = runStore.recorded[0];
    expect(rec?.name).toBe("two-node-linear");
    expect(rec?.submittedBy).toBe("tester");
    expect(rec?.result.status.a).toBe("Succeeded");
    expect(rec?.result.status.b).toBe("Succeeded");
  });

  test("a failed node fails its node and cancels the dependent", async () => {
    const launcher = new RecordingLauncher((cmd) => (cmd === "run-a" ? "failed" : "completed"));
    const runStore = new FakeRunStore();
    const runner = new LocalWorkflowRunner({ launcher, runStore, packageStore: catalog() });

    const { result } = await runner.run(linearWorkflow(), "tester");

    expect(result.status.a).toBe("Failed");
    expect(result.status.b).toBe("Cancelled");
    expect(launcher.commands).toEqual(["run-a"]);
    expect(runStore.recorded[0]?.result.status.b).toBe("Cancelled");
  });

  test("PoolJobLauncher drives a real ExecutorPool over a fake adapter", async () => {
    const submitted: string[] = [];
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit(spec) {
        submitted.push(spec.command);
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
    };
    const launcher = new PoolJobLauncher({ adapter, pollIntervalMs: 0, sleep: async () => {} });
    const runStore = new FakeRunStore();
    const runner = new LocalWorkflowRunner({ launcher, runStore, packageStore: catalog() });

    const { result } = await runner.run(linearWorkflow(), "tester");

    expect(submitted).toEqual(["run-a", "run-b"]);
    expect(result.status.a).toBe("Succeeded");
    expect(result.status.b).toBe("Succeeded");
  });

  test("persists scheduler failure details through the local AIO workflow path", async () => {
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S-failed" };
      },
      async cancel() {},
      async status() {
        return { status: "failed", exitCode: 7, message: "LAMMPS lost atoms at step 120" };
      },
    };
    const launcher = new PoolJobLauncher({ adapter, pollIntervalMs: 0, sleep: async () => {} });
    const runStore = new SqliteWorkflowRunStore(createSqliteDb(":memory:"));
    const runner = new LocalWorkflowRunner({ launcher, runStore, packageStore: catalog() });
    const workflow = workflowDsl.WorkflowSchema.parse({
      name: "failed-local-run",
      parameters: [],
      spec: { nodeDrafts: [suc("a", USECASE_A)], nodeRelations: [] },
    });

    const { runId, result } = await runner.run(workflow, "tester");
    const persisted = await runStore.getRun(runId);

    expect(result.values.a?.failure).toMatchObject({
      message: "LAMMPS lost atoms at step 120",
      exitCode: 7,
    });
    expect(result.values.a?.failure?.jobId).toMatch(/[0-9a-f-]{36}/);
    expect(persisted?.result?.values.a?.failure).toEqual(result.values.a?.failure);
  });

  test("PoolJobLauncher.submitJob stages input files into the job's workingDir before run", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "local-stage-work-"));
    const srcDir = mkdtempSync(join(tmpdir(), "local-stage-src-"));
    const src = join(srcDir, "input.dat");
    writeFileSync(src, "staged-input-content");

    let stagedAtSubmit = false;
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        stagedAtSubmit = existsSync(join(workDir, "in/input.dat"));
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
    };
    const launcher = new PoolJobLauncher({
      adapter,
      workingDir: workDir,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    const result = await launcher.submitJob({
      nodeId: "n1",
      name: "n1",
      command: "noop",
      envVars: {},
      inputStaging: [{ fileMetadataId: src, stagePath: "in/input.dat" }],
      expectedOutputs: [],
    });

    expect(result.status).toBe("completed");
    expect(stagedAtSubmit).toBe(true);
    expect(readFileSync(join(workDir, "in/input.dat"), "utf8")).toBe("staged-input-content");
  });

  test("PoolJobLauncher collects file outputs from its workingDir on completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-collect-"));
    writeFileSync(join(dir, "out.txt"), "hello-from-disk");

    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
    };
    const launcher = new PoolJobLauncher({
      adapter,
      workingDir: dir,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    const result = await launcher.submitJob({
      nodeId: "n1",
      name: "n1",
      command: "noop",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [{ descriptor: "result", path: "out.txt", isBatch: false }],
    });

    expect(result.status).toBe("completed");
    expect(result.collected.result).toBe("hello-from-disk");
  });

  test("run extracts a value from a collected file output into RunResult.values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-extract-"));
    writeFileSync(join(dir, "metrics.txt"), "residual = 1e-6\n");

    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
    };
    const launcher = new PoolJobLauncher({
      adapter,
      workingDir: dir,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    const runStore = new FakeRunStore();
    const packageStore = LocalPackageStore.fromEntries({
      [USECASE_A]: {
        usecase: { commandFile: "run-a", inputSlots: [] },
        software: { kind: "Bare" },
        filesomeOutputs: [
          { descriptor: "metrics", fileKind: { kind: "Normal", name: "metrics.txt" } },
        ],
        valueOutputs: [
          {
            descriptor: "residual",
            type: "double",
            from: { collectedOutDescriptor: "metrics" },
            extract: { kind: "Regex", pattern: "residual = ([0-9.eE+-]+)", group: 1 },
          },
        ],
      },
    });
    const wf = workflowDsl.WorkflowSchema.parse({
      name: "single-extract",
      parameters: [],
      spec: { nodeDrafts: [suc("a", USECASE_A)], nodeRelations: [] },
    });

    const runner = new LocalWorkflowRunner({ launcher, runStore, packageStore });
    const { result } = await runner.run(wf, "tester");

    expect(result.status.a).toBe("Succeeded");
    expect(result.values.a?.values.residual).toBe(1e-6);
  });

  test("submitJob captures job stdout under the reserved 'stdout' descriptor", async () => {
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
      async getJobLogs() {
        return "answer=42\n";
      },
    };
    const launcher = new PoolJobLauncher({ adapter, pollIntervalMs: 0, sleep: async () => {} });

    const result = await launcher.submitJob({
      nodeId: "n1",
      name: "n1",
      command: "noop",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    });

    expect(result.status).toBe("completed");
    expect(result.collected.stdout).toBe("answer=42\n");
  });

  test("submitJob does not clobber a file output named 'stdout'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-stdout-clobber-"));
    writeFileSync(join(dir, "stdout.txt"), "from-file");

    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
      async getJobLogs() {
        return "from-stdout";
      },
    };
    const launcher = new PoolJobLauncher({
      adapter,
      workingDir: dir,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    const result = await launcher.submitJob({
      nodeId: "n1",
      name: "n1",
      command: "noop",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [{ descriptor: "stdout", path: "stdout.txt", isBatch: false }],
    });

    expect(result.collected.stdout).toBe("from-file");
  });

  test("submitJob omits stdout when the adapter has no getJobLogs (best-effort)", async () => {
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
    };
    const launcher = new PoolJobLauncher({ adapter, pollIntervalMs: 0, sleep: async () => {} });

    const result = await launcher.submitJob({
      nodeId: "n1",
      name: "n1",
      command: "noop",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    });

    expect(result.status).toBe("completed");
    expect(result.collected.stdout).toBeUndefined();
  });

  test("submitJob omits stdout when getJobLogs throws (best-effort, no throw)", async () => {
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
      async getJobLogs() {
        throw new Error("log path unavailable");
      },
    };
    const launcher = new PoolJobLauncher({ adapter, pollIntervalMs: 0, sleep: async () => {} });

    const result = await launcher.submitJob({
      nodeId: "n1",
      name: "n1",
      command: "noop",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    });

    expect(result.status).toBe("completed");
    expect(result.collected.stdout).toBeUndefined();
  });

  test("run extracts a value from job stdout into RunResult.values", async () => {
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
      async getJobLogs() {
        return "answer=42";
      },
    };
    const launcher = new PoolJobLauncher({ adapter, pollIntervalMs: 0, sleep: async () => {} });
    const runStore = new FakeRunStore();
    const packageStore = LocalPackageStore.fromEntries({
      [USECASE_A]: {
        usecase: { commandFile: "run-a", inputSlots: [] },
        software: { kind: "Bare" },
        valueOutputs: [
          {
            descriptor: "answer",
            type: "int",
            from: { collectedOutDescriptor: "stdout" },
            extract: { kind: "Regex", pattern: "answer=(\\d+)", group: 1 },
          },
        ],
      },
    });
    const wf = workflowDsl.WorkflowSchema.parse({
      name: "stdout-extract",
      parameters: [],
      spec: { nodeDrafts: [suc("a", USECASE_A)], nodeRelations: [] },
    });

    const runner = new LocalWorkflowRunner({ launcher, runStore, packageStore });
    const { result } = await runner.run(wf, "tester");

    expect(result.status.a).toBe("Succeeded");
    expect(result.values.a?.values.answer).toBe(42);
  });

  test("scatter-gather: a batched output becomes a list a ForEach iterates and Reduce gathers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-scatter-"));
    writeFileSync(join(dir, "frame_2.txt"), "B");
    writeFileSync(join(dir, "frame_1.txt"), "A");
    writeFileSync(join(dir, "frame_3.txt"), "C");

    let workerLaunches = 0;
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit(spec) {
        if (spec.name === "worker") {
          workerLaunches += 1;
        }
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
      async getJobLogs() {
        return "ok=1\n";
      },
    };
    const launcher = new PoolJobLauncher({
      adapter,
      workingDir: dir,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    const runStore = new FakeRunStore();
    const packageStore = LocalPackageStore.fromEntries({
      [USECASE_A]: {
        usecase: { commandFile: "run-a", inputSlots: [] },
        software: { kind: "Bare" },
        filesomeOutputs: [
          { descriptor: "frames", fileKind: { kind: "Batched", pattern: "frame_*.txt" } },
        ],
        valueOutputs: [
          {
            descriptor: "frames",
            type: { list: "string" },
            from: { collectedOutDescriptor: "frames" },
            extract: { kind: "Whole" },
          },
        ],
      },
      [USECASE_B]: {
        usecase: { commandFile: "run-b", inputSlots: [] },
        software: { kind: "Bare" },
        valueOutputs: [
          {
            descriptor: "ok",
            type: "int",
            from: { collectedOutDescriptor: "stdout" },
            extract: { kind: "Regex", pattern: "ok=(\\d+)", group: 1 },
          },
        ],
      },
    });

    const wf = workflowDsl.WorkflowSchema.parse({
      name: "scatter-gather",
      parameters: [],
      spec: {
        nodeDrafts: [
          { ...suc("gen", USECASE_A) },
          {
            id: "fan",
            name: "fan",
            type: "Loop",
            mode: "ForEach",
            over: { expr: "nodes.gen.values.frames" },
            maxIterations: 100,
            body: {
              nodeDrafts: [{ ...suc("worker", USECASE_B), name: "worker" }],
              nodeRelations: [],
            },
            outputs: [{ descriptor: "oks", from: { node: "worker", output: "ok" } }],
          },
          {
            id: "gather",
            name: "gather",
            type: "Reduce",
            from: { loop: "fan", output: "oks" },
            reducer: { kind: "Collect" },
            output: { kind: "SingleFile", descriptor: "all" },
          },
        ],
        nodeRelations: [
          { fromId: "gen", toId: "fan", slotRelations: [] },
          { fromId: "fan", toId: "gather", slotRelations: [] },
        ],
      },
    });

    const runner = new LocalWorkflowRunner({ launcher, runStore, packageStore });
    const { result } = await runner.run(wf, "tester");

    expect(result.status.gen).toBe("Succeeded");
    expect(result.values.gen?.values.frames).toEqual(["A", "B", "C"]);
    expect(result.status.fan).toBe("Succeeded");
    expect(workerLaunches).toBe(3);
    expect(result.status.gather).toBe("Succeeded");
    expect(result.values.gather?.values.all).toEqual([1, 1, 1]);
  });

  test("submitAndWait resolves to failed when the pool is stopped before terminal (no hang)", async () => {
    const adapter: SchedulerAdapter = {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "running" };
      },
    };
    const launcher = new PoolJobLauncher({ adapter, pollIntervalMs: 0, sleep: async () => {} });
    const p = launcher.submitAndWait({
      jobId: "n1",
      name: "n1",
      command: "echo",
      cpus: 1,
      memoryMb: 1,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
    });
    launcher.stopAll();
    const outcome = await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hang")), 200)),
    ]);
    expect(outcome.status).toBe("failed");
  });
});
