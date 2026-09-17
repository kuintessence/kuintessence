import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        return Object.entries(opts).reduce<string>(
          (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
          key,
        );
      }
      return key;
    },
  }),
}));

vi.mock("./CpAttentionCards", () => ({
  CpAttentionCards: () => <div data-testid="cp-attention-cards" />,
}));

import { CpDashboard } from "./CpDashboard";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.setItem("kq_token", "test-token");
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("CpDashboard", () => {
  test("renders KPI tiles from a successful dashboard fetch", async () => {
    const kpis = {
      windowFrom: "2026-04-30T00:00:00Z",
      windowTo: "2026-05-01T00:00:00Z",
      jobsCompleted: 17,
      jobsFailed: 4,
      bytesTransferred: 1024,
      queueDepthPeak: 11,
      agentsHealthy: 6,
      agentsSick: 2,
      agentsOffline: 1,
      topUsers: [
        {
          userId: "u-alice",
          jobs: 9,
          displayName: "alice",
          email: "alice@example.com",
          organizationName: "HPC Center",
        },
      ],
      topApps: [{ appKey: "gromacs", jobs: 9 }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ kpis }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    render(<CpDashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("cp-kpi-jobsCompleted-value").textContent).toBe("17");
    });
    expect(screen.getByTestId("cp-kpi-jobsFailed-value").textContent).toBe("4");
    expect(screen.getByTestId("cp-kpi-agentsHealthy-value").textContent).toBe("6");
    const reportingWindows = screen.getAllByText("cp.dashboard.kpi.period24Hours");
    expect(reportingWindows).toHaveLength(4);
    for (const reportingWindow of reportingWindows) {
      expect(reportingWindow.classList.contains("whitespace-nowrap")).toBe(true);
    }
    expect(screen.getByTestId("cp-top-users")).toBeTruthy();
    expect(screen.getByTestId("cp-top-apps")).toBeTruthy();
    expect(screen.getByTestId("cp-agents-health")).toBeTruthy();
    expect(screen.getByTestId("cp-agents-health-label-healthy").textContent).toContain("healthy");
    expect(screen.getByTestId("cp-agents-health-label-sick").textContent).toContain("sick");
    expect(screen.getByTestId("cp-agents-health-label-offline").textContent).toContain("offline");
    expect(screen.getByTestId("cp-attention-cards")).toBeTruthy();
  });

  test("renders error state when the dashboard fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "no scope" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    render(<CpDashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("cp-dashboard-error")).toBeTruthy();
    });
  });
});
