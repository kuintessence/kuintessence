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

describe("quota request validation and history scope", () => {
  test.each([
    ["0.5", null, "", "files.quota.formIncomplete"],
    ["1000000000", null, "", "files.quota.formIncomplete"],
    ["3", 2 * 1024 ** 3, "", "files.quota.exceedsLimit"],
    ["1", null, "2000-01-01T00:00", "files.quota.expiryMustBeFuture"],
  ] as const)("rejects invalid quota %s with limit %s and expiry %s", async (quota, limit, expiry, message) => {
    vi.mocked(api.get).mockResolvedValue({ requests: [] });
    render(
      withQueryClient(
        <StorageQuotaRequestDialog
          open
          onOpenChange={vi.fn()}
          summary={{ ...summary, policy: { ...summary.policy, maxQuotaBytes: limit } }}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText("files.quota.requestedGb"), {
      target: { value: quota },
    });
    fireEvent.change(screen.getByLabelText("files.quota.reason"), {
      target: { value: "Research outputs" },
    });
    if (expiry)
      fireEvent.change(screen.getByLabelText("files.quota.expiresAt"), {
        target: { value: expiry },
      });
    fireEvent.click(screen.getByText("files.quota.submit"));
    expect(api.post).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(message);
  });

  test("submits a valid future expiry as UTC and allows the policy limit", async () => {
    vi.mocked(api.get).mockResolvedValue({ requests: [] });
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    render(
      withQueryClient(
        <StorageQuotaRequestDialog
          open
          onOpenChange={vi.fn()}
          summary={{ ...summary, policy: { ...summary.policy, maxQuotaBytes: 2 * 1024 ** 3 } }}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText("files.quota.requestedGb"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("files.quota.reason"), {
      target: { value: " Research outputs " },
    });
    fireEvent.change(screen.getByLabelText("files.quota.expiresAt"), {
      target: { value: "2099-01-01T12:00" },
    });
    fireEvent.click(screen.getByText("files.quota.submit"));
    expect(api.post).toHaveBeenCalledWith("/storage/quota-requests", {
      scope: "cloud",
      scopeId: "global",
      requestedQuotaBytes: 2 * 1024 ** 3,
      requestedExpiresAt: new Date("2099-01-01T12:00").toISOString(),
      reason: "Research outputs",
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  test.each([
    true,
    false,
  ])("shows only global cloud history when a cloud request exists: %s", async (hasCloud) => {
    const row = {
      requestedQuotaBytes: 1024 ** 3,
      requestedExpiresAt: null,
      status: "pending",
      createdAt: "2026-10-08T00:00:00Z",
    };
    vi.mocked(api.get).mockResolvedValue({
      requests: [
        ...Array.from({ length: 6 }, (_, index) => ({
          ...row,
          id: `cluster-${index}`,
          scope: "cluster_root",
          scopeId: "/scratch",
          reason: `Cluster request ${index}`,
        })),
        ...(hasCloud
          ? [{ ...row, id: "cloud", scope: "cloud", scopeId: "global", reason: "Cloud request" }]
          : []),
      ],
    });
    render(
      withQueryClient(<StorageQuotaRequestDialog open onOpenChange={vi.fn()} summary={summary} />),
    );
    if (hasCloud) expect(await screen.findByText("Cloud request")).toBeTruthy();
    else expect(await screen.findByText("files.quota.noRequests")).toBeTruthy();
    expect(screen.queryByText("Cluster request 0")).toBeNull();
  });
});
