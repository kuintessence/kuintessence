import { describe, expect, test } from "bun:test";
import { ExternalAgentBackend } from "./external-agent";
import type { TuiBackendCapabilities } from "./types";
import { UnsupportedInModeError } from "./types";

interface Recorded {
  url: string;
  method: string;
  auth?: string;
  body?: string;
}

const CAPS: TuiBackendCapabilities = {
  jobs: true,
  submit: true,
  logs: true,
  workflows: true,
  agents: false,
  metrics: false,
  software: true,
  ssh: false,
};

/** A fetch stub that replies per-path from a routing table. Records every call
 *  so the tests can assert method/path/auth/body. */
function stubFetch(routes: Record<string, { status?: number; json?: unknown }>): {
  calls: Recorded[];
  fetchImpl: typeof fetch;
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      auth: headers.Authorization ?? headers.authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const path = new URL(url).pathname + new URL(url).search;
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${new URL(url).pathname}`];
    if (!route) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    const status = route.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(route.json ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Routes that satisfy `create()` (capabilities + info), merged with extra. */
function withProbe(
  extra: Record<string, { status?: number; json?: unknown }>,
): Record<string, { status?: number; json?: unknown }> {
  return {
    "GET /capabilities": { json: CAPS },
    "GET /info": { json: { mode: "local", target: "slurm 23" } },
    ...extra,
  };
}

describe("ExternalAgentBackend", () => {
  test("create() fetches /capabilities + /info; info.mode='remote', target names the agent", async () => {
    const { calls, fetchImpl } = stubFetch(withProbe({}));
    const backend = await ExternalAgentBackend.create("http://node:8080", {
      token: "t",
      fetchImpl,
    });
    expect(backend.info).toEqual({ mode: "remote", target: "agent http://node:8080" });
    expect(backend.capabilities).toEqual(CAPS);
    // Both probe requests carry the Bearer header.
    expect(calls.map((c) => c.url)).toEqual([
      "http://node:8080/capabilities",
      "http://node:8080/info",
    ]);
    expect(calls.every((c) => c.auth === "Bearer t")).toBe(true);
  });

  test("trailing slash on baseUrl is normalized", async () => {
    const { calls, fetchImpl } = stubFetch(withProbe({}));
    const backend = await ExternalAgentBackend.create("http://node:8080/", { fetchImpl });
    expect(backend.info.target).toBe("agent http://node:8080");
    expect(calls[0]?.url).toBe("http://node:8080/capabilities");
  });

  test("listJobs → GET /jobs, parses the array", async () => {
    const { calls, fetchImpl } = stubFetch(
      withProbe({
        "GET /jobs": {
          json: [{ id: "j1", name: "wrf", status: "running", location: "debug" }],
        },
      }),
    );
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    const jobs = await backend.listJobs();
    expect(jobs).toEqual([{ id: "j1", name: "wrf", status: "running", location: "debug" }]);
    expect(calls.at(-1)).toMatchObject({ method: "GET", url: "http://node:8080/jobs" });
  });

  test("submitFromSpec → POST /jobs with { spec }", async () => {
    const { calls, fetchImpl } = stubFetch(
      withProbe({ "POST /jobs": { status: 201, json: { id: "job-7", name: "wrf" } } }),
    );
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    const res = await backend.submitFromSpec('{"name":"wrf"}');
    expect(res).toEqual({ id: "job-7", name: "wrf" });
    const call = calls.at(-1);
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ spec: '{"name":"wrf"}' });
  });

  test("getJobDetail → GET /jobs/:id (id encoded)", async () => {
    const { calls, fetchImpl } = stubFetch(
      withProbe({
        "GET /jobs/a%2Fb": { json: { id: "a/b", name: "x", status: "completed" } },
      }),
    );
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    const d = await backend.getJobDetail("a/b");
    expect(d).toMatchObject({ id: "a/b", status: "completed" });
    expect(calls.at(-1)?.url).toBe("http://node:8080/jobs/a%2Fb");
  });

  test("cancelJob → DELETE /jobs/:id, tolerates 204", async () => {
    const { calls, fetchImpl } = stubFetch(withProbe({ "DELETE /jobs/j1": { status: 204 } }));
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    await backend.cancelJob("j1");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "http://node:8080/jobs/j1" });
  });

  test("getJobLogs → GET /jobs/:id/logs?lines=N, unwraps { logs }", async () => {
    const { calls, fetchImpl } = stubFetch(
      withProbe({ "GET /jobs/j1/logs?lines=50": { json: { logs: "out\n" } } }),
    );
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    expect(await backend.getJobLogs("j1", 50)).toBe("out\n");
    expect(calls.at(-1)?.url).toBe("http://node:8080/jobs/j1/logs?lines=50");
  });

  test("submitWorkflow → POST /workflows with { yaml }", async () => {
    const { calls, fetchImpl } = stubFetch(
      withProbe({ "POST /workflows": { status: 201, json: { id: "run-3" } } }),
    );
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    const yaml = "name: pipe\nspec:\n  nodeDrafts: []\n";
    expect(await backend.submitWorkflow(yaml)).toEqual({ id: "run-3" });
    expect(JSON.parse(calls.at(-1)?.body ?? "{}")).toEqual({ yaml });
  });

  test("501 { unsupported: true } → UnsupportedInModeError", async () => {
    const { fetchImpl } = stubFetch(
      withProbe({
        "GET /agents": { status: 501, json: { error: '"agents" unsupported', unsupported: true } },
      }),
    );
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    await expect(backend.listAgents()).rejects.toBeInstanceOf(UnsupportedInModeError);
  });

  test("other non-2xx → a plain Error carrying the server message", async () => {
    const { fetchImpl } = stubFetch(
      withProbe({ "GET /jobs": { status: 500, json: { error: "boom" } } }),
    );
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    await expect(backend.listJobs()).rejects.toThrow(/500.*boom/);
  });

  test("subscribe methods are no-ops returning an unsubscribe", async () => {
    const { fetchImpl } = stubFetch(withProbe({}));
    const backend = await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    expect(typeof backend.subscribeJobStatus("j1", () => {})).toBe("function");
    expect(typeof backend.subscribeWorkflowStatus("w1", () => {})).toBe("function");
  });

  test("no token → no Authorization header", async () => {
    const { calls, fetchImpl } = stubFetch(withProbe({}));
    await ExternalAgentBackend.create("http://node:8080", { fetchImpl });
    expect(calls.every((c) => c.auth === undefined)).toBe(true);
  });
});
