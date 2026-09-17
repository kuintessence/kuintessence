import type { Transfer } from "@kuintessence/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TransfersTray } from "./TransfersTray";

const postMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    post: postMock,
  },
}));

vi.mock("sonner", () => ({
  toast: { error: toastErrorMock },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseTransfer = {
  id: "transfer-1",
  userId: "user-1",
  source: "inputs/a.dat",
  target: "/scratch/a.dat",
  agentId: "agent-1",
  siteId: "site-1",
  totalBytes: 1,
  copiedBytes: 0,
  state: "failed",
  startedAt: null,
  finishedAt: "2026-07-08T00:00:00.000Z",
  error: "failed",
} satisfies Omit<Transfer, "direction">;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("TransfersTray", () => {
  afterEach(() => {
    postMock.mockReset();
    toastErrorMock.mockReset();
  });

  test("does not offer cloud-to-cluster retry without a canonical source file id", async () => {
    render(
      <TransfersTray
        transfers={[{ ...baseTransfer, direction: "cloud_to_cluster" }]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    await waitFor(() => {
      expect(screen.queryByTestId("files-transfer-retry-transfer-1")).toBeNull();
    });
  });

  test("shows a retryable error instead of presenting a failed transfer query as empty", () => {
    const onRetryLoad = vi.fn();

    render(
      <TransfersTray
        transfers={[]}
        loadError="Server unavailable"
        onRetryLoad={onRetryLoad}
        onChanged={() => undefined}
        embedded
      />,
    );

    expect(screen.getByTestId("files-transfers-load-error")).toBeTruthy();
    expect(screen.queryByText("files.transfers.emptyFilter")).toBeNull();
    fireEvent.click(screen.getByText("files.transfers.retryLoad"));
    expect(onRetryLoad).toHaveBeenCalledOnce();
  });

  test("shows loading instead of an empty state during the initial transfer query", () => {
    render(<TransfersTray transfers={[]} isLoading onChanged={() => undefined} embedded />);

    expect(screen.getByTestId("files-transfers-loading")).toBeTruthy();
    expect(screen.queryByText("files.transfers.emptyFilter")).toBeNull();
  });

  test("reports cancel failures and prevents duplicate cancel requests", async () => {
    const request = deferred<Transfer>();
    postMock.mockImplementation(() => request.promise);
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            state: "running",
            finishedAt: null,
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    const cancel = screen.getByTestId("files-transfer-cancel-transfer-1");
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(postMock).toHaveBeenCalledOnce();
    expect(cancel).toHaveProperty("disabled", true);

    request.reject(new Error("network down"));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("files.transfers.cancelFailed");
      expect(cancel).toHaveProperty("disabled", false);
    });
  });

  test("prevents duplicate retry requests while one retry is pending", async () => {
    const sourceFileId = "00000000-0000-4000-8000-000000000111";
    const request = deferred<Transfer>();
    const refresh = deferred<void>();
    postMock.mockImplementation(() => request.promise);
    const onChanged = vi.fn(() => refresh.promise);
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cloud_to_cluster",
            sourceFileId,
          },
        ]}
        onChanged={onChanged}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));
    const retry = await screen.findByTestId("files-transfer-retry-transfer-1");
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(postMock).toHaveBeenCalledOnce();
    expect(retry).toHaveProperty("disabled", true);

    request.resolve({
      ...baseTransfer,
      direction: "cloud_to_cluster",
      sourceFileId,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(retry).toHaveProperty("disabled", true);
    fireEvent.click(retry);
    expect(postMock).toHaveBeenCalledOnce();

    refresh.resolve();
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
  });

  test("keeps retry available for cluster-to-cloud transfers", async () => {
    const outputFileId = "00000000-0000-4000-8000-000000000112";
    postMock.mockResolvedValue({
      ...baseTransfer,
      direction: "cluster_to_cloud",
    } satisfies Transfer);
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            netdriveFileIds: [outputFileId],
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    await waitFor(() => {
      expect(screen.getByTestId("files-transfer-retry-transfer-1")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("files-transfer-retry-transfer-1"));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith("/files/transfers", {
        direction: "cluster_to_cloud",
        source: "inputs/a.dat",
        target: "/scratch/a.dat",
        agentId: "agent-1",
        siteId: "site-1",
        totalBytes: 1,
      });
    });
  });

  test("retries cloud-to-cluster transfers when the canonical source file id is persisted", async () => {
    const sourceFileId = "00000000-0000-4000-8000-000000000111";
    postMock.mockResolvedValue({
      ...baseTransfer,
      direction: "cloud_to_cluster",
      sourceFileId,
      netdriveFileIds: [sourceFileId],
    } satisfies Transfer);
    const onChanged = vi.fn();

    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cloud_to_cluster",
            sourceFileId,
            netdriveFileIds: [sourceFileId],
          },
        ]}
        onChanged={onChanged}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));
    fireEvent.click(await screen.findByTestId("files-transfer-retry-transfer-1"));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith("/files/transfers", {
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/a.dat",
        agentId: "agent-1",
        siteId: "site-1",
        totalBytes: 1,
        sourceFileId,
      });
      expect(onChanged).toHaveBeenCalled();
    });
  });

  test("reports a synchronous retry rejection instead of leaving it unhandled", async () => {
    const sourceFileId = "00000000-0000-4000-8000-000000000111";
    postMock.mockRejectedValue(new Error("source changed"));

    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cloud_to_cluster",
            sourceFileId,
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));
    fireEvent.click(await screen.findByTestId("files-transfer-retry-transfer-1"));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("files.transfer.startFailed");
    });
  });

  test("renders interrupted restart errors as user-facing copy", async () => {
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            error: "TRANSFER_INTERRUPTED_BY_SERVER_RESTART",
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(
      await screen.findByText("files.transfers.error.interruptedByServerRestart"),
    ).toBeTruthy();
    expect(screen.queryByTitle("TRANSFER_INTERRUPTED_BY_SERVER_RESTART")).toBeNull();
  });

  test("renders missing cluster source errors as user-facing copy", async () => {
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            error: "CLUSTER_SOURCE_FILE_UNAVAILABLE",
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(await screen.findByText("files.transfers.error.clusterSourceUnavailable")).toBeTruthy();
    expect(screen.queryByTitle("CLUSTER_SOURCE_FILE_UNAVAILABLE")).toBeNull();
  });

  test("renders cluster target preflight errors as user-facing copy", async () => {
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cloud_to_cluster",
            error: "CLUSTER_TARGET_DIR_NOT_WRITABLE",
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(
      await screen.findByText("files.transfers.error.clusterTargetDirNotWritable"),
    ).toBeTruthy();
    expect(screen.queryByTitle("CLUSTER_TARGET_DIR_NOT_WRITABLE")).toBeNull();
  });

  test("renders unavailable transfer preflight errors as user-facing copy", async () => {
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            error: "CLUSTER_TRANSFER_PREFLIGHT_UNAVAILABLE",
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(
      await screen.findByText("files.transfers.error.clusterTransferPreflightUnavailable"),
    ).toBeTruthy();
    expect(screen.queryByTitle("CLUSTER_TRANSFER_PREFLIGHT_UNAVAILABLE")).toBeNull();
  });

  test("renders legacy raw cluster target permission errors as user-facing copy", async () => {
    const rawError =
      "mkdir: cannot create directory '/scratch': Permission denied curl: (23) Failed writing body (0 != 16384)";
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cloud_to_cluster",
            error: rawError,
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(
      await screen.findByText("files.transfers.error.clusterTargetDirNotWritable"),
    ).toBeTruthy();
    expect(screen.queryByTitle(rawError)).toBeNull();
    expect(screen.queryByText(/Permission denied|Failed writing body|curl/)).toBeNull();
  });

  test("renders invalid NetDrive source errors as user-facing copy", async () => {
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cloud_to_cluster",
            error: "NETDRIVE_SOURCE_FILE_UNAVAILABLE",
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(await screen.findByText("files.transfers.error.netdriveSourceUnavailable")).toBeTruthy();
    expect(screen.queryByTitle("NETDRIVE_SOURCE_FILE_UNAVAILABLE")).toBeNull();
  });

  test("renders execution-time root revocation and does not offer retry", async () => {
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            error: "TRANSFER_ROOT_AUTHORIZATION_REVOKED",
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(await screen.findByText("files.transfers.error.rootAuthorizationRevoked")).toBeTruthy();
    expect(screen.queryByTestId("files-transfer-retry-transfer-1")).toBeNull();
  });

  test("warns about a running root policy change and blocks retry after failure", async () => {
    const changedAt = "2026-07-13T01:00:00.000Z";
    const { rerender } = render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            state: "running",
            finishedAt: null,
            rootPolicyChangedAt: changedAt,
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    expect(
      await screen.findByTestId("files-transfer-badge-root-policy-changed-transfer-1"),
    ).toBeTruthy();
    expect(screen.getByText("files.transfers.rootPolicyChanged")).toBeTruthy();

    rerender(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            rootPolicyChangedAt: changedAt,
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );
    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));
    expect(screen.queryByTestId("files-transfer-retry-transfer-1")).toBeNull();
  });

  test("renders legacy raw missing-source errors as user-facing copy", async () => {
    const rawError = "ENOENT: no such file or directory, statx '/scratch/me/inputs/README.md'";
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            direction: "cluster_to_cloud",
            error: rawError,
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(await screen.findByText("files.transfers.error.clusterSourceUnavailable")).toBeTruthy();
    expect(screen.queryByTitle(rawError)).toBeNull();
  });

  test("orders failed transfers by interrupted and retryable triage", async () => {
    render(
      <TransfersTray
        transfers={[
          {
            ...baseTransfer,
            id: "transfer-plain",
            direction: "cloud_to_cluster",
            error: "plain failure",
          },
          {
            ...baseTransfer,
            id: "transfer-retryable",
            direction: "cloud_to_cluster",
            sourceFileId: "00000000-0000-4000-8000-000000000111",
            error: "retryable failure",
          },
          {
            ...baseTransfer,
            id: "transfer-interrupted",
            direction: "cluster_to_cloud",
            error: "TRANSFER_INTERRUPTED_BY_SERVER_RESTART",
          },
        ]}
        onChanged={() => undefined}
        embedded
      />,
    );

    fireEvent.click(screen.getByTestId("files-transfers-filter-failed"));

    expect(
      await screen.findByTestId("files-transfer-badge-interrupted-transfer-interrupted"),
    ).toBeTruthy();
    expect(screen.getByTestId("files-transfer-badge-retryable-transfer-interrupted")).toBeTruthy();
    expect(screen.getByTestId("files-transfer-badge-retryable-transfer-retryable")).toBeTruthy();
    expect(screen.queryByTestId("files-transfer-badge-retryable-transfer-plain")).toBeNull();
    expect(
      screen
        .getAllByTestId(/^files-transfer-transfer-/)
        .map((item) => item.getAttribute("data-testid")),
    ).toEqual([
      "files-transfer-transfer-interrupted",
      "files-transfer-transfer-retryable",
      "files-transfer-transfer-plain",
    ]);
  });
});
