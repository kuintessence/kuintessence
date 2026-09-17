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
      return key;
    },
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { AgentRegistrationPage } from "./AgentRegistrationPage";
import { AuditSearchPanel } from "./AuditSearchPanel";
import { CpAgentsTable } from "./CpAgentsTable";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function findCall(
  spy: ReturnType<typeof vi.fn>,
  predicate: (url: string, init: RequestInit | undefined) => boolean,
): { url: string; init: RequestInit | undefined } {
  for (const call of spy.mock.calls) {
    const url = typeof call[0] === "string" ? call[0] : String(call[0]);
    const init = call[1] as RequestInit | undefined;
    if (predicate(url, init)) return { url, init };
  }
  throw new Error("matching fetch call missing");
}

beforeEach(() => {
  localStorage.setItem("kq_token", "test-token");
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("CP operations flow", () => {
  test("issues an agent token, revokes a cert with a reason, and finds the reason in audit", async () => {
    const fingerprint = "f".repeat(64);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/platform/api/cp/agent-registration-context" && method === "GET") {
        return Promise.resolve(
          json({
            providerOrgs: [{ id: "org-1", name: "Provider One" }],
            isPlatformWide: false,
            schedulers: ["slurm", "pbs-pro", "torque", "kubernetes"],
          }),
        );
      }
      if (url === "/platform/api/cp/agent-registration-tokens" && method === "GET") {
        return Promise.resolve(json({ items: [] }));
      }
      if (url === "/platform/api/cp/agent-registration-tokens" && method === "POST") {
        return Promise.resolve(
          json({
            id: "intent-1",
            agentId: "agent-1",
            siteName: "site-a",
            providerOrgId: "org-1",
            token: "kqreg_plain",
            expiresAt: "2026-07-08T00:00:00.000Z",
          }),
        );
      }
      if (url === "/platform/api/cp/agents" && method === "GET") {
        return Promise.resolve(
          json({
            items: [{ id: "agent-1", hostname: "host-1", siteId: "site-a", status: "online" }],
          }),
        );
      }
      if (url === "/platform/api/cp/agents/agent-1/certs" && method === "GET") {
        return Promise.resolve(
          json({
            certs: [
              {
                id: "cert-1",
                fingerprintSha256: fingerprint,
                subjectCn: "agent-1",
                issuedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2027-01-01T00:00:00.000Z",
                revokedAt: null,
                issuedBy: "user-1",
              },
            ],
          }),
        );
      }
      if (
        url === `/platform/api/cp/agents/agent-1/certs/${fingerprint}/revoke` &&
        method === "POST"
      ) {
        return Promise.resolve(json({ success: true }));
      }
      if (url === "/platform/api/cp/audit/search" && method === "POST") {
        return Promise.resolve(
          json({
            total: 1,
            items: [
              {
                id: "audit-1",
                createdAt: "2026-07-08T00:01:00.000Z",
                actor: "cp-admin@example.com",
                action: "agent_cert_revoked",
                target: "agent:agent-1",
                diff: {
                  after: {
                    fingerprint,
                    reason: "key rotation",
                    revokedAt: "2026-07-08T00:01:00.000Z",
                  },
                },
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const registration = render(<AgentRegistrationPage />, { wrapper: makeWrapper() });
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
    fireEvent.click(screen.getByTestId("agent-registration-submit"));
    await waitFor(() => screen.getByTestId("agent-registration-token-intent-1"));
    expect(screen.getByTestId("agent-registration-command-intent-1").textContent).toContain(
      "kq agent register",
    );
    expect(
      findCall(
        fetchMock,
        (url, init) =>
          url === "/platform/api/cp/agent-registration-tokens" && init?.method === "POST",
      ).init?.body,
    ).toBe(
      JSON.stringify({
        providerOrgId: "org-1",
        agentId: "agent-1",
        siteName: "site-a",
        expiresInSec: 86400,
      }),
    );
    registration.unmount();

    const agents = render(<CpAgentsTable />, { wrapper: makeWrapper() });
    await waitFor(() => screen.getByTestId("cp-agents-row-agent-1"));
    fireEvent.click(screen.getByTestId("cp-agent-certs-toggle-agent-1"));
    await waitFor(() => screen.getByTestId(`cp-agent-cert-row-${fingerprint}`));
    fireEvent.click(screen.getByTestId(`cp-agent-cert-revoke-${fingerprint}`));
    fireEvent.change(screen.getByTestId("cp-agent-cert-revoke-reason"), {
      target: { value: "key rotation" },
    });
    fireEvent.click(screen.getByTestId("cp-agent-cert-revoke-confirm"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("cp.agents.certs.revoked"));
    expect(
      findCall(
        fetchMock,
        (url, init) =>
          url === `/platform/api/cp/agents/agent-1/certs/${fingerprint}/revoke` &&
          init?.method === "POST",
      ).init?.body,
    ).toBe(JSON.stringify({ reason: "key rotation" }));
    agents.unmount();

    render(<AuditSearchPanel />, { wrapper: makeWrapper() });
    fireEvent.change(screen.getByTestId("cp-audit-from"), {
      target: { value: "2026-07-08T00:00" },
    });
    fireEvent.change(screen.getByTestId("cp-audit-to"), {
      target: { value: "2026-07-08T01:00" },
    });
    fireEvent.change(screen.getByTestId("cp-audit-text"), {
      target: { value: "key rotation" },
    });
    fireEvent.click(screen.getByTestId("cp-audit-search-submit"));
    await waitFor(() => screen.getByTestId("cp-audit-row-audit-1"));
    expect(screen.getByTestId("cp-audit-row-audit-1").textContent).toContain("key rotation");
    expect(screen.getByTestId("cp-audit-row-audit-1").textContent).toContain(fingerprint);
    const auditBody = JSON.parse(
      String(findCall(fetchMock, (url) => url === "/platform/api/cp/audit/search").init?.body),
    ) as { text?: string };
    expect(auditBody.text).toBe("key rotation");
  });
});
