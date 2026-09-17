import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

// Stub react-i18next so child components that call useTranslation don't blow
// up looking for a provider. Tests assert against headline strings rather than
// translation keys.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

// Expose the selected job without mounting the job sheet's own queries.
vi.mock("../jobs/JobDetailSheet", () => ({
  JobDetailSheet: ({ jobId, open }: { jobId: string | null; open: boolean }) =>
    open ? <div data-testid="job-detail-sheet">{jobId}</div> : null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// WorkflowRunGraph (rendered when a run carries a graph) reads the theme and
// boots React Flow — stub both so happy-dom doesn't choke. The flow stub exposes
// node-level test ids so we can assert the real graph view is mounted.
vi.mock("../ThemeProvider", () => ({
  useTheme: () => ({ theme: "light", resolved: "light", setTheme: () => {} }),
}));

vi.mock("@xyflow/react", () => {
  const React = require("react") as typeof import("react");
  interface StubNode {
    id: string;
    data: { label: string; kind: string; status: string };
  }
  function ReactFlow(props: {
    children?: React.ReactNode;
    nodes?: StubNode[];
    edges?: Array<{ id: string; source: string; target: string }>;
  }) {
    return React.createElement(
      "div",
      { "data-testid": "run-graph" },
      (props.nodes ?? []).map((n) =>
        React.createElement(
          "div",
          { key: n.id, "data-testid": `run-node-${n.id}`, "data-status": n.data.status },
          `${n.data.label} · ${n.data.status}`,
        ),
      ),
      (props.edges ?? []).map((edge) =>
        React.createElement("span", {
          key: edge.id,
          "data-testid": `run-edge-${edge.source}-${edge.target}`,
        }),
      ),
      props.children,
    );
  }
  const Background = () => React.createElement("div");
  const Controls = () => React.createElement("div");
  return {
    ReactFlow,
    Background,
    BackgroundVariant: { Dots: "dots" },
    Controls,
    Handle: () => React.createElement("span"),
    MarkerType: { ArrowClosed: "arrowclosed" },
    Position: { Left: "left", Right: "right" },
  };
});

import { WorkflowDagView } from "./WorkflowDagView";

// Workflow detail request failures render an error card with a status-aware headline.

function makeWrapper() {
  // Disable retries so the error surfaces on the first failed query.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function mockFetchOnce(body: unknown, init: ResponseInit) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), init))),
  );
}

function workflowRunBody(status: string) {
  return {
    id: "00000000-0000-0000-0000-000000000003",
    name: "async-run",
    description: null,
    status,
    createdAt: "t",
    stepJobs: {},
    result: { status: { solve: status === "completed" ? "Succeeded" : "Running" }, values: {} },
    graph: {
      nodes: [{ id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" }],
      edges: [],
    },
  };
}

// A run reader may provide job mappings without a persisted graph or result.
function localWorkflowRunBody(stepJobs: Record<string, string>, status = "preview") {
  return {
    id: "local-run",
    name: "local-workflow",
    status,
    createdAt: "",
    description: null,
    stepJobs,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkflowDagView error UI", () => {
  test("renders 'Invalid run id' card on 400 from /api/workflows/:runId", async () => {
    mockFetchOnce(
      { error: { code: "VALIDATION_ERROR", message: "Invalid run id: must be a UUID" } },
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

    render(<WorkflowDagView runId="not-a-uuid" />, { wrapper: makeWrapper() });

    expect(await screen.findByText("The workflow run ID is invalid")).toBeTruthy();
    const card = screen.getByTestId("workflow-dag-view");
    expect(card.textContent).toContain("无法加载工作流运行记录");
    expect(card.textContent).not.toContain("Invalid run id: must be a UUID");
    expect(card.textContent).not.toContain("VALIDATION_ERROR");
    expect(card.textContent).toContain("not-a-uuid");
  });

  test("renders 'Workflow run not found' card on 404", async () => {
    mockFetchOnce(
      { error: { code: "NOT_FOUND", message: "Run gone" } },
      { status: 404, headers: { "Content-Type": "application/json" } },
    );

    render(<WorkflowDagView runId="00000000-0000-0000-0000-000000000000" />, {
      wrapper: makeWrapper(),
    });

    const card = await waitFor(() => {
      const c = screen.getByTestId("workflow-dag-view");
      if (!c.textContent?.includes("This workflow run may not exist")) throw new Error("not yet");
      return c;
    });
    expect(card.textContent).toContain("This workflow run may not exist");
    expect(card.textContent).toContain("This resource may not exist");
    expect(card.textContent).not.toContain("Run gone");
    expect(card.textContent).not.toContain("NOT_FOUND");
  });

  test("retries a transient 403 after immediate workflow creation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "FORBIDDEN", message: "Not authorized yet" } }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(workflowRunBody("completed")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkflowDagView runId="00000000-0000-0000-0000-000000000003" />, {
      wrapper: makeWrapper(),
    });

    expect(await screen.findByText("completed")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("renders a local run's per-node result without a persisted graph", async () => {
    mockFetchOnce(
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "local-run",
        description: null,
        status: "completed",
        createdAt: "t",
        stepJobs: {},
        graph: null,
        result: {
          status: { solve: "Succeeded", __run__: "Succeeded" },
          values: { solve: { status: "Succeeded", values: { residual: 0.003 } } },
        },
      },
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    render(<WorkflowDagView runId="00000000-0000-0000-0000-000000000001" />, {
      wrapper: makeWrapper(),
    });

    const card = await screen.findByTestId("workflow-nodes-card");
    expect(card.textContent).toContain("solve");
    expect(card.textContent).toContain("Succeeded");
    expect(card.textContent).toContain("residual");
    expect(screen.queryByTestId("workflow-node-__run__")).toBeNull();
    expect(screen.queryByTestId("dag-canvas")).toBeNull();
  });

  test.each([
    { label: "null", graph: null, result: null },
    { label: "missing", graph: undefined, result: undefined },
    { label: "empty", graph: { nodes: [], edges: [] }, result: { status: {}, values: {} } },
    { label: "run-only", graph: null, result: { status: { __run__: "Pending" }, values: {} } },
  ])("shows a pending state for $label graph/results without inventing a DAG", async (fields) => {
    mockFetchOnce(
      { ...workflowRunBody("pending"), graph: fields.graph, result: fields.result },
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    render(<WorkflowDagView runId="pending-run" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-graph-empty").textContent).toContain(
        "workflows.run.graphPending",
      );
    });
    expect(screen.queryByTestId("run-graph")).toBeNull();
    expect(screen.queryByTestId("dag-canvas")).toBeNull();
    expect(screen.queryByTestId("workflow-nodes-card")).toBeNull();
  });

  test("shows an unavailable graph for a finished local run without node results", async () => {
    mockFetchOnce(
      { ...workflowRunBody("completed"), graph: null, result: null },
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    render(<WorkflowDagView runId="local-run" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-graph-empty").textContent).toContain(
        "workflows.run.graphUnavailable",
      );
    });
    expect(screen.queryByTestId("dag-canvas")).toBeNull();
  });

  test("shows related jobs as node statuses without inferring edges from stepJobs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-solve") || url.endsWith("/api/jobs/job-post")) {
          return Promise.resolve(
            Response.json({
              id: url.split("/").pop(),
              name: "related-job",
              status: "running",
              submittedAt: "t",
            }),
          );
        }
        return Promise.resolve(
          Response.json(localWorkflowRunBody({ solve: "job-solve", post: "job-post" }, "running")),
        );
      }),
    );

    render(<WorkflowDagView runId="local-run" />, { wrapper: makeWrapper() });

    const solve = await screen.findByTestId("workflow-node-solve");
    await waitFor(() => {
      expect(solve.textContent).toContain("running");
      expect(screen.getByTestId("workflow-node-post").textContent).toContain("running");
    });
    expect(screen.queryByTestId("run-graph")).toBeNull();
    expect(screen.queryByTestId("dag-canvas")).toBeNull();
    expect(screen.queryByTestId("dag-edges")).toBeNull();
    expect(
      screen.getByText("Nodes", { selector: "span" }).parentElement?.nextElementSibling
        ?.textContent,
    ).toBe("-");
    expect(screen.getByText("Edges").parentElement?.nextElementSibling?.textContent).toBe("-");

    const jobButton = solve.querySelector("button");
    if (!jobButton) throw new Error("related job button missing");
    fireEvent.click(jobButton);
    expect(screen.getByTestId("job-detail-sheet").textContent).toBe("job-solve");
  });

  test("keeps local preview nodes with empty job IDs as unknown without fetching jobs", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json(localWorkflowRunBody({ solve: "" }))),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkflowDagView runId="local-run" />, { wrapper: makeWrapper() });

    const solve = await screen.findByTestId("workflow-node-solve");
    expect(solve.textContent).toContain("unknown");
    expect(solve.querySelector("button")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("workflow-graph-empty")).toBeNull();
    expect(screen.queryByTestId("run-graph")).toBeNull();
    expect(screen.queryByTestId("dag-edges")).toBeNull();
  });

  test("unions result and stepJobs node IDs while preserving available statuses", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          ...localWorkflowRunBody({ solve: "", post: "" }, "running"),
          result: {
            status: { control: "Succeeded", solve: "Running", __run__: "Running" },
            values: {},
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkflowDagView runId="local-run" />, { wrapper: makeWrapper() });

    const nodes = await screen.findByTestId("workflow-nodes-card");
    expect(nodes.querySelectorAll('[data-testid^="workflow-node-"]')).toHaveLength(3);
    expect(screen.getByTestId("workflow-node-control").textContent).toContain("Succeeded");
    expect(screen.getByTestId("workflow-node-solve").textContent).toContain("Running");
    expect(screen.getByTestId("workflow-node-post").textContent).toContain("unknown");
    expect(screen.queryByTestId("workflow-node-__run__")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    "http",
    "network",
  ])("keeps local job nodes visible after a %s lookup failure", async (failure) => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/jobs/job-solve")) {
        return failure === "network"
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(
              Response.json(
                { error: { code: "NOT_FOUND", message: "Job unavailable" } },
                { status: 404 },
              ),
            );
      }
      if (url.endsWith("/api/jobs/job-post")) {
        return Promise.resolve(
          Response.json({ id: "job-post", name: "Post", status: "running", submittedAt: "t" }),
        );
      }
      return Promise.resolve(
        Response.json(
          localWorkflowRunBody({ solve: "job-solve", post: "job-post", preview: "" }, "running"),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkflowDagView runId="local-run" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-node-post").textContent).toContain("running");
    });
    const solve = screen.getByTestId("workflow-node-solve");
    expect(solve.textContent).toContain("unknown");
    expect(screen.getByTestId("workflow-node-preview").textContent).toContain("unknown");
    const requestedJobUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/api/jobs/"));
    expect(requestedJobUrls.sort()).toEqual([
      "/platform/api/jobs/job-post",
      "/platform/api/jobs/job-solve",
    ]);
    expect(screen.queryByTestId("run-graph")).toBeNull();
    expect(screen.queryByTestId("dag-edges")).toBeNull();
    const jobButton = solve.querySelector("button");
    if (!jobButton) throw new Error("related job button missing");
    fireEvent.click(jobButton);
    expect(screen.getByTestId("job-detail-sheet").textContent).toBe("job-solve");
  });

  test("renders the React Flow graph view when a run carries a graph", async () => {
    mockFetchOnce(
      {
        id: "00000000-0000-0000-0000-000000000002",
        name: "graph-run",
        description: null,
        status: "running",
        createdAt: "t",
        stepJobs: {},
        result: { status: { a: "Succeeded", b: "Running" }, values: {} },
        graph: {
          nodes: [
            { id: "a", name: "Solve", kind: "SoftwareUsecaseComputing" },
            { id: "b", name: "Post", kind: "Script" },
          ],
          edges: [{ source: "a", target: "b" }],
        },
      },
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    render(<WorkflowDagView runId="00000000-0000-0000-0000-000000000002" />, {
      wrapper: makeWrapper(),
    });

    const graph = await screen.findByTestId("run-graph");
    expect(graph.querySelector('[data-testid="run-node-a"]')).toBeTruthy();
    expect(graph.querySelector('[data-testid="run-node-b"]')).toBeTruthy();
    expect(screen.getByTestId("run-node-a").getAttribute("data-status")).toBe("Succeeded");
    expect(screen.getByTestId("run-node-b").getAttribute("data-status")).toBe("Running");
    expect(screen.getByTestId("run-edge-a-b")).toBeTruthy();
    // A persisted graph takes precedence over the status-only view.
    expect(screen.queryByTestId("workflow-nodes-card")).toBeNull();
    expect(screen.queryByTestId("dag-canvas")).toBeNull();
  });

  test("localizes placement failures without exposing diagnostic fields", async () => {
    mockFetchOnce(
      {
        ...workflowRunBody("failed"),
        errorCode: "WORKFLOW_PLACEMENT_FAILED",
        errorMessage: "no candidate satisfies placement constraints",
      },
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    render(<WorkflowDagView runId="00000000-0000-0000-0000-000000000003" />, {
      wrapper: makeWrapper(),
    });

    expect(await screen.findByText("Workflow scheduling failed")).toBeTruthy();
    expect(
      screen.getByText(
        "No compute resource satisfies the current scheduling and placement constraints.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("WORKFLOW_PLACEMENT_FAILED")).toBeNull();
    expect(screen.queryByText("no candidate satisfies placement constraints")).toBeNull();
  });

  test("shows structured failed-node reason and exit code", async () => {
    mockFetchOnce(
      {
        ...workflowRunBody("failed"),
        errorCode: "WORKFLOW_NODE_FAILED",
        errorMessage: "solve: LAMMPS input command failed",
        result: {
          status: { solve: "Failed" },
          values: {
            solve: {
              status: "Failed",
              values: {},
              failure: {
                message: "LAMMPS: Invalid atom style at input line 42",
                exitCode: 2,
              },
            },
          },
        },
      },
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    render(<WorkflowDagView runId="00000000-0000-0000-0000-000000000003" />, {
      wrapper: makeWrapper(),
    });

    const details = await screen.findByTestId("workflow-failure-node-solve");
    expect(details.textContent).toContain("Solve");
    expect(details.textContent).toContain("LAMMPS: Invalid atom style at input line 42");
    expect(details.textContent).toContain("workflows.run.exitCode");
    expect(screen.queryByText("solve: LAMMPS input command failed")).toBeNull();
  });

  test("uses stepJobs for failed-node diagnostics even when graph and result are null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-solve")) {
          return Promise.resolve(
            Response.json({
              id: "job-solve",
              name: "lammps",
              status: "failed",
              submittedAt: "2026-08-14T00:00:00.000Z",
              reason: "LAMMPS lost atoms during timestep 240",
              exitCode: 1,
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            ...workflowRunBody("failed"),
            stepJobs: { solve: "job-solve" },
            result: null,
            graph: null,
          }),
        );
      }),
    );

    render(<WorkflowDagView runId="00000000-0000-0000-0000-000000000003" />, {
      wrapper: makeWrapper(),
    });

    const details = await screen.findByTestId("workflow-failure-node-solve");
    await waitFor(() => {
      expect(details.textContent).toContain("LAMMPS lost atoms during timestep 240");
      expect(details.textContent).toContain("workflows.run.exitCode");
    });
    expect(screen.queryByTestId("dag-canvas")).toBeNull();
    const jobButton = details.querySelector("button");
    if (!jobButton) throw new Error("failed job button missing");
    fireEvent.click(jobButton);
    expect(screen.getByTestId("job-detail-sheet").textContent).toBe("job-solve");
  });

  test("overlays live job status on the persisted graph", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          Response.json(
            String(input).endsWith("/api/jobs/job-solve")
              ? { id: "job-solve", name: "solve", status: "running", submittedAt: "t" }
              : {
                  ...workflowRunBody("running"),
                  stepJobs: { solve: "job-solve" },
                  result: { status: { solve: "Pending" }, values: {} },
                },
          ),
        ),
      ),
    );

    render(<WorkflowDagView runId="running-run" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("run-node-solve").getAttribute("data-status")).toBe("running");
    });
  });

  test("posts to the canonical cancel endpoint for a running run", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let status = "running";
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (method === "POST" && url.endsWith("/api/workflows/run-cancel/cancel")) {
          status = "cancelling";
          return Promise.resolve(
            new Response(JSON.stringify({ runId: "run-cancel", status }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ ...workflowRunBody(status), id: "run-cancel" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    render(<WorkflowDagView runId="run-cancel" />, { wrapper: makeWrapper() });

    const button = await screen.findByTestId("workflow-cancel-run");
    expect(button.textContent).toContain("Cancel run");

    fireEvent.click(button);

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === "POST" && c.url === "/platform/api/workflows/run-cancel/cancel",
        ),
      ).toBe(true);
    });
    expect(await screen.findByText("cancelling")).toBeTruthy();
  });

  test("does not show cancel action for a completed run", async () => {
    mockFetchOnce(workflowRunBody("completed"), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    render(<WorkflowDagView runId="00000000-0000-0000-0000-000000000003" />, {
      wrapper: makeWrapper(),
    });

    expect(await screen.findByText("completed")).toBeTruthy();
    expect(screen.queryByTestId("workflow-cancel-run")).toBeNull();
  });

  // 500 path is intentionally retried by the component up to 3× (network blip
  // recovery), so it doesn't surface within a normal test timeout. The 4xx
  // tests exercise the no-retry path; the 5xx behavior is the same render
  // branch (`runQ.error` truthy → error card with the generic headline).
});
