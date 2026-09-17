import type { JobSubmit, PlacementTrace } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { usePlacementPreview } from "./use-placement-preview";

/**
 * hook driving the placement preview mutation.
 *
 * The hook MUST:
 *   1. start with `trace: null`, `isLoading: false`, `error: null`
 *   2. on `refresh(jobSpec)` POST to `/platform/api/scheduler/preview-placement`
 *      with the spec body and bubble the parsed trace into local state
 *   3. expose the in-flight state via `isLoading`
 *   4. surface ApiError messages via `error`
 *   5. retain the previous successful trace while a new request is in flight
 *      (so the UI doesn't flicker to empty between previews)
 */

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const sampleJob: JobSubmit = {
  name: "preview-job",
  command: "true",
  resources: { cpus: 1, memoryMb: 1024 },
};

function buildTrace(overrides: Partial<PlacementTrace> = {}): PlacementTrace {
  return {
    generatedAt: "2026-05-01T00:00:00.000Z",
    preview: true,
    candidateCount: 1,
    stages: [
      { name: "permission", inputCount: 1, passed: [{ agentId: "ok" }], rejected: [] },
      { name: "software", inputCount: 1, passed: [{ agentId: "ok" }], rejected: [] },
      { name: "billing", inputCount: 1, passed: [{ agentId: "ok" }], rejected: [] },
      { name: "load", inputCount: 1, passed: [{ agentId: "ok" }], rejected: [] },
      { name: "urgency", inputCount: 1, passed: [{ agentId: "ok" }], rejected: [] },
      { name: "install-rights", inputCount: 1, passed: [{ agentId: "ok" }], rejected: [] },
      { name: "manual", inputCount: 1, passed: [{ agentId: "ok" }], rejected: [] },
      {
        name: "auto",
        inputCount: 1,
        passed: [{ agentId: "ok", score: 90 }],
        rejected: [],
      },
    ],
    finalDecision: { agentId: "ok", score: 90 },
    ...overrides,
  };
}

describe("usePlacementPreview", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("initial state is empty", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlacementPreview(), { wrapper: makeWrapper(qc) });
    expect(result.current.trace).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("refresh POSTs to /platform/api/scheduler/preview-placement and stores the trace", async () => {
    const trace = buildTrace();
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(trace), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlacementPreview(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.refresh(sampleJob);
    });

    await waitFor(() => expect(result.current.trace).not.toBeNull());
    expect(result.current.trace?.finalDecision?.agentId).toBe("ok");
    expect(result.current.error).toBeNull();

    // Verify the network call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    const [url, init] = call as unknown as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe("/platform/api/scheduler/preview-placement");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(sampleJob));
  });

  test("surfaces ApiError on a 4xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "bad" } }), {
            status: 400,
          }),
        ),
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlacementPreview(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.refresh(sampleJob).catch(() => {});
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe("bad");
    expect(result.current.trace).toBeNull();
  });

  test("retains the previous successful trace while a second refresh is in flight", async () => {
    let resolveSecond: ((v: Response) => void) | null = null;
    const trace1 = buildTrace({ generatedAt: "1" });
    const fetchSpy = vi
      .fn()
      .mockReturnValueOnce(Promise.resolve(new Response(JSON.stringify(trace1), { status: 200 })))
      .mockImplementationOnce(() => new Promise<Response>((r) => (resolveSecond = r)));
    vi.stubGlobal("fetch", fetchSpy);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlacementPreview(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.refresh(sampleJob);
    });
    expect(result.current.trace?.generatedAt).toBe("1");

    // Kick off the second refresh; while pending the previous trace stays.
    let secondPromise: Promise<PlacementTrace> | null = null;
    act(() => {
      secondPromise = result.current.refresh(sampleJob);
    });
    // Wait until the mutation has flipped into the pending state. We can't
    // observe it synchronously because TanStack Query updates state via
    // async dispatches.
    await waitFor(() => expect(result.current.isLoading).toBe(true));
    expect(result.current.trace?.generatedAt).toBe("1");

    // Resolve and confirm the new trace lands.
    await act(async () => {
      resolveSecond?.(
        new Response(JSON.stringify(buildTrace({ generatedAt: "2" })), { status: 200 }),
      );
      await secondPromise;
    });
    await waitFor(() => expect(result.current.trace?.generatedAt).toBe("2"));
  });

  test("reset clears the trace and any pending error", async () => {
    const trace = buildTrace();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(trace), { status: 200 }))),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlacementPreview(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.refresh(sampleJob);
    });
    expect(result.current.trace).not.toBeNull();

    act(() => {
      result.current.reset();
    });
    expect(result.current.trace).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
