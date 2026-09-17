import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import { PathPickerSheet } from "./PathPickerSheet";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
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
    get: vi.fn(),
  },
}));

vi.mock("../../lib/netdrive-client", async () => {
  const { api } = await import("../../lib/api-client");
  return {
    listAllNetDriveFiles: () => api.get("/netdrive/files"),
  };
});

function renderWithClient(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  return client;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PathPickerSheet", () => {
  test("starts cluster browsing at the first authorized root", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: "2026-07-10T00:00:00.000Z",
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
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
      throw new Error(`unexpected GET ${path}`);
    });
    const onSelect = vi.fn();

    renderWithClient(
      <PathPickerSheet
        open
        onOpenChange={vi.fn()}
        mode="directory"
        locations={["cluster"]}
        title="Pick directory"
        description="Pick directory"
        onSelect={onSelect}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("path-picker-current").textContent).toBe("/projects/team-a"),
    );
    const clusterRequest = vi
      .mocked(api.get)
      .mock.calls.find((call) => call[0].startsWith("/files/cluster"));
    expect(new URL(clusterRequest?.[0] ?? "", "http://server.test").searchParams.has("path")).toBe(
      false,
    );
    expect(screen.getByTestId("path-picker-cluster-up")).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByTestId("path-picker-cluster-root-select"), {
      target: { value: "/scratch/team-a" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("path-picker-current").textContent).toBe("/scratch/team-a"),
    );
    expect(screen.getByTestId("path-picker-cluster-up")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("path-picker-cluster-current"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ location: "cluster", path: "/scratch/team-a" }),
    );
    expect(screen.queryByTestId("path-picker-confirm")).toBeNull();
  });

  test("rediscovers roots when the selected root is revoked", async () => {
    let revoked = false;
    let pathlessCalls = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: "2026-07-10T00:00:00.000Z",
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
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
          entries: [],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const onSelect = vi.fn();
    const client = renderWithClient(
      <PathPickerSheet
        open
        onOpenChange={vi.fn()}
        mode="directory"
        locations={["cluster"]}
        title="Pick directory"
        description="Pick directory"
        onSelect={onSelect}
      />,
    );

    fireEvent.change(await screen.findByTestId("path-picker-cluster-root-select"), {
      target: { value: "/scratch/team-a" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("path-picker-current").textContent).toBe("/scratch/team-a"),
    );

    revoked = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["files-cluster"] });
    });

    await waitFor(() =>
      expect(screen.getByTestId("path-picker-current").textContent).toBe("/projects/team-a"),
    );
    expect(screen.queryByTestId("path-picker-cluster-root-select")).toBeNull();
    fireEvent.click(screen.getByTestId("path-picker-cluster-current"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ location: "cluster", path: "/projects/team-a" }),
    );
    expect(pathlessCalls).toBe(2);
  });

  test("disables cloud file confirmation after NetDrive refetch fails", async () => {
    let cloudState: "ready" | "failed" = "ready";
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/netdrive/files") {
        if (cloudState === "failed") throw new Error("NetDrive scope denied");
        return {
          success: true,
          data: {
            files: [
              {
                id: "file-1",
                path: "inputs/source.txt",
                size: 18,
                mtime: "2026-07-10T00:00:00.000Z",
                canUse: true,
                canDelete: true,
              },
            ],
            total: 1,
          },
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const onSelect = vi.fn();
    const client = renderWithClient(
      <PathPickerSheet
        open
        onOpenChange={vi.fn()}
        mode="file"
        locations={["cloud"]}
        title="Pick file"
        description="Pick file"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(await screen.findByTestId("path-picker-cloud-dir-inputs"));
    fireEvent.click(await screen.findByTestId("path-picker-cloud-file-file-1"));
    expect(screen.getByTestId("path-picker-confirm")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("path-picker-confirm").textContent).toContain(
      "files.pathPicker.chooseFile",
    );

    cloudState = "failed";
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["files-cloud"] });
    });

    await waitFor(() =>
      expect(screen.getByTestId("path-picker-confirm")).toHaveProperty("disabled", true),
    );
    fireEvent.click(screen.getByTestId("path-picker-confirm"));

    expect(onSelect).not.toHaveBeenCalled();
  });

  test("disables cluster file confirmation after listing refetch drops the selected file", async () => {
    let includeFile = true;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/agents") {
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: "2026-07-10T00:00:00.000Z",
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path.startsWith("/files/cluster")) {
        return {
          siteId: "Docker Slurm AIO",
          path: "/scratch/me/inputs",
          entries: includeFile
            ? [
                {
                  name: "README.md",
                  kind: "file",
                  size: 32,
                  modifiedAt: "2026-07-10T00:00:00.000Z",
                },
              ]
            : [],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const onSelect = vi.fn();
    const client = renderWithClient(
      <PathPickerSheet
        open
        onOpenChange={vi.fn()}
        mode="file"
        locations={["cluster"]}
        initialClusterPath="/scratch/me/inputs"
        title="Pick file"
        description="Pick file"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(await screen.findByTestId("path-picker-cluster-file-README.md"));
    expect(screen.getByTestId("path-picker-confirm")).toHaveProperty("disabled", false);

    includeFile = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["files-cluster"] });
    });

    await waitFor(() =>
      expect(screen.getByTestId("path-picker-confirm")).toHaveProperty("disabled", true),
    );
    fireEvent.click(screen.getByTestId("path-picker-confirm"));

    expect(onSelect).not.toHaveBeenCalled();
  });

  test("keeps cloud directory confirmation available after an empty successful refetch", async () => {
    let includeFile = true;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: includeFile
              ? [
                  {
                    id: "file-1",
                    path: "uploads/source.txt",
                    size: 18,
                    mtime: "2026-07-10T00:00:00.000Z",
                    canUse: true,
                    canDelete: true,
                  },
                ]
              : [],
            total: includeFile ? 1 : 0,
          },
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const onSelect = vi.fn();
    const client = renderWithClient(
      <PathPickerSheet
        open
        onOpenChange={vi.fn()}
        mode="directory"
        locations={["cloud"]}
        initialCloudPrefix="uploads/"
        title="Pick directory"
        description="Pick directory"
        onSelect={onSelect}
      />,
    );

    expect(await screen.findByTestId("path-picker-cloud-current")).toHaveProperty(
      "disabled",
      false,
    );

    includeFile = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["files-cloud"] });
    });

    await waitFor(() =>
      expect(screen.getByTestId("path-picker-cloud-current")).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByTestId("path-picker-cloud-current"));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        location: "cloud",
        mode: "directory",
        path: "uploads/",
      }),
    );
  });

  test("shows view-only cloud files without allowing file selection", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/netdrive/files") {
        return {
          success: true,
          data: {
            files: [
              {
                id: "view-only-file",
                path: "shared.txt",
                size: 18,
                mtime: "2026-07-10T00:00:00.000Z",
                canUse: false,
                canDelete: false,
              },
            ],
            total: 1,
          },
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const onSelect = vi.fn();

    renderWithClient(
      <PathPickerSheet
        open
        onOpenChange={vi.fn()}
        mode="file"
        locations={["cloud"]}
        title="Pick file"
        description="Pick file"
        onSelect={onSelect}
      />,
    );

    const row = await screen.findByTestId("path-picker-cloud-file-view-only-file");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("files.viewOnly");
    fireEvent.click(row);

    expect(screen.getByTestId("path-picker-confirm")).toHaveProperty("disabled", true);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
