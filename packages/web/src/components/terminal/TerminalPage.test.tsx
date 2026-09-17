import type { TerminalSession } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import { TerminalPage } from "./TerminalPage";

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "terminal.activeCount") return `${opts?.count} active sessions`;
      return key;
    },
  }),
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 100;
    rows = 28;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
    dispose = vi.fn();
  }
  return { Terminal };
});

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
  }
  return { FitAddon };
});

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function withQueryClient(children: ReactNode) {
  const client = makeQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mockEmptyPage() {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/terminal/sessions") return { sessions: [] };
    if (path === "/agents") {
      return {
        agents: [
          {
            agentId: "scheduler-slurm",
            siteName: "Docker Slurm AIO",
            schedulerType: "slurm",
            schedulerVersion: "23",
            status: "online",
            lastHeartbeat: new Date().toISOString(),
            cpuUsagePercent: 1,
            memoryUsedMb: 1,
            memoryTotalMb: 2,
          },
        ],
      };
    }
    if (path === "/sandbox/account-mappings") return { success: true, data: [makeMapping()] };
    throw new Error(`unexpected GET ${path}`);
  });
}

function makeSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "session-1",
    userId: "admin@example.com",
    siteId: "Docker Slurm AIO",
    agentId: "scheduler-slurm",
    remoteUser: "me",
    authMethod: "key",
    state: "open",
    cols: 120,
    rows: 32,
    openedAt: new Date().toISOString(),
    closedAt: null,
    bytesIn: 0,
    bytesOut: 0,
    reason: null,
    ...overrides,
  };
}

function makeMapping(agentId = "scheduler-slurm") {
  return {
    mapping: {
      id: `mapping-${agentId}`,
      userId: "user-1",
      accountId: `account-${agentId}`,
      status: "approved",
      isDefault: true,
      requestedAt: new Date().toISOString(),
      expiresAt: null,
    },
    account: {
      id: `account-${agentId}`,
      providerOrgId: "provider-1",
      agentId,
      displayName: "Research account",
      backendType: "unix",
      username: "me",
      schedulerAccount: "science",
      allowedQueues: ["normal"],
      namespace: null,
      serviceAccount: null,
      enabled: true,
    },
  };
}

describe("TerminalPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("labels the page as a command console and links live SSH to Agents", async () => {
    mockEmptyPage();

    render(withQueryClient(<TerminalPage />));

    expect((await screen.findByTestId("terminal-mode-badge")).textContent).toContain(
      "terminal.mode",
    );
    expect(screen.getByTestId("terminal-live-ssh-link").getAttribute("href")).toBe("/agents");
    expect(screen.getByTestId("terminal-empty").textContent).toContain("terminal.emptyHint");
  });

  test("surfaces command session list errors without rendering an empty page", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/terminal/sessions") throw new Error("session list denied");
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<TerminalPage />));

    await screen.findByTestId("terminal-sessions-error");
    expect(screen.getByTestId("terminal-sessions-error").textContent).not.toContain(
      "session list denied",
    );
    expect(screen.queryByTestId("terminal-empty")).toBeNull();
    expect(screen.getByTestId("terminal-open-shell")).toHaveProperty("disabled", true);
  });

  test("opens a command session without collecting unused credentials", async () => {
    mockEmptyPage();
    vi.mocked(api.post).mockResolvedValue(makeSession());

    render(withQueryClient(<TerminalPage />));

    fireEvent.click(screen.getByTestId("terminal-open-shell"));
    await screen.findByTestId("terminal-new-session");
    expect(screen.queryByTestId("terminal-secret-input")).toBeNull();
    expect(screen.queryByTestId("terminal-auth-password")).toBeNull();

    expect((await screen.findByTestId("terminal-user-select")).textContent).toContain(
      "Research account",
    );
    fireEvent.click(screen.getByTestId("terminal-open-submit"));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith("/terminal/sessions", {
      siteId: "Docker Slurm AIO",
      agentId: "scheduler-slurm",
      remoteUser: "me",
      authMethod: "key",
    });
  });

  test("clears stale command session actions after a session list refetch error", async () => {
    let sessionCalls = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/terminal/sessions") {
        sessionCalls += 1;
        if (sessionCalls > 1) throw new Error("session list denied");
        return { sessions: [makeSession()] };
      }
      if (path === "/agents") return { agents: [] };
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.post).mockResolvedValue({ output: "ready\n", session: makeSession() });
    const client = makeQueryClient();

    render(
      <QueryClientProvider client={client}>
        <TerminalPage />
      </QueryClientProvider>,
    );

    await screen.findByTestId("terminal-tab-session-1");
    expect(screen.getByTestId("terminal-pane")).toBeTruthy();

    await client.invalidateQueries({ queryKey: ["terminal-sessions"] });

    await screen.findByTestId("terminal-sessions-error");
    expect(screen.getByTestId("terminal-sessions-error").textContent).not.toContain(
      "session list denied",
    );
    expect(screen.queryByTestId("terminal-tab-session-1")).toBeNull();
    expect(screen.queryByTestId("terminal-tab-close-session-1")).toBeNull();
    expect(screen.queryByTestId("terminal-pane")).toBeNull();
    expect(api.delete).not.toHaveBeenCalled();
  });

  test("disables command session creation after an Agent list refetch error", async () => {
    let agentCalls = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/terminal/sessions") return { sessions: [] };
      if (path === "/agents") {
        agentCalls += 1;
        if (agentCalls > 1) throw new Error("agent list denied");
        return {
          agents: [
            {
              agentId: "scheduler-slurm",
              siteName: "Docker Slurm AIO",
              schedulerType: "slurm",
              schedulerVersion: "23",
              status: "online",
              lastHeartbeat: new Date().toISOString(),
              cpuUsagePercent: 1,
              memoryUsedMb: 1,
              memoryTotalMb: 2,
            },
          ],
        };
      }
      if (path === "/sandbox/account-mappings") {
        return { success: true, data: [makeMapping()] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const client = makeQueryClient();

    render(
      <QueryClientProvider client={client}>
        <TerminalPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("terminal-open-shell"));
    await screen.findByTestId("terminal-agent-select");
    await screen.findByTestId("terminal-user-select");

    await client.invalidateQueries({ queryKey: ["agents-list"] });

    await screen.findByTestId("terminal-agents-error");
    expect(screen.getByTestId("terminal-agents-error").textContent).not.toContain(
      "agent list denied",
    );
    expect(screen.queryByTestId("terminal-agent-select")).toBeNull();
    expect(screen.getByTestId("terminal-open-submit")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("terminal-open-submit"));

    expect(api.post).not.toHaveBeenCalled();
  });

  test("keeps every session pane mounted while switching tabs", async () => {
    const second = makeSession({
      id: "session-2",
      siteId: "Docker PBS AIO",
      agentId: "scheduler-pbs",
    });
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/terminal/sessions") return { sessions: [makeSession(), second] };
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<TerminalPage />));

    const firstPanel = await screen.findByTestId("terminal-panel-session-1");
    const secondPanel = screen.getByTestId("terminal-panel-session-2");
    expect(firstPanel).toHaveProperty("hidden", false);
    expect(secondPanel).toHaveProperty("hidden", true);

    fireEvent.click(screen.getByTestId("terminal-tab-session-2"));

    expect(firstPanel).toHaveProperty("hidden", true);
    expect(secondPanel).toHaveProperty("hidden", false);
    expect(screen.getAllByTestId("terminal-pane")).toHaveLength(2);
  });
});
