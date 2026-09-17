import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ role: "platform_admin" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock("../../lib/auth", () => ({ getAuthState: () => ({ role: auth.role }) }));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { CpAgentsTable } from "./CpAgentsTable";

const rootA = {
  id: "root-a",
  label: "Scratch",
  providerOrgId: "provider-1",
  agentId: "agent-1",
  path: "/tmp/kq-cluster-roots-smoke",
  visibleOrgIds: ["provider-1"],
  enabled: true,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

const rootAll = {
  ...rootA,
  id: "root-all",
  label: "Shared work",
  agentId: null,
  path: "/work/shared",
};

const rootOther = {
  ...rootA,
  id: "root-other",
  label: "Other agent",
  agentId: "agent-2",
  path: "/other",
};

function makeClientWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

function makeWrapper() {
  return makeClientWrapper().wrapper;
}

function installFetch() {
  const fp = "d".repeat(64);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/platform/api/cp/agents") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{ id: "agent-1", hostname: "host-1", siteId: "site-1", status: "online" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/platform/api/cp/agents/agent-1/certs" && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            certs: [
              {
                id: "cert-1",
                fingerprintSha256: fp,
                subjectCn: "agent-1",
                issuedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2027-01-01T00:00:00.000Z",
                revokedAt: null,
                issuedBy: "user-1",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === `/platform/api/cp/agents/agent-1/certs/${fp}/revoke` && init?.method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, fp };
}

function installCertErrorFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === "/platform/api/cp/agents" && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{ id: "agent-1", hostname: "host-1", siteId: "site-1", status: "online" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/platform/api/cp/agents/agent-1/certs" && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "provider denied" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installAgentListErrorFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === "/platform/api/cp/agents" && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "FORBIDDEN", message: "agent scope denied" } }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installRootsFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === "/platform/api/cp/agents" && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{ id: "agent-1", hostname: "host-1", siteId: "site-1", status: "online" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/platform/api/admin/cluster-file-roots" && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ roots: [rootA, rootAll, rootOther] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url === "/platform/api/admin/cluster-file-roots/root-a/check" && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            rootId: "root-a",
            path: rootA.path,
            agentId: "agent-1",
            status: "ok",
            checkedAt: "2026-07-08T00:00:01.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installRootsErrorFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === "/platform/api/cp/agents" && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{ id: "agent-1", hostname: "host-1", siteId: "site-1", status: "online" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/platform/api/admin/cluster-file-roots" && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "roots denied" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  auth.role = "platform_admin";
  toastSuccess.mockReset();
  toastError.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("CpAgentsTable", () => {
  test("surfaces agent list authorization failures without rendering an empty table", async () => {
    installAgentListErrorFetch();
    render(<CpAgentsTable />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-agents-error"));
    const error = screen.getByTestId("cp-agents-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("agent scope denied");
    expect(screen.queryByTestId("cp-agents-empty")).toBeNull();
    expect(screen.queryByTestId("cp-agent-certs-toggle-agent-1")).toBeNull();
  });

  test("clears stale expanded agent actions after a list refetch error", async () => {
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/platform/api/cp/agents" && method === "GET") {
        listCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              listCalls === 1
                ? {
                    items: [
                      { id: "agent-1", hostname: "host-1", siteId: "site-1", status: "online" },
                    ],
                  }
                : { error: { code: "FORBIDDEN", message: "agent scope denied" } },
            ),
            {
              status: listCalls === 1 ? 200 : 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      if (url === "/platform/api/admin/cluster-file-roots" && method === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ roots: [rootA] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { qc, wrapper } = makeClientWrapper();

    render(<CpAgentsTable />, { wrapper });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-roots-toggle-agent-1"));
    await waitFor(() => screen.getByTestId("cp-agent-root-row-root-a"));

    await qc.invalidateQueries({ queryKey: ["cp", "agents"] });

    await waitFor(() => screen.getByTestId("cp-agents-error"));
    const error = screen.getByTestId("cp-agents-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("agent scope denied");
    expect(screen.queryByTestId("cp-agents-row-agent-1")).toBeNull();
    expect(screen.queryByTestId("cp-agent-roots-toggle-agent-1")).toBeNull();
    expect(screen.queryByTestId("cp-agent-root-check-root-a")).toBeNull();
  });

  test("does not expose revoke actions when cert listing is denied", async () => {
    installCertErrorFetch();
    render(<CpAgentsTable />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-certs-toggle-agent-1"));

    await waitFor(() => screen.getByTestId("cp-agent-certs-error-agent-1"));
    const error = screen.getByTestId("cp-agent-certs-error-agent-1");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("provider denied");
    expect(screen.queryByTestId("cp-agent-certs-empty-agent-1")).toBeNull();
    expect(screen.queryByTestId(/^cp-agent-cert-revoke-/)).toBeNull();
  });

  test("expands cluster file roots for the selected agent", async () => {
    const fetchMock = installRootsFetch();
    render(<CpAgentsTable />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-roots-toggle-agent-1"));

    await waitFor(() => screen.getByTestId("cp-agent-roots-agent-1"));
    expect(screen.getByTestId("cp-agent-root-row-root-a")).toBeTruthy();
    expect(screen.getByTestId("cp-agent-root-row-root-all")).toBeTruthy();
    expect(screen.queryByTestId("cp-agent-root-row-root-other")).toBeNull();
    expect(screen.getByText("/tmp/kq-cluster-roots-smoke")).toBeTruthy();
    expect(screen.getByText("/work/shared")).toBeTruthy();
    expect(screen.getByText("cp.agents.roots.manage")).toHaveProperty(
      "href",
      "http://localhost:3000/settings#infrastructure/cluster-file-roots",
    );
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        return url === "/platform/api/admin/cluster-file-roots";
      }),
    ).toBe(true);
  });

  test("replaces the root Settings dead link with platform-admin guidance for CP admins", async () => {
    auth.role = "org_admin";
    installRootsFetch();
    render(<CpAgentsTable />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-roots-toggle-agent-1"));

    expect(await screen.findByTestId("cp-agent-roots-manage-restricted-agent-1")).toBeTruthy();
    expect(screen.queryByText("cp.agents.roots.manage")).toBeNull();
    expect(screen.getByText("cp.agents.roots.manageRestricted")).toBeTruthy();
  });

  test("checks a CP agent root from the expanded root list", async () => {
    const fetchMock = installRootsFetch();
    render(<CpAgentsTable />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-roots-toggle-agent-1"));
    await waitFor(() => screen.getByTestId("cp-agent-root-row-root-a"));
    fireEvent.click(screen.getByTestId("cp-agent-root-check-root-a"));

    expect(await screen.findByTestId("cp-agent-root-check-status-root-a")).toHaveProperty(
      "textContent",
      "cp.agents.roots.checkStatus.ok",
    );
    expect(toastSuccess).toHaveBeenCalledWith("cp.agents.roots.checkComplete");
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url === "/platform/api/admin/cluster-file-roots/root-a/check" && init?.method === "POST"
        );
      }),
    ).toBe(true);
  });

  test("surfaces cluster file root authorization failures without rendering an empty state", async () => {
    installRootsErrorFetch();
    render(<CpAgentsTable />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-roots-toggle-agent-1"));

    await waitFor(() => screen.getByTestId("cp-agent-roots-error-agent-1"));
    const error = screen.getByTestId("cp-agent-roots-error-agent-1");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("roots denied");
    expect(screen.queryByTestId("cp-agent-roots-empty-agent-1")).toBeNull();
  });

  test("hides stale root check actions after a roots refetch error", async () => {
    let rootListCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/platform/api/cp/agents" && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ id: "agent-1", hostname: "host-1", siteId: "site-1", status: "online" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/platform/api/admin/cluster-file-roots" && method === "GET") {
        rootListCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              rootListCalls === 1
                ? { roots: [rootA] }
                : { error: { code: "FORBIDDEN", message: "roots denied" } },
            ),
            {
              status: rootListCalls === 1 ? 200 : 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      if (url === "/platform/api/admin/cluster-file-roots/root-a/check" && method === "POST") {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { qc, wrapper } = makeClientWrapper();

    render(<CpAgentsTable />, { wrapper });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-roots-toggle-agent-1"));
    await waitFor(() => screen.getByTestId("cp-agent-root-row-root-a"));

    await qc.invalidateQueries({
      queryKey: ["cp", "agents", "all", "agent-1", "cluster-file-roots"],
    });

    await waitFor(() => screen.getByTestId("cp-agent-roots-error-agent-1"));
    const error = screen.getByTestId("cp-agent-roots-error-agent-1");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("roots denied");
    expect(screen.queryByTestId("cp-agent-root-row-root-a")).toBeNull();
    expect(screen.queryByTestId("cp-agent-root-check-root-a")).toBeNull();
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url === "/platform/api/admin/cluster-file-roots/root-a/check" && init?.method === "POST"
        );
      }),
    ).toBe(false);
  });

  test("expands CP-scoped certs and revokes an active cert", async () => {
    const { fetchMock, fp } = installFetch();
    render(<CpAgentsTable />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-certs-toggle-agent-1"));
    await waitFor(() => screen.getByTestId(`cp-agent-cert-row-${fp}`));
    fireEvent.click(screen.getByTestId(`cp-agent-cert-revoke-${fp}`));
    fireEvent.change(screen.getByTestId("cp-agent-cert-revoke-reason"), {
      target: { value: "key rotation" },
    });
    fireEvent.click(screen.getByTestId("cp-agent-cert-revoke-confirm"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url === `/platform/api/cp/agents/agent-1/certs/${fp}/revoke` &&
          init?.method === "POST" &&
          init.body === JSON.stringify({ reason: "key rotation" })
        );
      }),
    ).toBe(true);
  });

  test("prioritizes agent identity and actions in the mobile list layout", async () => {
    installFetch();
    render(<CpAgentsTable />, { wrapper: makeWrapper() });

    const row = await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    expect(screen.getByText("cp.common.agentStatus.online")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
    const scroller = screen.getByTestId("cp-agents-table-scroll");
    expect(scroller.className).toContain("sm:overflow-x-auto");
    expect(scroller.querySelector("table")?.className).toContain("sm:min-w-[48rem]");
    expect(row.className).toContain("grid");
    const rootsToggle = screen.getByTestId("cp-agent-roots-toggle-agent-1");
    const certsToggle = screen.getByTestId("cp-agent-certs-toggle-agent-1");
    expect(rootsToggle.className).toContain("min-h-11");
    expect(certsToggle.className).toContain("min-h-11");
    expect(rootsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(rootsToggle.getAttribute("aria-controls")).toBeNull();

    fireEvent.click(rootsToggle);
    expect(rootsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(rootsToggle.getAttribute("aria-controls")).toBe("cp-agent-roots-detail-agent-1");
    expect(document.getElementById("cp-agent-roots-detail-agent-1")).toBeTruthy();
    fireEvent.click(certsToggle);
    await waitFor(() => screen.getByTestId("cp-agent-certs-agent-1"));
    expect(document.getElementById("cp-agent-roots-detail-agent-1")).toBeNull();
    expect(rootsToggle.getAttribute("aria-controls")).toBeNull();
    expect(certsToggle.getAttribute("aria-expanded")).toBe("true");
  });

  test("hides stale cert revoke actions after a cert refetch error", async () => {
    const fp = "d".repeat(64);
    let certListCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/platform/api/cp/agents" && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ id: "agent-1", hostname: "host-1", siteId: "site-1", status: "online" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/platform/api/cp/agents/agent-1/certs" && method === "GET") {
        certListCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              certListCalls === 1
                ? {
                    certs: [
                      {
                        id: "cert-1",
                        fingerprintSha256: fp,
                        subjectCn: "agent-1",
                        issuedAt: "2026-01-01T00:00:00.000Z",
                        expiresAt: "2027-01-01T00:00:00.000Z",
                        revokedAt: null,
                        issuedBy: "user-1",
                      },
                    ],
                  }
                : { error: { code: "FORBIDDEN", message: "certs denied" } },
            ),
            {
              status: certListCalls === 1 ? 200 : 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      if (url === `/platform/api/cp/agents/agent-1/certs/${fp}/revoke` && method === "POST") {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { qc, wrapper } = makeClientWrapper();

    render(<CpAgentsTable />, { wrapper });

    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-certs-toggle-agent-1"));
    await waitFor(() => screen.getByTestId(`cp-agent-cert-row-${fp}`));
    fireEvent.click(screen.getByTestId(`cp-agent-cert-revoke-${fp}`));
    expect(screen.getByTestId("cp-agent-cert-revoke-confirm")).toBeTruthy();

    await qc.invalidateQueries({ queryKey: ["cp", "agents", "all", "agent-1", "certs"] });

    await waitFor(() => screen.getByTestId("cp-agent-certs-error-agent-1"));
    const error = screen.getByTestId("cp-agent-certs-error-agent-1");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("certs denied");
    expect(screen.queryByTestId(`cp-agent-cert-row-${fp}`)).toBeNull();
    expect(screen.queryByTestId(`cp-agent-cert-revoke-${fp}`)).toBeNull();
    expect(screen.queryByTestId("cp-agent-cert-revoke-confirm")).toBeNull();
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url === `/platform/api/cp/agents/agent-1/certs/${fp}/revoke` && init?.method === "POST"
        );
      }),
    ).toBe(false);
  });
});
