import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

import { SshCredentialsForm } from "./SshCredentialsForm";

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

function installFetch(handlers: Array<(call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const queue = [...handlers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const call: FetchCall = { url, method: init?.method ?? "GET", body: init?.body };
      calls.push(call);
      const handler = queue.shift();
      if (!handler) throw new Error(`Unexpected fetch: ${call.method} ${url}`);
      return handler(call);
    }),
  );
  return calls;
}

const oneAgent = () =>
  new Response(
    JSON.stringify({
      credentials: [
        {
          agentId: "agent-1",
          host: "login01",
          port: 22,
          username: "alice",
          hasSecret: true,
          updatedAt: null,
          updatedBy: "admin@x",
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

describe("SshCredentialsForm", () => {
  test("lists configured agents (no secrets shown)", async () => {
    installFetch([() => oneAgent()]);
    render(<SshCredentialsForm />);
    await waitFor(() => screen.getByTestId("ssh-cred-row-agent-1"));
    const row = screen.getByTestId("ssh-cred-row-agent-1");
    expect(row.textContent).toContain("alice@login01:22");
    expect(row.textContent).toContain("secret set");
  });

  test("shows the empty state when no agents are configured", async () => {
    installFetch([() => new Response(JSON.stringify({ credentials: [] }), { status: 200 })]);
    render(<SshCredentialsForm />);
    await waitFor(() => screen.getByTestId("ssh-cred-empty"));
  });

  test("surfaces load errors without showing an empty credential list", async () => {
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

    render(<SshCredentialsForm />);

    await waitFor(() => screen.getByTestId("ssh-load-error"));
    expect(screen.getByTestId("ssh-load-error").textContent).not.toContain(
      "Authorization principal is not bound",
    );
    expect(screen.queryByTestId("ssh-cred-empty")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByTestId("ssh-cred-save")).toHaveProperty("disabled", true);
  });

  test("keeps stale credential rows visible but disables actions after refresh errors", async () => {
    const calls = installFetch([
      () => oneAgent(),
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
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
    render(<SshCredentialsForm />);

    await waitFor(() => screen.getByTestId("ssh-cred-row-agent-1"));
    fireEvent.change(screen.getByTestId("ssh-agent-id"), { target: { value: "agent-2" } });
    fireEvent.change(screen.getByTestId("ssh-host"), { target: { value: "login02" } });
    fireEvent.change(screen.getByTestId("ssh-username"), { target: { value: "bob" } });
    fireEvent.click(screen.getByTestId("ssh-cred-save"));

    await waitFor(() => screen.getByTestId("ssh-load-error"));
    expect(screen.getByTestId("ssh-load-error").textContent).not.toContain(
      "Authorization principal is not bound",
    );
    expect(screen.getByTestId("ssh-cred-row-agent-1").textContent).toContain("alice@login01:22");
    expect(screen.getByTestId("ssh-cred-edit-agent-1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("ssh-cred-delete-agent-1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("ssh-cred-save")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("ssh-cred-delete-agent-1"));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  test("PUTs credentials on save and refreshes", async () => {
    const calls = installFetch([
      () => new Response(JSON.stringify({ credentials: [] }), { status: 200 }), // initial list
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }), // PUT
      () => oneAgent(), // refresh
    ]);
    render(<SshCredentialsForm />);
    await waitFor(() => screen.getByTestId("ssh-cred-empty"));

    fireEvent.change(screen.getByTestId("ssh-agent-id"), { target: { value: "agent-1" } });
    fireEvent.change(screen.getByTestId("ssh-host"), { target: { value: "login01" } });
    fireEvent.change(screen.getByTestId("ssh-username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByTestId("ssh-password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByTestId("ssh-cred-save"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/api/admin/ssh-credentials/agent-1");
    const sent = JSON.parse(put?.body ?? "{}");
    expect(sent.username).toBe("alice");
    expect(sent.password).toBe("hunter2");
  });

  test("DELETE removes an agent's credentials", async () => {
    const calls = installFetch([
      () => oneAgent(), // initial list
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }), // DELETE
      () => new Response(JSON.stringify({ credentials: [] }), { status: 200 }), // refresh
    ]);
    render(<SshCredentialsForm />);
    await waitFor(() => screen.getByTestId("ssh-cred-delete-agent-1"));
    fireEvent.click(screen.getByTestId("ssh-cred-delete-agent-1"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("agent-1"))).toBe(true);
  });
});
