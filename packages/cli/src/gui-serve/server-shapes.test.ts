import { describe, expect, it } from "bun:test";
import type {
  TuiAgent,
  TuiJob,
  TuiJobDetail,
  TuiSoftware,
  TuiWorkflowDetail,
  TuiWorkflowRun,
} from "../tui/backend/types";
import {
  toAgentRow,
  toInstalledRow,
  toJobDetail,
  toJobRow,
  toWorkflowRunDetail,
  toWorkflowRunRow,
} from "./server-shapes";

describe("toJobRow", () => {
  it("maps TuiJob → Server JobRow", () => {
    const j: TuiJob = {
      id: "j1",
      name: "echo",
      status: "running",
      location: "batch",
      submittedAt: "2026-06-02T00:00:00Z",
    };
    expect(toJobRow(j)).toEqual({
      id: "j1",
      name: "echo",
      status: "running",
      submittedAt: "2026-06-02T00:00:00Z",
    });
  });

  it("falls back to empty submittedAt when the kernel lacks it", () => {
    const j: TuiJob = { id: "j2", name: "x", status: "queued", location: "batch" };
    expect(toJobRow(j).submittedAt).toBe("");
  });
});

describe("toJobDetail", () => {
  it("carries command/exitCode/resources when present", () => {
    const d: TuiJobDetail = {
      id: "j1",
      name: "echo",
      status: "completed",
      schedulerJobId: "s9",
      node: "compute-2",
      startedAt: "t0",
      completedAt: "t1",
      exitCode: 0,
      command: "echo hi",
      cpus: 4,
      memoryMb: 2048,
    };
    expect(toJobDetail(d)).toMatchObject({
      id: "j1",
      name: "echo",
      status: "completed",
      command: "echo hi",
      schedulerJobId: "s9",
      node: "compute-2",
      startedAt: "t0",
      completedAt: "t1",
      exitCode: 0,
      submittedAt: "",
      resources: { cpus: 4, memoryMb: 2048 },
    });
  });

  it("nulls fields the kernel lacks (no live agent, no placement)", () => {
    const d: TuiJobDetail = { id: "j3", name: "x", status: "queued" };
    const row = toJobDetail(d);
    expect(row.agentId).toBeNull();
    expect(row.node).toBeNull();
    expect(row.command).toBeNull();
    expect(row.exitCode).toBeNull();
    expect(row.resources).toBeNull();
  });

  it("omits resources when only one dimension is known", () => {
    const d: TuiJobDetail = { id: "j4", name: "x", status: "running", cpus: 2 };
    expect(toJobDetail(d).resources).toEqual({ cpus: 2 });
  });
});

describe("toWorkflowRunRow", () => {
  it("maps TuiWorkflowRun → Server WorkflowRunRow", () => {
    const w: TuiWorkflowRun = {
      id: "w1",
      name: "pipeline",
      status: "running",
      createdAt: "2026-06-02T00:00:00Z",
    };
    expect(toWorkflowRunRow(w)).toEqual({
      id: "w1",
      name: "pipeline",
      status: "running",
      createdAt: "2026-06-02T00:00:00Z",
    });
  });
});

describe("toWorkflowRunDetail", () => {
  it("preserves structured results, graph and job associations independently of step info", () => {
    const d = {
      id: "w1",
      name: "pipeline",
      status: "failed",
      description: "demo",
      steps: [
        { id: "s1", status: "completed", info: '{"artifact":"output.tar"}' },
        { id: "s2", status: "failed", info: "display-only failure" },
        { id: "s3", status: "queued" },
      ],
      result: {
        status: { s1: "Succeeded", s2: "Failed", s3: "Cancelled" },
        values: {
          s1: { status: "Succeeded", values: { artifact: "output.tar" } },
          s2: {
            status: "Failed",
            values: {},
            failure: { message: "Exit 7", jobId: "job-2", exitCode: 7 },
          },
        },
      },
      graph: {
        nodes: [
          { id: "s1", name: "Build", kind: "SoftwareUsecaseComputing" },
          { id: "s2", name: "Run", kind: "SoftwareUsecaseComputing" },
          { id: "s3", name: "Collect", kind: "NoAction" },
        ],
        edges: [{ source: "s1", target: "s2", when: "true" }],
      },
      stepJobs: { s1: "job-1", s2: "job-2" },
    } satisfies TuiWorkflowDetail;
    const row = toWorkflowRunDetail(d);
    expect(row).toMatchObject({
      id: "w1",
      name: "pipeline",
      status: "failed",
      description: "demo",
      createdAt: "",
    });
    expect(row.result).toBe(d.result);
    expect(row.graph).toBe(d.graph);
    expect(row.stepJobs).toBe(d.stepJobs);
    expect(row.stepJobs).toEqual({ s1: "job-1", s2: "job-2" });
  });

  it("never derives job ids or results from display-only steps", () => {
    const row = toWorkflowRunDetail({
      id: "w2",
      name: "display-only",
      status: "completed",
      steps: [
        { id: "json", status: "Succeeded", info: '{"jobId":"not-a-job-association"}' },
        { id: "label", status: "unknown", info: "job job-label" },
        { id: "bare", status: "unknown", info: "job-bare" },
        { id: "empty", status: "unknown" },
      ],
    });
    expect(row.stepJobs).toEqual({});
    expect(row.result).toBeNull();
    expect(row.graph).toBeNull();
  });

  it("preserves active graph job associations while the result is null", () => {
    const d = {
      id: "active",
      name: "computing",
      status: "running",
      steps: [],
      result: null,
      graph: {
        nodes: [{ id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" }],
        edges: [],
      },
      stepJobs: { solve: "job-solve" },
    } satisfies TuiWorkflowDetail;
    const row = toWorkflowRunDetail(d);
    expect(row.result).toBeNull();
    expect(row.graph).toBe(d.graph);
    expect(row.stepJobs).toEqual({ solve: "job-solve" });
  });

  it("keeps node results without a stored graph or job mapping", () => {
    const d = {
      id: "local",
      name: "completed",
      status: "completed",
      steps: [{ id: "solve", status: "Succeeded", info: '{"answer":42}' }],
      result: {
        status: { solve: "Succeeded" },
        values: { solve: { status: "Succeeded", values: { answer: 42 } } },
      },
    } satisfies TuiWorkflowDetail;
    const row = toWorkflowRunDetail(d);
    expect(row.result).toBe(d.result);
    expect(row.graph).toBeNull();
    expect(row.stepJobs).toEqual({});
  });
});

describe("toAgentRow", () => {
  it("maps TuiAgent → Server AgentRow with split scheduler type/version", () => {
    const a: TuiAgent = {
      id: "local",
      site: "this-node",
      scheduler: "slurm 23.02",
      status: "running",
      cpuPercent: 12,
      memoryUsedMb: 100,
      memoryTotalMb: 1000,
      queueDepth: 3,
      maxConcurrentJobs: 8,
      lastHeartbeat: "2026-06-02T00:00:00Z",
    };
    expect(toAgentRow(a)).toEqual({
      agentId: "local",
      siteName: "this-node",
      schedulerType: "slurm",
      schedulerVersion: "23.02",
      status: "online",
      cpuUsagePercent: 12,
      memoryUsedMb: 100,
      memoryTotalMb: 1000,
      queueDepth: 3,
      maxConcurrentJobs: 8,
      lastHeartbeat: "2026-06-02T00:00:00Z",
    });
  });

  it("nulls live-metric fields the kernel lacks", () => {
    const a: TuiAgent = { id: "local", site: "node", scheduler: "pbs-pro", status: "running" };
    const row = toAgentRow(a);
    expect(row.schedulerType).toBe("pbs-pro");
    expect(row.schedulerVersion).toBe("");
    expect(row.cpuUsagePercent).toBeNull();
    expect(row.queueDepth).toBeNull();
    expect(row.lastHeartbeat).toBeNull();
  });
});

describe("toInstalledRow", () => {
  it("maps TuiSoftware → installed-row shape", () => {
    const s: TuiSoftware = {
      id: "spack/zlib",
      name: "zlib",
      source: "spack",
      versions: ["1.3"],
      lifecycle: "installed",
      spec: "zlib@1.3",
      hash: "zlib-local-spec",
      compiler: "gcc@13",
      reportedAt: "2026-08-10T00:00:00.000Z",
    };
    expect(toInstalledRow(s)).toEqual({
      name: "zlib",
      version: "1.3",
      hash: "zlib-local-spec",
      compiler: "gcc@13",
      spec: "zlib@1.3",
      reportedAt: "2026-08-10T00:00:00.000Z",
    });
  });
});
