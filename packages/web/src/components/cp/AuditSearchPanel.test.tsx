import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key.startsWith("cp.audit.summary.") && typeof opts?.value === "string") {
        return `${key}: ${opts.value}`;
      }
      if (opts && typeof opts === "object") {
        return Object.entries(opts).reduce<string>(
          (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
          key,
        );
      }
      return key;
    },
  }),
}));

import { AuditSearchPanel } from "./AuditSearchPanel";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.setItem("kq_token", "test-token");
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("AuditSearchPanel", () => {
  test("rejects from > to without firing the request", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _opts?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ total: 0, items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AuditSearchPanel />, { wrapper: makeWrapper() });

    fireEvent.change(screen.getByTestId("cp-audit-from"), {
      target: { value: "2026-05-02T00:00" },
    });
    fireEvent.change(screen.getByTestId("cp-audit-to"), {
      target: { value: "2026-05-01T00:00" },
    });

    fireEvent.click(screen.getByTestId("cp-audit-search-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("cp-audit-validation").textContent).toContain(
        "cp.audit.fromAfterTo",
      );
    });

    const callsToAudit = fetchMock.mock.calls.filter((call) => {
      const input = call[0];
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/api/cp/audit/search");
    });
    expect(callsToAudit.length).toBe(0);
  });

  test("submits a valid range and renders results", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _opts?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            total: 3,
            items: [
              {
                id: "ev-1",
                createdAt: "2026-05-01T00:00:00Z",
                actor: "alice@example.com",
                action: "agent_cert_revoked",
                target: "agent:1",
                diff: {
                  after: {
                    nested: {
                      apiKey: "SHOULD_NOT_RENDER_API_KEY",
                      session: {
                        authorization: "SHOULD_NOT_RENDER_AUTHORIZATION",
                        bearer: "SHOULD_NOT_RENDER_BEARER",
                      },
                    },
                    outputs: [
                      {
                        accessKey: "SHOULD_NOT_RENDER_ACCESS_KEY",
                        passphrase: "SHOULD_NOT_RENDER_PASSPHRASE",
                      },
                    ],
                    apiSecret: "SHOULD_NOT_RENDER_SECRET",
                    authToken: "SHOULD_NOT_RENDER_TOKEN",
                    credentialRef: "SHOULD_NOT_RENDER_CREDENTIAL",
                    fingerprint: "f".repeat(64),
                    password: "SHOULD_NOT_RENDER_PASSWORD",
                    pem: "SHOULD_NOT_RENDER_PEM",
                    privateKey: "SHOULD_NOT_RENDER_PRIVATE_KEY",
                    privateKeyPem: "SHOULD_NOT_RENDER",
                    reason: "key rotation",
                    revokedAt: "2026-05-01T00:01:00.000Z",
                    errorMessage: "Authorization denied: SHOULD_NOT_RENDER_DIAGNOSTIC",
                    stack: "Error: SHOULD_NOT_RENDER_STACK",
                    stderr: "SHOULD_NOT_RENDER_STDERR",
                    stdout: "SHOULD_NOT_RENDER_STDOUT",
                  },
                },
              },
              {
                id: "ev-ssh",
                createdAt: "2026-05-01T00:02:00Z",
                actor: "bob@example.com",
                action: "ssh.session_open",
                target: "agent:2",
                diff: null,
              },
              {
                id: "ev-auth",
                createdAt: "2026-05-01T00:03:00Z",
                actor: "carol@example.com",
                action: "auth.oidc.callback",
                target: "user:3",
                diff: null,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AuditSearchPanel />, { wrapper: makeWrapper() });

    fireEvent.change(screen.getByTestId("cp-audit-from"), {
      target: { value: "2026-04-30T00:00" },
    });
    fireEvent.change(screen.getByTestId("cp-audit-to"), {
      target: { value: "2026-05-02T00:00" },
    });
    fireEvent.click(screen.getByTestId("cp-audit-search-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("cp-audit-row-ev-1")).toBeTruthy();
    });
    expect(screen.getByTestId("cp-audit-row-ev-1").textContent).toContain("alice@example.com");
    expect(screen.getByTestId("cp-audit-row-ev-1").textContent).toContain(
      "cp.audit.category.security",
    );
    expect(screen.getByTestId("cp-audit-row-ev-ssh").textContent).toContain(
      "cp.audit.category.security",
    );
    expect(screen.getByTestId("cp-audit-row-ev-auth").textContent).toContain(
      "cp.audit.category.security",
    );
    expect(screen.getByTestId("cp-audit-row-ev-1").textContent).toContain(
      "cp.audit.summary.reason",
    );
    expect(screen.getByTestId("cp-audit-row-ev-1").textContent).toContain("key rotation");
    expect(screen.getByTestId("cp-audit-row-ev-1").textContent).toContain("f".repeat(64));
    const scroller = screen.getByTestId("cp-audit-table-scroll");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.querySelector("table")?.className).toContain("min-w-[72rem]");
    expect(screen.queryByTestId("cp-audit-details-ev-1")).toBeNull();

    fireEvent.click(screen.getByTestId("cp-audit-details-toggle-ev-1"));

    await waitFor(() => {
      expect(screen.getByTestId("cp-audit-details-ev-1")).toBeTruthy();
    });
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).toContain("[redacted]");
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).toContain(
      "[internal details hidden]",
    );
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).not.toContain(
      "SHOULD_NOT_RENDER_SECRET",
    );
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).not.toContain(
      "SHOULD_NOT_RENDER_TOKEN",
    );
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).not.toContain(
      "SHOULD_NOT_RENDER_PASSWORD",
    );
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).not.toContain(
      "SHOULD_NOT_RENDER_CREDENTIAL",
    );
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).not.toContain(
      "SHOULD_NOT_RENDER_PRIVATE_KEY",
    );
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).not.toContain(
      "SHOULD_NOT_RENDER_PEM",
    );
    expect(screen.getByTestId("cp-audit-details-ev-1").textContent).not.toContain(
      "SHOULD_NOT_RENDER",
    );

    fireEvent.click(screen.getByTestId("cp-audit-filter-action-ev-1"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { text?: string };
    expect(secondBody.text).toBe("agent_cert_revoked");

    fireEvent.click(screen.getByTestId("cp-audit-filter-target-ev-1"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    const thirdBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { text?: string };
    expect(thirdBody.text).toBe("agent:1");
  });

  test("surfaces search errors without showing stale audit results", async () => {
    localStorage.setItem("kq.lang", "en");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total: 1,
            items: [
              {
                id: "ev-stale",
                createdAt: "2026-05-01T00:00:00Z",
                actor: "alice@example.com",
                action: "agent_cert_revoked",
                target: "agent:1",
                diff: null,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: "Authorization principal is not bound",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<AuditSearchPanel />, { wrapper: makeWrapper() });

    fireEvent.change(screen.getByTestId("cp-audit-from"), {
      target: { value: "2026-04-30T00:00" },
    });
    fireEvent.change(screen.getByTestId("cp-audit-to"), {
      target: { value: "2026-05-02T00:00" },
    });
    fireEvent.click(screen.getByTestId("cp-audit-search-submit"));
    await waitFor(() => screen.getByTestId("cp-audit-row-ev-stale"));

    fireEvent.click(screen.getByTestId("cp-audit-search-submit"));

    await waitFor(() => screen.getByTestId("cp-audit-error"));
    expect(screen.getByTestId("cp-audit-error").textContent).toContain(
      "Your account does not have permission",
    );
    expect(screen.getByTestId("cp-audit-error").textContent).not.toContain(
      "Authorization principal is not bound",
    );
    expect(screen.queryByTestId("cp-audit-row-ev-stale")).toBeNull();
    expect(screen.queryByTestId("cp-audit-total")).toBeNull();
    expect(screen.queryByTestId("cp-audit-empty")).toBeNull();
  });
});
