import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import { isActiveWorkflowStatus, WorkflowsPage } from "./WorkflowsPage";

const navigate = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "common.all") return "All";
      if (key === "common.refresh") return "Refresh";
      if (key === "workflows.countHint") return `${opts?.visible} visible · ${opts?.total} total`;
      if (key === "workflows.lastUpdated") return `Updated ${opts?.time}`;
      if (key === "workflows.pagination.page") return `Page ${opts?.page} of ${opts?.pages}`;
      const labels: Record<string, string> = {
        "workflows.title": "Workflows",
        "workflows.subtitle": "Workflow status",
        "workflows.searchPlaceholder": "Search runs",
        "workflows.summary.active": "Active",
        "workflows.summary.completed": "Completed",
        "workflows.summary.failed": "Failed",
        "workflows.summary.cancelled": "Cancelled",
        "workflows.filters.active": "Active",
        "workflows.filters.completed": "Completed",
        "workflows.filters.failed": "Failed",
        "workflows.filters.cancelled": "Cancelled",
        "workflows.clearFilters": "Clear filters",
        "workflows.newWorkflow": "New workflow",
        "workflows.empty": "No workflow runs yet.",
        "workflows.noMatches": "No workflow runs match these filters.",
        "workflows.notUpdated": "not yet",
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    get: vi.fn(),
  },
}));

function makeClientWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

function wrapper() {
  return makeClientWrapper().wrapper;
}

const runs = [
  {
    id: "run-submitted",
    name: "Alpha preprocess",
    status: "submitted",
    createdAt: "2026-06-10T08:00:00.000Z",
  },
  {
    id: "run-running",
    name: "Beta train",
    status: "running",
    createdAt: "2026-06-10T09:00:00.000Z",
  },
  {
    id: "run-completed",
    name: "Gamma report",
    status: "completed",
    createdAt: "2026-06-10T10:00:00.000Z",
  },
  {
    id: "run-failed",
    name: "Delta failed",
    status: "WORKFLOW_INTERRUPTED",
    createdAt: "2026-06-10T11:00:00.000Z",
  },
  {
    id: "run-cancelled",
    name: "Epsilon cancelled",
    status: "cancelled",
    createdAt: "2026-06-10T12:00:00.000Z",
  },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("WorkflowsPage", () => {
  test("aligns active workflow statuses with the Server lifecycle", () => {
    expect(
      ["submitted", "queued", "pending", "awaiting_approval", "running", "cancelling"].every(
        isActiveWorkflowStatus,
      ),
    ).toBe(true);
    expect(isActiveWorkflowStatus("completed")).toBe(false);
  });

  test("summarizes, searches, filters, and clears workflow runs", async () => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "/workflows/drafts") return Promise.resolve({ drafts: [] });
      const params = new URL(path, "http://localhost").searchParams;
      const query = params.get("q")?.toLowerCase();
      const status = params.get("status");
      const searched = query
        ? runs.filter((run) =>
            [run.name, run.id, run.status].some((value) => value.toLowerCase().includes(query)),
          )
        : runs;
      const filtered = status
        ? searched.filter((run) =>
            status === "active"
              ? isActiveWorkflowStatus(run.status)
              : run.status.toLowerCase().includes(status),
          )
        : searched;
      return Promise.resolve({ runs: filtered, total: filtered.length });
    });

    render(<WorkflowsPage />, { wrapper: wrapper() });

    await screen.findByTestId("workflow-row-run-submitted");
    expect(screen.getByTestId("workflows-count").textContent).toBe("5 visible · 5 total");
    expect(screen.getByTestId("workflows-summary-active").textContent).toBe("2");
    expect(screen.getByTestId("workflows-summary-completed").textContent).toBe("1");
    expect(screen.getByTestId("workflows-summary-failed").textContent).toBe("1");
    expect(screen.getByTestId("workflows-summary-cancelled").textContent).toBe("1");

    fireEvent.change(screen.getByTestId("workflows-search"), { target: { value: "alpha" } });
    await waitFor(() =>
      expect(screen.getByTestId("workflows-count").textContent).toBe("1 visible · 1 total"),
    );
    expect(screen.getByTestId("workflow-row-run-submitted")).toBeTruthy();
    expect(screen.queryByTestId("workflow-row-run-running")).toBeNull();

    fireEvent.click(screen.getByTestId("workflows-clear-filters"));
    await waitFor(() =>
      expect(screen.getByTestId("workflows-count").textContent).toBe("5 visible · 5 total"),
    );

    fireEvent.click(screen.getByTestId("workflows-chip-active"));
    await waitFor(() =>
      expect(screen.getByTestId("workflows-count").textContent).toBe("2 visible · 2 total"),
    );
    expect(screen.getByTestId("workflow-row-run-submitted")).toBeTruthy();
    expect(screen.getByTestId("workflow-row-run-running")).toBeTruthy();
    expect(screen.queryByTestId("workflow-row-run-completed")).toBeNull();
  });

  test("surfaces workflow list errors without rendering an empty table", async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      path === "/workflows/drafts"
        ? Promise.resolve({ drafts: [] })
        : Promise.reject(new Error("workflow list denied")),
    );

    render(<WorkflowsPage />, { wrapper: wrapper() });

    await screen.findByTestId("workflows-list-error");
    expect(screen.getByTestId("workflows-list-error").textContent).not.toContain(
      "workflow list denied",
    );
    expect(screen.queryByText("No workflow runs yet.")).toBeNull();
    expect(screen.getByTestId("workflows-new")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("workflows-count").textContent).toBe("— visible · — total");
    expect(screen.getByTestId("workflows-summary-active").textContent).toBe("—");
    expect(screen.getByTestId("workflows-summary-completed").textContent).toBe("—");
    expect(screen.getByTestId("workflows-summary-failed").textContent).toBe("—");
    expect(screen.getByTestId("workflows-summary-cancelled").textContent).toBe("—");
  });

  test("clears stale workflow rows after a list refetch error", async () => {
    let calls = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/workflows/drafts") return { drafts: [] };
      if (!path.startsWith("/workflows?")) throw new Error(`unexpected GET ${path}`);
      calls += 1;
      if (calls > 1) throw new Error("workflow list denied");
      return { runs };
    });
    const { client, wrapper } = makeClientWrapper();

    render(<WorkflowsPage />, { wrapper });

    await screen.findByTestId("workflow-row-run-running");
    fireEvent.click(screen.getByTestId("workflow-row-run-running"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/workflows/$runId",
      params: { runId: "run-running" },
    });
    navigate.mockClear();

    await client.invalidateQueries({ queryKey: ["workflows-list"] });

    await screen.findByTestId("workflows-list-error");
    expect(screen.getByTestId("workflows-list-error").textContent).not.toContain(
      "workflow list denied",
    );
    expect(screen.queryByTestId("workflow-row-run-running")).toBeNull();
    expect(screen.getByTestId("workflows-new")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("workflows-count").textContent).toBe("— visible · — total");
    expect(navigate).not.toHaveBeenCalled();
  });

  test("surfaces draft loading errors instead of treating drafts as empty", async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      path === "/workflows/drafts"
        ? Promise.reject(new Error("Authorization principal is not bound"))
        : Promise.resolve({ runs }),
    );

    render(<WorkflowsPage />, { wrapper: wrapper() });

    await screen.findByTestId("workflow-row-run-submitted");
    const error = await screen.findByTestId("workflow-drafts-error");
    expect(error.textContent).toContain("workflows.drafts.loadFailed");
    expect(error.textContent).not.toContain("Authorization principal is not bound");
    expect(screen.queryByTestId("workflow-drafts")).toBeNull();
  });

  test("refreshes manually and navigates from rows", async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path === "/workflows/drafts" ? { drafts: [] } : { runs }),
    );

    render(<WorkflowsPage />, { wrapper: wrapper() });

    fireEvent.click(await screen.findByTestId("workflow-row-run-running"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/workflows/$runId",
      params: { runId: "run-running" },
    });

    fireEvent.click(screen.getByTestId("workflows-refresh"));
    await waitFor(() =>
      expect(
        vi.mocked(api.get).mock.calls.filter(([path]) => path.startsWith("/workflows?")),
      ).toHaveLength(2),
    );
  });

  test("paginates server-side and resets to the first page when filters change", async () => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "/workflows/drafts") return Promise.resolve({ drafts: [] });
      const secondPage = path.includes("offset=25");
      return Promise.resolve({
        runs: secondPage ? [runs[2]] : runs,
        total: 30,
        summary: { active: 12, completed: 10, failed: 5, cancelled: 3 },
      });
    });

    render(<WorkflowsPage />, { wrapper: wrapper() });

    expect(await screen.findByTestId("workflows-pagination")).toBeTruthy();
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    expect(screen.getByTestId("workflows-summary-active").textContent).toBe("12");
    fireEvent.click(screen.getByTestId("workflows-next-page"));
    await waitFor(() =>
      expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes("offset=25"))).toBe(true),
    );
    expect(await screen.findByText("Page 2 of 2")).toBeTruthy();

    fireEvent.click(screen.getByTestId("workflows-chip-failed"));
    await waitFor(() =>
      expect(
        vi
          .mocked(api.get)
          .mock.calls.some(([path]) => path.includes("offset=0") && path.includes("status=failed")),
      ).toBe(true),
    );
  });

  test("returns to a valid page when the result set shrinks", async () => {
    let shrunk = false;
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "/workflows/drafts") return Promise.resolve({ drafts: [] });
      if (path.includes("offset=25")) {
        shrunk = true;
        return Promise.resolve({ runs: [], total: 1 });
      }
      return Promise.resolve({ runs: [runs[0]], total: shrunk ? 1 : 30 });
    });

    render(<WorkflowsPage />, { wrapper: wrapper() });

    fireEvent.click(await screen.findByTestId("workflows-next-page"));
    await waitFor(() =>
      expect(
        vi.mocked(api.get).mock.calls.filter(([path]) => path.includes("offset=0")),
      ).toHaveLength(2),
    );
    expect(await screen.findByTestId("workflow-row-run-submitted")).toBeTruthy();
    expect(screen.queryByTestId("workflows-pagination")).toBeNull();
  });
});
