import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LocalWorkflowRunner,
  LocalWorkflowRunRecord,
  WorkflowRunReader,
} from "@kuintessence/agent/embedded";
import type { WorkflowRunRecordResult, workflowDsl } from "@kuintessence/shared";
import { createLocalWorkflowSupport, listWorkflowDir } from "./local-workflows";

function fakeReader(runs: Record<string, LocalWorkflowRunRecord>): WorkflowRunReader {
  return {
    async getRun(runId: string) {
      return runs[runId] ?? null;
    },
    async listRuns() {
      return Object.values(runs);
    },
  };
}

function recordOf(over: Partial<LocalWorkflowRunRecord> = {}): LocalWorkflowRunRecord {
  return {
    runId: "run-1",
    name: "Alpha",
    description: null,
    submittedBy: "local",
    status: "succeeded",
    stepJobs: {},
    result: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function wfYaml(name: string): string {
  return `name: ${name}\nspec:\n  nodeDrafts: []\n`;
}

describe("listWorkflowDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kq-wf-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists *.yml/*.yaml specs with id=filename and name from the parsed wf", () => {
    writeFileSync(join(dir, "demo.yml"), wfYaml("Demo Pipeline"));
    writeFileSync(join(dir, "sweep.yaml"), wfYaml("Sweep"));
    writeFileSync(join(dir, "notes.txt"), "ignored");

    expect(listWorkflowDir(dir)).toEqual([
      { id: "demo.yml", name: "Demo Pipeline", status: "unknown" },
      { id: "sweep.yaml", name: "Sweep", status: "unknown" },
    ]);
  });

  test("skips an unparseable spec rather than blanking the listing", () => {
    writeFileSync(join(dir, "good.yml"), wfYaml("Good"));
    writeFileSync(join(dir, "bad.yml"), "name:\n");

    expect(listWorkflowDir(dir)).toEqual([{ id: "good.yml", name: "Good", status: "unknown" }]);
  });

  test("returns [] for a missing directory (best-effort, no throw)", () => {
    expect(listWorkflowDir(join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("createLocalWorkflowSupport", () => {
  const fakeFs = {
    readDir: (_dir: string) => ["a.yml", "b.yaml", "skip.json"],
    readFile: (path: string) => (path.endsWith("a.yml") ? wfYaml("Alpha") : wfYaml("Beta")),
  };

  test("list delegates to listWorkflowDir over the injected fs", async () => {
    const runner = {
      run: async () => ({ runId: "r", result: { status: {}, values: {} } }),
    } as unknown as LocalWorkflowRunner;
    const support = createLocalWorkflowSupport("/wf", runner, fakeReader({}), fakeFs);
    expect(await support.list()).toEqual([
      { id: "a.yml", name: "Alpha", status: "unknown" },
      { id: "b.yaml", name: "Beta", status: "unknown" },
    ]);
  });

  test("submit parses the named spec, runs it, and returns the recorded run id", async () => {
    let ran: { name: string; by: string } | undefined;
    const runner = {
      run: async (wf: workflowDsl.Workflow, by: string) => {
        ran = { name: wf.name, by };
        return { runId: "run-42", result: { status: {}, values: {} } };
      },
    } as unknown as LocalWorkflowRunner;
    const support = createLocalWorkflowSupport("/wf", runner, fakeReader({}), fakeFs);

    expect(await support.submit("a.yml")).toEqual({ id: "run-42", name: "Alpha" });
    expect(ran).toEqual({ name: "Alpha", by: "local" });
  });

  test("getDetail maps a recorded run's per-node status + values into steps", async () => {
    const result: WorkflowRunRecordResult = {
      status: { build: "completed", run: "failed" },
      values: {
        build: { status: "completed", values: { artifact: "a.tar" } },
        run: {
          status: "failed",
          values: {},
          failure: { message: "Exit 7", jobId: "job-run", exitCode: 7 },
        },
      },
    };
    const reader = fakeReader({
      "run-7": recordOf({
        runId: "run-7",
        name: "pipe",
        status: "failed",
        graph: {
          nodes: [
            { id: "build", name: "Build", kind: "SoftwareUsecaseComputing" },
            { id: "run", name: "Run", kind: "SoftwareUsecaseComputing" },
          ],
          edges: [],
        },
        stepJobs: { build: "job-build", run: "job-run" },
        result,
      }),
    });
    const support = createLocalWorkflowSupport("/wf", {} as LocalWorkflowRunner, reader, fakeFs);

    const detail = await support.getDetail?.("run-7");
    const record = await reader.getRun("run-7");
    expect(detail).toEqual({
      id: "run-7",
      name: "pipe",
      status: "failed",
      description: undefined,
      result,
      graph: record?.graph,
      stepJobs: { build: "job-build", run: "job-run" },
      steps: [
        { id: "build", status: "completed", info: '{"artifact":"a.tar"}' },
        { id: "run", status: "failed", info: undefined },
      ],
    });
    expect(detail?.result).toBe(result);
    expect(detail?.graph).toBe(record?.graph);
    expect(detail?.stepJobs).toBe(record?.stepJobs);
  });

  test("getDetail needs a result or graph nodes", async () => {
    for (const graph of [undefined, null, { nodes: [], edges: [] }]) {
      const reader = fakeReader({
        "run-8": recordOf({
          runId: "run-8",
          name: "pending-result",
          status: "running",
          description: "computing",
          graph,
          stepJobs: { prep: "job-1", solve: "job-2" },
        }),
      });
      const support = createLocalWorkflowSupport("/wf", {} as LocalWorkflowRunner, reader, fakeFs);

      const detail = await support.getDetail?.("run-8");
      expect(detail).toEqual({
        id: "run-8",
        name: "pending-result",
        status: "running",
        description: "computing",
        steps: [],
        result: null,
        graph,
        stepJobs: { prep: "job-1", solve: "job-2" },
      });
    }
  });

  test("getDetail maps active graph nodes to submitted jobs without a result", async () => {
    const graph = {
      nodes: [
        { id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" },
        { id: "collect", name: "Collect", kind: "NoAction" },
      ],
      edges: [],
    };
    const reader = fakeReader({
      active: recordOf({
        runId: "active",
        status: "running",
        graph,
        stepJobs: { orphan: "job-outside", solve: "job-solve" },
      }),
    });
    const support = createLocalWorkflowSupport("/wf", {} as LocalWorkflowRunner, reader, fakeFs);
    const detail = await support.getDetail?.("active");
    expect(detail?.status).toBe("running");
    expect(detail?.result).toBeNull();
    expect(detail?.graph).toBe(graph);
    expect(detail?.stepJobs).toEqual({ orphan: "job-outside", solve: "job-solve" });
    expect(detail?.steps).toEqual([
      { id: "solve", status: "unknown", info: "job job-solve" },
      { id: "collect", status: "unknown", info: undefined },
    ]);
    expect(graph.edges).toEqual([]);
  });

  test("getDetail maps graph nodes before any jobs are submitted", async () => {
    const reader = fakeReader({
      queued: recordOf({
        runId: "queued",
        status: "queued",
        graph: {
          nodes: [{ id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" }],
          edges: [],
        },
      }),
    });
    const support = createLocalWorkflowSupport("/wf", {} as LocalWorkflowRunner, reader, fakeFs);
    expect((await support.getDetail?.("queued"))?.steps).toEqual([
      { id: "solve", status: "unknown", info: undefined },
    ]);
  });

  test("getDetail returns null for an unknown run id and unknown spec", async () => {
    const support = createLocalWorkflowSupport(
      "/wf",
      {} as LocalWorkflowRunner,
      fakeReader({}),
      fakeFs,
    );
    expect(await support.getDetail?.("nope")).toBeNull();
  });
});

describe("createLocalWorkflowSupport getDetail by spec filename", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kq-wf-detail-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function workflowYamlWithNodes(name: string): string {
    return [
      `name: ${name}`,
      "spec:",
      "  nodeDrafts:",
      "    - id: solve",
      "      name: Solve",
      "      type: NoAction",
      "    - id: collect",
      "      name: Collect",
      "      type: NoAction",
    ].join("\n");
  }

  test("resolves a spec filename to the latest recorded run matching its name", async () => {
    writeFileSync(join(dir, "hello.yml"), wfYaml("Hello"));
    const reader = fakeReader({
      "run-old": recordOf({ runId: "run-old", name: "Hello", status: "succeeded" }),
    });
    const support = createLocalWorkflowSupport(dir, {} as LocalWorkflowRunner, reader);

    const detail = await support.getDetail?.("hello.yml");
    expect(detail).toEqual({
      id: "run-old",
      name: "Hello",
      status: "completed",
      description: undefined,
      steps: [],
      result: null,
      graph: undefined,
      stepJobs: {},
    });
  });

  test("picks the newest-first run when several share the spec name", async () => {
    writeFileSync(join(dir, "hello.yml"), wfYaml("Hello"));
    const reader: WorkflowRunReader = {
      async getRun(runId) {
        return runId === "run-new"
          ? recordOf({ runId: "run-new", name: "Hello", status: "running" })
          : null;
      },
      async listRuns() {
        return [
          recordOf({ runId: "run-new", name: "Hello", status: "running" }),
          recordOf({ runId: "run-old", name: "Hello", status: "succeeded" }),
        ];
      },
    };
    const support = createLocalWorkflowSupport(dir, {} as LocalWorkflowRunner, reader);

    const detail = await support.getDetail?.("hello.yml");
    expect(detail?.id).toBe("run-new");
    expect(detail?.status).toBe("running");
  });

  test("returns a pending preview (steps from nodes) when no run was recorded", async () => {
    writeFileSync(join(dir, "hello.yml"), workflowYamlWithNodes("Hello"));
    const support = createLocalWorkflowSupport(dir, {} as LocalWorkflowRunner, fakeReader({}));

    const detail = await support.getDetail?.("hello.yml");
    expect(detail).toEqual({
      id: "hello.yml",
      name: "Hello",
      status: "queued",
      description: undefined,
      steps: [
        { id: "solve", status: "pending" },
        { id: "collect", status: "pending" },
      ],
      result: { status: { solve: "Pending", collect: "Pending" }, values: {} },
      graph: {
        nodes: [
          { id: "solve", name: "Solve", kind: "NoAction" },
          { id: "collect", name: "Collect", kind: "NoAction" },
        ],
        edges: [],
      },
      stepJobs: {},
    });
  });

  test("a recorded run id still resolves directly (regression)", async () => {
    const reader = fakeReader({
      "run-7": recordOf({ runId: "run-7", name: "pipe", status: "running" }),
    });
    const support = createLocalWorkflowSupport(dir, {} as LocalWorkflowRunner, reader);

    const detail = await support.getDetail?.("run-7");
    expect(detail?.id).toBe("run-7");
    expect(detail?.status).toBe("running");
  });

  test("returns null for a spec filename that does not exist on disk", async () => {
    const support = createLocalWorkflowSupport(dir, {} as LocalWorkflowRunner, fakeReader({}));
    expect(await support.getDetail?.("does-not-exist.yml")).toBeNull();
  });
});
