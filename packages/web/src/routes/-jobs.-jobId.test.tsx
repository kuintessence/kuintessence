import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../lib/api-client";
import { JobDetailPage } from "./jobs_.$jobId";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  statusStream: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../lib/api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api-client")>();
  return { ...original, api: { get: mocks.get, post: mocks.post } };
});

vi.mock("../lib/use-job-status-stream", () => ({ useJobStatusStream: mocks.statusStream }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../components/scheduler", () => ({ PlacementPipelineView: () => <div /> }));
vi.mock("../components/jobs/JobLogsTab", () => ({ JobLogsTab: () => <div /> }));
vi.mock("../components/jobs/JobFilesTab", () => ({ JobFilesTab: () => <div /> }));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <JobDetailPage jobId="job-1" />
    </QueryClientProvider>,
  );
}

describe("JobDetailPage", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.statusStream.mockReset();
    mocks.toastSuccess.mockReset();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  test("shows a retry action for transient detail failures", async () => {
    let detailRequests = 0;
    mocks.get.mockImplementation((path: string) => {
      if (path.endsWith("/placement")) {
        return Promise.reject(new ApiError(404, "NOT_FOUND", "No placement trace"));
      }
      detailRequests += 1;
      if (detailRequests === 1) return Promise.reject(new Error("Server unavailable"));
      return Promise.resolve({
        id: "job-1",
        name: "retry-job",
        status: "completed",
        submittedAt: "2026-08-12T00:00:00.000Z",
      });
    });
    renderPage();

    expect(await screen.findByTestId("job-detail-error")).toBeTruthy();
    fireEvent.click(screen.getByText("common.retry"));
    expect(await screen.findByTestId("job-detail-page")).toBeTruthy();
  });

  test("explains authorization denial without offering a pointless retry", async () => {
    mocks.get.mockRejectedValue(new ApiError(403, "FORBIDDEN", "Forbidden"));
    renderPage();

    expect(await screen.findByText("jobs.error.forbidden")).toBeTruthy();
    expect(screen.queryByText("common.retry")).toBeNull();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith("/jobs/job-1");
    expect(mocks.statusStream).toHaveBeenLastCalledWith(null);
  });

  test("allows cancelling a running job from the deep-link page", async () => {
    const running = {
      id: "job-1",
      name: "running-job",
      status: "running",
      submittedAt: "2026-08-12T00:00:00.000Z",
    };
    mocks.get.mockImplementation((path: string) =>
      path.endsWith("/placement")
        ? Promise.reject(new ApiError(404, "NOT_FOUND", "No placement trace"))
        : Promise.resolve(running),
    );
    mocks.post.mockResolvedValue({ ...running, status: "cancelled" });
    renderPage();

    fireEvent.click(await screen.findByText("jobs.cancel"));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/jobs/job-1/cancel", {}));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("jobs.cancelled");
  });
});
