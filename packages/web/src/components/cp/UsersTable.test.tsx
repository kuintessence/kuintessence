import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts
        ? Object.entries(opts).reduce<string>(
            (value, [name, replacement]) => value.replace(`{{${name}}}`, String(replacement)),
            key,
          )
        : key,
  }),
}));

import { UsersTable } from "./UsersTable";

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function setOrganization(id: string | null) {
  if (id) localStorage.setItem("kq_active_organization_id", id);
  else localStorage.removeItem("kq_active_organization_id");
  window.dispatchEvent(new Event("kq:active-organization-change"));
}

function installUsersFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const organization = (init?.headers as Record<string, string> | undefined)?.[
      "X-KQ-Active-Organization"
    ];
    if (url.includes("/api/cp/users") && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            total: 2,
            items: [
              {
                id: `${organization}-marked`,
                email: "marked@example.com",
                role: "user",
                suspended: true,
                quota: 0,
              },
              {
                id: `${organization}-missing`,
                email: "missing@example.com",
                role: "user",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("UsersTable read-only governance", () => {
  beforeEach(() => {
    localStorage.setItem("kq_token", "test-token");
    setOrganization("org-a");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test("renders historical fields and never exposes legacy write actions", async () => {
    const fetchMock = installUsersFetch();
    render(<UsersTable />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-users-row-org-a-marked"));
    expect(screen.getByTestId("cp-users-readonly-notice")).toBeTruthy();
    expect(screen.getByText("cp.users.historyMarked")).toBeTruthy();
    expect(screen.getByText("cp.users.historyQuotaZero")).toBeTruthy();
    expect(screen.getByText("cp.users.historyUnknown")).toBeTruthy();
    expect(screen.getByText("cp.users.notProvided")).toBeTruthy();
    expect(screen.queryByTestId(/^cp-users-suspend-/)).toBeNull();
    expect(screen.queryByTestId(/^cp-users-edit-quota-/)).toBeNull();
    expect(screen.queryByTestId("edit-quota-dialog")).toBeNull();
    expect(
      (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>).every(
        ([, init]) => init?.method !== "POST",
      ),
    ).toBe(true);
  });

  test("requires an organization and does not read an aggregate member list", async () => {
    setOrganization(null);
    const fetchMock = installUsersFetch();
    render(<UsersTable />, { wrapper: makeWrapper() });

    expect(screen.getByTestId("cp-users-organization-required")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("clears organization A while B is loading and keeps requests scoped to B", async () => {
    let resolveA: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const org = (init?.headers as Record<string, string>)["X-KQ-Active-Organization"];
      if (org === "org-a")
        return new Promise<Response>((resolve) => {
          resolveA = resolve;
        });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            total: 1,
            items: [{ id: "b", email: "b@example.com", role: "user", suspended: false, quota: 3 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<UsersTable />, { wrapper: makeWrapper() });

    setOrganization("org-b");
    await waitFor(() => screen.getByTestId("cp-users-row-b"));
    resolveA?.(
      new Response(
        JSON.stringify({
          total: 1,
          items: [{ id: "a", email: "a@example.com", role: "user", suspended: false, quota: 9 }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("cp-users-row-a")).toBeNull());
    expect(screen.getByText("b@example.com")).toBeTruthy();
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  test("shows an accessible read error and retries with GET only", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "denied" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<UsersTable />, { wrapper: makeWrapper() });

    const error = await screen.findByTestId("cp-users-error");
    expect(error.getAttribute("role")).toBe("alert");
    fireEvent.click(screen.getByText("cp.users.retryRead"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
});
