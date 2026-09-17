import { describe, expect, it } from "bun:test";
import type { LocalWorkflowRunner } from "@kuintessence/agent/embedded";
import { createLocalWorkflowSupport } from "../tui/backend/local-workflows";
import {
  type TuiAgent,
  type TuiBackend,
  type TuiBackendCapabilities,
  type TuiBackendInfo,
  type TuiJob,
  type TuiJobDetail,
  type TuiJobStatus,
  type TuiSoftware,
  type TuiSubmitResult,
  type TuiWorkflowDetail,
  type TuiWorkflowRun,
  UnsupportedInModeError,
} from "../tui/backend/types";
import { createGuiServer } from "./server";

interface FakeOptions {
  unsupported?: ReadonlySet<string>;
  target?: string;
  workflowDetail?: Omit<TuiWorkflowDetail, "id">;
}

/** In-memory TuiBackend recording calls so route tests can assert wiring. */
class FakeBackend implements TuiBackend {
  readonly info: TuiBackendInfo;
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
  readonly calls: string[] = [];
  private readonly unsupported: ReadonlySet<string>;
  private readonly workflowDetail: FakeOptions["workflowDetail"];

  constructor(opts: FakeOptions = {}) {
    this.info = { mode: "local", target: opts.target ?? "slurm 23.02" };
    this.unsupported = opts.unsupported ?? new Set();
    this.workflowDetail = opts.workflowDetail;
  }

  private guard(name: string): void {
    if (this.unsupported.has(name)) throw new UnsupportedInModeError(name, "local");
  }

  listJobs(): Promise<TuiJob[]> {
    this.calls.push("listJobs");
    this.guard("listJobs");
    return Promise.resolve([
      {
        id: "j1",
        name: "echo",
        status: "running" as TuiJobStatus,
        location: "batch",
        submittedAt: "2026-06-02T00:00:00Z",
      },
    ]);
  }

  cancelJob(id: string): Promise<void> {
    this.calls.push(`cancelJob:${id}`);
    this.guard("cancelJob");
    return Promise.resolve();
  }

  getJobDetail(id: string): Promise<TuiJobDetail> {
    this.calls.push(`getJobDetail:${id}`);
    this.guard("getJobDetail");
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

  submitFromSpec(raw: string): Promise<TuiSubmitResult> {
    this.calls.push(`submitFromSpec:${raw}`);
    this.guard("submitFromSpec");
    return Promise.resolve({ id: "j99", name: "submitted" });
  }

  getJobLogs(id: string, lines: number): Promise<string> {
    this.calls.push(`getJobLogs:${id}:${lines}`);
    this.guard("getJobLogs");
    return Promise.resolve("line1\nline2");
  }

  listWorkflows(): Promise<TuiWorkflowRun[]> {
    this.calls.push("listWorkflows");
    this.guard("listWorkflows");
    return Promise.resolve([
      { id: "w1", name: "pipeline", status: "running" as TuiJobStatus, createdAt: "t0" },
    ]);
  }

  submitWorkflow(yaml: string): Promise<TuiSubmitResult> {
    this.calls.push(`submitWorkflow:${yaml}`);
    this.guard("submitWorkflow");
    return Promise.resolve({ id: "w99", name: "wf" });
  }

  getWorkflowDetail(id: string): Promise<TuiWorkflowDetail> {
    this.calls.push(`getWorkflowDetail:${id}`);
    this.guard("getWorkflowDetail");
    if (this.workflowDetail) return Promise.resolve({ ...this.workflowDetail, id });
    return Promise.resolve({
      id,
      name: "pipeline",
      status: "running" as TuiJobStatus,
      steps: [{ id: "s1", status: "Running", info: '{"residual":0.003}' }],
      result: {
        status: { s1: "Running" },
        values: { s1: { status: "Running", values: { residual: 0.003 } } },
      },
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
    this.calls.push("listAgents");
    this.guard("listAgents");
    return Promise.resolve([
      { id: "local", site: "this-node", scheduler: "slurm 23.02", status: "running" },
    ]);
  }

  listSoftware(): Promise<TuiSoftware[]> {
    this.calls.push("listSoftware");
    this.guard("listSoftware");
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

function req(method: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://x${path}`, { method, ...init });
}

function jsonBody(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return req(method, path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("createGuiServer auth stub", () => {
  it("POST /api/auth/login returns a token (default local-dev)", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(jsonBody("POST", "/api/auth/login", { email: "a@b.c", role: "user" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ token: "local-dev", expiresIn: 86400 });
  });

  it("POST /api/auth/login echoes the configured token", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "t" });
    const r = await s.fetch(jsonBody("POST", "/api/auth/login", { email: "a@b.c", role: "user" }));
    expect((await r.json()).token).toBe("t");
  });

  it("GET /api/auth/oidc/config-public → { enabled:false, providerName:'' }", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", "/api/auth/oidc/config-public"));
    expect(await r.json()).toEqual({ enabled: false, providerName: "" });
  });

  it("auth routes are open even when a token is configured", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "t" });
    expect((await s.fetch(req("GET", "/api/auth/oidc/config-public"))).status).toBe(200);
    expect(
      (await s.fetch(jsonBody("POST", "/api/auth/login", { email: "a@b.c", role: "user" }))).status,
    ).toBe(200);
  });
});

describe("createGuiServer jobs", () => {
  it("GET /api/jobs → { jobs: JobRow[] } (Server shape)", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", "/api/jobs"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs[0]).toEqual({
      id: "j1",
      name: "echo",
      status: "running",
      submittedAt: "2026-06-02T00:00:00Z",
    });
  });

  it("POST /api/jobs → maps the Server JobSubmit shape to the local spec", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const spec = {
      name: "echo",
      command: "echo hi",
      resources: { cpus: 1, memoryMb: 256, gpus: 2, wallTimeSec: 60 },
      workingDir: "/scratch/run",
    };
    const r = await s.fetch(jsonBody("POST", "/api/jobs", spec));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: "j99", name: "submitted" });
    expect(backend.calls).toContain(
      `submitFromSpec:${JSON.stringify({
        name: "echo",
        command: "echo hi",
        workingDir: "/scratch/run",
        cpus: 1,
        memoryMb: 256,
        gpus: 2,
        wallTimeSec: 60,
      })}`,
    );
  });

  it("POST /api/jobs with non-JSON body → 400", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("POST", "/api/jobs", { body: "not json" }));
    expect(r.status).toBe(400);
  });

  it("POST /api/jobs defaults workingDir to the GUI server directory", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const r = await s.fetch(
      jsonBody("POST", "/api/jobs", {
        name: "echo",
        command: "echo hi",
        resources: { cpus: 1, memoryMb: 256 },
      }),
    );
    expect(r.status).toBe(201);
    expect(backend.calls).toContain(
      `submitFromSpec:${JSON.stringify({
        name: "echo",
        command: "echo hi",
        workingDir: process.cwd(),
        cpus: 1,
        memoryMb: 256,
        gpus: 0,
        wallTimeSec: 0,
      })}`,
    );
  });

  it("POST /api/jobs leaves Kubernetes workingDir unset by default", async () => {
    const backend = new FakeBackend({ target: "kubernetes v1.31.6" });
    const s = createGuiServer(backend, {});
    const r = await s.fetch(
      jsonBody("POST", "/api/jobs", {
        name: "echo",
        command: "echo hi",
        resources: { cpus: 1, memoryMb: 256 },
      }),
    );
    expect(r.status).toBe(201);
    expect(backend.calls[0]).toContain('"workingDir":""');
  });

  it("POST /api/jobs rejects Server-only fields instead of silently dropping them", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const r = await s.fetch(
      jsonBody("POST", "/api/jobs", {
        name: "echo",
        command: "echo hi",
        resources: { cpus: 1, memoryMb: 256 },
        tags: ["server-only"],
      }),
    );
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({
      error: "not available in local mode: tags",
      unsupported: true,
    });
    expect(backend.calls).toEqual([]);
  });

  it("POST /api/jobs with a flat local spec → 400", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(
      jsonBody("POST", "/api/jobs", {
        name: "echo",
        command: "echo hi",
        cpus: 1,
        memoryMb: 256,
      }),
    );
    expect(r.status).toBe(400);
  });

  it("GET /api/jobs/:id → toJobDetail (Server shape)", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const r = await s.fetch(req("GET", "/api/jobs/j7"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      id: "j7",
      command: "echo hi",
      exitCode: 0,
      resources: { cpus: 2, memoryMb: 512 },
    });
    expect(backend.calls).toContain("getJobDetail:j7");
  });

  it("POST /api/jobs/:id/cancel → cancels then returns the detail", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const r = await s.fetch(req("POST", "/api/jobs/j7/cancel"));
    expect(r.status).toBe(200);
    expect((await r.json()).id).toBe("j7");
    expect(backend.calls).toContain("cancelJob:j7");
    expect(backend.calls).toContain("getJobDetail:j7");
  });

  it("GET /api/jobs/:id/logs?text=1 → { text }", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const r = await s.fetch(req("GET", "/api/jobs/j7/logs?text=1"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: "line1\nline2" });
    expect(backend.calls).toContain("getJobLogs:j7:1000");
  });

  it("decodes :id percent-encoding", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    await s.fetch(req("GET", "/api/jobs/a%2Fb"));
    expect(backend.calls).toContain("getJobDetail:a/b");
  });
});

describe("createGuiServer workflows", () => {
  it("GET /api/workflows → { runs: WorkflowRunRow[] }", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", "/api/workflows"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.runs[0]).toEqual({
      id: "w1",
      name: "pipeline",
      status: "running",
      createdAt: "t0",
    });
  });

  it("POST /api/workflows {yaml} → { runId, name, status }", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const r = await s.fetch(jsonBody("POST", "/api/workflows", { yaml: "name: x" }));
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ runId: "w99", name: "wf", status: "submitted" });
    expect(backend.calls).toContain("submitWorkflow:name: x");
  });

  it("POST /api/workflows/run {yaml} → { runId }", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const r = await s.fetch(jsonBody("POST", "/api/workflows/run", { yaml: "name: y" }));
    expect(r.status).toBe(202);
    expect((await r.json()).runId).toBe("w99");
    expect(backend.calls).toContain("submitWorkflow:name: y");
  });

  it("POST /api/workflows missing yaml → 400", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(jsonBody("POST", "/api/workflows", {}));
    expect(r.status).toBe(400);
  });

  it("GET /api/workflows/:id → toWorkflowRunDetail", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", "/api/workflows/w5"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.id).toBe("w5");
    expect(body.stepJobs).toEqual({ s1: "job-1" });
    expect(body.result).toEqual({
      status: { s1: "Running" },
      values: { s1: { status: "Running", values: { residual: 0.003 } } },
    });
    expect(body.graph).toEqual({
      nodes: [{ id: "s1", name: "Compute", kind: "SoftwareUsecaseComputing" }],
      edges: [],
    });
  });

  it("GET workflow detail preserves local results without graph or job ids", async () => {
    const result = {
      status: { solve: "Failed" },
      values: {
        solve: {
          status: "Failed",
          values: { residual: 0.003 },
          failure: { message: "Exit 7", jobId: "job-failed", exitCode: 7 },
        },
      },
    };
    const s = createGuiServer(
      new FakeBackend({
        workflowDetail: {
          name: "local-result",
          status: "failed",
          steps: [{ id: "solve", status: "Failed", info: '{"residual":0.003}' }],
          result,
        },
      }),
      {},
    );
    const response = await s.fetch(req("GET", "/api/workflows/local"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toEqual(result);
    expect(body.graph).toBeNull();
    expect(body.stepJobs).toEqual({});
  });

  it("GET workflow detail never interprets display info as job ids", async () => {
    const s = createGuiServer(
      new FakeBackend({
        workflowDetail: {
          name: "display-only",
          status: "running",
          steps: [
            { id: "values", status: "Succeeded", info: '{"jobId":"not-an-association"}' },
            { id: "label", status: "unknown", info: "job job-label" },
            { id: "bare", status: "unknown", info: "job-bare" },
          ],
        },
      }),
      {},
    );
    const response = await s.fetch(req("GET", "/api/workflows/display-only"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.stepJobs).toEqual({});
    expect(body.result).toBeNull();
    expect(body.graph).toBeNull();
  });

  it("GET workflow detail preserves active graph and real jobs without a result", async () => {
    const graph = {
      nodes: [{ id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" }],
      edges: [],
    };
    const s = createGuiServer(
      new FakeBackend({
        workflowDetail: {
          name: "active",
          status: "running",
          steps: [{ id: "solve", status: "unknown", info: "job job-solve" }],
          result: null,
          graph,
          stepJobs: { solve: "job-solve" },
        },
      }),
      {},
    );
    const response = await s.fetch(req("GET", "/api/workflows/active"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBeNull();
    expect(body.graph).toEqual(graph);
    expect(body.stepJobs).toEqual({ solve: "job-solve" });
  });

  it("GET a local spec preview exposes Pending node results and the actual graph", async () => {
    const support = createLocalWorkflowSupport(
      "/wf",
      {} as LocalWorkflowRunner,
      {
        getRun: async () => null,
        listRuns: async () => [],
      },
      {
        readDir: () => ["preview.yml"],
        readFile: () => `name: Preview
spec:
  nodeDrafts:
    - { id: solve, name: Solve, type: NoAction }
    - { id: collect, name: Collect, type: NoAction }
  nodeRelations:
    - { fromId: solve, toId: collect, slotRelations: [], when: { expr: "true" } }
`,
      },
    );
    const preview = await support.getDetail?.("preview.yml");
    if (!preview) throw new Error("expected a local workflow preview");
    const s = createGuiServer(new FakeBackend({ workflowDetail: preview }), {});
    const response = await s.fetch(req("GET", "/api/workflows/preview.yml"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("queued");
    expect(body.result).toEqual({
      status: { solve: "Pending", collect: "Pending" },
      values: {},
    });
    expect(body.graph).toEqual({
      nodes: [
        { id: "solve", name: "Solve", kind: "NoAction" },
        { id: "collect", name: "Collect", kind: "NoAction" },
      ],
      edges: [{ source: "solve", target: "collect", when: "true" }],
    });
    expect(body.stepJobs).toEqual({});
  });
});

describe("createGuiServer agents + software", () => {
  it("GET /api/agents → { agents: AgentRow[] }", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", "/api/agents"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.agents[0]).toMatchObject({
      agentId: "local",
      siteName: "this-node",
      schedulerType: "slurm",
      schedulerVersion: "23.02",
    });
  });

  it("GET /api/agents/:id → matched AgentRow", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", "/api/agents/local"));
    expect(r.status).toBe(200);
    expect((await r.json()).agentId).toBe("local");
  });

  it("GET /api/agents/:id unknown → 404", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", "/api/agents/missing"));
    expect(r.status).toBe(404);
  });

  it("GET /api/software/agents/:id/installed → { success, data }", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", "/api/software/agents/local/installed"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.data[0]).toMatchObject({ name: "zlib", spec: "zlib@1.3" });
  });
});

describe("createGuiServer capabilities", () => {
  it("GET /api/capabilities → backend.capabilities", async () => {
    const backend = new FakeBackend();
    const s = createGuiServer(backend, {});
    const r = await s.fetch(req("GET", "/api/capabilities"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(backend.capabilities);
  });

  it("GET /api/capabilities is auth-guarded when a token is configured", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "t" });
    expect((await s.fetch(req("GET", "/api/capabilities"))).status).toBe(401);
    expect(
      (await s.fetch(req("GET", "/api/capabilities", { headers: { authorization: "Bearer t" } })))
        .status,
    ).toBe(200);
  });
});

describe("createGuiServer Server-only routes → 404", () => {
  it.each([
    "/api/cp/clusters",
    "/api/audit-log",
    "/api/terminal/sessions",
    "/api/files/list",
    "/api/netdrive/mounts",
    "/api/software/policies",
  ])("%s → 404 not-available", async (path) => {
    const s = createGuiServer(new FakeBackend(), {});
    const r = await s.fetch(req("GET", path));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("not available in local mode");
  });
});

describe("createGuiServer errors", () => {
  it("UnsupportedInModeError → 501 { unsupported:true }", async () => {
    const s = createGuiServer(new FakeBackend({ unsupported: new Set(["listWorkflows"]) }), {});
    const r = await s.fetch(req("GET", "/api/workflows"));
    expect(r.status).toBe(501);
    const body = await r.json();
    expect(body.unsupported).toBe(true);
    expect(body.error).toBeString();
  });

  it("generic backend error → 500 { error }", async () => {
    const backend = new FakeBackend();
    backend.listJobs = () => Promise.reject(new Error("scheduler down"));
    const s = createGuiServer(backend, {});
    const r = await s.fetch(req("GET", "/api/jobs"));
    expect(r.status).toBe(500);
    expect((await r.json()).error).toBe("scheduler down");
  });

  it("unknown route → 404", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    expect((await s.fetch(req("GET", "/api/nope"))).status).toBe(404);
  });
});

describe("createGuiServer auth matrix", () => {
  it("token configured → protected routes need Bearer", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "t" });
    expect((await s.fetch(req("GET", "/api/jobs"))).status).toBe(401);
    expect(
      (await s.fetch(req("GET", "/api/jobs", { headers: { authorization: "Bearer t" } }))).status,
    ).toBe(200);
  });

  it("wrong token → 401", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "t" });
    expect(
      (await s.fetch(req("GET", "/api/jobs", { headers: { authorization: "Bearer no" } }))).status,
    ).toBe(401);
  });

  it("no token configured → no auth", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    expect((await s.fetch(req("GET", "/api/jobs"))).status).toBe(200);
  });
});
