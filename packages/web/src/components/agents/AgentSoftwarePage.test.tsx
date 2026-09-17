import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentSoftwarePage } from "./AgentSoftwarePage";

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
  localStorage.setItem("kq.lang", "zh");
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("AgentSoftwarePage", () => {
  test("renders empty state when API returns no rows", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentSoftwarePage agentId="agent-x" />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("agent-software-empty")).toBeDefined();
    });
    expect(screen.getByTestId("agent-software-count").textContent).toContain("0");
  });

  test("renders rows when API returns installed specs", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                name: "gromacs",
                version: "2024.1",
                hash: "abcdef1234567890",
                compiler: "gcc@13.2.0",
                spec: "gromacs@2024.1%gcc@13.2.0",
                reportedAt: "2026-04-30T00:00:00Z",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentSoftwarePage agentId="agent-x" />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("agent-software-table")).toBeDefined();
    });
    expect(screen.getByText("gromacs")).toBeDefined();
    expect(screen.getByText("gcc@13.2.0")).toBeDefined();
  });

  test("renders a friendly error without exposing the API permission detail", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "FORBIDDEN", message: "Need org_admin or above" } }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentSoftwarePage agentId="agent-x" />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("agent-software-error")).toBeDefined();
    });
    expect(screen.getByTestId("agent-software-error").textContent).toContain(
      "没有执行此操作的权限",
    );
    expect(screen.getByTestId("agent-software-error").textContent).not.toContain("org_admin");
    expect(screen.getByTestId("agent-software-error").textContent).not.toContain("FORBIDDEN");
  });
});
