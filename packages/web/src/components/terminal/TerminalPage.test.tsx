import type { TerminalAuditFrame, TerminalSession } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import { AuditDrawer } from "./AuditDrawer";
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

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

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

function withQueryClient(children: ReactNode, client = makeQueryClient()) {
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

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("TerminalPage", () => {
  test("labels the page as a command console and links live SSH to Agents", async () => {
    mockEmptyPage();

    render(withQueryClient(<TerminalPage />));

    expect((await screen.findByTestId("terminal-mode-badge")).textContent).toContain(
      "terminal.mode",
    );
    expect(screen.getByTestId("terminal-live-ssh-link").getAttribute("href")).toBe("/agents");
    expect((await screen.findByTestId("terminal-empty")).textContent).toContain(
      "terminal.emptyHint",
    );
  });

  test("surfaces command session list errors without rendering an empty page", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/terminal/sessions") throw new Error("session list denied");
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<TerminalPage />));

    await screen.findByTestId("terminal-sessions-error");
    expect(screen.queryByText("0 active sessions")).toBeNull();
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

  test("keeps the active session on a close failure from either close control", async () => {
    const sessions = [makeSession(), makeSession({ id: "session-2", siteId: "Second site" })];
    vi.mocked(api.get).mockResolvedValue({ sessions });
    vi.mocked(api.delete).mockRejectedValue(new Error("unavailable"));
    render(withQueryClient(<TerminalPage />));
    const tab = await screen.findByTestId("terminal-tab-session-2");
    fireEvent.click(tab);
    fireEvent.click(screen.getByTestId("terminal-tab-close-session-2"));
    await screen.findByTestId("terminal-close-error-session-2");
    expect(tab.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(
      within(screen.getByTestId("terminal-panel-session-2")).getByTestId("terminal-close"),
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("terminal-close-error-session-2")).toBeTruthy();
  });

  test("only enables audit export after a successful read with frames", async () => {
    let available = false;
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === "/terminal/sessions") return { sessions: [makeSession()] };
      if (path.endsWith("/audit") && available) {
        return { frames: [{ kind: "stderr", ts: "2026-11-20T00:00:00Z", data: "警告\n详细信息" }] };
      }
      throw new Error("offline");
    });
    render(withQueryClient(<TerminalPage />));
    fireEvent.click(await screen.findByTestId("terminal-open-audit"));
    const drawer = within(await screen.findByTestId("terminal-audit-drawer"));
    await drawer.findByRole("alert");
    expect(drawer.queryByTestId("terminal-audit-summary")).toBeNull();
    expect(drawer.getByTestId("terminal-audit-export")).toHaveProperty("disabled", true);
    available = true;
    fireEvent.click(drawer.getByRole("button", { name: "common.retry" }));
    await drawer.findByText("警告");
    expect(drawer.getByTestId("terminal-audit-export")).toHaveProperty("disabled", false);
    fireEvent.change(drawer.getByRole("searchbox"), { target: { value: "missing" } });
    fireEvent.click(drawer.getByRole("button", { name: "terminal.auditClearFilters" }));
    expect(drawer.getByRole("searchbox")).toHaveProperty("value", "");
    expect(drawer.getByText("警告")).toBeTruthy();
  });

  test("moves focus and selection with the keyboard while keeping every pane mounted", async () => {
    const second = makeSession({
      id: "session-2",
      siteId: "Docker PBS AIO",
      agentId: "scheduler-pbs",
    });
    const third = makeSession({ id: "session-3" });
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/terminal/sessions") return { sessions: [makeSession(), second, third] };
      throw new Error(`unexpected GET ${path}`);
    });

    render(withQueryClient(<TerminalPage />));

    const firstPanel = await screen.findByTestId("terminal-panel-session-1");
    const secondPanel = screen.getByTestId("terminal-panel-session-2");
    const firstTab = screen.getByTestId("terminal-tab-session-1");
    const secondTab = screen.getByTestId("terminal-tab-session-2");
    const thirdTab = screen.getByTestId("terminal-tab-session-3");
    const firstPane = within(firstPanel).getByTestId("terminal-pane");
    const secondPane = within(secondPanel).getByTestId("terminal-pane");
    expect(firstTab.tabIndex).toBe(0);
    expect(secondTab.tabIndex).toBe(-1);
    expect(thirdTab.tabIndex).toBe(-1);
    expect(firstTab.getAttribute("aria-controls")).toBe(firstPanel.id);
    expect(secondTab.getAttribute("aria-controls")).toBe(secondPanel.id);
    expect(firstPanel.getAttribute("aria-labelledby")).toBe(firstTab.id);
    expect(secondPanel.getAttribute("aria-labelledby")).toBe(secondTab.id);
    expect(firstTab.id).not.toBe(secondTab.id);
    expect(firstPanel).toHaveProperty("hidden", false);
    expect(secondPanel).toHaveProperty("hidden", true);

    firstTab.focus();
    for (const [from, key, to] of [
      [firstTab, "ArrowLeft", thirdTab],
      [thirdTab, "ArrowRight", firstTab],
      [firstTab, "ArrowRight", secondTab],
      [secondTab, "ArrowLeft", firstTab],
      [firstTab, "End", thirdTab],
      [thirdTab, "Home", firstTab],
    ] as const) {
      expect(document.activeElement).toBe(from);
      expect(fireEvent.keyDown(from, { key })).toBe(false);
      expect(document.activeElement).toBe(to);
      expect(from.tabIndex).toBe(-1);
      expect(to.tabIndex).toBe(0);
      expect(from.getAttribute("aria-selected")).toBe("false");
      expect(to.getAttribute("aria-selected")).toBe("true");
    }

    const secondClose = screen.getByTestId("terminal-tab-close-session-2");
    expect(secondClose.tabIndex).toBe(0);
    secondClose.focus();
    expect(fireEvent.keyDown(secondClose, { key: "ArrowRight" })).toBe(true);
    expect(document.activeElement).toBe(secondClose);
    expect(firstTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(secondTab);
    expect(firstPanel).toHaveProperty("hidden", true);
    expect(secondPanel).toHaveProperty("hidden", false);
    expect(
      within(screen.getByTestId("terminal-panel-session-1")).getByTestId("terminal-pane"),
    ).toBe(firstPane);
    expect(
      within(screen.getByTestId("terminal-panel-session-2")).getByTestId("terminal-pane"),
    ).toBe(secondPane);
  });

  test("keeps the selected session when closing fails and lets the user retry", async () => {
    const first = makeSession();
    const second = makeSession({ id: "session-2" });
    vi.mocked(api.get)
      .mockResolvedValueOnce({ sessions: [first, second] })
      .mockResolvedValue({ sessions: [first] });
    vi.mocked(api.delete)
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL_ERROR", "backend diagnostic"))
      .mockResolvedValueOnce({ ...second, state: "closed" });

    render(withQueryClient(<TerminalPage />));

    const secondTab = await screen.findByTestId("terminal-tab-session-2");
    const close = screen.getByTestId("terminal-tab-close-session-2");
    fireEvent.click(secondTab);
    close.focus();
    fireEvent.click(close);
    close.blur();

    await screen.findByTestId("terminal-close-error-session-2");
    expect(secondTab.getAttribute("aria-selected")).toBe("true");
    expect(close).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(close);
    expect(api.get).toHaveBeenCalledTimes(1);

    fireEvent.click(close);
    close.blur();

    await waitFor(() => expect(screen.queryByTestId("terminal-tab-session-2")).toBeNull());
    expect(api.delete).toHaveBeenCalledTimes(2);
    const firstTab = screen.getByTestId("terminal-tab-session-1");
    expect(firstTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(firstTab);
  });

  test("treats a 404 when closing from the pane as an already closed session", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({ sessions: [makeSession()] })
      .mockResolvedValue({ sessions: [] });
    vi.mocked(api.delete).mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "session gone"));

    render(withQueryClient(<TerminalPage />));

    const close = await screen.findByTestId("terminal-close");
    close.focus();
    fireEvent.click(close);
    const copy = screen.getByTestId("terminal-copy-id");
    copy.focus();
    expect(document.activeElement).toBe(copy);

    await screen.findByTestId("terminal-empty");
    expect(document.activeElement).toBe(screen.getByTestId("terminal-open-shell"));
    expect(api.delete).toHaveBeenCalledWith("/terminal/sessions/session-1");
    expect(toast.error).not.toHaveBeenCalled();
  });

  test("deduplicates closing across both controls and preserves a newer tab selection", async () => {
    const first = makeSession();
    const second = makeSession({ id: "session-2" });
    const third = makeSession({ id: "session-3" });
    const closeFirst = Promise.withResolvers<TerminalSession>();
    const closeThird = Promise.withResolvers<TerminalSession>();
    vi.mocked(api.get)
      .mockResolvedValueOnce({ sessions: [first, second, third] })
      .mockResolvedValueOnce({ sessions: [third, second] })
      .mockResolvedValue({ sessions: [second] });
    vi.mocked(api.delete)
      .mockReturnValueOnce(closeFirst.promise)
      .mockReturnValueOnce(closeThird.promise);

    render(withQueryClient(<TerminalPage />));

    const firstPane = await screen.findByTestId("terminal-panel-session-1");
    const secondTab = screen.getByTestId("terminal-tab-session-2");
    const paneClose = within(firstPane).getByTestId("terminal-close");
    const firstTabClose = screen.getByTestId("terminal-tab-close-session-1");
    fireEvent.click(screen.getByTestId("terminal-tab-session-1"));
    paneClose.focus();
    fireEvent.click(paneClose);
    expect(firstTabClose).toHaveProperty("disabled", true);
    expect(paneClose).toHaveProperty("disabled", true);
    fireEvent.click(firstTabClose);
    fireEvent.click(paneClose);
    secondTab.focus();
    fireEvent.click(secondTab);
    fireEvent.click(screen.getByTestId("terminal-tab-close-session-3"));

    expect(api.delete).toHaveBeenCalledTimes(2);
    expect(api.delete).toHaveBeenNthCalledWith(1, "/terminal/sessions/session-1");
    expect(api.delete).toHaveBeenNthCalledWith(2, "/terminal/sessions/session-3");

    await act(async () => closeFirst.resolve({ ...first, state: "closed" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-tab-session-1")).toBeNull());
    expect(secondTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(secondTab);
    expect(screen.getByTestId("terminal-tab-close-session-3")).toHaveProperty("disabled", true);

    await act(async () => closeThird.resolve({ ...third, state: "closed" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-tab-session-3")).toBeNull());
  });

  test("respects a focus change during a close even if focus later leaves that control", async () => {
    const session = makeSession();
    const request = Promise.withResolvers<TerminalSession>();
    vi.mocked(api.get)
      .mockResolvedValueOnce({ sessions: [session] })
      .mockResolvedValue({ sessions: [] });
    vi.mocked(api.delete).mockReturnValueOnce(request.promise);

    render(withQueryClient(<TerminalPage />));

    const close = await screen.findByTestId("terminal-tab-close-session-1");
    close.focus();
    fireEvent.click(close);
    const link = screen.getByTestId("terminal-live-ssh-link");
    link.focus();
    expect(document.activeElement).toBe(link);
    link.blur();

    await act(async () => request.resolve({ ...session, state: "closed" }));

    await screen.findByTestId("terminal-empty");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("AuditDrawer", () => {
  test("exposes the selected frame kind and names the audit search box", async () => {
    const session = makeSession();
    vi.mocked(api.get).mockResolvedValueOnce({
      frames: [
        { ts: session.openedAt, kind: "stdout", data: "command output" },
        { ts: session.openedAt, kind: "stderr", data: "command error" },
      ],
    });

    render(withQueryClient(<AuditDrawer session={session} open onOpenChange={vi.fn()} />));

    const all = await screen.findByRole("button", { name: "terminal.auditAll (2)", pressed: true });
    const errors = screen.getByRole("button", { name: "stderr (1)", pressed: false });
    const search = screen.getByRole("searchbox", { name: "terminal.auditSearch" });
    fireEvent.click(errors);

    expect(all.getAttribute("aria-pressed")).toBe("false");
    expect(errors.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("command output")).toBeNull();
    expect(screen.getByText("command error")).toBeTruthy();

    fireEvent.change(search, { target: { value: "output" } });

    expect(screen.queryByText("command error")).toBeNull();
  });

  test("keeps export disabled during loading, failure and an empty retry", async () => {
    const request = Promise.withResolvers<{ frames: TerminalAuditFrame[] }>();
    const createUrl = vi.spyOn(URL, "createObjectURL");
    vi.mocked(api.get).mockReturnValueOnce(request.promise).mockResolvedValueOnce({ frames: [] });

    render(withQueryClient(<AuditDrawer session={makeSession()} open onOpenChange={vi.fn()} />));

    const exportButton = screen.getByTestId("terminal-audit-export");
    expect(screen.getByText("terminal.auditLoading")).toBeTruthy();
    expect(exportButton).toHaveProperty("disabled", true);
    fireEvent.click(exportButton);

    await act(async () => request.reject(new Error("private audit diagnostic")));

    const error = await screen.findByRole("alert");
    expect(error.textContent).not.toContain("private audit diagnostic");
    expect(screen.queryByText("terminal.auditEmpty")).toBeNull();
    expect(exportButton).toHaveProperty("disabled", true);
    fireEvent.click(exportButton);
    expect(createUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));

    await screen.findByText("terminal.auditEmpty");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(exportButton).toHaveProperty("disabled", true);
  });

  test("hides cached frames and counts after a refetch error until fresh frames arrive", async () => {
    const session = makeSession();
    const client = makeQueryClient();
    const retry = Promise.withResolvers<{ frames: TerminalAuditFrame[] }>();
    const frame = { ts: session.openedAt, kind: "stdout", data: "cached output" } as const;
    const createUrl = vi.spyOn(URL, "createObjectURL");
    vi.mocked(api.get)
      .mockResolvedValueOnce({ frames: [frame] })
      .mockRejectedValueOnce(new Error("audit refetch failed"))
      .mockReturnValueOnce(retry.promise);

    render(withQueryClient(<AuditDrawer session={session} open onOpenChange={vi.fn()} />, client));

    await screen.findByText("cached output");
    const exportButton = screen.getByTestId("terminal-audit-export");
    expect(screen.getByRole("button", { name: "terminal.auditAll (1)" })).toBeTruthy();
    expect(screen.getByTestId("terminal-audit-summary")).toBeTruthy();
    expect(exportButton).toHaveProperty("disabled", false);

    await client.invalidateQueries({ queryKey: ["terminal-audit", session.id] });

    await screen.findByRole("alert");
    const retryButton = screen.getByRole("button", { name: "common.retry" });
    expect(screen.queryByText("cached output")).toBeNull();
    expect(screen.queryByTestId("terminal-audit-filter-ALL")).toBeNull();
    expect(screen.queryByTestId("terminal-audit-summary")).toBeNull();
    expect(exportButton).toHaveProperty("disabled", true);
    fireEvent.click(exportButton);
    fireEvent.click(retryButton);
    await waitFor(() => expect(retryButton).toHaveProperty("disabled", true));
    expect(exportButton).toHaveProperty("disabled", true);
    expect(createUrl).not.toHaveBeenCalled();

    await act(async () => retry.resolve({ frames: [{ ...frame, data: "fresh output" }] }));

    await screen.findByText("fresh output");
    expect(screen.getByRole("button", { name: "terminal.auditAll (1)" })).toBeTruthy();
    expect(screen.getByTestId("terminal-audit-summary")).toBeTruthy();
    expect(exportButton).toHaveProperty("disabled", false);
  });
});
