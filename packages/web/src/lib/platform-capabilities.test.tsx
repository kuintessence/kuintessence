import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const apiGet = vi.hoisted(() => vi.fn());

vi.mock("./api-client", () => ({ api: { get: apiGet } }));

import { useMeCapabilities } from "./platform-capabilities";

function capabilities(values: Array<"workspace.provider.manage" | "workspace.provider.view">) {
  return {
    principal: {
      userId: "00000000-0000-4000-8000-000000000001",
      email: "provider@test.local",
      role: "user",
    },
    capabilities: values,
    contexts: [{ id: "personal", type: "personal" }],
    activeContextId: "personal",
    devicePolicy: {
      highRiskMutations: "desktop-only",
      mobileMode: "observe-approve",
    },
  } as const;
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  apiGet.mockReset();
  localStorage.clear();
});

describe("useMeCapabilities", () => {
  test("fails closed while capabilities reload for a new active organization", async () => {
    localStorage.setItem("kq_email", "provider@test.local");
    localStorage.setItem("kq_session", "cookie");
    localStorage.setItem("kq_auth_revision", "session-1");
    localStorage.setItem("kq_active_organization_id", "org-a");

    let resolveOperator: ((value: unknown) => void) | undefined;
    apiGet
      .mockResolvedValueOnce(capabilities(["workspace.provider.view", "workspace.provider.manage"]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOperator = resolve;
          }),
      );

    const { result } = renderHook(() => useMeCapabilities(true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data?.capabilities).toContain("workspace.provider.manage");

    localStorage.setItem("kq_active_organization_id", "org-b");
    window.dispatchEvent(new Event("kq:active-organization-change"));

    await waitFor(() => expect(result.current.status).toBe("loading"));
    expect(result.current.data).toBeNull();

    resolveOperator?.(capabilities(["workspace.provider.view"]));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data?.capabilities).not.toContain("workspace.provider.manage");
  });
});
