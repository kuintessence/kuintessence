import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const apiGet = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

vi.mock("../../lib/api-client", () => ({
  api: { get: apiGet },
}));

import { AuditLogPanel } from "./AuditLogPanel";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("AuditLogPanel", () => {
  test("loads the global audit feed and supports an explicit refresh", async () => {
    apiGet.mockResolvedValue({
      entries: [
        {
          id: "audit-1",
          actor: "operator@example.com",
          action: "job.submit",
          target: "job-1",
          createdAt: "2026-08-11T00:00:00.000Z",
        },
      ],
    });

    render(<AuditLogPanel />, { wrapper });

    expect(await screen.findByTestId("events-list")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith("/audit-log?limit=100");

    fireEvent.click(screen.getByTestId("platform-audit-refresh"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  test("shows a stable error instead of an empty audit feed", async () => {
    apiGet.mockRejectedValue(new Error("audit unavailable"));

    render(<AuditLogPanel />, { wrapper });

    const error = await screen.findByTestId("platform-audit-error");
    expect(error.textContent).toContain("settings.operations.auditLog.loadFailed");
    expect(error.textContent).not.toContain("audit unavailable");
    expect(screen.queryByTestId("events-empty")).toBeNull();
  });
});
