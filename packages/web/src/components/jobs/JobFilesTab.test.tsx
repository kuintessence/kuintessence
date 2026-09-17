import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, downloadAuthedFile } from "../../lib/api-client";
import { JobFilesTab } from "./JobFilesTab";
import type { JobDetail } from "./types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: Record<string, unknown>) => {
      let value = String(opts?.defaultValue ?? opts?.name ?? opts?.count ?? _key);
      for (const [key, replacement] of Object.entries(opts ?? {})) {
        value = value.replaceAll(`{{${key}}}`, String(replacement));
      }
      return value;
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  api: {
    get: vi.fn(),
  },
  downloadAuthedFile: vi.fn(),
}));

function withQueryClient(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const job: JobDetail = {
  id: "867d9e1e-c725-4a09-b258-e6073e0c75b7",
  name: "mock-bash-batch-multischeduler-smoke-run",
  status: "completed",
  submittedAt: "2026-07-02T08:00:00.000Z",
  agentId: "scheduler-slurm",
  workingDir: "/tmp/kuintessence-workflows/867d9e1e-c725-4a09-b258-e6073e0c75b7",
  usecaseInputs: {
    inputs: [{ fileMetadataId: "file-input-a", fileMetadataName: "a.txt" }],
  },
  inputStaging: [{ fileMetadataId: "file-input-a", stagePath: "inputs/a.txt" }],
  expectedOutputs: [
    { descriptor: "summary", path: "summary.txt", isBatch: false },
    { descriptor: "chunks", path: "chunks/*.txt", isBatch: true },
  ],
};

describe("JobFilesTab actions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("downloads NetDrive inputs and matched output files, and supports cluster output download", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-input-a",
                path: "scheduler-smoke/slurm/batch/a.txt",
                size: 5,
                mtime: "2026-07-02T08:00:00.000Z",
              },
              {
                id: "file-output-summary",
                path: "outputs/867d9e1e-c725-4a09-b258-e6073e0c75b7/summary.txt",
                size: 7,
                mtime: "2026-07-02T08:01:00.000Z",
              },
              {
                id: "file-output-chunk-a",
                path: "outputs/867d9e1e-c725-4a09-b258-e6073e0c75b7/chunks/chunks_a.txt",
                size: 9,
                mtime: "2026-07-02T08:01:00.000Z",
              },
              {
                id: "file-output-chunk-foreign",
                path: "workflow-runs/other-run/jobs/other-job/chunks/chunks_a.txt",
                size: 11,
                mtime: "2026-07-02T08:01:00.000Z",
              },
            ],
            total: 2,
          },
        };
      }
      if (path === "/netdrive/files/file-input-a/download-url") {
        return {
          success: true,
          data: { downloadUrl: "https://minio.local/a.txt", expiresAt: "2099-01-01T00:00:00Z" },
        };
      }
      if (path === "/netdrive/files/file-output-summary/download-url") {
        return {
          success: true,
          data: {
            downloadUrl: "https://minio.local/summary.txt",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<JobFilesTab job={job} loading={false} />));

    const inputDownload = await screen.findByTestId("job-file-input-download-file-input-a");
    await waitFor(() => expect(inputDownload).toHaveProperty("disabled", false));
    fireEvent.click(inputDownload);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/netdrive/files/file-input-a/download-url"),
    );

    fireEvent.click(
      await screen.findByTestId("job-file-output-download-cloud-summary-file-output-summary"),
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/netdrive/files/file-output-summary/download-url"),
    );

    fireEvent.click(screen.getByTestId("job-file-output-download-cluster-summary"));
    await waitFor(() => expect(downloadAuthedFile).toHaveBeenCalled());
    expect(downloadAuthedFile).toHaveBeenCalledWith(
      "/files/cluster/download?agentId=scheduler-slurm&path=%2Ftmp%2Fkuintessence-workflows%2F867d9e1e-c725-4a09-b258-e6073e0c75b7%2Fsummary.txt",
      "summary.txt",
    );
    expect(
      await screen.findByTestId("job-file-output-download-cloud-chunks-file-output-chunk-a"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("job-file-output-download-cloud-chunks-file-output-chunk-foreign"),
    ).toBeNull();
  });

  test("does not show generic glob matches from other workflow runs", async () => {
    const get = vi.mocked(api.get);
    get.mockResolvedValue({
      success: true,
      data: {
        files: [
          {
            id: "file-output-chunk-foreign",
            path: "workflow-runs/other-run/jobs/other-job/chunks/chunks_a.txt",
            size: 11,
            mtime: "2026-07-02T08:01:00.000Z",
          },
        ],
        total: 1,
      },
    });

    render(withQueryClient(<JobFilesTab job={job} loading={false} />));

    expect((await screen.findAllByText("Not published")).length).toBeGreaterThan(0);
    expect(
      screen.queryByTestId("job-file-output-download-cloud-chunks-file-output-chunk-foreign"),
    ).toBeNull();
    const chunksDiagnostic = await screen.findByTestId("job-file-output-diagnostic-chunks");
    expect(chunksDiagnostic.textContent).toContain("Not published");
    expect(chunksDiagnostic.textContent).toContain("no matching NetDrive artifact");
  });

  test("surfaces NetDrive list errors instead of treating outputs as cleanly absent", async () => {
    const get = vi.mocked(api.get);
    get.mockRejectedValue(new Error("MinIO unavailable"));

    render(withQueryClient(<JobFilesTab job={job} loading={false} />));

    const error = await screen.findByTestId("job-files-netdrive-error");
    expect(error.textContent).toContain("Unable to verify NetDrive artifacts");
    expect(error.textContent).toContain("无法验证 NetDrive 文件，请稍后重试。");
    expect(error.textContent).not.toContain("MinIO unavailable");
    expect(error.textContent).not.toContain("Authorization denied");
    expect(error.textContent).not.toContain("FORBIDDEN");
    const diagnostics = await screen.findAllByText(/artifact publication cannot be verified/i);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(
      (await screen.findByTestId("job-file-input-download-file-input-a")) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);
    expect(
      (await screen.findByTestId("job-file-input-open-file-input-a")) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);
    expect(
      (await screen.findByTestId("job-file-output-open-summary")) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);
    expect(
      (await screen.findByTestId("job-file-output-download-cluster-summary")) as HTMLButtonElement,
    ).toHaveProperty("disabled", false);
  });

  test("disables cloud file actions while NetDrive publication is still loading", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(() => new Promise(() => {}));

    render(withQueryClient(<JobFilesTab job={job} loading={false} />));

    expect(screen.getByTestId("job-file-input-download-file-input-a")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("job-file-input-open-file-input-a")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("job-file-output-open-summary")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("job-file-output-download-cluster-summary")).toHaveProperty(
      "disabled",
      false,
    );
  });

  test("explains missing expected outputs without exposing the terminal job error", async () => {
    const get = vi.mocked(api.get);
    get.mockResolvedValue({
      success: true,
      data: { files: [], total: 0 },
    });

    render(
      withQueryClient(
        <JobFilesTab
          job={{ ...job, status: "failed", errorMessage: "output collection failed: summary.txt" }}
          loading={false}
        />,
      ),
    );

    await waitFor(() => {
      const summaryDiagnostic = screen.getByTestId("job-file-output-diagnostic-summary");
      expect(summaryDiagnostic.textContent).toContain("作业在发布此输出前失败，请查看作业日志。");
      expect(summaryDiagnostic.textContent).not.toContain("output collection failed: summary.txt");
      expect(summaryDiagnostic.textContent).not.toContain("stderr");
      expect(summaryDiagnostic.textContent).not.toContain("FORBIDDEN");
    });
  });
});
