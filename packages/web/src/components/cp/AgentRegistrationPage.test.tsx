import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { AgentRegistrationPage } from "./AgentRegistrationPage";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function makeClientWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false, gcTime: 0 } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

function getCall(
  spy: ReturnType<typeof vi.fn>,
  idx = 0,
): { url: string; init: RequestInit | undefined } {
  const call = spy.mock.calls[idx];
  if (!call) throw new Error(`fetch call #${idx} missing`);
  const url = typeof call[0] === "string" ? call[0] : String(call[0]);
  return { url, init: call[1] as RequestInit | undefined };
}

function findCall(
  spy: ReturnType<typeof vi.fn>,
  predicate: (url: string, init: RequestInit | undefined) => boolean,
): { url: string; init: RequestInit | undefined } {
  for (let idx = 0; idx < spy.mock.calls.length; idx += 1) {
    const call = getCall(spy, idx);
    if (predicate(call.url, call.init)) return call;
  }
  throw new Error("matching fetch call missing");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentRegistrationPage", () => {
  test("surfaces context authorization failures and does not create tokens", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/agent-registration-context")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "FORBIDDEN",
                message: "Authorization principal is not bound",
              },
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      if (url.endsWith("/agent-registration-tokens") && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentRegistrationPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("agent-registration-context-error"));
    const error = screen.getByTestId("agent-registration-context-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("Authorization principal is not bound");
    expect(error.textContent).not.toContain("FORBIDDEN");
    expect((screen.getByTestId("agent-registration-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(screen.getByTestId("agent-registration-agent-id"), {
      target: { value: "agent-1" },
    });
    fireEvent.change(screen.getByTestId("agent-registration-site-name"), {
      target: { value: "site-a" },
    });
    fireEvent.click(screen.getByTestId("agent-registration-submit"));

    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return url === "/platform/api/cp/agent-registration-tokens" && init?.method === "POST";
      }),
    ).toBe(false);
  });

  test("disables token creation after a context refetch failure", async () => {
    const context = {
      providerOrgs: [{ id: "org-1", name: "Provider One" }],
      isPlatformWide: false,
      schedulers: ["slurm", "pbs-pro", "torque", "kubernetes"],
    };
    let contextCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/agent-registration-context")) {
        contextCalls += 1;
        if (contextCalls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify(context), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "FORBIDDEN",
                message: "Authorization principal is not bound",
              },
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      if (url.endsWith("/agent-registration-tokens") && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { qc, Wrapper } = makeClientWrapper();

    render(<AgentRegistrationPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect((screen.getByTestId("agent-registration-provider") as HTMLSelectElement).value).toBe(
        "org-1",
      );
    });
    fireEvent.change(screen.getByTestId("agent-registration-agent-id"), {
      target: { value: "agent-1" },
    });
    fireEvent.change(screen.getByTestId("agent-registration-site-name"), {
      target: { value: "site-a" },
    });

    await qc.invalidateQueries({ queryKey: ["cp", "agent-registration-context"] });

    await waitFor(() => screen.getByTestId("agent-registration-context-error"));
    expect((screen.getByTestId("agent-registration-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByTestId("agent-registration-submit"));

    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return url === "/platform/api/cp/agent-registration-tokens" && init?.method === "POST";
      }),
    ).toBe(false);
  });

  test("surfaces active token authorization failures without exposing revoke actions", async () => {
    const context = {
      providerOrgs: [{ id: "org-1", name: "Provider One" }],
      isPlatformWide: false,
      schedulers: ["slurm", "pbs-pro", "torque", "kubernetes"],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/agent-registration-context")) {
        return Promise.resolve(
          new Response(JSON.stringify(context), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/agent-registration-tokens")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: "FORBIDDEN", message: "token scope denied" } }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentRegistrationPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("agent-registration-active-error"));
    const error = screen.getByTestId("agent-registration-active-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("token scope denied");
    expect(error.textContent).not.toContain("FORBIDDEN");
    expect(screen.queryByTestId("agent-registration-active-empty")).toBeNull();
    expect(screen.queryByTestId(/^agent-registration-active-revoke-/)).toBeNull();
  });

  test("creates a registration token and renders the register command", async () => {
    const context = {
      providerOrgs: [{ id: "org-1", name: "Provider One" }],
      isPlatformWide: false,
      schedulers: ["slurm", "pbs-pro", "torque", "kubernetes"],
    };
    const token = {
      id: "intent-1",
      agentId: "agent-1",
      siteName: "site-a",
      providerOrgId: "org-1",
      token: "kqreg_plain",
      expiresAt: "2026-07-07T00:00:00Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      let body: unknown = { items: [] };
      if (url.endsWith("/agent-registration-context")) body = context;
      if (url.endsWith("/agent-registration-tokens") && init?.method === "POST") body = token;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentRegistrationPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect((screen.getByTestId("agent-registration-provider") as HTMLSelectElement).value).toBe(
        "org-1",
      );
    });
    fireEvent.change(screen.getByTestId("agent-registration-agent-id"), {
      target: { value: "agent-1" },
    });
    fireEvent.change(screen.getByTestId("agent-registration-site-name"), {
      target: { value: "site-a" },
    });
    fireEvent.change(screen.getByTestId("agent-registration-scheduler"), {
      target: { value: "pbs-pro" },
    });
    fireEvent.click(screen.getByTestId("agent-registration-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-registration-token-intent-1")).toBeTruthy();
    });

    expect(
      findCall(fetchMock, (url) => url === "/platform/api/cp/agent-registration-context").url,
    ).toBe("/platform/api/cp/agent-registration-context");
    const { url, init } = findCall(
      fetchMock,
      (callUrl, callInit) =>
        callUrl === "/platform/api/cp/agent-registration-tokens" && callInit?.method === "POST",
    );
    expect(url).toBe("/platform/api/cp/agent-registration-tokens");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({
        providerOrgId: "org-1",
        agentId: "agent-1",
        siteName: "site-a",
        expiresInSec: 86400,
      }),
    );
    expect(screen.getByTestId("agent-registration-token-value-intent-1").textContent).toBe("");
    expect(
      (screen.getByTestId("agent-registration-token-value-intent-1") as HTMLInputElement).value,
    ).toBe("kqreg_plain");
    const command = screen.getByTestId("agent-registration-command-intent-1").textContent ?? "";
    expect(command).toContain("kq agent register");
    expect(command).toContain("--url 'http://localhost:3000'");
    expect(command).toContain("--grpc-url 'http://localhost:3001'");
    expect(command).toContain("--scheduler 'pbs-pro'");
    expect(command).toContain("--token 'kqreg_plain'");
  });

  test("renders persisted active tokens and revokes them by id", async () => {
    const context = {
      providerOrgs: [{ id: "org-1", name: "Provider One" }],
      isPlatformWide: false,
      schedulers: ["slurm", "pbs-pro", "torque", "kubernetes"],
    };
    const active = {
      items: [
        {
          id: "intent-active-1",
          agentId: "agent-active",
          siteName: "site-active",
          providerOrgId: "org-1",
          expiresAt: "2026-07-07T00:00:00Z",
          createdAt: "2026-07-06T00:00:00Z",
        },
      ],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const body = url.endsWith("/agent-registration-context") ? context : active;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentRegistrationPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("agent-registration-active-token-intent-active-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("agent-registration-active-revoke-intent-active-1"));

    await waitFor(() => {
      const revokeCall = findCall(
        fetchMock,
        (url, init) =>
          url === "/platform/api/cp/agent-registration-tokens/intent-active-1" &&
          init?.method === "DELETE",
      );
      expect(revokeCall.url).toBe("/platform/api/cp/agent-registration-tokens/intent-active-1");
    });
  });
});

const reviewContext = {
  providerOrgs: [{ id: "org-review", name: "Review Provider" }],
  isPlatformWide: false,
  schedulers: ["slurm"],
};
const reviewToken = {
  id: "review-token",
  agentId: "review-agent",
  siteName: "Review Site",
  providerOrgId: "org-review",
  token: "fictional-test-token",
  expiresAt: "2026-10-06T00:00:00Z",
  createdAt: "2026-10-05T00:00:00Z",
};

async function fillReviewForm() {
  await waitFor(() =>
    expect(screen.getByTestId("agent-registration-provider")).toHaveProperty("value", "org-review"),
  );
  fireEvent.change(screen.getByTestId("agent-registration-agent-id"), {
    target: { value: "review-agent" },
  });
  fireEvent.change(screen.getByTestId("agent-registration-site-name"), {
    target: { value: "Review Site" },
  });
}

test("explains unavailable registration endpoints and retries context loading", async () => {
  let available = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/agent-registration-context")) {
        return Promise.resolve(
          available
            ? Response.json(reviewContext)
            : Response.json({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 }),
        );
      }
      return Promise.resolve(Response.json({ items: [] }));
    }),
  );
  render(<AgentRegistrationPage />, { wrapper: makeWrapper() });
  const error = await screen.findByTestId("agent-registration-context-error");
  expect(error.textContent).toContain("cp.agentRegistration.endpointUnavailable");
  expect(screen.getByTestId("agent-registration-submit")).toHaveProperty("disabled", true);
  available = true;
  fireEvent.click(screen.getByRole("button", { name: "globalError.retry" }));
  await fillReviewForm();
  expect(screen.queryByTestId("agent-registration-context-error")).toBeNull();
  expect(screen.getByTestId("agent-registration-submit")).toHaveProperty("disabled", false);
});

test("matches the server TTL range and does not truncate exponential numeric input", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      Response.json(
        String(input).endsWith("/agent-registration-context")
          ? reviewContext
          : init?.method === "POST"
            ? reviewToken
            : { items: [] },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentRegistrationPage />, { wrapper: makeWrapper() });
  await fillReviewForm();
  for (const value of ["", "1", "59", "60.5", "2592001"]) {
    fireEvent.change(screen.getByTestId("agent-registration-ttl"), { target: { value } });
    expect(screen.getByTestId("agent-registration-submit")).toHaveProperty("disabled", true);
  }
  for (const value of ["60", "2592000", "1e3"]) {
    fireEvent.change(screen.getByTestId("agent-registration-ttl"), { target: { value } });
    expect(screen.getByTestId("agent-registration-submit")).toHaveProperty("disabled", false);
  }
  const form = screen.getByTestId("agent-registration-submit").closest("form");
  if (!form) throw new Error("Expected registration form");
  fireEvent.submit(form);
  await screen.findByTestId("agent-registration-token-review-token");
  const call = findCall(fetchMock, (_url, init) => init?.method === "POST");
  expect(JSON.parse(String(call.init?.body)).expiresInSec).toBe(1000);
});

test("creation failure is handled and the same form can retry", async () => {
  let creates = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        creates += 1;
        return Promise.resolve(
          creates === 1
            ? Response.json(
                { error: { code: "INTERNAL_ERROR", message: "private failure" } },
                { status: 500 },
              )
            : Response.json(reviewToken),
        );
      }
      return Promise.resolve(
        Response.json(
          String(input).endsWith("/agent-registration-context") ? reviewContext : { items: [] },
        ),
      );
    }),
  );
  render(<AgentRegistrationPage />, { wrapper: makeWrapper() });
  await fillReviewForm();
  fireEvent.click(screen.getByTestId("agent-registration-submit"));
  expect((await screen.findByTestId("agent-registration-error")).textContent).toContain(
    "cp.agentRegistration.form.createFailed",
  );
  fireEvent.click(screen.getByTestId("agent-registration-submit"));
  await screen.findByTestId("agent-registration-token-review-token");
  expect(screen.queryByTestId("agent-registration-error")).toBeNull();
  expect(creates).toBe(2);
});

test("revocation failure keeps the token visible until a successful retry", async () => {
  let revokes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        revokes += 1;
        return Promise.resolve(
          revokes === 1
            ? Response.json(
                { error: { code: "INTERNAL_ERROR", message: "private failure" } },
                { status: 500 },
              )
            : new Response(null, { status: 204 }),
        );
      }
      return Promise.resolve(
        Response.json(
          String(input).endsWith("/agent-registration-context")
            ? reviewContext
            : { items: revokes > 1 ? [] : [reviewToken] },
        ),
      );
    }),
  );
  render(<AgentRegistrationPage />, { wrapper: makeWrapper() });
  fireEvent.click(await screen.findByTestId("agent-registration-active-revoke-review-token"));
  expect((await screen.findByTestId("agent-registration-revoke-error")).textContent).toContain(
    "cp.agentRegistration.tokens.revokeFailed",
  );
  expect(screen.getByTestId("agent-registration-active-token-review-token")).toBeTruthy();
  fireEvent.click(screen.getByTestId("agent-registration-active-revoke-review-token"));
  await waitFor(() =>
    expect(screen.queryByTestId("agent-registration-active-token-review-token")).toBeNull(),
  );
  expect(screen.queryByTestId("agent-registration-revoke-error")).toBeNull();
});

test("clipboard rejection gives manual-copy guidance without a false success", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        Response.json(
          String(input).endsWith("/agent-registration-context")
            ? reviewContext
            : init?.method === "POST"
              ? reviewToken
              : { items: [] },
        ),
      ),
    ),
  );
  render(<AgentRegistrationPage />, { wrapper: makeWrapper() });
  await fillReviewForm();
  fireEvent.click(screen.getByTestId("agent-registration-submit"));
  await screen.findByTestId("agent-registration-token-review-token");
  fireEvent.click(screen.getByRole("button", { name: "cp.agentRegistration.tokens.copyCommand" }));
  expect((await screen.findByTestId("agent-registration-copy-error")).textContent).toContain(
    "cp.agentRegistration.tokens.copyFailed",
  );
  expect(screen.getByTestId("agent-registration-command-review-token").textContent).toContain(
    "kq agent register",
  );
});
