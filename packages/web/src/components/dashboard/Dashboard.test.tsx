import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      if (key === "dashboard.loadFailed") return "Dashboard data is unavailable. Please try again.";
      if (key === "dashboard.unavailable") return "Unavailable";
      return opts?.defaultValue ?? key;
    },
  }),
}));

// Stub heavy children we don't need under test. The audit-log gate lives in
// Dashboard itself and surfaces through EventsList — keep that one real.
vi.mock("./QuickStart", () => ({ QuickStart: () => null }));
vi.mock("./ThroughputChart", () => ({ ThroughputChart: () => null }));
vi.mock("./AgentsTable", () => ({ AgentsTable: () => null }));
vi.mock("./StatCard", () => ({
  StatCard: ({ hint, testId, value }: { hint?: ReactNode; testId?: string; value: ReactNode }) => (
    <div data-testid={testId}>
      <span data-testid={testId ? `${testId}-value` : undefined}>{value}</span>
      {hint ? <span>{hint}</span> : null}
    </div>
  ),
}));

vi.mock("../../lib/local-mode", () => ({
  isLocalMode: vi.fn(() => false),
  localApiBase: () => undefined,
  localToken: () => undefined,
  useLocalCapabilities: vi.fn(() => null),
}));

const auditAccess = vi.hoisted(() => ({ allowed: false, ready: true }));

vi.mock("../../lib/platform-capabilities", () => ({
  usePlatformCapability: () => auditAccess,
}));

import { isLocalMode } from "../../lib/local-mode";
import { Dashboard } from "./Dashboard";

const mockedIsLocalMode = vi.mocked(isLocalMode);

// Regression coverage for ISSUE-009 — Dashboard used to fire /api/audit-log
// for every user and swallow the resulting 403 in the queryFn. The browser
// still logged the network failure and we ate a wasted round-trip every 10s.
// The fix gates the query on the platform operator branch; EventsList renders
// the same `forbidden` fallback whether the role check fails locally or the
// server returns 403.

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function setRole(role: string) {
  localStorage.setItem("kq_token", "test-token");
  localStorage.setItem("kq_email", "qa@example.com");
  localStorage.setItem("kq_role", role);
  localStorage.setItem("kq_token_expires_at", String(Date.now() + 60_000));
}

function mockJsonRoutes(auditEntries: Array<Record<string, unknown>> = [], failedPath?: string) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (failedPath && url.includes(failedPath)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "INTERNAL_SERVER_ERROR", message: "scheduler stderr leaked" },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    if (url.includes("/api/jobs")) return json({ jobs: [] });
    if (url.includes("/api/workflows")) return json({ runs: [] });
    if (url.includes("/api/agents")) return json({ agents: [] });
    if (url.includes("/api/audit-log")) return json({ entries: auditEntries });
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function auditCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return url.includes("/audit-log");
  }).length;
}

beforeEach(() => {
  mockedIsLocalMode.mockReturnValue(false);
  auditAccess.allowed = false;
  auditAccess.ready = true;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Dashboard audit-log gating", () => {
  test("role=user does not fire /audit-log and renders the forbidden fallback", async () => {
    setRole("user");
    const fetchMock = mockJsonRoutes();

    render(<Dashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("events-forbidden")).toBeTruthy();
    });

    expect(auditCallCount(fetchMock)).toBe(0);
  });

  test("role=platform_admin fires /audit-log and renders entries", async () => {
    setRole("platform_admin");
    const fetchMock = mockJsonRoutes([
      {
        id: "00000000-0000-0000-0000-000000000001",
        action: "job.create",
        actor: "qa@example.com",
        target: "job:1",
        createdAt: new Date().toISOString(),
      },
    ]);

    render(<Dashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("events-list")).toBeTruthy();
    });

    expect(auditCallCount(fetchMock)).toBeGreaterThan(0);
  });

  test("role=operator fires /audit-log and renders entries", async () => {
    setRole("operator");
    const fetchMock = mockJsonRoutes([
      {
        id: "00000000-0000-0000-0000-000000000003",
        action: "job.create",
        actor: "operator@example.com",
        target: "job:3",
        createdAt: new Date().toISOString(),
      },
    ]);

    render(<Dashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("events-list")).toBeTruthy();
    });
    expect(auditCallCount(fetchMock)).toBeGreaterThan(0);
  });

  test("audit_readonly capability fires /audit-log for a technical user", async () => {
    setRole("user");
    auditAccess.allowed = true;
    const fetchMock = mockJsonRoutes([
      {
        id: "00000000-0000-0000-0000-000000000004",
        action: "job.create",
        actor: "auditor@example.com",
        target: "job:4",
        createdAt: new Date().toISOString(),
      },
    ]);

    render(<Dashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("events-list")).toBeTruthy();
    });
    expect(auditCallCount(fetchMock)).toBeGreaterThan(0);
  });

  test("renders recent audit entries with user-facing labels", async () => {
    setRole("platform_admin");
    mockJsonRoutes([
      {
        id: "00000000-0000-0000-0000-000000000002",
        action: "netdrive.file.commit",
        actor: "f1a8be4c-ddc2-4bca-8402-6f69370fba83",
        target: "1d084c0d-de21-48db-9138-04f88c1d267f",
        diff: { after: { path: "scheduler-smoke/slurm/batch/a.txt", size: 6 } },
        createdAt: new Date().toISOString(),
      },
    ]);

    render(<Dashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("保存了云盘文件")).toBeTruthy();
    });

    const listText = screen.getByTestId("events-list").textContent ?? "";
    expect(listText).toContain("scheduler-smoke/slurm/batch/a.txt");
    expect(listText).not.toContain("netdrive.file.commit");
    expect(listText).not.toContain("f1a8be4c-ddc2-4bca-8402-6f69370fba83");
  });

  test("local mode does not fire /audit-log even for platform_admin", async () => {
    setRole("platform_admin");
    mockedIsLocalMode.mockReturnValue(true);
    const fetchMock = mockJsonRoutes();

    render(<Dashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("dashboard")).toBeTruthy();
    });

    expect(auditCallCount(fetchMock)).toBe(0);
  });

  test("role=null (logged out) does not fire /audit-log", async () => {
    // Don't call setRole — leaves localStorage empty.
    const fetchMock = mockJsonRoutes();

    render(<Dashboard />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("events-forbidden")).toBeTruthy();
    });

    expect(auditCallCount(fetchMock)).toBe(0);
  });

  test("shows a friendly dashboard error and unavailable metrics when a query fails", async () => {
    setRole("user");
    const fetchMock = mockJsonRoutes([], "/api/jobs");

    render(<Dashboard />, { wrapper: makeWrapper() });

    const error = await screen.findByTestId("dashboard-load-error");
    expect(error.textContent).toContain("Dashboard data is unavailable");
    expect(error.textContent).not.toContain("scheduler stderr leaked");
    expect(screen.getByTestId("stat-active-jobs-value").textContent).toBe("—");
    expect(screen.getByTestId("stat-active-jobs").textContent).toContain("Unavailable");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/jobs"))).toBe(true);
  });
});
