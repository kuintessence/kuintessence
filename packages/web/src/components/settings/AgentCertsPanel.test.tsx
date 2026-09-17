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

import { AgentCertsPanel } from "./AgentCertsPanel";

interface FetchCall {
  url: string;
  method: string;
  body?: BodyInit | null;
}

function installFetch(handlers: Array<(c: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const queue = [...handlers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: BodyInit | null; method?: string }) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const call = { url, method: init?.method ?? "GET", body: init?.body };
      calls.push(call);
      const handler = queue.shift();
      if (!handler) throw new Error(`Unexpected fetch: ${call.method} ${url}`);
      return handler(call);
    }),
  );
  return calls;
}

const fp = "a".repeat(64);

function certList(certs = [{ revokedAt: null as string | null }]) {
  return new Response(
    JSON.stringify({
      certs: certs.map((cert) => ({
        id: "cert-1",
        fingerprintSha256: fp,
        subjectCn: "agent-1",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
        issuedBy: "user-1",
        revokedAt: cert.revokedAt,
      })),
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("AgentCertsPanel", () => {
  test("loads cert metadata for an agent", async () => {
    const calls = installFetch([() => certList()]);
    render(<AgentCertsPanel />);

    fireEvent.change(screen.getByTestId("agent-certs-agent-id"), {
      target: { value: "agent-1" },
    });
    fireEvent.click(screen.getByTestId("agent-certs-load"));

    await waitFor(() => screen.getByTestId(`agent-cert-row-${fp}`));
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "/platform/api/admin/agents/agent-1/certs",
    });
    expect(screen.getByTestId(`agent-cert-row-${fp}`).textContent).toContain(fp);
  });

  test("surfaces load errors without showing an empty cert ledger", async () => {
    installFetch([
      () => certList([]),
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
    render(<AgentCertsPanel />);

    fireEvent.change(screen.getByTestId("agent-certs-agent-id"), {
      target: { value: "agent-1" },
    });
    fireEvent.click(screen.getByTestId("agent-certs-load"));
    await waitFor(() => screen.getByTestId("agent-certs-empty"));

    fireEvent.click(screen.getByTestId("agent-certs-load"));

    await waitFor(() => screen.getByTestId("agent-certs-error"));
    const error = screen.getByTestId("agent-certs-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("Authorization principal is not bound");
    expect(error.textContent).not.toContain("FORBIDDEN");
    expect(screen.queryByTestId("agent-certs-idle")).toBeNull();
    expect(screen.queryByTestId("agent-certs-empty")).toBeNull();
    expect(screen.queryByTestId(`agent-cert-revoke-${fp}`)).toBeNull();
  });

  test("revokes an active cert and refreshes the list", async () => {
    const calls = installFetch([
      () => certList(),
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      () => certList([{ revokedAt: "2026-01-02T00:00:00.000Z" }]),
    ]);
    render(<AgentCertsPanel />);

    fireEvent.change(screen.getByTestId("agent-certs-agent-id"), {
      target: { value: "agent-1" },
    });
    fireEvent.click(screen.getByTestId("agent-certs-load"));
    await waitFor(() => screen.getByTestId(`agent-cert-revoke-${fp}`));
    fireEvent.click(screen.getByTestId(`agent-cert-revoke-${fp}`));
    fireEvent.change(screen.getByTestId("agent-cert-revoke-reason"), {
      target: { value: "compromised host" },
    });
    fireEvent.click(screen.getByTestId("agent-cert-revoke-confirm"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.url === `/platform/api/admin/agents/agent-1/cert/${fp}/revoke` &&
          call.body === JSON.stringify({ reason: "compromised host" }),
      ),
    ).toBe(true);
  });
});
