import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, downloadAuthedFile } from "../../lib/api-client";
import { FilesPage } from "./FilesPage";

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "files.storage") return `${opts?.used} / ${opts?.total} GiB`;
      if (key === "files.globalCloud") return "云盘：全局 NetDrive";
      return key;
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    details?: unknown;
    constructor(status: number, code: string, message: string, details?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
  api: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  },
  downloadAuthedFile: vi.fn(),
  uploadFileToNetDrive: vi.fn(),
}));

vi.mock("../../lib/netdrive-client", async () => {
  const { api } = await import("../../lib/api-client");
  return {
    listAllNetDriveFiles: () => api.get("/netdrive/files"),
  };
});

function withQueryClient(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("FilesPage transfer direction", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  test("renders real cloud usage and the single global cloud label", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") return { agents: [] };
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path === "/files/transfers") return { transfers: [] };
      if (path === "/storage/summary?scope=cloud&scopeId=global") {
        return {
          scope: "cloud",
          scopeId: "global",
          usedBytes: 5 * 1024 ** 3,
          quotaBytes: 80 * 1024 ** 3,
          availableBytes: 75 * 1024 ** 3,
          usagePercent: 6.25,
          fileCount: 4,
          uploadedBytes30d: 0,
          downloadedBytes30d: 0,
          storedByteHours30d: 0,
          policy: {
            defaultQuotaBytes: 50 * 1024 ** 3,
            maxQuotaBytes: null,
            requestMode: "manual",
            autoApproveLimitBytes: null,
          },
          activeGrant: {
            quotaBytes: 80 * 1024 ** 3,
            expiresAt: null,
            source: "manual",
          },
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    expect(await screen.findByText("5.0 / 80.0 GiB")).toBeTruthy();
    expect(screen.getByText("云盘：全局 NetDrive")).toBeTruthy();
  });

  test("pull action opens a cluster_to_cloud transfer for the selected agent", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries: [
            {
              name: "result.txt",
              kind: "file",
              size: 32,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockResolvedValue({
      id: "transfer-1",
      userId: "admin@example.com",
      direction: "cluster_to_cloud",
      source: "/scratch/me/inputs/result.txt",
      target: "uploads/result.txt",
      agentId: "scheduler-slurm",
      siteId: "Docker Slurm AIO",
      totalBytes: null,
      copiedBytes: 0,
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    });

    render(withQueryClient(<FilesPage />));

    const row = await screen.findByTestId("files-cluster-row-result.txt");
    fireEvent.click(row);
    fireEvent.click(screen.getByTestId("files-pull"));
    expect((await screen.findByTestId("files-new-transfer-source")).textContent).toContain(
      "/scratch/me/inputs/result.txt",
    );
    fireEvent.click(screen.getByTestId("files-new-transfer-submit"));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/files/transfers", {
      direction: "cluster_to_cloud",
      source: "/scratch/me/inputs/result.txt",
      target: "uploads/result.txt",
      agentId: "scheduler-slurm",
      siteId: "Docker Slurm AIO",
      totalBytes: undefined,
    });
  });

  test("renders transfer preflight errors as user-facing toast copy", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries: [
            {
              name: "README.md",
              kind: "file",
              size: 32,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockRejectedValue(
      new ApiError(404, "NOT_FOUND", "Cluster source file not found or unavailable", {
        reason: "CLUSTER_SOURCE_FILE_UNAVAILABLE",
      }),
    );

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cluster-row-README.md"));
    fireEvent.click(screen.getByTestId("files-pull"));
    fireEvent.click(await screen.findByTestId("files-new-transfer-submit"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("files.transfer.error.clusterSourceUnavailable"),
    );
  });

  test("maps legacy transfer error codes when details are missing", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries: [
            {
              name: "README.md",
              kind: "file",
              size: 32,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockRejectedValue(
      new ApiError(404, "CLUSTER_SOURCE_FILE_UNAVAILABLE", "raw missing source"),
    );

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cluster-row-README.md"));
    fireEvent.click(screen.getByTestId("files-pull"));
    fireEvent.click(await screen.findByTestId("files-new-transfer-submit"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("files.transfer.error.clusterSourceUnavailable"),
    );
  });

  test("clears stale cluster selections before creating cluster_to_cloud transfers", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    let clusterCalls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        clusterCalls += 1;
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries:
            clusterCalls === 1
              ? [
                  {
                    name: "README.md",
                    kind: "file",
                    size: 32,
                    modifiedAt: new Date().toISOString(),
                  },
                ]
              : [],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cluster-row-README.md"));
    expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByTestId("files-cluster-refresh"));

    await waitFor(() => expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", true));
    expect(screen.queryByTestId("files-cluster-row-README.md")).toBeNull();

    fireEvent.click(screen.getByTestId("files-pull"));
    expect(screen.queryByTestId("files-new-transfer")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  test("clears stale cloud selections before creating cloud_to_cluster transfers", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    let cloudCalls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        cloudCalls += 1;
        return {
          success: true,
          data: {
            files:
              cloudCalls === 1
                ? [
                    {
                      id: "file-1",
                      path: "inputs/source.txt",
                      size: 18,
                      mtime: new Date().toISOString(),
                      canUse: true,
                      canDelete: true,
                    },
                  ]
                : [],
            total: cloudCalls === 1 ? 1 : 0,
          },
        };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: "/scratch/me/inputs", entries: [] };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cloud-dir-inputs"));
    fireEvent.click(await screen.findByTestId("files-cloud-row-file-1"));
    expect(screen.getByTestId("files-push")).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByTestId("files-cloud-refresh"));

    await waitFor(() => expect(screen.getByTestId("files-push")).toHaveProperty("disabled", true));
    expect(screen.queryByTestId("files-cloud-row-file-1")).toBeNull();

    fireEvent.click(screen.getByTestId("files-push"));
    expect(screen.queryByTestId("files-new-transfer")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  test("hides stale NetDrive rows and cloud actions when NetDrive refetch fails", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    let cloudCalls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        cloudCalls += 1;
        if (cloudCalls > 1) throw new Error("NetDrive scope denied");
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                path: "inputs/source.txt",
                size: 18,
                mtime: new Date().toISOString(),
                canUse: true,
                canDelete: true,
              },
            ],
            total: 1,
          },
        };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: "/scratch/me/inputs", entries: [] };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cloud-dir-inputs"));
    fireEvent.click(await screen.findByTestId("files-cloud-row-file-1"));
    expect(screen.getByTestId("files-push")).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByTestId("files-cloud-refresh"));

    await waitFor(() => expect(screen.getByTestId("files-push")).toHaveProperty("disabled", true));
    expect(screen.queryByTestId("files-cloud-row-file-1")).toBeNull();
    expect(screen.queryByTestId("files-cloud-upload")).toBeNull();

    fireEvent.click(screen.getByTestId("files-push"));
    expect(screen.queryByTestId("files-new-transfer")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  test("hides stale cluster rows and downloads when cluster listing refetch fails", async () => {
    const get = vi.mocked(api.get);
    const download = vi.mocked(downloadAuthedFile);
    let clusterCalls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        clusterCalls += 1;
        if (clusterCalls > 1) throw new Error("Cluster listing is unavailable");
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries: [
            {
              name: "README.md",
              kind: "file",
              size: 32,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cluster-row-README.md"));
    expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("files-cluster-download-README.md")).toBeTruthy();

    fireEvent.click(screen.getByTestId("files-cluster-refresh"));

    const message = await screen.findByText("files.pathPicker.loadFailed");
    expect(message.textContent).not.toContain("Cluster listing is unavailable");
    expect(screen.queryByTestId("files-cluster-row-README.md")).toBeNull();
    expect(screen.queryByTestId("files-cluster-download-README.md")).toBeNull();
    expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", true);
    expect(download).not.toHaveBeenCalled();
  });

  test("maps raw cluster target permission errors when starting a transfer", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                path: "all-suno-prompts.txt",
                size: 3_700_000,
                mtime: new Date().toISOString(),
                canUse: true,
                canDelete: true,
              },
            ],
            total: 1,
          },
        };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: "/scratch/me/inputs", entries: [] };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockRejectedValue(
      new ApiError(
        500,
        "TRANSFER_FAILED",
        "mkdir: cannot create directory '/scratch': Permission denied curl: (23) Failed writing body (0 != 16384)",
      ),
    );

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cloud-row-file-1"));
    fireEvent.click(screen.getByTestId("files-push"));
    fireEvent.click(await screen.findByTestId("files-new-transfer-submit"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("files.transfer.error.clusterTargetDirNotWritable"),
    );
  });

  test("push action uses the path picker to choose a cluster target directory", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                path: "inputs/result.txt",
                size: 12,
                mtime: new Date().toISOString(),
                canUse: true,
                canDelete: true,
              },
            ],
            total: 1,
          },
        };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries: [
            {
              name: "runs",
              kind: "dir",
              size: null,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockResolvedValue({
      id: "transfer-1",
      userId: "admin@example.com",
      direction: "cloud_to_cluster",
      source: "inputs/result.txt",
      target: "/scratch/me/inputs/runs/result.txt",
      agentId: "scheduler-slurm",
      siteId: "Docker Slurm AIO",
      totalBytes: 12,
      copiedBytes: 0,
      state: "queued",
      startedAt: null,
      finishedAt: null,
      error: null,
    });

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cloud-dir-inputs"));
    fireEvent.click(await screen.findByTestId("files-cloud-row-file-1"));
    fireEvent.click(screen.getByTestId("files-push"));
    fireEvent.click(await screen.findByTestId("files-new-transfer-target-picker"));
    fireEvent.click(await screen.findByTestId("path-picker-cluster-choose-dir-runs"));
    await waitFor(() =>
      expect(screen.getByTestId("files-new-transfer-target").textContent).toContain(
        "/scratch/me/inputs/runs",
      ),
    );
    expect(screen.getByTestId("files-new-transfer-summary").textContent).toContain(
      "/scratch/me/inputs/runs/result.txt",
    );
    fireEvent.click(screen.getByTestId("files-new-transfer-submit"));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/files/transfers", {
      direction: "cloud_to_cluster",
      source: "inputs/result.txt",
      target: "/scratch/me/inputs/runs/result.txt",
      sourceFileId: "file-1",
      agentId: "scheduler-slurm",
      siteId: "Docker Slurm AIO",
      totalBytes: 12,
    });
  });

  test("new transfer can pick a cloud source file from the sheet", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                path: "source.txt",
                size: 18,
                mtime: new Date().toISOString(),
                canUse: true,
                canDelete: true,
              },
            ],
            total: 1,
          },
        };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: "/scratch/me/inputs", entries: [] };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockResolvedValue({
      id: "transfer-1",
      userId: "admin@example.com",
      direction: "cloud_to_cluster",
      source: "source.txt",
      target: "/scratch/me/inputs/source.txt",
      agentId: "scheduler-slurm",
      siteId: "Docker Slurm AIO",
      totalBytes: 18,
      copiedBytes: 0,
      state: "queued",
      startedAt: null,
      finishedAt: null,
      error: null,
    });

    render(withQueryClient(<FilesPage />));

    const newTransfer = await screen.findByTestId("files-new-transfer-button");
    await waitFor(() => expect(newTransfer).toHaveProperty("disabled", false));
    fireEvent.click(newTransfer);
    fireEvent.click(await screen.findByTestId("files-new-transfer-source-picker"));
    fireEvent.click(await screen.findByTestId("path-picker-cloud-file-file-1"));
    fireEvent.click(screen.getByTestId("path-picker-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("files-new-transfer-source").textContent).toContain("source.txt"),
    );
    fireEvent.click(screen.getByTestId("files-new-transfer-submit"));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/files/transfers", {
      direction: "cloud_to_cluster",
      source: "source.txt",
      target: "/scratch/me/inputs/source.txt",
      sourceFileId: "file-1",
      agentId: "scheduler-slurm",
      siteId: "Docker Slurm AIO",
      totalBytes: 18,
    });
  });

  test("blocks cloud to cluster transfer before opening the sheet when no target root is verified", async () => {
    const get = vi.mocked(api.get);
    const post = vi.mocked(api.post);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                path: "source.txt",
                size: 18,
                mtime: new Date().toISOString(),
                canUse: true,
                canDelete: true,
              },
            ],
            total: 1,
          },
        };
      }
      if (path.startsWith("/files/cluster")) {
        throw new Error("Cluster path not found or unavailable");
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    fireEvent.click(await screen.findByTestId("files-cloud-row-file-1"));
    const message = await screen.findByText("files.pathPicker.loadFailed");
    expect(message.textContent).not.toContain("Cluster path not found or unavailable");
    expect(screen.getByTestId("files-push")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("files-push"));

    expect(screen.queryByTestId("files-new-transfer")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  test("new transfer sheet renders labels through i18n keys", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: "/scratch/me/inputs", entries: [] };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    const newTransfer = await screen.findByTestId("files-new-transfer-button");
    await waitFor(() => expect(newTransfer).toHaveProperty("disabled", false));
    fireEvent.click(newTransfer);

    expect(await screen.findByText("files.transfer.newTitle")).toBeTruthy();
    expect(screen.getByText("files.transfer.source")).toBeTruthy();
    expect(screen.getByText("files.transfer.executionCluster")).toBeTruthy();
    expect(screen.getByText("files.transfer.targetPath")).toBeTruthy();
    expect(screen.getByText("files.transfer.summary")).toBeTruthy();
    expect(screen.getAllByText("files.pathPicker.choose").length).toBeGreaterThanOrEqual(2);
  });

  test("completed filter shows finished transfers separately from active transfers", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: "/scratch/me/inputs", entries: [] };
      }
      if (path === "/files/transfers") {
        return {
          transfers: [
            {
              id: "transfer-done",
              userId: "admin@example.com",
              direction: "cluster_to_cloud",
              source: "/scratch/me/inputs/result.txt",
              target: "uploads/result.txt",
              agentId: "scheduler-slurm",
              siteId: "Docker Slurm AIO",
              totalBytes: 32,
              copiedBytes: 32,
              state: "succeeded",
              startedAt: "2026-06-10T00:00:00.000Z",
              finishedAt: "2026-06-10T00:00:01.000Z",
              error: null,
            },
          ],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    expect(await screen.findByText("files.transfers.emptyFilter")).toBeTruthy();
    fireEvent.click(screen.getByTestId("files-transfers-filter-completed"));

    expect(await screen.findByTestId("files-transfer-transfer-done")).toBeTruthy();
  });

  test("cluster pane wraps the path and exposes refresh plus context actions", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries: [
            {
              name: "result.txt",
              kind: "file",
              size: 32,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    await waitFor(() =>
      expect(screen.getByTestId("files-cluster-path").textContent).toContain("/scratch/me/inputs"),
    );
    const beforeRefresh = get.mock.calls.filter((call) =>
      call[0].startsWith("/files/cluster"),
    ).length;
    fireEvent.click(screen.getByTestId("files-cluster-refresh"));
    await waitFor(() => {
      const afterRefresh = get.mock.calls.filter((call) =>
        call[0].startsWith("/files/cluster"),
      ).length;
      expect(afterRefresh).toBeGreaterThan(beforeRefresh);
    });

    fireEvent.click(await screen.findByTestId("files-cluster-more-result.txt"));

    expect(await screen.findByTestId("files-context-menu")).toBeTruthy();
    expect(screen.getByTestId("files-context-copy").textContent).toContain("files.context.copy");
    expect(screen.queryByTestId("files-context-delete")).toBeNull();
  });

  test("uses the first authorized cluster root without requesting the legacy scratch path", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        const requestedPath = new URL(path, "http://server.test").searchParams.get("path");
        return {
          siteId: "Docker Slurm AIO",
          path: requestedPath ?? "/projects/team-a",
          roots: ["/projects/team-a", "/scratch/team-a"],
          entries: [],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    await waitFor(() =>
      expect(screen.getByTestId("files-cluster-path").textContent).toContain("/projects/team-a"),
    );
    const clusterRequest = get.mock.calls.find((call) => call[0].startsWith("/files/cluster"));
    expect(clusterRequest).toBeDefined();
    expect(new URL(clusterRequest?.[0] ?? "", "http://server.test").searchParams.has("path")).toBe(
      false,
    );
    expect(screen.getByTestId("files-cluster-up")).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByTestId("files-cluster-root-select"), {
      target: { value: "/scratch/team-a" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("files-cluster-path").textContent).toBe("/scratch/team-a"),
    );
    expect(screen.getByTestId("files-cluster-root-select")).toHaveProperty(
      "value",
      "/scratch/team-a",
    );
    expect(
      get.mock.calls.some(
        (call) =>
          call[0].startsWith("/files/cluster") &&
          new URL(call[0], "http://server.test").searchParams.get("path") === "/scratch/team-a",
      ),
    ).toBe(true);
    expect(screen.getByTestId("files-cluster-up")).toHaveProperty("disabled", true);
  });

  test("shows an explicit empty state when the selected Agent has no authorized root", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: null, roots: [], entries: [] };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    expect(await screen.findByText("files.clusterNoAuthorizedRoot")).toBeTruthy();
    expect(screen.getByTestId("files-cluster-up")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("files-push")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", true);
  });

  test("hides stale cluster rows and disables actions after the Agent list refetch fails", async () => {
    const get = vi.mocked(api.get);
    let agentCalls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        agentCalls += 1;
        if (agentCalls > 1) throw new Error("Agent registry unavailable");
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me",
          roots: ["/scratch/me"],
          entries: [
            {
              name: "stale.dat",
              kind: "file",
              size: 12,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") return { transfers: [] };
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));
    expect(await screen.findByText("stale.dat")).toBeTruthy();
    fireEvent.click(screen.getByTestId("files-cluster-refresh"));

    expect(await screen.findByText("files.clusterAgentsLoadFailed")).toBeTruthy();
    expect(screen.queryByText("stale.dat")).toBeNull();
    expect(screen.getByTestId("files-push")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", true);
  });

  test("disables every transfer entry point while NetDrive is unavailable", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        throw new ApiError(503, "NETDRIVE_DISABLED", "NetDrive unavailable");
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me",
          roots: ["/scratch/me"],
          entries: [
            {
              name: "output.dat",
              kind: "file",
              size: 12,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") return { transfers: [] };
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));
    expect(await screen.findByText("files.netdriveDisabled")).toBeTruthy();
    const newTransfer = screen.getByTestId("files-new-transfer-button");
    expect(newTransfer).toHaveProperty("disabled", true);
    expect(newTransfer.getAttribute("title")).toBe("files.transfer.netdriveUnavailable");
    expect(screen.getByTestId("files-push")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", true);
  });

  test("rediscovers roots when the active root is revoked", async () => {
    const get = vi.mocked(api.get);
    let revoked = false;
    let pathlessCalls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        const requestedPath = new URL(path, "http://server.test").searchParams.get("path");
        if (!requestedPath) pathlessCalls += 1;
        if (requestedPath === "/scratch/team-a" && revoked) {
          throw new ApiError(403, "FORBIDDEN", "Cluster path is outside allowed roots", {
            reason: "PATH_OUTSIDE_ALLOWED_ROOT",
          });
        }
        const roots = revoked ? ["/projects/team-a"] : ["/projects/team-a", "/scratch/team-a"];
        return {
          siteId: "Docker Slurm AIO",
          path: requestedPath ?? roots[0],
          roots,
          entries:
            requestedPath === "/scratch/team-a"
              ? [
                  {
                    name: "README.md",
                    kind: "file",
                    size: 32,
                    modifiedAt: new Date().toISOString(),
                  },
                ]
              : [],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    fireEvent.change(await screen.findByTestId("files-cluster-root-select"), {
      target: { value: "/scratch/team-a" },
    });
    fireEvent.click(await screen.findByTestId("files-cluster-row-README.md"));
    expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", false);

    revoked = true;
    fireEvent.click(screen.getByTestId("files-cluster-refresh"));

    await waitFor(() =>
      expect(screen.getByTestId("files-cluster-path").textContent).toBe("/projects/team-a"),
    );
    await waitFor(() => expect(screen.queryByTestId("files-cluster-root-select")).toBeNull());
    expect(screen.getByTestId("files-pull")).toHaveProperty("disabled", true);
    expect(pathlessCalls).toBe(2);
  });

  test("does not rediscover roots for unrelated forbidden errors", async () => {
    const get = vi.mocked(api.get);
    let denied = false;
    let pathlessCalls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        const requestedPath = new URL(path, "http://server.test").searchParams.get("path");
        if (!requestedPath) pathlessCalls += 1;
        if (requestedPath === "/scratch/team-a" && denied) {
          throw new ApiError(403, "FORBIDDEN", "Cluster access denied", {
            reason: "AGENT_ACCESS_DENIED",
          });
        }
        return {
          siteId: "Docker Slurm AIO",
          path: requestedPath ?? "/projects/team-a",
          roots: ["/projects/team-a", "/scratch/team-a"],
          entries: [],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));

    fireEvent.change(await screen.findByTestId("files-cluster-root-select"), {
      target: { value: "/scratch/team-a" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("files-cluster-path").textContent).toBe("/scratch/team-a"),
    );

    denied = true;
    fireEvent.click(screen.getByTestId("files-cluster-refresh"));

    const message = await screen.findByText(/does not have permission|没有执行此操作的权限/);
    expect(message.textContent).not.toContain("Cluster access denied");
    expect(screen.getByTestId("files-cluster-path").textContent).toBe("/scratch/team-a");
    expect(screen.getByTestId("files-cluster-root-select")).toHaveProperty(
      "value",
      "/scratch/team-a",
    );
    expect(pathlessCalls).toBe(1);
  });

  test("downloads a NetDrive file through a presigned download URL", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                path: "result.txt",
                size: 12,
                mtime: new Date().toISOString(),
                canUse: true,
                canDelete: true,
              },
            ],
            total: 1,
          },
        };
      }
      if (path === "/netdrive/files/file-1/download-url") {
        return {
          success: true,
          data: { downloadUrl: "http://minio.local/result.txt", expiresAt: "2099-01-01T00:00:00Z" },
        };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: "/scratch/me/inputs", entries: [] };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      clicked.push(this.href);
    };

    try {
      render(withQueryClient(<FilesPage />));
      fireEvent.click(await screen.findByTestId("files-cloud-download-file-1"));

      await waitFor(() => expect(get).toHaveBeenCalledWith("/netdrive/files/file-1/download-url"));
      expect(clicked).toEqual(["http://minio.local/result.txt"]);
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  test("keeps view-only NetDrive files visible but blocks download and push", async () => {
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "view-only-file",
                ownerId: "another-user",
                path: "shared/result.txt",
                size: 12,
                mtime: new Date().toISOString(),
                canUse: false,
                canDelete: false,
              },
            ],
            total: 1,
          },
        };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          roots: ["/scratch/me"],
          entries: [],
        };
      }
      if (path === "/files/transfers") return { transfers: [] };
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));
    fireEvent.click(await screen.findByTestId("files-cloud-dir-shared"));
    fireEvent.click(await screen.findByTestId("files-cloud-row-view-only-file"));

    expect(screen.getByTestId("files-cloud-view-only-view-only-file")).toBeTruthy();
    expect(screen.queryByTestId("files-cloud-download-view-only-file")).toBeNull();
    expect(screen.getByTestId("files-push")).toHaveProperty("disabled", true);
  });

  test("deletes an owned platform file only after confirmation and refreshes usage", async () => {
    const get = vi.mocked(api.get);
    const remove = vi.mocked(api.delete);
    let deleted = false;
    let storageCalls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") return { agents: [] };
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: deleted
              ? []
              : [
                  {
                    id: "file-1",
                    ownerId: "user-1",
                    canUse: true,
                    canDelete: true,
                    path: "results/output.txt",
                    size: 12,
                    mtime: new Date().toISOString(),
                  },
                ],
            total: deleted ? 0 : 1,
          },
        };
      }
      if (path === "/files/transfers") return { transfers: [] };
      if (path === "/storage/summary?scope=cloud&scopeId=global") {
        storageCalls += 1;
        return {
          scope: "cloud",
          scopeId: "global",
          usedBytes: deleted ? 0 : 12,
          quotaBytes: 1024,
          availableBytes: deleted ? 1024 : 1012,
          usagePercent: deleted ? 0 : 1.17,
          fileCount: deleted ? 0 : 1,
          uploadedBytes30d: 0,
          downloadedBytes30d: 0,
          storedByteHours30d: 0,
          policy: {
            defaultQuotaBytes: 1024,
            maxQuotaBytes: null,
            requestMode: "manual",
            autoApproveLimitBytes: null,
          },
          activeGrant: null,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    remove.mockImplementation(async () => {
      deleted = true;
      return { success: true };
    });

    render(withQueryClient(<FilesPage />));
    fireEvent.click(await screen.findByTestId("files-cloud-dir-results"));
    fireEvent.click(await screen.findByTestId("files-cloud-row-file-1"));
    fireEvent.click(screen.getByTestId("files-cloud-more-file-1"));
    fireEvent.click(await screen.findByTestId("files-context-delete"));

    expect(screen.getByTestId("files-delete-dialog")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    const storageCallsBeforeDelete = storageCalls;
    fireEvent.click(screen.getByTestId("files-delete-confirm"));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("/netdrive/files/file-1"));
    await waitFor(() => expect(screen.queryByTestId("files-delete-dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("files-cloud-row-file-1")).toBeNull());
    expect(screen.queryByTestId("files-cloud-selected")).toBeNull();
    expect(storageCalls).toBeGreaterThan(storageCallsBeforeDelete);
    expect(toastSuccess).toHaveBeenCalledWith("files.deleteDialog.succeeded");
  });

  test("keeps the delete dialog and selection when deleting a platform file fails", async () => {
    const get = vi.mocked(api.get);
    const remove = vi.mocked(api.delete);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") return { agents: [] };
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                ownerId: "user-1",
                canUse: true,
                canDelete: true,
                path: "output.txt",
                size: 12,
                mtime: new Date().toISOString(),
              },
            ],
            total: 1,
          },
        };
      }
      if (path === "/files/transfers") return { transfers: [] };
      throw new Error(`unexpected GET ${path}`);
    });
    remove.mockRejectedValue(new ApiError(403, "FORBIDDEN", "No delete permission"));

    render(withQueryClient(<FilesPage />));
    fireEvent.click(await screen.findByTestId("files-cloud-row-file-1"));
    fireEvent.click(screen.getByTestId("files-cloud-more-file-1"));
    fireEvent.click(await screen.findByTestId("files-context-delete"));
    fireEvent.click(screen.getByTestId("files-delete-confirm"));

    const alert = await screen.findByTestId("files-delete-error");
    expect(alert.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(alert.textContent).not.toContain("No delete permission");
    expect(screen.getByTestId("files-delete-dialog")).toBeTruthy();
    expect(screen.getByTestId("files-cloud-row-file-1")).toBeTruthy();
    expect(screen.getByTestId("files-cloud-selected")).toBeTruthy();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/does not have permission|没有执行此操作的权限/),
    );
    expect(toastError).not.toHaveBeenCalledWith("No delete permission");
  });

  test("locks the target row and prevents duplicate delete requests while pending", async () => {
    const get = vi.mocked(api.get);
    const remove = vi.mocked(api.delete);
    let resolveDelete: (value: unknown) => void = () => undefined;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") return { agents: [] };
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                ownerId: "user-1",
                canUse: true,
                canDelete: true,
                path: "output.txt",
                size: 12,
                mtime: new Date().toISOString(),
              },
            ],
            total: 1,
          },
        };
      }
      if (path === "/files/transfers") return { transfers: [] };
      throw new Error(`unexpected GET ${path}`);
    });
    remove.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );

    render(withQueryClient(<FilesPage />));
    fireEvent.click(await screen.findByTestId("files-cloud-more-file-1"));
    fireEvent.click(await screen.findByTestId("files-context-delete"));
    const confirm = screen.getByTestId("files-delete-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("files-cloud-more-file-1") as HTMLButtonElement).disabled).toBe(
      true,
    );
    resolveDelete({ success: true });
    await waitFor(() => expect(screen.queryByTestId("files-delete-dialog")).toBeNull());
  });

  test("cancels deletion without a request and hides delete for directories and shared files", async () => {
    const get = vi.mocked(api.get);
    const remove = vi.mocked(api.delete);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") return { agents: [] };
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "owned-file",
                ownerId: "user-1",
                canUse: true,
                canDelete: true,
                path: "inputs/owned.txt",
                size: 12,
                mtime: new Date().toISOString(),
              },
              {
                id: "shared-file",
                ownerId: "user-2",
                canUse: true,
                canDelete: false,
                path: "shared.txt",
                size: 8,
                mtime: new Date().toISOString(),
              },
            ],
            total: 2,
          },
        };
      }
      if (path === "/files/transfers") return { transfers: [] };
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));
    fireEvent.click(await screen.findByTestId("files-cloud-more-dir-inputs"));
    expect(await screen.findByTestId("files-context-copy")).toBeTruthy();
    expect(screen.queryByTestId("files-context-delete")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(await screen.findByTestId("files-cloud-more-shared-file"));
    expect(await screen.findByTestId("files-context-copy")).toBeTruthy();
    expect(screen.queryByTestId("files-context-delete")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByTestId("files-cloud-dir-inputs"));
    fireEvent.click(await screen.findByTestId("files-cloud-more-owned-file"));
    fireEvent.click(await screen.findByTestId("files-context-delete"));
    fireEvent.click(screen.getByText("common.cancel"));
    expect(screen.queryByTestId("files-delete-dialog")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  test("downloads a selected cluster file through the authenticated endpoint", async () => {
    const get = vi.mocked(api.get);
    const download = vi.mocked(downloadAuthedFile);
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries: [
            {
              name: "result.txt",
              kind: "file",
              size: 32,
              modifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/files/transfers") {
        return { transfers: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));
    fireEvent.click(await screen.findByTestId("files-cluster-download-result.txt"));

    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(download).toHaveBeenCalledWith(
      "/files/cluster/download?agentId=scheduler-slurm&siteId=Docker%20Slurm%20AIO&path=%2Fscratch%2Fme%2Finputs%2Fresult.txt",
      "result.txt",
    );
  });

  test("refreshes file panes when a transfer reaches a terminal state", async () => {
    const get = vi.mocked(api.get);
    let transferPolls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/netdrive/files") {
        return { success: true, data: { files: [], total: 0 } };
      }
      if (path.startsWith("/files/cluster")) {
        return { siteId: "Docker Slurm AIO", path: "/scratch/me/inputs", entries: [] };
      }
      if (path === "/files/transfers") {
        transferPolls += 1;
        return {
          transfers: [
            {
              id: "transfer-1",
              userId: "admin@example.com",
              direction: "cluster_to_cloud",
              source: "/scratch/me/inputs/result.txt",
              target: "uploads/result.txt",
              agentId: "scheduler-slurm",
              siteId: "Docker Slurm AIO",
              totalBytes: null,
              copiedBytes: transferPolls > 1 ? 32 : 0,
              state: transferPolls > 1 ? "succeeded" : "running",
              startedAt: "2026-06-10T00:00:00.000Z",
              finishedAt: transferPolls > 1 ? "2026-06-10T00:00:01.000Z" : null,
              error: null,
            },
          ],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<FilesPage />));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/netdrive/files"));
    const initialCloudCalls = get.mock.calls.filter((call) => call[0] === "/netdrive/files").length;
    const initialClusterCalls = get.mock.calls.filter((call) =>
      call[0].startsWith("/files/cluster"),
    ).length;

    await waitFor(
      () => {
        const cloudCalls = get.mock.calls.filter((call) => call[0] === "/netdrive/files").length;
        expect(cloudCalls).toBeGreaterThan(initialCloudCalls);
        const clusterCalls = get.mock.calls.filter((call) =>
          call[0].startsWith("/files/cluster"),
        ).length;
        expect(clusterCalls).toBeGreaterThan(initialClusterCalls);
      },
      { timeout: 4_000 },
    );
  }, 6_000);
});
