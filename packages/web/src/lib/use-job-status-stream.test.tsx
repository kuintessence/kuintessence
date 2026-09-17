import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useJobStatusStream, useWorkflowStatusStream } from "./use-job-status-stream";

/**
 * WebSocket subscription hook for /ws/jobs/:id.
 *
 * The hook MUST:
 *   1. open a ws:// URL derived from window.location with either a legacy
 *      JWT query token or a same-origin HttpOnly cookie
 *   2. apply incoming { type: "job.status", … } payloads to the
 *      ["job-detail", jobId] query cache
 *   3. fall back to polling — i.e. invalidate the query — if the socket
 *      closes without a clean code, so TanStack Query refetches via REST
 *   4. clean up on unmount (close socket, no leaked listeners)
 *
 * We mock `WebSocket` globally so we can drive open/message/close events
 * deterministically.
 */

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  onopen: ((evt: Event) => void) | null = null;
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onclose: ((evt: CloseEvent) => void) | null = null;
  onerror: ((evt: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  triggerMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }) as MessageEvent);
  }

  triggerClose(code = 1006) {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code, wasClean: code === 1000 }) as CloseEvent);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("useJobStatusStream", () => {
  let originalWS: typeof WebSocket;

  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    originalWS = globalThis.WebSocket;
    // @ts-expect-error — assigning mock to global
    globalThis.WebSocket = MockWebSocket;
    localStorage.setItem("kq_token", "fake-jwt-for-tests");
  });

  afterEach(() => {
    globalThis.WebSocket = originalWS;
    localStorage.removeItem("kq_token");
    vi.restoreAllMocks();
  });

  test("opens a ws connection with token query parameter on the right path", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useJobStatusStream("job-1"), { wrapper: makeWrapper(qc) });

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    const url = new URL(ws?.url ?? "http://invalid");
    expect(url.pathname).toBe("/platform/ws/jobs/job-1");
    expect(url.searchParams.get("token")).toBe("fake-jwt-for-tests");
  });

  test("opens a cookie-only ws connection when no browser-readable token exists", () => {
    localStorage.removeItem("kq_token");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useJobStatusStream("job-1"), { wrapper: makeWrapper(qc) });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(new URL(MockWebSocket.instances[0]?.url ?? "http://invalid").pathname).toBe(
      "/platform/ws/jobs/job-1",
    );
  });

  test("does not open a socket when jobId is null", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useJobStatusStream(null), { wrapper: makeWrapper(qc) });
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  test("applies incoming job.status messages to the query cache", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["job-detail", "job-1"], {
      id: "job-1",
      name: "test",
      status: "pending",
    });

    renderHook(() => useJobStatusStream("job-1"), { wrapper: makeWrapper(qc) });
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
      ws.triggerMessage({
        type: "job.status",
        jobId: "job-1",
        status: "running",
        schedulerJobId: "slurm-99",
        agentId: null,
        ts: new Date().toISOString(),
      });
    });

    const cached = qc.getQueryData<{ status: string; schedulerJobId: string | null }>([
      "job-detail",
      "job-1",
    ]);
    expect(cached?.status).toBe("running");
    expect(cached?.schedulerJobId).toBe("slurm-99");
  });

  test("ignores messages with mismatched type or jobId", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["job-detail", "job-1"], { id: "job-1", status: "pending" });

    renderHook(() => useJobStatusStream("job-1"), { wrapper: makeWrapper(qc) });
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
      ws.triggerMessage({ type: "ping" });
      ws.triggerMessage({ type: "job.status", jobId: "different-job", status: "completed" });
    });

    const cached = qc.getQueryData<{ status: string }>(["job-detail", "job-1"]);
    expect(cached?.status).toBe("pending");
  });

  test("invalidates the query (REST fallback) when the socket closes uncleanly", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["job-detail", "job-1"], { id: "job-1", status: "running" });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    renderHook(() => useJobStatusStream("job-1"), { wrapper: makeWrapper(qc) });
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
      ws.triggerClose(1006); // abnormal closure
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["job-detail", "job-1"] }),
    );
  });

  test("closes the socket on unmount and does not leak listeners", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useJobStatusStream("job-1"), {
      wrapper: makeWrapper(qc),
    });

    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
    });
    expect(ws.closed).toBe(false);

    unmount();
    expect(ws.closed).toBe(true);
  });

  test("changing jobId opens a new socket and closes the old one", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(({ id }: { id: string }) => useJobStatusStream(id), {
      initialProps: { id: "job-1" },
      wrapper: makeWrapper(qc),
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws1 = MockWebSocket.instances[0];

    rerender({ id: "job-2" });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(ws1?.closed).toBe(true);
    expect(new URL(MockWebSocket.instances[1]?.url ?? "http://invalid").pathname).toBe(
      "/platform/ws/jobs/job-2",
    );
  });
});

describe("useWorkflowStatusStream", () => {
  let originalWS: typeof WebSocket;

  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    originalWS = globalThis.WebSocket;
    // @ts-expect-error — assigning mock to global
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWS;
    vi.restoreAllMocks();
  });

  test("opens a cookie-only ws connection when no browser-readable token exists", () => {
    localStorage.removeItem("kq_token");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useWorkflowStatusStream("run-1"), { wrapper: makeWrapper(qc) });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(new URL(MockWebSocket.instances[0]?.url ?? "http://invalid").pathname).toBe(
      "/platform/ws/workflows/run-1",
    );
  });
});
