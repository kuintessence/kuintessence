import type {
  TuiAgent,
  TuiBackend,
  TuiBackendCapabilities,
  TuiBackendInfo,
  TuiJob,
  TuiJobDetail,
  TuiJobStatus,
  TuiSoftware,
  TuiSubmitResult,
  TuiWorkflowDetail,
  TuiWorkflowRun,
} from "../tui/backend/types";

/**
 * In-memory {@link TuiBackend} with deterministic fixtures, shared by the
 * gui-serve integration tests (Server-shape round-trip + real-browser e2e) so the
 * full stack can be exercised over a real socket without a scheduler.
 */
export class FakeGuiBackend implements TuiBackend {
  readonly info: TuiBackendInfo = { mode: "local", target: "slurm 23.02" };
  readonly capabilities: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: true,
    workflows: true,
    agents: true,
    metrics: true,
    software: true,
    ssh: false,
  };

  listJobs(): Promise<TuiJob[]> {
    return Promise.resolve([
      {
        id: "j1",
        name: "echo",
        status: "running" as TuiJobStatus,
        location: "batch",
        submittedAt: "2026-06-02T00:00:00Z",
      },
      {
        id: "j2",
        name: "train",
        status: "completed" as TuiJobStatus,
        location: "gpu",
        submittedAt: "2026-06-02T01:00:00Z",
      },
    ]);
  }

  cancelJob(): Promise<void> {
    return Promise.resolve();
  }

  getJobDetail(id: string): Promise<TuiJobDetail> {
    return Promise.resolve({
      id,
      name: "echo",
      status: "completed" as TuiJobStatus,
      command: "echo hi",
      exitCode: 0,
      cpus: 2,
      memoryMb: 512,
    });
  }

  subscribeJobStatus(): () => void {
    return () => {};
  }

  submitFromSpec(): Promise<TuiSubmitResult> {
    return Promise.resolve({ id: "j99", name: "submitted" });
  }

  getJobLogs(): Promise<string> {
    return Promise.resolve("line1\nline2");
  }

  listWorkflows(): Promise<TuiWorkflowRun[]> {
    return Promise.resolve([
      {
        id: "w1",
        name: "pipeline",
        status: "running" as TuiJobStatus,
        createdAt: "2026-06-02T02:00:00Z",
      },
    ]);
  }

  submitWorkflow(): Promise<TuiSubmitResult> {
    return Promise.resolve({ id: "w99", name: "wf" });
  }

  getWorkflowDetail(id: string): Promise<TuiWorkflowDetail> {
    return Promise.resolve({
      id,
      name: "pipeline",
      status: "running" as TuiJobStatus,
      steps: [{ id: "s1", status: "unknown", info: "job job-1" }],
      result: null,
      graph: {
        nodes: [{ id: "s1", name: "Compute", kind: "SoftwareUsecaseComputing" }],
        edges: [],
      },
      stepJobs: { s1: "job-1" },
    });
  }

  subscribeWorkflowStatus(): () => void {
    return () => {};
  }

  listAgents(): Promise<TuiAgent[]> {
    return Promise.resolve([
      { id: "local", site: "this-node", scheduler: "slurm 23.02", status: "running" },
    ]);
  }

  listSoftware(): Promise<TuiSoftware[]> {
    return Promise.resolve([
      {
        id: "spack/zlib",
        name: "zlib",
        source: "spack",
        versions: ["1.3"],
        lifecycle: "installed",
        spec: "zlib@1.3",
        hash: "zlib-local-spec",
        compiler: "gcc@13",
        reportedAt: "2026-08-10T00:00:00.000Z",
      },
    ]);
  }
}
