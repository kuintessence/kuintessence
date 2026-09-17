import { afterEach, describe, expect, test } from "bun:test";
import { ApiClient } from "../../lib/api-client";
import { RemoteBackend } from "./remote";

/**
 * Scenario 1 (remote client) end-to-end through the *real* ApiClient → fetch:
 * the other RemoteBackend tests stub ApiClient.get/post directly, so the actual
 * `${base}/api${path}` URL construction, the Bearer header, and JSON response
 * parsing are never exercised. Here we mock only `globalThis.fetch` and drive
 * RemoteBackend through a real ApiClient, asserting the wire contract a Server
 * sees. Symmetric to local-integration.test.ts (scenario 2).
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Recorded {
  url: string;
  method: string;
  auth?: string;
  body?: string;
}

function mockFetch(json: unknown): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.Authorization ?? headers.authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

function backend(): RemoteBackend {
  return new RemoteBackend(new ApiClient("http://server.test", "tok"), {
    serverUrl: "http://server.test",
    token: "tok",
  });
}

describe("RemoteBackend × ApiClient (real HTTP path)", () => {
  test("listJobs → GET /api/jobs with Bearer auth, maps the envelope", async () => {
    const { calls } = mockFetch({
      jobs: [{ id: "j1", name: "wrf", status: "RUNNING", agentId: "site-alpha", submittedAt: "t" }],
    });
    const jobs = await backend().listJobs();
    expect(jobs[0]).toMatchObject({ id: "j1", status: "running", location: "site-alpha" });
    expect(calls[0]?.url).toBe("http://server.test/api/jobs");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.auth).toBe("Bearer tok");
  });

  test("getJobDetail → GET /api/jobs/:id, mapping the enriched fields", async () => {
    const { calls } = mockFetch({
      id: "j1",
      name: "wrf",
      status: "running",
      node: "node[01-04]",
      reason: "None",
      startedAt: "2023-11-14T22:13:20.000Z",
      command: "./run.sh",
      cpus: 8,
      memoryMb: 16384,
      wallTimeSec: 7200,
    });
    const d = await backend().getJobDetail("j1");
    expect(d).toMatchObject({
      id: "j1",
      status: "running",
      node: "node[01-04]",
      reason: "None",
      startedAt: "2023-11-14T22:13:20.000Z",
      // Server returns the job's spec on /jobs/:id — surface the resource request.
      command: "./run.sh",
      cpus: 8,
      memoryMb: 16384,
      wallTimeSec: 7200,
    });
    expect(calls[0]?.url).toBe("http://server.test/api/jobs/j1");
  });

  test("submitFromSpec → POST /api/jobs with the parsed JSON body", async () => {
    const { calls } = mockFetch({ id: "job-7", name: "wrf" });
    const res = await backend().submitFromSpec('{"name":"wrf","command":"echo"}');
    expect(res).toEqual({ id: "job-7", name: "wrf" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://server.test/api/jobs");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ name: "wrf", command: "echo" });
  });

  test("cancelJob → POST /api/jobs/:id/cancel", async () => {
    const { calls } = mockFetch({});
    await backend().cancelJob("j1");
    expect(calls[0]?.url).toBe("http://server.test/api/jobs/j1/cancel");
    expect(calls[0]?.method).toBe("POST");
  });

  test("getJobLogs → GET /api/jobs/:id/logs?text=1&lines=N", async () => {
    const { calls } = mockFetch({ text: "out\n" });
    expect(await backend().getJobLogs("j1", 200)).toBe("out\n");
    expect(calls[0]?.url).toBe("http://server.test/api/jobs/j1/logs?text=1&lines=200");
  });

  test("submitWorkflow → POST /api/workflows with {yaml}", async () => {
    const { calls } = mockFetch({ runId: "run-7", name: "pipe" });
    const yaml = "name: pipe\nspec:\n  nodeDrafts: []\n";
    expect(await backend().submitWorkflow(yaml)).toEqual({ id: "run-7", name: "pipe" });
    expect(calls[0]?.url).toBe("http://server.test/api/workflows");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ yaml });
  });

  test("listWorkflows / listAgents / listSoftware hit their endpoints", async () => {
    const wf = mockFetch({ runs: [{ id: "w1", name: "p", status: "running" }] });
    expect((await backend().listWorkflows())[0]).toMatchObject({ id: "w1", status: "running" });
    expect(wf.calls[0]?.url).toBe("http://server.test/api/workflows");

    const ag = mockFetch({
      agents: [
        {
          agentId: "ag1",
          siteName: "n",
          schedulerType: "slurm",
          schedulerVersion: "23",
          status: "online",
          cpuUsagePercent: 50,
          diskUsedPercent: 64,
          lastHeartbeat: "2026-05-30T12:00:00Z",
          gpus: [{ index: 0, model: "A100", utilPercent: 87, memUsedMb: 12000, memTotalMb: 40000 }],
        },
      ],
    });
    const agents = await backend().listAgents();
    expect(agents[0]).toMatchObject({
      id: "ag1",
      status: "running",
      cpuPercent: 50,
      diskUsedPercent: 64,
      lastHeartbeat: "2026-05-30T12:00:00Z",
      gpus: [{ index: 0, model: "A100", utilPercent: 87, memUsedMb: 12000, memTotalMb: 40000 }],
    });
    expect(ag.calls[0]?.url).toBe("http://server.test/api/agents");

    const sw = mockFetch({
      page: 1,
      pageSize: 24,
      totalCount: 1,
      totalPages: 1,
      packages: [
        {
          name: "openmpi",
          source: "upstream",
          asset: { version: "upstream", lifecycle: "published" },
        },
      ],
    });
    expect((await backend().listSoftware())[0]).toMatchObject({
      id: "catalog:upstream:openmpi",
      source: "upstream",
      lifecycle: "published",
    });
    expect(sw.calls[0]?.url).toContain("http://server.test/software/api/spack/catalog");
  });
});
