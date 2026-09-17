import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  getAuthState: vi.fn(),
  listSoftwareAccessRequests: vi.fn(),
  listSandboxAgentSecurityViews: vi.fn(),
  listSandboxMappingReviewQueue: vi.fn(),
}));

vi.mock("../../lib/auth", () => ({
  getAuthState: mocks.getAuthState,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../lib/api-client", () => ({
  api: { get: mocks.apiGet },
  listSoftwareAccessRequests: mocks.listSoftwareAccessRequests,
}));

vi.mock("../../lib/sandbox-client", () => ({
  listSandboxAgentSecurityViews: mocks.listSandboxAgentSecurityViews,
  listSandboxMappingReviewQueue: mocks.listSandboxMappingReviewQueue,
}));

import { OperationsAttentionCards } from "./OperationsAttentionCards";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OperationsAttentionCards", () => {
  test("aggregates platform approvals and alerts from governed sources", async () => {
    mocks.getAuthState.mockReturnValue({ role: "platform_admin" });
    mocks.listSoftwareAccessRequests.mockResolvedValue([{ id: "one" }, { id: "two" }]);
    mocks.listSandboxMappingReviewQueue.mockResolvedValue([{ mapping: { id: "mapping" } }]);
    mocks.listSandboxAgentSecurityViews.mockResolvedValue([
      { sandboxReadiness: "critical" },
      { sandboxReadiness: "degraded" },
      { sandboxReadiness: "ready" },
    ]);
    mocks.apiGet.mockImplementation((path: string) => {
      if (path.includes("quota-requests")) {
        return Promise.resolve({
          requests: [{ status: "pending" }, { status: "approved" }],
        });
      }
      return Promise.resolve({
        success: true,
        data: { outbox: { dead: 3 }, shadowDiffs: 4 },
      });
    });

    render(<OperationsAttentionCards />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("operations-approval-attention-software").textContent).toContain(
        "2",
      );
    });
    expect(screen.getByTestId("operations-approval-attention-storage").textContent).toContain("1");
    expect(screen.getByTestId("operations-approval-attention-accounts").textContent).toContain("1");
    expect(screen.getByTestId("operations-alert-attention-sandboxCritical").textContent).toContain(
      "1",
    );
    expect(screen.getByTestId("operations-alert-attention-authzDeadLetters").textContent).toContain(
      "3",
    );
    expect(screen.getByTestId("operations-alert-attention-authzDiffs").textContent).toContain("4");
  });

  test("keeps available counts when one source fails", async () => {
    mocks.getAuthState.mockReturnValue({ role: "platform_admin" });
    mocks.listSoftwareAccessRequests.mockRejectedValue(new Error("unavailable"));
    mocks.listSandboxMappingReviewQueue.mockResolvedValue([]);
    mocks.listSandboxAgentSecurityViews.mockResolvedValue([]);
    mocks.apiGet.mockImplementation((path: string) => {
      if (path.includes("quota-requests")) return Promise.resolve({ requests: [] });
      return Promise.resolve({ success: true, data: { outbox: { dead: 0 }, shadowDiffs: 0 } });
    });

    render(<OperationsAttentionCards />, { wrapper });

    await waitFor(() => {
      expect(screen.getAllByText("settings.operations.attention.partialFailure")).toHaveLength(1);
    });
    expect(screen.getByTestId("operations-approval-attention-storage").textContent).toContain("0");
  });

  test("limits an operator to sandbox readiness without treating unavailable admin sources as errors", async () => {
    mocks.getAuthState.mockReturnValue({ role: "operator" });
    mocks.listSandboxAgentSecurityViews.mockResolvedValue([
      { sandboxReadiness: "critical" },
      { sandboxReadiness: "ready" },
    ]);

    render(<OperationsAttentionCards />, { wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId("operations-alert-attention-sandboxCritical").textContent,
      ).toContain("1");
    });
    expect(mocks.listSandboxAgentSecurityViews).toHaveBeenCalledOnce();
    expect(mocks.listSoftwareAccessRequests).not.toHaveBeenCalled();
    expect(mocks.listSandboxMappingReviewQueue).not.toHaveBeenCalled();
    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(screen.queryByText("settings.operations.attention.partialFailure")).toBeNull();
  });
});
