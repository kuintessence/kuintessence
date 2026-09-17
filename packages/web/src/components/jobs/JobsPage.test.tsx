import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JobsPage, jobsPath } from "./JobsPage";

const jobDetailSheetMock = vi.hoisted(() => vi.fn());
const submitJobDialogMock = vi.hoisted(() => vi.fn());
const importJobJsonDialogMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "jobs.pagination.next") return "下一页";
      if (key === "jobs.pagination.previous") return "上一页";
      if (key === "jobs.pagination.range") {
        return `${opts?.start}-${opts?.end} / ${opts?.total}`;
      }
      if (key === "jobs.pagination.page") return `${opts?.page} / ${opts?.pages}`;
      if (key === "jobs.agentFilter.active") return `Agent ${opts?.agentId}`;
      return opts?.defaultValue ?? key;
    },
  }),
}));

vi.mock("./JobDetailSheet", () => ({
  JobDetailSheet: (props: { jobId: string | null; open: boolean }) => {
    jobDetailSheetMock(props);
    return props.open ? <div data-testid="mock-job-detail-sheet">{props.jobId}</div> : null;
  },
}));
vi.mock("./SubmitJobDialog", () => ({
  SubmitJobDialog: (props: { open: boolean; openUsecasePickerOnOpen?: boolean }) => {
    submitJobDialogMock(props);
    return props.open ? (
      <div data-testid="mock-submit-job-dialog">
        {props.openUsecasePickerOnOpen ? "usecase-picker" : "default"}
      </div>
    ) : null;
  },
}));
vi.mock("./ImportJobJsonDialog", () => ({
  ImportJobJsonDialog: (props: { open: boolean }) => {
    importJobJsonDialogMock(props);
    return props.open ? <div data-testid="mock-import-job-json-dialog" /> : null;
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

function makeWrapper() {
  return makeClientWrapper().wrapper;
}

function job(id: number) {
  return {
    id: `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`,
    name: `mock-job-${id}`,
    status: id % 2 === 0 ? "completed" : "failed",
    submittedAt: "2026-07-06T00:00:00.000Z",
    accessScope: "owner",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  jobDetailSheetMock.mockClear();
  submitJobDialogMock.mockClear();
  importJobJsonDialogMock.mockClear();
});

async function openSubmitMenu() {
  const trigger = await screen.findByTestId("jobs-submit-menu");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe("JobsPage pagination", () => {
  test("builds a server-paginated access-scope query", () => {
    expect(
      jobsPath({
        pageIndex: 2,
        search: "solver",
        status: "RUNNING",
        scope: "provider_operator",
        agentId: "agent-a/b",
      }),
    ).toBe(
      "/jobs?limit=25&offset=50&scope=provider_operator&q=solver&status=running&agentId=agent-a%2Fb",
    );
  });

  test("requests only the selected Agent jobs and exposes a clear action", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(JSON.stringify({ jobs: [job(1)], total: 1, limit: 25, offset: 0 }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const clearAgentFilter = vi.fn();

    render(<JobsPage agentId="agent-a/b" onClearAgentFilter={clearAgentFilter} />, {
      wrapper: makeWrapper(),
    });

    await screen.findByTestId("jobs-agent-filter");
    expect(screen.getByTestId("jobs-agent-filter").textContent).toContain("agent-a/b");
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("agentId=agent-a%2Fb")),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("jobs-agent-filter-clear"));
    expect(clearAgentFilter).toHaveBeenCalledTimes(1);
  });

  test("opens the JSON import review instead of submitting immediately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ jobs: [], total: 0, limit: 25, offset: 0 }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    render(<JobsPage />, { wrapper: makeWrapper() });

    await openSubmitMenu();
    fireEvent.click(await screen.findByTestId("jobs-submit-upload"));

    expect(await screen.findByTestId("mock-import-job-json-dialog")).toBeTruthy();
    expect(screen.queryByTestId("mock-submit-job-dialog")).toBeNull();
  });

  test("opens the existing software usecase picker from the secondary action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ jobs: [], total: 0, limit: 25, offset: 0 }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    render(<JobsPage />, { wrapper: makeWrapper() });

    await openSubmitMenu();
    fireEvent.click(await screen.findByTestId("jobs-submit-template"));

    expect(await screen.findByTestId("mock-submit-job-dialog")).toHaveProperty(
      "textContent",
      "usecase-picker",
    );
    expect(screen.queryByTestId("mock-import-job-json-dialog")).toBeNull();
  });

  test("surfaces job list errors without rendering an empty table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "jobs denied" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    render(<JobsPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("jobs-list-error"));
    expect(screen.getByTestId("jobs-list-error").textContent).toContain("does not have permission");
    expect(screen.getByTestId("jobs-list-error").textContent).not.toContain("jobs denied");
    expect(screen.queryByText("No jobs match these filters.")).toBeNull();
    expect(screen.queryByTestId("jobs-pagination")).toBeNull();
    expect(screen.getByTestId("jobs-submit-button")).toHaveProperty("disabled", true);
  });

  test("clears stale job actions after a list refetch error", async () => {
    const firstJob = job(1);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname !== "/platform/api/jobs") {
          throw new Error(`Unexpected fetch: ${url.pathname}`);
        }
        calls += 1;
        if (calls > 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "jobs denied" } }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ jobs: [firstJob], total: 1, limit: 25, offset: 0 }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );
    const { client, wrapper } = makeClientWrapper();

    render(<JobsPage />, { wrapper });

    await waitFor(() => screen.getByTestId(`job-row-${firstJob.id}`));
    fireEvent.click(screen.getByTestId(`job-row-${firstJob.id}`));
    expect(screen.getByTestId("mock-job-detail-sheet")).toHaveProperty("textContent", firstJob.id);

    await client.invalidateQueries({ queryKey: ["jobs-list", 0, "", "ALL"] });

    await waitFor(() => screen.getByTestId("jobs-list-error"));
    expect(screen.getByTestId("jobs-list-error").textContent).toContain("does not have permission");
    expect(screen.getByTestId("jobs-list-error").textContent).not.toContain("jobs denied");
    expect(screen.queryByTestId(`job-row-${firstJob.id}`)).toBeNull();
    expect(screen.queryByTestId("mock-job-detail-sheet")).toBeNull();
    expect(screen.queryByTestId("jobs-pagination")).toBeNull();
    expect(screen.getByTestId("jobs-submit-button")).toHaveProperty("disabled", true);
  });

  test("requests the next server page", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const jobs = offset === 0 ? Array.from({ length: 25 }, (_, i) => job(i + 1)) : [job(26)];
      return Promise.resolve(
        new Response(JSON.stringify({ jobs, total: 26, limit: 25, offset }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<JobsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("mock-job-1")).toBeTruthy();
    });

    const nextButton = screen.getByTestId("jobs-next-page") as HTMLButtonElement;
    await waitFor(() => {
      expect(nextButton.disabled).toBe(false);
    });
    fireEvent.click(nextButton);

    await waitFor(() => {
      const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(
        requestedUrls.some((url) => url.includes("limit=25") && url.includes("offset=25")),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByText("mock-job-26")).toBeTruthy();
    });
    expect(screen.getByTestId("jobs-pagination-range").textContent).toBe("26-26 / 26");
  });
});
