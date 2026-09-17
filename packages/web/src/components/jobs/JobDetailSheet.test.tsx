import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

vi.mock("../../lib/use-job-status-stream", () => ({
  useJobStatusStream: vi.fn(),
}));

import { JobDetailSheet } from "./JobDetailSheet";

// Failed job detail requests show a status-aware error card and hide the tabs.
// Terminal client errors are not retried.

function makeWrapper() {
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

function mockFetchByPath(handler: (path: string) => { body: unknown; init: ResponseInit }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname.replace(/^\/platform/, "");
      const { body, init } = handler(path);
      return Promise.resolve(new Response(JSON.stringify(body), init));
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("JobDetailSheet error UI", () => {
  test("renders 'Invalid job id' card on 400 from /platform/api/jobs/:id", async () => {
    mockFetchOnce(
      { error: { code: "VALIDATION_ERROR", message: "Invalid job id: must be a UUID" } },
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

    render(<JobDetailSheet jobId="not-a-uuid" open={true} onOpenChange={() => {}} />, {
      wrapper: makeWrapper(),
    });

    const card = await waitFor(() => screen.getByTestId("job-detail-error"));
    expect(card.textContent).toContain("Invalid job id");
    expect(card.textContent).not.toContain("Invalid job id: must be a UUID");
    expect(card.textContent).toContain("not-a-uuid");

    // Tabs are hidden when an error is set.
    expect(screen.queryByTestId("tab-overview")).toBeNull();
    expect(screen.queryByTestId("tab-logs")).toBeNull();
    expect(screen.queryByTestId("tab-resources")).toBeNull();
  });

  test("renders 'Job not found' card on 404", async () => {
    mockFetchOnce(
      { error: { code: "NOT_FOUND", message: "Job not found" } },
      { status: 404, headers: { "Content-Type": "application/json" } },
    );

    render(
      <JobDetailSheet
        jobId="00000000-0000-0000-0000-000000000000"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: makeWrapper() },
    );

    const card = await waitFor(() => screen.getByTestId("job-detail-error"));
    expect(card.textContent).toContain("Job not found");
  });

  test("does not render the error card when jobId is null", () => {
    render(<JobDetailSheet jobId={null} open={true} onOpenChange={() => {}} />, {
      wrapper: makeWrapper(),
    });
    expect(screen.queryByTestId("job-detail-error")).toBeNull();
  });

  test("renders successful job detail with truncation-safe title and resource tab", async () => {
    const jobId = "867d9e1e-c725-4a09-b258-e6073e0c75b7";
    const longName =
      "mock-bash-batch-multischeduler-smoke-run-with-a-very-long-human-readable-name";
    mockFetchByPath((path) => {
      if (path === `/api/jobs/${jobId}`) {
        return {
          body: {
            id: jobId,
            name: longName,
            status: "completed",
            submittedAt: "2026-07-02T08:00:00.000Z",
            startedAt: "2026-07-02T08:00:05.000Z",
            completedAt: "2026-07-02T08:00:10.000Z",
            resources: { cpus: 4, memoryMb: 8192 },
          },
          init: { status: 200, headers: { "Content-Type": "application/json" } },
        };
      }
      if (path === `/api/jobs/${jobId}/placement`) {
        return {
          body: { error: { code: "NOT_FOUND", message: "No placement trace" } },
          init: { status: 404, headers: { "Content-Type": "application/json" } },
        };
      }
      return {
        body: { error: { code: "NOT_FOUND", message: `Unexpected path ${path}` } },
        init: { status: 404, headers: { "Content-Type": "application/json" } },
      };
    });

    render(<JobDetailSheet jobId={jobId} open={true} onOpenChange={() => {}} />, {
      wrapper: makeWrapper(),
    });

    const title = await screen.findByRole("heading", { name: longName });
    expect(title.className).toContain("truncate");
    expect(title.getAttribute("title")).toBe(longName);
    expect(await screen.findByTestId("job-overview-tab")).toBeTruthy();
  });

  test("cancels an active job from the detail sheet and updates the status", async () => {
    const jobId = "867d9e1e-c725-4a09-b258-e6073e0c75b7";
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname.replace(/^\/platform/, "");
      if (path === `/api/jobs/${jobId}/cancel` && init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            id: jobId,
            name: "active-job",
            status: "cancelled",
            submittedAt: "2026-08-10T08:00:00.000Z",
          }),
        );
      }
      if (path === `/api/jobs/${jobId}`) {
        return Promise.resolve(
          Response.json({
            id: jobId,
            name: "active-job",
            status: "running",
            submittedAt: "2026-08-10T08:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(
        Response.json(
          { error: { code: "NOT_FOUND", message: "No placement trace" } },
          { status: 404 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );

    render(<JobDetailSheet jobId={jobId} open={true} onOpenChange={() => {}} />, {
      wrapper: makeWrapper(),
    });

    fireEvent.click(await screen.findByTestId("job-cancel-button"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/platform/api/jobs/${jobId}/cancel`,
        expect.objectContaining({ method: "POST" }),
      );
    });
    await waitFor(
      () => {
        expect(screen.queryByTestId("job-cancel-button")).toBeNull();
        expect(screen.getByTestId("job-detail-sheet").textContent).toContain("cancelled");
      },
      { timeout: 5_000 },
    );
  });
});
