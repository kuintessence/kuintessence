import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
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
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  apiGet.mockReset();
  localStorage.clear();
});

describe("useMeCapabilities", () => {
  test("refreshes on window return and stops checking when disabled", async () => {
    vi.useFakeTimers();
    apiGet.mockResolvedValue(capabilities(["workspace.provider.view"]));
    const { result, rerender, unmount } = renderHook((enabled) => useMeCapabilities(enabled), {
      initialProps: true,
      wrapper: wrapper(),
    });
    await act(() => vi.advanceTimersByTimeAsync(1));
    act(() => focusManager.setFocused(false));
    apiGet.mockResolvedValue(capabilities([]));
    act(() => focusManager.setFocused(true));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.data?.capabilities).toEqual([]);
    rerender(false);
    apiGet.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    unmount();
  });

  test("updates an open page on grants and revocations and fails closed on refresh errors", async () => {
    vi.useFakeTimers();
    apiGet.mockResolvedValue(capabilities(["workspace.provider.view"]));
    const { result, unmount } = renderHook(() => useMeCapabilities(true), { wrapper: wrapper() });
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.data?.capabilities).not.toContain("workspace.provider.manage");

    apiGet.mockResolvedValue(
      capabilities(["workspace.provider.view", "workspace.provider.manage"]),
    );
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.data?.capabilities).toContain("workspace.provider.manage");

    apiGet.mockResolvedValue(capabilities(["workspace.provider.view"]));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.data?.capabilities).not.toContain("workspace.provider.manage");

    apiGet.mockRejectedValue(new Error("network unavailable"));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.status).toBe("error");
    expect(result.current.data).toBeNull();
    unmount();
  });

  test("fails closed while capabilities reload for a new active organization", async () => {
    localStorage.setItem("kq_email", "provider@test.local");
    localStorage.setItem("kq_session", "cookie");
    localStorage.setItem("kq_auth_revision", "session-1");
    localStorage.setItem("kq_active_organization_id", "org-a");

    let resolveOperator: ((value: unknown) => void) | undefined;
    const operatorResponse = new Promise((resolve) => {
      resolveOperator = resolve;
    });
    apiGet
      .mockResolvedValueOnce(capabilities(["workspace.provider.view", "workspace.provider.manage"]))
      .mockReturnValue(operatorResponse);

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
