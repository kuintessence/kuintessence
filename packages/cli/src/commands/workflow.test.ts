import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient } from "../lib/api-client";
import { cancelWorkflow, formatRunDetail, submitWorkflow } from "./workflow";

describe("formatRunDetail", () => {
  test.each([undefined, null])("keeps metadata without a result or graph nodes (%s)", (result) => {
    const run = {
      id: "r1",
      name: "pending-result",
      status: "running",
      createdAt: "t",
      description: null,
      stepJobs: { solve: "job-a" },
      result,
    };
    for (const graph of [undefined, null, { nodes: [], edges: [] }]) {
      expect(formatRunDetail({ ...run, graph })).toEqual([
        "Workflow: pending-result (r1)",
        "Status: running",
        "Description: -",
      ]);
    }
  });

  test.each([
    undefined,
    null,
  ])("renders graph nodes and submitted jobs without result (%s)", (result) => {
    const graph = {
      nodes: [
        { id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" },
        { id: "collect", name: "Collect", kind: "NoAction" },
      ],
      edges: [],
    };
    const out = formatRunDetail({
      id: "active",
      name: "computing",
      status: "running",
      createdAt: "t",
      description: null,
      graph,
      stepJobs: { orphan: "job-outside", solve: "job-solve" },
      result,
    });
    expect(out).toEqual([
      "Workflow: computing (active)",
      "Status: running",
      "Description: -",
      "Nodes:",
      "  - solve: unknown  job job-solve",
      "  - collect: unknown",
    ]);
    expect(graph.edges).toEqual([]);
  });

  test("renders graph nodes when no jobs have been submitted", () => {
    const out = formatRunDetail({
      id: "queued",
      name: "computing",
      status: "queued",
      createdAt: "t",
      description: null,
      graph: {
        nodes: [{ id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" }],
        edges: [],
      },
    });
    expect(out.slice(3)).toEqual(["Nodes:", "  - solve: unknown"]);
  });

  test("renders a run's per-node result when present", () => {
    const out = formatRunDetail({
      id: "r2",
      name: "completed-run",
      status: "completed",
      createdAt: "t",
      description: null,
      graph: {
        nodes: [{ id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" }],
        edges: [],
      },
      stepJobs: { solve: "job-solve" },
      result: {
        status: { solve: "Succeeded" },
        values: { solve: { status: "Succeeded", values: { residual: 0.003 } } },
      },
    }).join("\n");
    expect(out).toMatch(/Nodes:/);
    expect(out).toMatch(/solve: Succeeded/);
    expect(out).toMatch(/residual/);
    expect(out).not.toContain("unknown");
    expect(out).not.toContain("job job-solve");
  });
});

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(responder: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    responder(url.toString(), init)) as typeof fetch;
}

describe("submitWorkflow", () => {
  test("posts the yaml to /api/workflows and returns the async run handle", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          runId: "run-1",
          name: "w",
          status: "submitted",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new ApiClient("http://server:3000", "tok");
    const result = await submitWorkflow(client, "name: w\nspec:\n  nodeDrafts: []\n");
    expect(capturedUrl).toBe("http://server:3000/api/workflows");
    expect(JSON.parse(capturedBody).yaml).toBe("name: w\nspec:\n  nodeDrafts: []\n");
    expect(result.runId).toBe("run-1");
    expect(result.status).toBe("submitted");
  });

  test("posts cancel to the canonical workflow cancel endpoint", async () => {
    let capturedUrl = "";
    mockFetch(async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ runId: "run-1", status: "cancelled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new ApiClient("http://server:3000", "tok");
    const result = await cancelWorkflow(client, "run-1");
    expect(capturedUrl).toBe("http://server:3000/api/workflows/run-1/cancel");
    expect(result.status).toBe("cancelled");
  });
});

describe("ApiClient.post for workflows endpoint", () => {
  test("posts yaml field to /api/workflows and parses response", async () => {
    let capturedBody = "";
    let capturedUrl = "";

    mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          runId: "run-abc-123",
          name: "test-wf",
          status: "submitted",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = new ApiClient("http://server:3000", "my-token");
    const yaml = "name: test-wf\nspec:\n  nodeDrafts: []\n";
    const result = await client.post<{
      runId: string;
      name: string;
      status: string;
    }>("/workflows", { yaml });

    expect(capturedUrl).toBe("http://server:3000/api/workflows");
    expect(JSON.parse(capturedBody).yaml).toBe(yaml);
    expect(result.runId).toBe("run-abc-123");
    expect(result.name).toBe("test-wf");
    expect(result.status).toBe("submitted");
  });

  test("ApiClient throws ApiError on non-ok response", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "bad yaml" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const client = new ApiClient("http://server:3000", "tok");
    await expect(client.post("/workflows", { yaml: "bad" })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });
});
