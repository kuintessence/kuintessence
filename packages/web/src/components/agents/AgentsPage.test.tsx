import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import { AgentsPage } from "./AgentsPage";

const mocks = vi.hoisted(() => ({
  getAuthState: vi.fn(),
  isLocalMode: vi.fn(),
  useMeCapabilities: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "agents.countHint") return `${opts?.online} online · ${opts?.total} total`;
      return key;
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    search,
    to,
    ...props
  }: {
    children: ReactNode;
    params?: Record<string, string>;
    search?: Record<string, string>;
    to: string;
  }) => {
    const path = params?.agentId ? to.replace("$agentId", params.agentId) : to;
    const query = search ? new URLSearchParams(search).toString() : "";
    const href = query ? `${path}?${query}` : path;
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    get: vi.fn(),
  },
}));

vi.mock("../../lib/auth", () => ({ getAuthState: mocks.getAuthState }));
vi.mock("../../lib/local-mode", () => ({ isLocalMode: mocks.isLocalMode }));
vi.mock("../../lib/platform-capabilities", () => ({
  toCapabilitySet: (data: { capabilities?: string[] } | null) => new Set(data?.capabilities ?? []),
  useMeCapabilities: mocks.useMeCapabilities,
}));

function makeClientWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const agent = {
  agentId: "agent-1",
  siteName: "Slurm site",
  schedulerType: "slurm",
  schedulerVersion: "23",
  status: "online",
  lastHeartbeat: "2026-07-08T00:00:00.000Z",
  cpuUsagePercent: 12,
  memoryUsedMb: 1024,
  memoryTotalMb: 4096,
  queueDepth: 0,
  computeHealthStatus: "ready",
  computeHealthNodeCount: 1,
  computeHealthOperationalNodeCount: 1,
};

beforeEach(() => {
  mocks.getAuthState.mockReturnValue({ isAuthenticated: true });
  mocks.isLocalMode.mockReturnValue(false);
  mocks.useMeCapabilities.mockReturnValue({
    status: "ready",
    data: { capabilities: ["terminal.open"] },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentsPage", () => {
  test("surfaces agent list errors without rendering an empty inventory", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error("agents denied"));

    render(<AgentsPage />, { wrapper: makeClientWrapper().wrapper });

    await screen.findByTestId("agents-list-error");
    expect(screen.getByTestId("agents-list-error").textContent).not.toContain("agents denied");
    expect(screen.queryByTestId("agents-empty")).toBeNull();
    expect(screen.queryByTestId("agents-grid")).toBeNull();
    expect(screen.getByTestId("agents-count").textContent).toBe("0 online · 0 total");
  });

  test("clears stale SSH entrypoints after a list refetch error", async () => {
    let calls = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path !== "/agents") throw new Error(`unexpected GET ${path}`);
      calls += 1;
      if (calls > 1) throw new Error("agents denied");
      return { agents: [agent] };
    });
    const { client, wrapper } = makeClientWrapper();

    render(<AgentsPage />, { wrapper });

    await screen.findByTestId("agent-card-agent-1");
    expect(screen.getByTestId("agent-health-agent-1").textContent).toContain("1/1");
    expect(screen.getByTestId("agent-queue-depth-agent-1").textContent).toContain("0");
    expect(screen.getByTestId("agent-open-ssh-agent-1")).toHaveProperty(
      "href",
      "http://localhost:3000/agents/agent-1/ssh",
    );

    await client.invalidateQueries({ queryKey: ["agents-list"] });

    await screen.findByTestId("agents-list-error");
    expect(screen.getByTestId("agents-list-error").textContent).not.toContain("agents denied");
    expect(screen.queryByTestId("agent-card-agent-1")).toBeNull();
    expect(screen.queryByTestId("agent-open-ssh-agent-1")).toBeNull();
    expect(screen.getByTestId("agents-count").textContent).toBe("0 online · 0 total");
  });

  test("hides SSH entrypoints without the terminal capability", async () => {
    mocks.useMeCapabilities.mockReturnValue({
      status: "ready",
      data: { capabilities: [] },
    });
    vi.mocked(api.get).mockResolvedValueOnce({ agents: [agent] });

    render(<AgentsPage />, { wrapper: makeClientWrapper().wrapper });

    await screen.findByTestId("agent-card-agent-1");
    expect(screen.queryByTestId("agent-open-ssh-agent-1")).toBeNull();
  });

  test("opens the jobs list scoped to the selected Agent", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ agents: [agent] });

    render(<AgentsPage />, { wrapper: makeClientWrapper().wrapper });

    await screen.findByTestId("agent-card-agent-1");
    expect(screen.getByTestId("agent-view-jobs-agent-1")).toHaveProperty(
      "href",
      "http://localhost:3000/jobs?agentId=agent-1",
    );
  });

  test("shows local Agent status and queue without a remote SSH entrypoint", async () => {
    mocks.isLocalMode.mockReturnValue(true);
    vi.mocked(api.get).mockResolvedValueOnce({ agents: [{ ...agent, queueDepth: 3 }] });

    render(<AgentsPage />, { wrapper: makeClientWrapper().wrapper });

    await screen.findByTestId("agent-card-agent-1");
    expect(screen.getByTestId("agents-count").textContent).toBe("1 online · 1 total");
    expect(screen.getByTestId("agent-queue-depth-agent-1").textContent).toContain("3");
    expect(screen.queryByTestId("agent-open-ssh-agent-1")).toBeNull();
  });
});
