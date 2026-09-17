import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k,
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { SshActiveSessions } from "./SshActiveSessions";

interface FetchCall {
  url: string;
  method: string;
}

function installFetch(handlers: Array<(c: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const queue = [...handlers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const call = { url, method: init?.method ?? "GET" };
      calls.push(call);
      const h = queue.shift();
      if (!h) throw new Error(`Unexpected fetch: ${call.method} ${url}`);
      return h(call);
    }),
  );
  return calls;
}

const oneSession = () =>
  new Response(
    JSON.stringify({
      sessions: [
        {
          sessionId: "sess-12345678",
          agentId: "agent-1",
          user: "alice@x",
          sourceIp: "10.0.0.1",
          openedAtMs: 1000,
          durationMs: 65000,
        },
      ],
    }),
    { status: 200 },
  );

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("SshActiveSessions", () => {
  test("lists live sessions", async () => {
    installFetch([() => oneSession()]);
    render(<SshActiveSessions />);
    await waitFor(() => screen.getByTestId("ssh-sess-row-sess-12345678"));
    const row = screen.getByTestId("ssh-sess-row-sess-12345678");
    expect(row.textContent).toContain("alice@x");
    expect(row.textContent).toContain("agent-1");
    expect(row.textContent).toContain("1m 5s"); // 65000ms
  });

  test("empty state when no sessions", async () => {
    installFetch([() => new Response(JSON.stringify({ sessions: [] }), { status: 200 })]);
    render(<SshActiveSessions />);
    await waitFor(() => screen.getByTestId("ssh-sess-empty"));
  });

  test("surfaces load errors without showing an empty sessions list", async () => {
    installFetch([
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: "Authorization principal is not bound",
            },
          }),
          { status: 403 },
        ),
    ]);

    render(<SshActiveSessions />);

    await waitFor(() => screen.getByTestId("ssh-sess-error"));
    expect(screen.getByTestId("ssh-sess-error").textContent).not.toContain(
      "Authorization principal is not bound",
    );
    expect(screen.queryByTestId("ssh-sess-empty")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  test("keeps stale sessions visible but disables force-disconnect after refresh errors", async () => {
    installFetch([
      () => oneSession(),
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: "Authorization principal is not bound",
            },
          }),
          { status: 403 },
        ),
    ]);

    render(<SshActiveSessions />);

    await waitFor(() => screen.getByTestId("ssh-sess-row-sess-12345678"));
    fireEvent.click(screen.getByTestId("ssh-sess-refresh"));

    await waitFor(() => screen.getByTestId("ssh-sess-error"));
    expect(screen.getByTestId("ssh-sess-row-sess-12345678").textContent).toContain("alice@x");
    expect(screen.getByTestId("ssh-sess-error").textContent).not.toContain(
      "Authorization principal is not bound",
    );
    expect(screen.getByTestId("ssh-sess-kill-sess-12345678")).toHaveProperty("disabled", true);
  });

  test("force-disconnect issues DELETE and refreshes", async () => {
    const calls = installFetch([
      () => oneSession(), // initial list
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }), // DELETE
      () => new Response(JSON.stringify({ sessions: [] }), { status: 200 }), // refresh
    ]);
    render(<SshActiveSessions />);
    await waitFor(() => screen.getByTestId("ssh-sess-kill-sess-12345678"));
    fireEvent.click(screen.getByTestId("ssh-sess-kill-sess-12345678"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("sess-12345678"))).toBe(true);
    await waitFor(() => screen.getByTestId("ssh-sess-empty"));
  });
});
