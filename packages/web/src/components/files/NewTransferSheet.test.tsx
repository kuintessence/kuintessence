import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import { NewTransferSheet } from "./NewTransferSheet";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {},
  api: { post: vi.fn() },
}));

vi.mock("./PathPickerSheet", () => ({
  PathPickerField: ({
    value,
    testId,
    mode,
    locations,
    onSelect,
  }: {
    value: string;
    testId: string;
    mode: "file" | "directory";
    locations: Array<"cloud" | "cluster">;
    onSelect: (selection: {
      location: "cloud" | "cluster";
      mode: "file" | "directory";
      path: string;
      id?: string;
      agentId?: string;
      siteId?: string;
      name?: string;
      size?: number;
    }) => void;
  }) => {
    const location = locations[0] ?? "cloud";
    const path =
      location === "cluster"
        ? mode === "directory"
          ? "/projects/new-root"
          : "/projects/new-root/input.txt"
        : mode === "directory"
          ? "users/me/uploads/"
          : "users/me/source.txt";
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={() =>
          onSelect({
            location,
            mode,
            path,
            ...(location === "cloud" ? { id: "cloud-a" } : {}),
            ...(location === "cluster"
              ? { agentId: "agent-a", siteId: "site-a", name: "input.txt", size: 16 }
              : {}),
          })
        }
      >
        {value || "empty"}
      </button>
    );
  },
}));

const agent = {
  agentId: "agent-a",
  siteName: "site-a",
  schedulerType: "slurm",
  schedulerVersion: "23",
  status: "online",
  lastHeartbeat: "2026-07-13T00:00:00.000Z",
  cpuUsagePercent: 1,
  memoryUsedMb: 1,
  memoryTotalMb: 2,
};

const cloudObjects = [
  {
    id: "cloud-a",
    userId: "user-a",
    key: "users/me/source.txt",
    size: 16,
    contentType: "text/plain",
    createdAt: "2026-07-13T00:00:00.000Z",
    modifiedAt: "2026-07-13T00:00:00.000Z",
    etag: "etag-a",
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("NewTransferSheet cluster context changes", () => {
  test("cannot be dismissed while a transfer creation request is pending", async () => {
    const request = deferred<unknown>();
    vi.mocked(api.post).mockImplementation(() => request.promise);
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();

    render(
      <NewTransferSheet
        open
        onOpenChange={onOpenChange}
        initialDirection="cloud_to_cluster"
        cloudObjects={cloudObjects}
        cloudListVerified
        cloudSelected="cloud-a"
        clusterAgent={agent}
        clusterPath="/scratch/old-root"
        clusterPathVerified
        clusterSelected={null}
        onCreated={onCreated}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByTestId("files-new-transfer-submit"));
    fireEvent.submit(screen.getByTestId("files-new-transfer-form"));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveProperty("disabled", true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    request.resolve({ id: "transfer-created" });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith({ id: "transfer-created" });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("clears a cluster target without replacing the cloud source", async () => {
    const baseProps = {
      open: true,
      onOpenChange: vi.fn(),
      initialDirection: "cloud_to_cluster" as const,
      cloudObjects,
      cloudListVerified: true,
      cloudSelected: "cloud-a",
      clusterAgent: agent,
      clusterPath: "/scratch/old-root",
      clusterPathVerified: true,
      clusterSelected: null,
      onCreated: vi.fn(),
    };
    const { rerender } = render(<NewTransferSheet {...baseProps} />);

    await waitFor(() =>
      expect(screen.getByTestId("files-new-transfer-target").textContent).toContain(
        "/scratch/old-root/",
      ),
    );
    expect(screen.getByTestId("files-new-transfer-source").textContent).toContain(
      "users/me/source.txt",
    );

    rerender(<NewTransferSheet {...baseProps} clusterPath="/projects/new-root" />);

    expect(await screen.findByTestId("files-new-transfer-cluster-context-invalid")).toBeTruthy();
    expect(screen.getByTestId("files-new-transfer-target").textContent).toBe("empty");
    expect(screen.getByTestId("files-new-transfer-source").textContent).toContain(
      "users/me/source.txt",
    );
    expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("files-new-transfer-target"));

    await waitFor(() =>
      expect(screen.queryByTestId("files-new-transfer-cluster-context-invalid")).toBeNull(),
    );
    expect(screen.getByTestId("files-new-transfer-target").textContent).toBe("/projects/new-root");
    expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", false);
  });

  test("clears a cluster source without replacing the cloud target", async () => {
    const baseProps = {
      open: true,
      onOpenChange: vi.fn(),
      initialDirection: "cluster_to_cloud" as const,
      cloudObjects,
      cloudListVerified: true,
      cloudSelected: "cloud-a",
      clusterAgent: agent,
      clusterPath: "/scratch/old-root",
      clusterPathVerified: true,
      clusterSelected: "README.md",
      onCreated: vi.fn(),
    };
    const { rerender } = render(<NewTransferSheet {...baseProps} />);

    await waitFor(() =>
      expect(screen.getByTestId("files-new-transfer-source").textContent).toContain(
        "/scratch/old-root/README.md",
      ),
    );
    expect(screen.getByTestId("files-new-transfer-target").textContent).toBe("users/me/");

    rerender(
      <NewTransferSheet {...baseProps} clusterPath="/projects/new-root" clusterSelected={null} />,
    );

    expect(await screen.findByTestId("files-new-transfer-cluster-context-invalid")).toBeTruthy();
    expect(screen.getByTestId("files-new-transfer-source").textContent).toBe(
      "files.transfer.pickClusterFilePlaceholder",
    );
    expect(screen.getByTestId("files-new-transfer-target").textContent).toBe("users/me/");
    expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("files-new-transfer-source"));

    await waitFor(() =>
      expect(screen.queryByTestId("files-new-transfer-cluster-context-invalid")).toBeNull(),
    );
    expect(screen.getByTestId("files-new-transfer-source").textContent).toBe(
      "/projects/new-root/input.txt",
    );
    expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", false);
  });

  test("clears a deleted cloud source without replacing the cluster target", async () => {
    const baseProps = {
      open: true,
      onOpenChange: vi.fn(),
      initialDirection: "cloud_to_cluster" as const,
      cloudObjects,
      cloudListVerified: true,
      cloudSelected: "cloud-a",
      clusterAgent: agent,
      clusterPath: "/scratch/target-root",
      clusterPathVerified: true,
      clusterSelected: null,
      onCreated: vi.fn(),
    };
    const { rerender } = render(<NewTransferSheet {...baseProps} />);

    await waitFor(() =>
      expect(screen.getByTestId("files-new-transfer-source").textContent).toContain(
        "users/me/source.txt",
      ),
    );
    expect(screen.getByTestId("files-new-transfer-target").textContent).toContain(
      "/scratch/target-root/",
    );

    rerender(<NewTransferSheet {...baseProps} cloudObjects={[]} cloudSelected={null} />);

    expect(await screen.findByTestId("files-new-transfer-cloud-context-invalid")).toBeTruthy();
    expect(screen.getByTestId("files-new-transfer-source").textContent).toBe(
      "files.transfer.pickCloudObjectPlaceholder",
    );
    expect(screen.getByTestId("files-new-transfer-target").textContent).toContain(
      "/scratch/target-root/",
    );
    expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", true);

    rerender(<NewTransferSheet {...baseProps} cloudSelected={null} />);
    fireEvent.click(screen.getByTestId("files-new-transfer-source"));

    await waitFor(() =>
      expect(screen.queryByTestId("files-new-transfer-cloud-context-invalid")).toBeNull(),
    );
    expect(screen.getByTestId("files-new-transfer-source").textContent).toBe("users/me/source.txt");
    expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", false);
  });

  test("preserves a cloud target prefix while NetDrive verification is unavailable", async () => {
    const baseProps = {
      open: true,
      onOpenChange: vi.fn(),
      initialDirection: "cluster_to_cloud" as const,
      cloudObjects,
      cloudListVerified: true,
      cloudSelected: "cloud-a",
      clusterAgent: agent,
      clusterPath: "/scratch/source-root",
      clusterPathVerified: true,
      clusterSelected: "README.md",
      onCreated: vi.fn(),
    };
    const { rerender } = render(<NewTransferSheet {...baseProps} />);

    await waitFor(() =>
      expect(screen.getByTestId("files-new-transfer-target").textContent).toBe("users/me/"),
    );

    rerender(<NewTransferSheet {...baseProps} cloudObjects={[]} cloudListVerified={false} />);

    expect(await screen.findByTestId("files-new-transfer-cloud-context-invalid")).toBeTruthy();
    expect(screen.getByTestId("files-new-transfer-target").textContent).toBe("users/me/");
    expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", true);

    rerender(<NewTransferSheet {...baseProps} cloudObjects={[]} />);

    await waitFor(() =>
      expect(screen.queryByTestId("files-new-transfer-cloud-context-invalid")).toBeNull(),
    );
    expect(screen.getByTestId("files-new-transfer-target").textContent).toBe("users/me/");
    expect(screen.getByTestId("files-new-transfer-submit")).toHaveProperty("disabled", false);
  });
});
