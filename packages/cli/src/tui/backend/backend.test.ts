import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListedJob, SchedulerAdapter, Spawner } from "@kuintessence/agent/adapters";
import {
  LocalSoftwareCatalog,
  type SoftwareEntry,
  SqliteLocalJobStore,
} from "@kuintessence/agent/embedded";
import { createSqliteDb } from "@kuintessence/db";
import { ApiClient } from "../../lib/api-client";
import { LocalBackend } from "./local";
import { RemoteBackend } from "./remote";
import { expandTilde, makeLocalStore, probeWorkflowSupport, resolveTuiMode } from "./select";
import { type TuiWorkflowRun, UnsupportedInModeError } from "./types";

// ── RemoteBackend (scenario 1) ───────────────────────────────────────────────

function stubClient(
  getResult: unknown,
  onPost?: (path: string, body: unknown) => void,
  postResult: unknown = {},
): ApiClient {
  const client = new ApiClient("http://server.test", "tok");
  // @ts-expect-error — override network methods for a pure unit test
  client.get = async () => getResult;
  // @ts-expect-error — override network methods for a pure unit test
  client.post = async (path: string, body: unknown) => {
    onPost?.(path, body);
    return postResult;
  };
  return client;
}

describe("RemoteBackend", () => {
  test("maps Server job list into TuiJob[] and normalises status", async () => {
    const client = stubClient({
      jobs: [
        { id: "a1", name: "wrf", status: "RUNNING", submittedAt: "t1", agentId: "site-alpha" },
        { id: "b2", name: "mesh", status: "pending", submittedAt: "t2" },
        { id: "c3", name: "post", status: "weird-state" },
      ],
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test", token: "tok" });

    expect(backend.info).toEqual({ mode: "remote", target: "http://server.test" });
    expect(backend.capabilities).toEqual({
      jobs: true,
      submit: true,
      logs: true,
      workflows: true,
      agents: true,
      metrics: true,
      software: true,
      ssh: true,
    });
    expect(await backend.listJobs()).toEqual([
      { id: "a1", name: "wrf", status: "running", location: "site-alpha", submittedAt: "t1" },
      { id: "b2", name: "mesh", status: "queued", location: "—", submittedAt: "t2" },
      { id: "c3", name: "post", status: "unknown", location: "—", submittedAt: undefined },
    ]);
  });

  test("getJobDetail maps the Server job record", async () => {
    const client = stubClient({
      id: "j1",
      name: "wrf",
      status: "completed",
      schedulerJobId: "12345",
      startedAt: "s",
      completedAt: "c",
      exitCode: 0,
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    expect(await backend.getJobDetail("j1")).toEqual({
      id: "j1",
      name: "wrf",
      status: "completed",
      schedulerJobId: "12345",
      startedAt: "s",
      completedAt: "c",
      exitCode: 0,
    });
  });

  test("getJobDetail surfaces the node when the Server returns it", async () => {
    const client = stubClient({
      id: "j1",
      name: "wrf",
      status: "running",
      node: "node[001-004]",
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    const detail = await backend.getJobDetail("j1");
    expect(detail.node).toBe("node[001-004]");
  });

  test("cancelJob posts to the cancel endpoint", async () => {
    let posted = "";
    const client = stubClient({ jobs: [] }, (p) => {
      posted = p;
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    await backend.cancelJob("job-9");
    expect(posted).toBe("/jobs/job-9/cancel");
  });

  test("submitFromSpec passes parsed JSON through to POST /jobs", async () => {
    let body: unknown;
    const client = stubClient(
      { jobs: [] },
      (_p, b) => {
        body = b;
      },
      { id: "job-7", name: "wrf" },
    );
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    const res = await backend.submitFromSpec('{"name":"wrf","command":"echo"}');
    expect(res).toEqual({ id: "job-7", name: "wrf" });
    expect(body).toEqual({ name: "wrf", command: "echo" });
  });

  test("submitFromSpec rejects invalid JSON", async () => {
    const backend = new RemoteBackend(stubClient({ jobs: [] }), {
      serverUrl: "http://server.test",
    });
    expect(backend.submitFromSpec("{not json")).rejects.toThrow(/not valid JSON/);
  });

  test("getJobLogs returns the text tail", async () => {
    const backend = new RemoteBackend(stubClient({ text: "out\nerr\n" }), {
      serverUrl: "http://server.test",
    });
    expect(await backend.getJobLogs("j1", 100)).toBe("out\nerr\n");
  });

  test("submitWorkflow posts YAML to /workflows and returns the run id", async () => {
    let body: unknown;
    const client = stubClient(
      { runs: [] },
      (_p, b) => {
        body = b;
      },
      { runId: "run-7", name: "pipe" },
    );
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    const yaml = "name: pipe\nspec:\n  nodeDrafts: []\n";
    expect(await backend.submitWorkflow(yaml)).toEqual({ id: "run-7", name: "pipe" });
    expect(body).toEqual({ yaml });
  });

  test("listWorkflows maps the runs envelope", async () => {
    const client = stubClient({
      runs: [{ id: "w1", name: "pipe", status: "running", createdAt: "t" }],
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    expect(await backend.listWorkflows()).toEqual([
      { id: "w1", name: "pipe", status: "running", createdAt: "t" },
    ]);
  });

  test("getWorkflowDetail maps a run's per-node status + values into steps", async () => {
    const record = {
      id: "w1",
      name: "pipe",
      status: "running",
      graph: {
        nodes: [
          { id: "build", name: "Build", kind: "SoftwareUsecaseComputing" },
          { id: "run", name: "Run", kind: "SoftwareUsecaseComputing" },
        ],
        edges: [],
      },
      stepJobs: { build: "job-build", run: "job-run" },
      result: {
        status: { build: "completed", run: "running" },
        values: {
          build: { status: "completed", values: { artifact: "a.tar" } },
          run: { status: "running", values: {} },
        },
      },
    };
    const client = stubClient(record);
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    const d = await backend.getWorkflowDetail("w1");
    expect(d.status).toBe("running");
    expect(d.result).toBe(record.result);
    expect(d.graph).toBe(record.graph);
    expect(d.stepJobs).toBe(record.stepJobs);
    expect(d.steps).toEqual([
      { id: "build", status: "completed", info: '{"artifact":"a.tar"}' },
      { id: "run", status: "running", info: undefined },
    ]);
  });

  test.each([
    undefined,
    null,
  ])("getWorkflowDetail needs a result or graph nodes (%s)", async (result) => {
    for (const graph of [undefined, null, { nodes: [], edges: [] }]) {
      const client = stubClient({
        id: "w2",
        name: "pending-result",
        status: "running",
        description: "computing",
        graph,
        stepJobs: { prep: "job-1", solve: "job-2" },
        result,
      });
      const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
      const d = await backend.getWorkflowDetail("w2");
      expect(d.status).toBe("running");
      expect(d.description).toBe("computing");
      expect(d.steps).toEqual([]);
      expect(d.result).toBe(result);
      expect(d.graph).toBe(graph);
      expect(d.stepJobs).toEqual({ prep: "job-1", solve: "job-2" });
    }
  });

  test.each([
    undefined,
    null,
  ])("maps active graph nodes to jobs without result (%s)", async (result) => {
    const graph = {
      nodes: [
        { id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" },
        { id: "collect", name: "Collect", kind: "NoAction" },
      ],
      edges: [],
    };
    const client = stubClient({
      id: "active",
      name: "computing",
      status: "running",
      graph,
      stepJobs: { orphan: "job-outside", solve: "job-solve" },
      result,
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    const detail = await backend.getWorkflowDetail("active");
    expect(detail.status).toBe("running");
    expect(detail.result).toBe(result);
    expect(detail.graph).toBe(graph);
    expect(detail.stepJobs).toEqual({ orphan: "job-outside", solve: "job-solve" });
    expect(detail.steps).toEqual([
      { id: "solve", status: "unknown", info: "job job-solve" },
      { id: "collect", status: "unknown", info: undefined },
    ]);
    expect(graph.edges).toEqual([]);
  });

  test("maps graph nodes before any jobs are submitted", async () => {
    const client = stubClient({
      id: "queued",
      name: "computing",
      status: "queued",
      graph: {
        nodes: [{ id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" }],
        edges: [],
      },
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    expect((await backend.getWorkflowDetail("queued")).steps).toEqual([
      { id: "solve", status: "unknown", info: undefined },
    ]);
  });

  test("listSoftware maps the Registry catalog", async () => {
    const client = stubClient({});
    let requested = "";
    const backend = new RemoteBackend(
      client,
      { serverUrl: "http://server.test" },
      undefined,
      async (input) => {
        requested = String(input);
        return new Response(
          JSON.stringify({
            page: 2,
            pageSize: 50,
            totalCount: 2,
            totalPages: 3,
            packages: [
              {
                name: "openmpi",
                source: "upstream",
                metadata: { versions: ["4.1.6"] },
                asset: { version: "upstream", lifecycle: "published" },
              },
              {
                name: "cuda",
                id: "vendor-cuda-id",
                source: "vendor",
                metadata: { versions: ["12.4"] },
              },
            ],
          }),
        );
      },
    );
    const page = await backend.listSoftwarePage({ page: 2, pageSize: 50, query: "cuda" });
    expect(page).toEqual({
      page: 2,
      pageSize: 50,
      totalCount: 2,
      totalPages: 3,
      items: [
        {
          id: "catalog:upstream:openmpi",
          name: "openmpi",
          source: "upstream",
          versions: ["4.1.6"],
          lifecycle: "published",
        },
        {
          id: "vendor-cuda-id",
          name: "cuda",
          source: "vendor",
          versions: ["12.4"],
          lifecycle: "catalog",
        },
      ],
    });
    expect(requested).toContain("page=2&pageSize=50&q=cuda");
  });

  test("listAgents maps the agents envelope and online→running", async () => {
    const client = stubClient({
      agents: [
        {
          agentId: "ag1",
          siteName: "site-alpha",
          schedulerType: "slurm",
          schedulerVersion: "23.02.7",
          status: "online",
        },
        {
          agentId: "ag2",
          siteName: "site-beta",
          schedulerType: "pbs",
          schedulerVersion: "2024",
          status: "offline",
        },
      ],
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    expect(await backend.listAgents()).toEqual([
      { id: "ag1", site: "site-alpha", scheduler: "slurm 23.02.7", status: "running" },
      { id: "ag2", site: "site-beta", scheduler: "pbs 2024", status: "failed" },
    ]);
  });

  test("listAgents passes through GPU + disk telemetry from the agent row", async () => {
    const client = stubClient({
      agents: [
        {
          agentId: "ag-g",
          siteName: "gpu",
          schedulerType: "slurm",
          schedulerVersion: "23",
          status: "online",
          diskUsedPercent: 72,
          gpus: [{ index: 0, model: "A100", utilPercent: 87, memUsedMb: 12000, memTotalMb: 40000 }],
        },
      ],
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    const [agent] = await backend.listAgents();
    expect(agent?.diskUsedPercent).toBe(72);
    expect(agent?.gpus).toEqual([
      { index: 0, model: "A100", utilPercent: 87, memUsedMb: 12000, memTotalMb: 40000 },
    ]);
  });

  test("listAgents maps the lastHeartbeat timestamp for staleness display", async () => {
    const client = stubClient({
      agents: [
        {
          agentId: "ag1",
          siteName: "site-alpha",
          schedulerType: "slurm",
          schedulerVersion: "23",
          status: "online",
          lastHeartbeat: "2026-05-30T12:00:00Z",
        },
      ],
    });
    const backend = new RemoteBackend(client, { serverUrl: "http://server.test" });
    const [agent] = await backend.listAgents();
    expect(agent?.lastHeartbeat).toBe("2026-05-30T12:00:00Z");
  });
});

// ── LocalBackend (scenario 2) ────────────────────────────────────────────────

/** A real {@link LocalSoftwareCatalog} backed by a fake Spawner: `spack` probes
 *  succeed and `spack find --json` yields the given entries. */
function fakeCatalog(entries: SoftwareEntry[]): LocalSoftwareCatalog {
  const findJson = JSON.stringify(
    entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      hash: entry.hash,
      compiler: entry.compiler
        ? {
            name: entry.compiler.split("@")[0],
            version: entry.compiler.split("@")[1],
          }
        : undefined,
      spec: entry.spec,
    })),
  );
  const spawner: Spawner = {
    async run(command: string[]) {
      if (command[1] === "find") {
        return { exitCode: 0, stdout: findJson, stderr: "" };
      }
      return { exitCode: 0, stdout: "spack 0.21.0", stderr: "" };
    },
  };
  return new LocalSoftwareCatalog({ spawner });
}

function fakeAdapter(over: Partial<SchedulerAdapter> = {}): SchedulerAdapter {
  return {
    type: "slurm",
    version: "23.02.7",
    async submit() {
      return { schedulerJobId: "1" };
    },
    async cancel() {},
    async status() {
      return { status: "running" };
    },
    ...over,
  };
}

describe("LocalBackend", () => {
  test("maps adapter.listJobs into TuiJob[] and reports local mode", async () => {
    const listed: ListedJob[] = [
      {
        schedulerJobId: "12345",
        name: "wrf",
        status: "running",
        queue: "compute",
        submittedAt: "t",
      },
      { schedulerJobId: "12346", name: "mesh", status: "queued" },
    ];
    const backend = new LocalBackend(fakeAdapter({ listJobs: async () => listed }));

    expect(backend.info).toEqual({ mode: "local", target: "slurm 23.02.7" });
    expect(backend.capabilities).toEqual({
      jobs: true,
      submit: true,
      logs: false,
      workflows: false,
      agents: false,
      metrics: false,
      software: false,
      ssh: false,
    });
    expect(await backend.listJobs()).toEqual([
      { id: "12345", name: "wrf", status: "running", location: "compute", submittedAt: "t" },
      { id: "12346", name: "mesh", status: "queued", location: "—", submittedAt: undefined },
    ]);
  });

  test("getJobDetail queries adapter.status for live status + exit code", async () => {
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [],
        status: async (id: string) => {
          expect(id).toBe("777");
          return { status: "completed" as const, exitCode: 0, message: "Slurm state: COMPLETED" };
        },
      }),
    );
    expect(await backend.getJobDetail("777")).toEqual({
      id: "777",
      name: "777",
      status: "completed",
      schedulerJobId: "777",
      exitCode: 0,
      message: "Slurm state: COMPLETED",
    });
  });

  test("getJobLogs lights up the logs capability and delegates to the adapter", async () => {
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [],
        getJobLogs: async (id: string, lines: number) => `${id}:${lines}:out`,
      }),
    );
    expect(backend.capabilities.logs).toBe(true);
    expect(await backend.getJobLogs("123", 50)).toBe("123:50:out");
  });

  test("subscribeJobStatus is a no-op returning a safe unsubscribe", () => {
    const backend = new LocalBackend(fakeAdapter({ listJobs: async () => [] }));
    const unsub = backend.subscribeJobStatus("777", () => {
      throw new Error("local should never push");
    });
    expect(() => unsub()).not.toThrow();
  });

  test("subscribeWorkflowStatus is a no-op returning a safe unsubscribe", () => {
    const backend = new LocalBackend(fakeAdapter({ listJobs: async () => [] }));
    const unsub = backend.subscribeWorkflowStatus("w1", () => {
      throw new Error("local should never push");
    });
    expect(() => unsub()).not.toThrow();
  });

  test("cancelJob delegates to adapter.cancel", async () => {
    let cancelled = "";
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [],
        cancel: async (id: string) => {
          cancelled = id;
        },
      }),
    );
    await backend.cancelJob("999");
    expect(cancelled).toBe("999");
  });

  test("an adapter without listJobs disables the jobs capability and throws on list", async () => {
    const backend = new LocalBackend(fakeAdapter({ listJobs: undefined }));
    expect(backend.capabilities.jobs).toBe(false);
    expect(backend.listJobs()).rejects.toBeInstanceOf(UnsupportedInModeError);
  });

  test("submitFromSpec maps a spec file to adapter.submit", async () => {
    let submitted: { name: string; cpus: number } | undefined;
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [],
        submit: async (spec) => {
          submitted = { name: spec.name, cpus: spec.cpus };
          return { schedulerJobId: "55555" };
        },
      }),
    );
    const res = await backend.submitFromSpec(
      '{"name":"wrf","command":"echo hi","cpus":4,"memoryMb":8192}',
    );
    expect(res).toEqual({ id: "55555", name: "wrf" });
    expect(submitted).toEqual({ name: "wrf", cpus: 4 });
  });

  test("submitFromSpec rejects a spec missing required fields", async () => {
    const backend = new LocalBackend(fakeAdapter({ listJobs: async () => [] }));
    // name+command present but no numeric cpus/memoryMb → hits the resource check.
    expect(backend.submitFromSpec('{"name":"x","command":"echo"}')).rejects.toThrow(/cpus/);
  });

  test("workflows and agents are unsupported in local mode", async () => {
    const backend = new LocalBackend(fakeAdapter({ listJobs: async () => [] }));
    expect(backend.capabilities.workflows).toBe(false);
    expect(backend.capabilities.agents).toBe(false);
    expect(backend.listWorkflows()).rejects.toBeInstanceOf(UnsupportedInModeError);
    const yaml = "name: pipe\nspec:\n  nodeDrafts: []\n";
    expect(backend.submitWorkflow(yaml)).rejects.toBeInstanceOf(UnsupportedInModeError);
    expect(backend.listAgents()).rejects.toBeInstanceOf(UnsupportedInModeError);
    expect(backend.getWorkflowDetail("w1")).rejects.toBeInstanceOf(UnsupportedInModeError);
    expect(backend.capabilities.logs).toBe(false);
    expect(backend.getJobLogs("j1", 100)).rejects.toBeInstanceOf(UnsupportedInModeError);
    expect(backend.capabilities.software).toBe(false);
    expect(await backend.listSoftware()).toEqual([]);
  });

  test("software capability stays off and listSoftware is empty without a catalog", async () => {
    const backend = new LocalBackend(fakeAdapter({ listJobs: async () => [] }));
    expect(backend.capabilities.software).toBe(false);
    expect(await backend.listSoftware()).toEqual([]);
  });

  test("injected workflow support lights up the workflows capability and drives list/submit", async () => {
    const runs: TuiWorkflowRun[] = [
      { id: "demo.yml", name: "demo", status: "unknown" },
      { id: "sweep.yaml", name: "sweep", status: "unknown" },
    ];
    let submitted = "";
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => [] }),
      undefined,
      "local",
      undefined,
      undefined,
      false,
      {
        list: async () => runs,
        submit: async (idOrName: string) => {
          submitted = idOrName;
          return { id: "run-1", name: "demo" };
        },
      },
    );
    expect(backend.capabilities.workflows).toBe(true);
    expect(await backend.listWorkflows()).toEqual(runs);
    expect(await backend.submitWorkflow("demo.yml")).toEqual({ id: "run-1", name: "demo" });
    expect(submitted).toBe("demo.yml");
  });

  test("getWorkflowDetail stays unsupported when the support surface has no read-back", () => {
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => [] }),
      undefined,
      "local",
      undefined,
      undefined,
      false,
      { list: async () => [], submit: async () => ({ id: "r" }) },
    );
    expect(backend.getWorkflowDetail("w1")).rejects.toBeInstanceOf(UnsupportedInModeError);
  });

  test("getWorkflowDetail reads back a recorded run when the support surface exposes getDetail", async () => {
    const detail = {
      id: "run-7",
      name: "pipe",
      status: "failed" as const,
      description: undefined,
      steps: [{ id: "build", status: "completed", info: '{"out":1}' }],
    };
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => [] }),
      undefined,
      "local",
      undefined,
      undefined,
      false,
      {
        list: async () => [],
        submit: async () => ({ id: "run-7" }),
        getDetail: async (runId: string) => (runId === "run-7" ? detail : null),
      },
    );
    expect(await backend.getWorkflowDetail("run-7")).toEqual(detail);
  });

  test("getWorkflowDetail throws not-found for an unknown run id", () => {
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => [] }),
      undefined,
      "local",
      undefined,
      undefined,
      false,
      { list: async () => [], submit: async () => ({ id: "r" }), getDetail: async () => null },
    );
    expect(backend.getWorkflowDetail("nope")).rejects.toThrow(/not found/);
  });

  test("an injected detected catalog lights up the software capability", () => {
    const catalog = fakeCatalog([]);
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => [] }),
      undefined,
      "local",
      undefined,
      catalog,
      true,
    );
    expect(backend.capabilities.software).toBe(true);
  });

  test("listSoftware maps the catalog's installed entries into TuiSoftware rows", async () => {
    const catalog = fakeCatalog([
      {
        name: "openmpi",
        version: "4.1.6",
        hash: "openmpi-spec",
        compiler: "gcc@13",
        spec: "openmpi@4.1.6%gcc@13",
        source: "spack",
      },
      {
        name: "gcc",
        version: "13.2.0",
        hash: "gcc-spec",
        spec: "gcc@13.2.0",
        source: "spack",
      },
    ]);
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => [] }),
      undefined,
      "local",
      undefined,
      catalog,
      true,
    );
    const software = await backend.listSoftware();
    expect(software).toHaveLength(2);
    expect(software[0]).toMatchObject({
      id: "spack/openmpi-spec",
      name: "openmpi",
      source: "spack",
      versions: ["4.1.6"],
      lifecycle: "installed",
      spec: "openmpi@4.1.6%gcc@13",
      hash: "openmpi-spec",
      compiler: "gcc@13",
    });
    expect(software[1]).toMatchObject({
      id: "spack/gcc-spec",
      name: "gcc",
      source: "spack",
      versions: ["13.2.0"],
      lifecycle: "installed",
      spec: "gcc@13.2.0",
      hash: "gcc-spec",
      compiler: null,
    });
    expect(software[0]?.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(software[1]?.reportedAt).toBe(software[0]?.reportedAt);
  });

  test("a resource sampler enables the Metrics pane: listAgents returns this node's telemetry", async () => {
    const sampler = {
      sample: async () => ({
        cpuPercent: 42,
        memoryUsedMb: 4096,
        memoryTotalMb: 16384,
        queueDepth: 3,
        diskUsedPercent: 71,
        gpus: [{ index: 0, model: "A100", utilPercent: 88, memUsedMb: 12000, memTotalMb: 40000 }],
      }),
    };
    const backend = new LocalBackend(fakeAdapter({ listJobs: async () => [] }), sampler);
    expect(backend.capabilities.metrics).toBe(true);
    // No multi-agent registry / SSH in local mode — the Agents pane stays off.
    expect(backend.capabilities.agents).toBe(false);
    const agents = await backend.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "local",
      status: "running",
      cpuPercent: 42,
      memoryUsedMb: 4096,
      memoryTotalMb: 16384,
      queueDepth: 3,
      diskUsedPercent: 71,
      gpus: [{ index: 0, model: "A100", utilPercent: 88, memUsedMb: 12000, memTotalMb: 40000 }],
    });
  });

  test("a provided node id (login-node hostname) labels the synthetic Metrics row", async () => {
    const sampler = { sample: async () => ({ cpuPercent: 10 }) };
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => [] }),
      sampler,
      "hpc-login01",
    );
    const [agent] = await backend.listAgents();
    expect(agent?.id).toBe("hpc-login01");
  });

  test("without a sampler, the Metrics capability stays off", () => {
    const backend = new LocalBackend(fakeAdapter({ listJobs: async () => [] }));
    expect(backend.capabilities.metrics).toBe(false);
  });
});

// ── Mode resolution ──────────────────────────────────────────────────────────

describe("LocalBackend × SQLite store (scenario 2 persistence)", () => {
  const SPEC = '{"name":"wrf","command":"echo hi","cpus":4,"memoryMb":8192}';

  test("submitFromSpec persists the job in the store", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    const backend = new LocalBackend(
      fakeAdapter({ submit: async () => ({ schedulerJobId: "555" }) }),
      undefined,
      "host",
      store,
    );
    await backend.submitFromSpec(SPEC);
    const persisted = store.list();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ schedulerJobId: "555", name: "wrf", status: "queued" });
  });

  test("listJobs appends persisted jobs that have left the live queue", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    // An old kq job, completed and already evicted from the scheduler queue.
    store.record({
      jobId: "u-old",
      schedulerJobId: "900",
      name: "old-run",
      status: "completed",
      command: "echo",
      cpus: 1,
      memoryMb: 1024,
      submittedAt: new Date(1_000),
    });
    const live: ListedJob[] = [
      { schedulerJobId: "901", name: "current", status: "running", queue: "compute" },
    ];
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => live }),
      undefined,
      "host",
      store,
    );
    const jobs = await backend.listJobs();
    expect(jobs.map((j) => j.id)).toEqual(["901", "900"]);
    expect(jobs.find((j) => j.id === "900")).toMatchObject({
      name: "old-run",
      status: "completed",
      location: "—",
    });
  });

  test("listJobs records each live job's latest status so it survives eviction", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "100",
      name: "wrf",
      status: "queued",
      command: "echo",
      cpus: 4,
      memoryMb: 8192,
      submittedAt: new Date(2_000),
    });
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [
          { schedulerJobId: "100", name: "wrf", status: "running", queue: "compute" },
        ],
      }),
      undefined,
      "host",
      store,
    );
    await backend.listJobs();
    // Live status captured; on the next poll with an empty queue the job shows completed.
    expect(store.list()[0]).toMatchObject({ status: "running" });
  });

  test("listJobs refreshes an active persisted job after it leaves the live queue", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "308",
      name: "short-run",
      status: "queued",
      command: "true",
      cpus: 1,
      memoryMb: 64,
      submittedAt: new Date(),
    });
    let statusCalls = 0;
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [],
        status: async () => {
          statusCalls += 1;
          return { status: "completed", exitCode: 0 };
        },
      }),
      undefined,
      "host",
      store,
    );

    expect(await backend.listJobs()).toMatchObject([{ id: "308", status: "completed" }]);
    expect(store.findBySchedulerId("308")).toMatchObject({ status: "completed", exitCode: 0 });
    await backend.listJobs();
    expect(statusCalls).toBe(1);
  });

  test("listJobs bounds evicted active status reconciliation per poll", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    for (let index = 0; index < 6; index += 1) {
      store.record({
        jobId: `u${index}`,
        schedulerJobId: String(400 + index),
        name: `run-${index}`,
        status: "queued",
        command: "sleep 1",
        cpus: 1,
        memoryMb: 64,
        submittedAt: new Date(index),
      });
    }
    let statusCalls = 0;
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [],
        status: async () => {
          statusCalls += 1;
          return { status: "running" };
        },
      }),
      undefined,
      "host",
      store,
    );

    await backend.listJobs();
    expect(statusCalls).toBe(4);
    await backend.listJobs();
    expect(statusCalls).toBe(6);
  });

  test("listJobs does not persist a failed lookup without an exit code", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "500",
      name: "accounting-lag",
      status: "queued",
      command: "true",
      cpus: 1,
      memoryMb: 64,
      submittedAt: new Date(),
    });
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [],
        status: async () => ({ status: "failed", message: "job not found" }),
      }),
      undefined,
      "host",
      store,
    );

    expect(await backend.listJobs()).toMatchObject([{ id: "500", status: "queued" }]);
    expect(store.findBySchedulerId("500")?.status).toBe("queued");
  });

  test("cancelJob marks the persisted job cancelled so it doesn't show stale after eviction", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "300",
      name: "wrf",
      status: "running",
      command: "echo",
      cpus: 4,
      memoryMb: 8192,
      submittedAt: new Date(),
    });
    let cancelled = "";
    const backend = new LocalBackend(
      fakeAdapter({
        cancel: async (id: string) => {
          cancelled = id;
        },
      }),
      undefined,
      "host",
      store,
    );
    await backend.cancelJob("300");
    expect(cancelled).toBe("300");
    expect(store.findBySchedulerId("300")?.status).toBe("cancelled");
  });

  test("listJobs keeps an acknowledged local cancellation when Torque reports C", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "300",
      name: "cancelled-run",
      status: "cancelled",
      command: "sleep 120",
      cpus: 1,
      memoryMb: 64,
      submittedAt: new Date(),
    });
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [
          { schedulerJobId: "300", name: "cancelled-run", status: "completed" },
        ],
      }),
      undefined,
      "host",
      store,
    );

    expect(await backend.listJobs()).toMatchObject([{ id: "300", status: "cancelled" }]);
    expect(store.findBySchedulerId("300")?.status).toBe("cancelled");
  });

  test("getJobDetail keeps an acknowledged local cancellation with the scheduler exit code", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "300",
      name: "cancelled-run",
      status: "cancelled",
      command: "sleep 120",
      cpus: 1,
      memoryMb: 64,
      submittedAt: new Date(),
    });
    const backend = new LocalBackend(
      fakeAdapter({ status: async () => ({ status: "failed", exitCode: 271 }) }),
      undefined,
      "host",
      store,
    );

    const detail = await backend.getJobDetail("300");
    expect(detail).toMatchObject({
      id: "300",
      status: "cancelled",
      exitCode: 271,
    });
    expect(detail.message).toBeUndefined();
    expect(store.findBySchedulerId("300")?.status).toBe("cancelled");
  });

  test("getJobDetail keeps an active persisted state during scheduler accounting lag", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "500",
      name: "accounting-lag",
      status: "running",
      command: "sleep 1",
      cpus: 1,
      memoryMb: 64,
      submittedAt: new Date(),
    });
    const backend = new LocalBackend(
      fakeAdapter({ status: async () => ({ status: "failed", message: "job not found" }) }),
      undefined,
      "host",
      store,
    );

    const detail = await backend.getJobDetail("500");
    expect(detail).toMatchObject({ id: "500", status: "running" });
    expect(detail.message).toBeUndefined();
    expect(store.findBySchedulerId("500")?.status).toBe("running");
  });

  test("getJobDetail does not regress a completed persisted job", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "501",
      name: "finished",
      status: "completed",
      command: "true",
      cpus: 1,
      memoryMb: 64,
      submittedAt: new Date(),
    });
    store.updateStatusBySchedulerId("501", "completed", 0);
    const backend = new LocalBackend(
      fakeAdapter({ status: async () => ({ status: "failed", message: "history expired" }) }),
      undefined,
      "host",
      store,
    );

    const detail = await backend.getJobDetail("501");
    expect(detail).toMatchObject({ id: "501", status: "completed", exitCode: 0 });
    expect(detail.message).toBeUndefined();
    expect(store.findBySchedulerId("501")).toMatchObject({ status: "completed", exitCode: 0 });
  });

  test("listJobs shows one row per scheduler id even if it was recycled in the store", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    // Same scheduler id "100" reused across two kq jobs (id recycling).
    store.record({
      jobId: "old",
      schedulerJobId: "100",
      name: "old-run",
      status: "completed",
      command: "echo",
      cpus: 1,
      memoryMb: 1,
      submittedAt: new Date(1_000),
    });
    store.record({
      jobId: "new",
      schedulerJobId: "100",
      name: "new-run",
      status: "failed",
      command: "echo",
      cpus: 1,
      memoryMb: 1,
      submittedAt: new Date(9_000),
    });
    const backend = new LocalBackend(
      fakeAdapter({ listJobs: async () => [] }),
      undefined,
      "host",
      store,
    );
    const jobs = (await backend.listJobs()).filter((j) => j.id === "100");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: "new-run", status: "failed" }); // freshest
  });

  test("getJobDetail surfaces the persisted resource request (command/cpus/mem)", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "100",
      name: "wrf",
      status: "queued",
      command: "./run.sh --np 16",
      cpus: 16,
      memoryMb: 32768,
      wallTimeSec: 7200,
      submittedAt: new Date(),
    });
    const backend = new LocalBackend(
      fakeAdapter({ status: async () => ({ status: "running" }) }),
      undefined,
      "host",
      store,
    );
    const detail = await backend.getJobDetail("100");
    expect(detail).toMatchObject({
      command: "./run.sh --np 16",
      cpus: 16,
      memoryMb: 32768,
      wallTimeSec: 7200,
    });
  });

  test("getJobDetail fills the real job name from the store for a live job", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u1",
      schedulerJobId: "100",
      name: "wrf-ensemble",
      status: "queued",
      command: "echo",
      cpus: 4,
      memoryMb: 8192,
      submittedAt: new Date(),
    });
    const backend = new LocalBackend(
      fakeAdapter({ status: async () => ({ status: "running" }) }),
      undefined,
      "host",
      store,
    );
    const detail = await backend.getJobDetail("100");
    expect(detail).toMatchObject({ id: "100", name: "wrf-ensemble", status: "running" });
  });

  test("getJobDetail falls back to the persisted record when the scheduler can't resolve an evicted job", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    store.record({
      jobId: "u2",
      schedulerJobId: "200",
      name: "done-run",
      status: "completed",
      command: "echo",
      cpus: 1,
      memoryMb: 512,
      submittedAt: new Date(),
    });
    const backend = new LocalBackend(
      fakeAdapter({
        status: async () => {
          throw new Error("slurm_load_jobs error: Invalid job id specified");
        },
      }),
      undefined,
      "host",
      store,
    );
    const detail = await backend.getJobDetail("200");
    expect(detail).toMatchObject({ id: "200", name: "done-run", status: "completed" });
  });

  test("getJobDetail rethrows the scheduler error when there is no persisted fallback", async () => {
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    const backend = new LocalBackend(
      fakeAdapter({
        status: async () => {
          throw new Error("boom");
        },
      }),
      undefined,
      "host",
      store,
    );
    expect(backend.getJobDetail("999")).rejects.toThrow(/boom/);
  });

  test("without a store, listJobs is pure live querying (no extra rows)", async () => {
    const backend = new LocalBackend(
      fakeAdapter({
        listJobs: async () => [{ schedulerJobId: "1", name: "j", status: "running" }],
      }),
    );
    expect((await backend.listJobs()).map((j) => j.id)).toEqual(["1"]);
  });
});

describe("expandTilde", () => {
  test("expands a leading ~ to the home dir; leaves other paths alone", () => {
    expect(expandTilde("~/scratch/local.db", "/home/u")).toBe("/home/u/scratch/local.db");
    expect(expandTilde("~", "/home/u")).toBe("/home/u");
    expect(expandTilde("/abs/path.db", "/home/u")).toBe("/abs/path.db");
    expect(expandTilde("rel/path.db", "/home/u")).toBe("rel/path.db");
    expect(expandTilde("~user/x", "/home/u")).toBe("~user/x"); // only ~/ and bare ~
  });
});

describe("makeLocalStore", () => {
  test("returns undefined when persistence is disabled (--no-db)", () => {
    expect(makeLocalStore({ noDb: true })).toBeUndefined();
  });

  test("opens a working store at an explicit db path (--db)", () => {
    const store = makeLocalStore({ dbPath: ":memory:" });
    expect(store).toBeDefined();
    store?.record({
      jobId: "u1",
      schedulerJobId: "1",
      name: "j",
      status: "queued",
      command: "echo",
      cpus: 1,
      memoryMb: 1,
      submittedAt: new Date(),
    });
    expect(store?.list()).toHaveLength(1);
  });

  test("degrades to no-store (not a throw) when the db path can't be opened", () => {
    // Parent is a file (/dev/null), so mkdirSync of its child dir fails — the
    // read-only / quota'd login-node case. The all-in-one binary must still
    // start, falling back to pure live querying rather than crashing.
    const store = makeLocalStore({ dbPath: "/dev/null/nope/local.db" });
    expect(store).toBeUndefined();
  });
});

describe("probeWorkflowSupport", () => {
  test("returns undefined (workflows stay off) when no package catalog is present", () => {
    const home = mkdtempSync(join(tmpdir(), "kq-home-"));
    try {
      expect(probeWorkflowSupport(fakeAdapter(), { home })).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wires a runnable support surface when packages.yaml + workflows/ exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "kq-home-"));
    try {
      const dataDir = join(home, ".kuintessence");
      const wfDir = join(dataDir, "workflows");
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(dataDir, "packages.yaml"), "{}\n");
      writeFileSync(join(wfDir, "demo.yml"), "name: Demo\nspec:\n  nodeDrafts: []\n");

      const support = probeWorkflowSupport(fakeAdapter(), { home });
      expect(support).toBeDefined();
      expect(await support?.list()).toEqual([{ id: "demo.yml", name: "Demo", status: "unknown" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveTuiMode", () => {
  const loggedIn = { serverUrl: "http://server", token: "tok" };
  const anon = { serverUrl: "http://server" };

  test("--local flag forces local (even when logged in)", () => {
    expect(resolveTuiMode({ local: true }, {}, loggedIn)).toBe("local");
  });

  test("KQ_TUI_LOCAL=1/true forces local", () => {
    expect(resolveTuiMode({}, { KQ_TUI_LOCAL: "1" }, loggedIn)).toBe("local");
    expect(resolveTuiMode({}, { KQ_TUI_LOCAL: "true" }, anon)).toBe("local");
  });

  test("KQ_TUI_LOCAL=0 forces remote even when not logged in", () => {
    expect(resolveTuiMode({}, { KQ_TUI_LOCAL: "0" }, anon)).toBe("remote");
    expect(resolveTuiMode({}, { KQ_TUI_LOCAL: "false" }, anon)).toBe("remote");
  });

  test("logged in (token present) defaults to remote", () => {
    expect(resolveTuiMode({}, {}, loggedIn)).toBe("remote");
  });

  test("not logged in → auto (try local, fall back to remote)", () => {
    expect(resolveTuiMode({}, {}, anon)).toBe("auto");
  });
});
