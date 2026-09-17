import type { StorageQuotaSummary } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import { StorageQuotaRequestDialog } from "./StorageQuotaRequestDialog";

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {},
  api: { get: vi.fn(), post: vi.fn() },
}));

const summary: StorageQuotaSummary = {
  scope: "cloud",
  scopeId: "global",
  usedBytes: 1024,
  quotaBytes: 2048,
  availableBytes: 1024,
  usagePercent: 50,
  fileCount: 1,
  uploadedBytes30d: 0,
  downloadedBytes30d: 0,
  storedByteHours30d: 0,
  policy: {
    defaultQuotaBytes: 2048,
    maxQuotaBytes: null,
    requestMode: "manual",
    autoApproveLimitBytes: null,
  },
  activeGrant: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function withQueryClient(children: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("StorageQuotaRequestDialog", () => {
  test("does not present missing quota data as zero and allows an explicit retry", () => {
    vi.mocked(api.get).mockResolvedValue({ requests: [] });
    const onRetrySummary = vi.fn();

    render(
      withQueryClient(
        <StorageQuotaRequestDialog
          open
          onOpenChange={() => undefined}
          summary={null}
          summaryError="Server unavailable"
          onRetrySummary={onRetrySummary}
        />,
      ),
    );

    expect(screen.getByText("files.quota.summaryLoadFailed")).toBeTruthy();
    expect(screen.queryByText("0 KB")).toBeNull();
    fireEvent.click(screen.getAllByText("common.retry")[0] as HTMLElement);
    expect(onRetrySummary).toHaveBeenCalledOnce();
    expect(screen.getByText("files.quota.submit")).toHaveProperty("disabled", true);
  });

  test("shows a retryable history error instead of an empty history", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error("history failed")).mockResolvedValueOnce({
      requests: [],
    });

    render(
      withQueryClient(
        <StorageQuotaRequestDialog open onOpenChange={() => undefined} summary={summary} />,
      ),
    );

    expect(await screen.findByText("files.quota.historyLoadFailed")).toBeTruthy();
    expect(screen.queryByText("files.quota.noRequests")).toBeNull();
    fireEvent.click(screen.getByText("common.retry"));
    expect(await screen.findByText("files.quota.noRequests")).toBeTruthy();
  });

  test("prevents duplicate submission and dismissal while the request is pending", async () => {
    vi.mocked(api.get).mockResolvedValue({ requests: [] });
    const request = deferred<unknown>();
    vi.mocked(api.post).mockImplementation(() => request.promise);
    const onOpenChange = vi.fn();

    render(
      withQueryClient(
        <StorageQuotaRequestDialog open onOpenChange={onOpenChange} summary={summary} />,
      ),
    );

    fireEvent.change(screen.getByLabelText("files.quota.requestedGb"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("files.quota.reason"), {
      target: { value: "experiment outputs" },
    });
    const submit = screen.getByText("files.quota.submit");
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(api.post).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Close" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    request.resolve({ ok: true });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("files.quota.requestCreated"));
  });
});
