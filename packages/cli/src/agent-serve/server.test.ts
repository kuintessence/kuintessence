import { describe, expect, it } from "bun:test";
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
import { createAgentServer } from "./server";

interface FakeOptions {
  capabilities?: Partial<TuiBackendCapabilities>;
  /** Methods that should throw UnsupportedInModeError, by name. */
  unsupported?: ReadonlySet<string>;
}

/** In-memory TuiBackend that records calls so route tests can assert wiring
 *  without a real scheduler. */
class FakeBackend implements TuiBackend {
  readonly info: TuiBackendInfo = { mode: "local", target: "slurm 23.02" };
  readonly capabilities: TuiBackendCapabilities;
  readonly calls: string[] = [];
  private readonly unsupported: ReadonlySet<string>;

  constructor(opts: FakeOptions = {}) {
    this.capabilities = {
      jobs: true,
      submit: true,
      logs: true,
      workflows: true,
      agents: false,
      metrics: true,
      software: true,
      ssh: false,
      ...opts.capabilities,
    };
    this.unsupported = opts.unsupported ?? new Set();
  }

  private guard(name: string): void {
    if (this.unsupported.has(name)) {
      throw new UnsupportedInModeError(name, "local");
    }
  }

  listJobs(): Promise<TuiJob[]> {
    this.calls.push("listJobs");
    this.guard("listJobs");
    return Promise.resolve([
      { id: "1", name: "job-a", status: "running" as TuiJobStatus, location: "batch" },
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
    return Promise.resolve({ id, name: "job-a", status: "running" as TuiJobStatus });
  }

  subscribeJobStatus(): () => void {
    return () => {};
  }

  submitFromSpec(raw: string): Promise<TuiSubmitResult> {
    this.calls.push(`submitFromSpec:${raw}`);
    this.guard("submitFromSpec");
    return Promise.resolve({ id: "99", name: "submitted" });
  }

  getJobLogs(id: string, lines: number): Promise<string> {
    this.calls.push(`getJobLogs:${id}:${lines}`);
    this.guard("getJobLogs");
    return Promise.resolve("line1\nline2");
  }

  listWorkflows(): Promise<TuiWorkflowRun[]> {
    this.calls.push("listWorkflows");
    this.guard("listWorkflows");
    return Promise.resolve([{ id: "w1", name: "wf", status: "running" as TuiJobStatus }]);
  }

  submitWorkflow(yaml: string): Promise<TuiSubmitResult> {
    this.calls.push(`submitWorkflow:${yaml}`);
    this.guard("submitWorkflow");
    return Promise.resolve({ id: "w99" });
  }

  getWorkflowDetail(id: string): Promise<TuiWorkflowDetail> {
    this.calls.push(`getWorkflowDetail:${id}`);
    this.guard("getWorkflowDetail");
    return Promise.resolve({ id, name: "wf", status: "running" as TuiJobStatus, steps: [] });
  }

  subscribeWorkflowStatus(): () => void {
    return () => {};
  }

  listAgents(): Promise<TuiAgent[]> {
    this.calls.push("listAgents");
    this.guard("listAgents");
    return Promise.resolve([
      { id: "local", site: "this-node", scheduler: "slurm", status: "running" as TuiJobStatus },
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
      },
    ]);
  }
}

function req(method: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://x${path}`, { method, ...init });
}

describe("createAgentServer", () => {
  it("GET /healthz → 200 {ok:true}, no auth required", async () => {
    const server = createAgentServer(new FakeBackend(), { token: "secret" });
    const res = await server.fetch(req("GET", "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /info → backend.info", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/info"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(backend.info);
  });

  it("GET /capabilities → backend.capabilities", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(backend.capabilities);
  });

  it("GET /jobs → backend.listJobs", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/jobs"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "1", name: "job-a", status: "running", location: "batch" },
    ]);
    expect(backend.calls).toContain("listJobs");
  });

  it("POST /jobs → 201 submitFromSpec", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(
      req("POST", "/jobs", { body: JSON.stringify({ spec: "{json}" }) }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "99", name: "submitted" });
    expect(backend.calls).toContain("submitFromSpec:{json}");
  });

  it("POST /jobs with bad body → 400", async () => {
    const server = createAgentServer(new FakeBackend(), {});
    const res = await server.fetch(req("POST", "/jobs", { body: "not json" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeString();
  });

  it("POST /jobs missing spec → 400", async () => {
    const server = createAgentServer(new FakeBackend(), {});
    const res = await server.fetch(req("POST", "/jobs", { body: JSON.stringify({ foo: 1 }) }));
    expect(res.status).toBe(400);
  });

  it("GET /jobs/:id → getJobDetail", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/jobs/42"));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("42");
    expect(backend.calls).toContain("getJobDetail:42");
  });

  it("DELETE /jobs/:id → 204 cancelJob", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("DELETE", "/jobs/7"));
    expect(res.status).toBe(204);
    expect(backend.calls).toContain("cancelJob:7");
  });

  it("GET /jobs/:id/logs?lines=N → {logs}", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/jobs/3/logs?lines=10"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logs: "line1\nline2" });
    expect(backend.calls).toContain("getJobLogs:3:10");
  });

  it("GET /agents → listAgents (metrics pane parity)", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/agents"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "local", site: "this-node", scheduler: "slurm", status: "running" },
    ]);
    expect(backend.calls).toContain("listAgents");
  });

  it("GET /software → listSoftware", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/software"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TuiSoftware[])[0]?.name).toBe("zlib");
  });

  it("GET /workflows → listWorkflows", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/workflows"));
    expect(res.status).toBe(200);
    expect(backend.calls).toContain("listWorkflows");
  });

  it("POST /workflows → 201 submitWorkflow", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(
      req("POST", "/workflows", { body: JSON.stringify({ yaml: "name: x" }) }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "w99" });
    expect(backend.calls).toContain("submitWorkflow:name: x");
  });

  it("POST /workflows missing yaml → 400", async () => {
    const server = createAgentServer(new FakeBackend(), {});
    const res = await server.fetch(req("POST", "/workflows", { body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
  });

  it("GET /workflows/:id → getWorkflowDetail", async () => {
    const backend = new FakeBackend();
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/workflows/w5"));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("w5");
    expect(backend.calls).toContain("getWorkflowDetail:w5");
  });

  it("UnsupportedInModeError → 501 {unsupported:true}", async () => {
    const backend = new FakeBackend({ unsupported: new Set(["listWorkflows"]) });
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/workflows"));
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.unsupported).toBe(true);
    expect(body.error).toBeString();
  });

  it("backend throwing a generic error → 500 {error}", async () => {
    const backend = new FakeBackend();
    backend.listJobs = () => Promise.reject(new Error("scheduler down"));
    const server = createAgentServer(backend, {});
    const res = await server.fetch(req("GET", "/jobs"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("scheduler down");
  });

  it("unknown route → 404", async () => {
    const server = createAgentServer(new FakeBackend(), {});
    const res = await server.fetch(req("GET", "/nope"));
    expect(res.status).toBe(404);
  });

  describe("auth", () => {
    it("missing token when configured → 401 on a protected route", async () => {
      const server = createAgentServer(new FakeBackend(), { token: "secret" });
      const res = await server.fetch(req("GET", "/jobs"));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized");
    });

    it("wrong token → 401", async () => {
      const server = createAgentServer(new FakeBackend(), { token: "secret" });
      const res = await server.fetch(
        req("GET", "/jobs", { headers: { Authorization: "Bearer nope" } }),
      );
      expect(res.status).toBe(401);
    });

    it("correct bearer token → passes", async () => {
      const server = createAgentServer(new FakeBackend(), { token: "secret" });
      const res = await server.fetch(
        req("GET", "/jobs", { headers: { Authorization: "Bearer secret" } }),
      );
      expect(res.status).toBe(200);
    });

    it("healthz is open even with auth configured", async () => {
      const server = createAgentServer(new FakeBackend(), { token: "secret" });
      const res = await server.fetch(req("GET", "/healthz"));
      expect(res.status).toBe(200);
    });

    it("no token configured → no auth required", async () => {
      const server = createAgentServer(new FakeBackend(), {});
      const res = await server.fetch(req("GET", "/jobs"));
      expect(res.status).toBe(200);
    });
  });

  describe("Bun.serve smoke", () => {
    it("serves /healthz over a real ephemeral port", async () => {
      const server = createAgentServer(new FakeBackend(), {});
      const listener = Bun.serve({ port: 0, fetch: server.fetch });
      try {
        const res = await fetch(`http://${listener.hostname}:${listener.port}/healthz`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        listener.stop(true);
      }
    });
  });
});
