import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetSshStreamSessionsForTests, useSshStream } from "./use-ssh-stream";

/**
 * WebSocket subscription hook for /api/ssh/sessions/:agentId.
 *
 * The hook MUST:
 *   1. open a ws:// URL derived from window.location, carrying a legacy JWT in
 *      the `Sec-WebSocket-Protocol` subprotocol when present, or relying on
 *      the same-origin HttpOnly cookie otherwise
 *   2. transition through `idle` -> `connecting` -> `connected` -> `closed`
 *      on the underlying WebSocket lifecycle
 *   3. forward consumer-sent bytes via `send()` as binary frames
 *   4. surface inbound binary frames as `Uint8Array` to the registered handler
 *   5. clean up on unmount and ignore late events
 *   6. allow the consumer to `reconnect()` a closed session
 */

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  protocol: string | string[] | undefined;
  readyState = MockWebSocket.CONNECTING;
  binaryType = "arraybuffer";
  onopen: ((evt: Event) => void) | null = null;
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onclose: ((evt: CloseEvent) => void) | null = null;
  onerror: ((evt: Event) => void) | null = null;
  closed = false;
  sent: unknown[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocol = protocols;
    MockWebSocket.instances.push(this);
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  triggerMessage(data: ArrayBuffer | Uint8Array | string) {
    this.onmessage?.(new MessageEvent("message", { data }) as MessageEvent);
  }

  triggerClose(code = 1006, reason = "") {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(
      new CloseEvent("close", { code, reason, wasClean: code === 1000 }) as CloseEvent,
    );
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }) as CloseEvent);
  }
}

describe("useSshStream", () => {
  let originalWS: typeof WebSocket;

  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    originalWS = globalThis.WebSocket;
    // @ts-expect-error — assigning mock to global
    globalThis.WebSocket = MockWebSocket;
    resetSshStreamSessionsForTests();
    localStorage.setItem("kq_token", "fake-jwt-for-tests");
  });

  afterEach(() => {
    resetSshStreamSessionsForTests();
    globalThis.WebSocket = originalWS;
    localStorage.removeItem("kq_token");
    vi.restoreAllMocks();
  });

  test("opens a ws connection on mount with the JWT carried in the Sec-WebSocket-Protocol subprotocol", () => {
    const { result } = renderHook(() => useSshStream("agent-1"));
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(new URL(ws?.url ?? "http://invalid").pathname).toBe(
      "/platform/api/ssh/sessions/agent-1",
    );
    // Subprotocol must carry "Bearer, <jwt>" so the Server can recover the token.
    expect(ws?.protocol).toEqual(["Bearer", "fake-jwt-for-tests"]);
    expect(result.current.state).toBe("connecting");
  });

  test("opens a cookie-only socket when no browser-readable token is present", () => {
    localStorage.removeItem("kq_token");
    const { result } = renderHook(() => useSshStream("agent-1"));
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(new URL(ws?.url ?? "http://invalid").pathname).toBe(
      "/platform/api/ssh/sessions/agent-1",
    );
    expect(ws?.protocol).toBeUndefined();
    expect(result.current.state).toBe("connecting");
  });

  test("transitions to `connected` on socket open", () => {
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
    });
    expect(result.current.state).toBe("connected");
  });

  test("`send` forwards Uint8Array bytes to the socket once connected", () => {
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
    });

    const payload = new Uint8Array([0x6c, 0x73, 0x0a]); // "ls\n"
    act(() => {
      result.current.send(payload);
    });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(ws.sent[0] as Uint8Array)).toEqual([0x6c, 0x73, 0x0a]);
  });

  test("`resize` sends a JSON resize control frame once connected", () => {
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
    });
    act(() => {
      result.current.resize(120, 40);
    });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  });

  test("resize is a no-op while connecting", () => {
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      result.current.resize(80, 24);
    });
    expect(ws.sent).toHaveLength(0);
  });

  test("send is a no-op while connecting (does not throw, does not buffer onto a closed socket)", () => {
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      result.current.send(new Uint8Array([0x61]));
    });
    expect(ws.sent).toHaveLength(0);
  });

  test("inbound binary frames invoke the registered `onData` handler with a Uint8Array", () => {
    const onData = vi.fn();
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      result.current.onData(onData);
      ws.triggerOpen();
    });

    const buf = new Uint8Array([0x68, 0x69]).buffer;
    act(() => {
      ws.triggerMessage(buf);
    });

    expect(onData).toHaveBeenCalledTimes(1);
    const arg = onData.mock.calls[0]?.[0] as Uint8Array;
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(Array.from(arg)).toEqual([0x68, 0x69]);
  });

  test("string frames are coerced to Uint8Array via UTF-8", () => {
    const onData = vi.fn();
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      result.current.onData(onData);
      ws.triggerOpen();
      ws.triggerMessage("hi");
    });

    expect(onData).toHaveBeenCalledTimes(1);
    const arg = onData.mock.calls[0]?.[0] as Uint8Array;
    expect(Array.from(arg)).toEqual([0x68, 0x69]);
  });

  test("server-initiated close transitions state to `closed` with code + reason", () => {
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
      ws.triggerClose(4404, "agent offline");
    });

    expect(result.current.state).toBe("closed");
    expect(result.current.lastReason).toBe("agent offline");
  });

  test("`reconnect` re-opens the WebSocket after a close", () => {
    const { result } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
      ws.triggerClose(1006, "boom");
    });
    expect(result.current.state).toBe("closed");

    act(() => {
      result.current.reconnect();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(result.current.state).toBe("connecting");
  });

  test("late messages after unmount are ignored (no callback fires)", () => {
    const onData = vi.fn();
    const { result, unmount } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      result.current.onData(onData);
      ws.triggerOpen();
    });
    unmount();

    // Simulate a late frame after unmount.
    ws.triggerMessage(new Uint8Array([0x61]).buffer);
    expect(onData).not.toHaveBeenCalled();
  });

  test("remounting the same agent reuses the live socket and preserves hidden output", () => {
    const firstOnData = vi.fn();
    const secondOnData = vi.fn();
    const first = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      first.result.current.onData(firstOnData);
      ws.triggerOpen();
    });
    first.unmount();

    expect(ws.closed).toBe(false);
    ws.triggerMessage(new Uint8Array([0x62]).buffer);

    const second = renderHook(() => useSshStream("agent-1"));
    act(() => {
      second.result.current.onData(secondOnData);
      ws.triggerMessage(new Uint8Array([0x63]).buffer);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(firstOnData).not.toHaveBeenCalled();
    expect(second.result.current.readTranscript().map((chunk) => Array.from(chunk))).toEqual([
      [0x62],
      [0x63],
    ]);
    expect(secondOnData).toHaveBeenCalledTimes(1);
    expect(Array.from(secondOnData.mock.calls[0]?.[0] as Uint8Array)).toEqual([0x63]);
  });

  test("restores transcript after in-memory sessions are reset", () => {
    const first = renderHook(() => useSshStream("agent-reload"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
      ws.triggerMessage(new Uint8Array([0x72, 0x65, 0x6c, 0x6f, 0x61, 0x64]).buffer);
    });
    expect(first.result.current.readTranscript().map((chunk) => Array.from(chunk))).toEqual([
      [0x72, 0x65, 0x6c, 0x6f, 0x61, 0x64],
    ]);
    first.unmount();
    resetSshStreamSessionsForTests({ keepStoredTranscripts: true });

    const second = renderHook(() => useSshStream("agent-reload"));

    expect(second.result.current.readTranscript().map((chunk) => Array.from(chunk))).toEqual([
      [0x72, 0x65, 0x6c, 0x6f, 0x61, 0x64],
    ]);
  });

  test("unmount detaches the consumer but keeps the underlying socket alive", () => {
    const { unmount } = renderHook(() => useSshStream("agent-1"));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("expected ws");

    act(() => {
      ws.triggerOpen();
    });
    expect(ws.closed).toBe(false);
    unmount();
    expect(ws.closed).toBe(false);
  });

  test("changing agentId opens a new socket and keeps the old session alive", () => {
    const { rerender } = renderHook(({ id }: { id: string }) => useSshStream(id), {
      initialProps: { id: "agent-1" },
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws1 = MockWebSocket.instances[0];

    rerender({ id: "agent-2" });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(ws1?.closed).toBe(false);
    expect(new URL(MockWebSocket.instances[1]?.url ?? "http://invalid").pathname).toBe(
      "/platform/api/ssh/sessions/agent-2",
    );
  });
});
