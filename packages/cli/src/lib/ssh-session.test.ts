import { describe, expect, test } from "bun:test";
import { runSshSession, type SshWsLike } from "./ssh-session";

// -----------------------------------------------------------------------------
// In-process WebSocket stub. Mimics the small surface runSshSession touches:
//   send / close / addEventListener('open'|'message'|'close'|'error', cb)
// Tests drive open/message/close manually via fireOpen / fireMessage / fireClose.
// -----------------------------------------------------------------------------

interface FakeListeners {
  open: Array<(ev: Event) => void>;
  message: Array<(ev: MessageEvent<unknown>) => void>;
  close: Array<(ev: CloseEvent) => void>;
  error: Array<(ev: Event) => void>;
}

interface FakeWs extends SshWsLike {
  sent: Uint8Array[];
  sentText: string[];
  closed: { code?: number; reason?: string } | null;
  fireOpen(): void;
  fireMessage(data: Uint8Array | string | ArrayBuffer): void;
  fireClose(code: number, reason: string): void;
  fireError(): void;
}

function makeFakeWs(): FakeWs {
  const listeners: FakeListeners = { open: [], message: [], close: [], error: [] };
  const sent: Uint8Array[] = [];
  const sentText: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  return {
    send(data) {
      if (typeof data === "string") {
        sentText.push(data);
      } else if (data instanceof Uint8Array) {
        sent.push(new Uint8Array(data));
      } else if (data instanceof ArrayBuffer) {
        sent.push(new Uint8Array(data));
      } else if (typeof (data as ArrayBufferView).buffer !== "undefined") {
        const view = data as ArrayBufferView;
        sent.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      }
    },
    close(code, reason) {
      closed = { code, reason };
    },
    addEventListener(type, cb) {
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      (listeners[type as keyof FakeListeners] as any[]).push(cb as any);
    },
    get sent() {
      return sent;
    },
    get sentText() {
      return sentText;
    },
    get closed() {
      return closed;
    },
    fireOpen() {
      for (const cb of listeners.open) cb(new Event("open"));
    },
    fireMessage(data) {
      const evt = { data } as MessageEvent<unknown>;
      for (const cb of listeners.message) cb(evt);
    },
    fireClose(code, reason) {
      const evt = { code, reason, wasClean: code === 1000 } as unknown as CloseEvent;
      for (const cb of listeners.close) cb(evt);
    },
    fireError() {
      for (const cb of listeners.error) cb(new Event("error"));
    },
  };
}

// Minimal stdin stub. runSshSession should attach a 'data' handler and
// a 'end' handler. We expose helpers to push bytes / EOF.
type FakeStdinHandler = (...args: unknown[]) => void;

interface FakeStdin {
  emitData(buf: Uint8Array): void;
  emitEnd(): void;
  isRaw: boolean;
  rawCalls: boolean[];
  setRawMode(value: boolean): unknown;
  // Loose `on` shape — assignable to the overloaded SshStdinLike.on().
  // biome-ignore lint/suspicious/noExplicitAny: test fake intentionally permissive
  on(event: any, cb: any): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: test fake intentionally permissive
  off(event: any, cb: any): unknown;
  handlerCount(event: "data" | "end"): number;
  pause(): unknown;
  resume(): unknown;
}

function makeFakeStdin(): FakeStdin {
  const handlers: Record<string, FakeStdinHandler[]> = {
    data: [],
    end: [],
  };
  const rawCalls: boolean[] = [];
  const stdin: FakeStdin = {
    emitData(buf) {
      for (const cb of handlers.data ?? []) cb(buf);
    },
    emitEnd() {
      for (const cb of handlers.end ?? []) cb();
    },
    isRaw: false,
    rawCalls,
    setRawMode(value) {
      this.isRaw = value;
      rawCalls.push(value);
      return this;
    },
    on(event, cb) {
      handlers[event as string] ??= [];
      handlers[event as string]?.push(cb as FakeStdinHandler);
      return this;
    },
    off(event, cb) {
      const current = handlers[event as string] ?? [];
      handlers[event as string] = current.filter((handler) => handler !== cb);
      return this;
    },
    handlerCount(event) {
      return handlers[event]?.length ?? 0;
    },
    pause() {
      return this;
    },
    resume() {
      return this;
    },
  };
  return stdin;
}

interface FakeWriter {
  chunks: Uint8Array[];
  write(buf: Uint8Array | string): boolean;
}

function makeFakeWriter(): FakeWriter {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write(buf) {
      const bytes = typeof buf === "string" ? new TextEncoder().encode(buf) : buf;
      chunks.push(new Uint8Array(bytes));
      return true;
    },
  };
}

function decodeAll(chunks: Uint8Array[]): string {
  const dec = new TextDecoder();
  return chunks.map((c) => dec.decode(c)).join("");
}

// Fake terminal resize source: drives onResize callbacks and reports a
// settable size, mirroring `process.stdout` (columns/rows + 'resize' event).
function makeFakeResize(cols: number, rows: number) {
  let size = { cols, rows };
  const cbs: Array<() => void> = [];
  let offCount = 0;
  return {
    getSize: () => size,
    onResize: (cb: () => void) => {
      cbs.push(cb);
    },
    offResize: (cb: () => void) => {
      offCount++;
      const i = cbs.indexOf(cb);
      if (i >= 0) cbs.splice(i, 1);
    },
    setSize(c: number, r: number) {
      size = { cols: c, rows: r };
    },
    fire() {
      for (const cb of [...cbs]) cb();
    },
    get offCount() {
      return offCount;
    },
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("runSshSession", () => {
  test("forwards stdin bytes to the websocket as binary frames", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: false,
      agentId: "agent-1",
    });

    // Drive the lifecycle: open, push stdin, close.
    ws.fireOpen();
    stdin.emitData(new Uint8Array([0x68, 0x69])); // "hi"
    stdin.emitData(new Uint8Array([0x0a])); // "\n"
    ws.fireClose(1000, "ssh ended");

    const result = await sessionPromise;

    expect(ws.sent.length).toBe(2);
    expect(Array.from(ws.sent[0] ?? [])).toEqual([0x68, 0x69]);
    expect(Array.from(ws.sent[1] ?? [])).toEqual([0x0a]);
    expect(result.exitCode).toBe(0);
  });

  test("removes stdin listeners when the session closes", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout: makeFakeWriter(),
      stderr: makeFakeWriter(),
      isTty: true,
      noTty: false,
      agentId: "agent-1",
    });

    ws.fireOpen();
    expect(stdin.handlerCount("data")).toBe(1);
    expect(stdin.handlerCount("end")).toBe(1);
    ws.fireClose(1000, "ssh ended");
    await sessionPromise;

    expect(stdin.handlerCount("data")).toBe(0);
    expect(stdin.handlerCount("end")).toBe(0);
    stdin.emitData(new Uint8Array([0x71]));
    expect(ws.sent).toHaveLength(0);
  });

  test("writes inbound binary messages to stdout (Uint8Array, ArrayBuffer)", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: false,
      agentId: "agent-1",
    });

    ws.fireOpen();

    const u8 = new Uint8Array([0x41, 0x42]); // "AB"
    ws.fireMessage(u8);

    const ab = new Uint8Array([0x43, 0x44]).buffer; // "CD"
    ws.fireMessage(ab);

    ws.fireClose(1000, "client closed");

    await sessionPromise;

    expect(decodeAll(stdout.chunks)).toBe("ABCD");
  });

  test("clean close (1000) exits 0 and prints connection banner to stderr", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: false,
      agentId: "agent-7",
    });

    ws.fireOpen();
    ws.fireClose(1000, "ssh ended");

    const result = await sessionPromise;
    expect(result.exitCode).toBe(0);
    expect(decodeAll(stderr.chunks)).toContain("agent-7");
  });

  test("4404 close surfaces reason on stderr and exits 1", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: false,
      agentId: "agent-x",
    });

    ws.fireOpen();
    ws.fireClose(4404, "agent agent-x is offline");

    const result = await sessionPromise;
    expect(result.exitCode).toBe(1);
    const errOut = decodeAll(stderr.chunks);
    expect(errOut).toContain("agent agent-x is offline");
  });

  test("close before open with a non-clean reason exits 1 and surfaces reason", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: false,
      agentId: "agent-z",
    });

    ws.fireClose(4404, "Invalid or expired token");

    const result = await sessionPromise;
    expect(result.exitCode).toBe(1);
    expect(decodeAll(stderr.chunks)).toContain("Invalid or expired token");
  });

  test("tty mode toggles raw mode on open and restores on close", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: false,
      agentId: "agent-1",
    });

    ws.fireOpen();
    expect(stdin.rawCalls).toContain(true);

    ws.fireClose(1000, "ssh ended");
    await sessionPromise;
    expect(stdin.rawCalls).toContain(false);
    // last setRawMode call must restore cooked mode
    expect(stdin.rawCalls[stdin.rawCalls.length - 1]).toBe(false);
  });

  test("--no-tty mode keeps stdin cooked (never calls setRawMode(true))", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: true,
      agentId: "agent-1",
    });

    ws.fireOpen();
    stdin.emitData(new Uint8Array([0x78])); // 'x'
    ws.fireClose(1000, "ssh ended");

    await sessionPromise;
    expect(stdin.rawCalls.includes(true)).toBe(false);
    expect(ws.sent.length).toBe(1);
  });

  test("stdin EOF triggers a clean ws.close (client-initiated disconnect)", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: false,
      noTty: true,
      agentId: "agent-1",
    });

    ws.fireOpen();
    stdin.emitEnd();

    expect(ws.closed).not.toBeNull();
    expect(ws.closed?.code).toBe(1000);

    // Server confirms the close.
    ws.fireClose(1000, "client closed");
    const result = await sessionPromise;
    expect(result.exitCode).toBe(0);
  });

  test("forwards terminal resize as a JSON control frame on open and on resize", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();
    const resize = makeFakeResize(120, 40);

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: false,
      agentId: "agent-1",
      resize,
    });

    ws.fireOpen();
    // Initial size is pushed on open so the remote PTY starts correctly sized.
    expect(ws.sentText).toContain(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    // A subsequent SIGWINCH-style resize emits an updated frame.
    resize.setSize(80, 24);
    resize.fire();
    expect(ws.sentText).toContain(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    // Resize frames are text, never counted as stdin binary.
    expect(ws.sent.length).toBe(0);

    ws.fireClose(1000, "ssh ended");
    await sessionPromise;
    // The resize subscription is released on teardown (no leak).
    expect(resize.offCount).toBeGreaterThan(0);
  });

  test("--no-tty mode never sends resize frames", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();
    const resize = makeFakeResize(100, 30);

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: true,
      agentId: "agent-1",
      resize,
    });

    ws.fireOpen();
    resize.fire();
    expect(ws.sentText.length).toBe(0);

    ws.fireClose(1000, "ssh ended");
    await sessionPromise;
  });

  test("forwards Ctrl-C bytes through to the remote (no local intercept)", async () => {
    const ws = makeFakeWs();
    const stdin = makeFakeStdin();
    const stdout = makeFakeWriter();
    const stderr = makeFakeWriter();

    const sessionPromise = runSshSession({
      ws,
      stdin,
      stdout,
      stderr,
      isTty: true,
      noTty: false,
      agentId: "agent-1",
    });

    ws.fireOpen();
    stdin.emitData(new Uint8Array([0x03])); // Ctrl-C
    ws.fireClose(1000, "ssh ended");

    await sessionPromise;
    expect(ws.sent.length).toBe(1);
    expect(ws.sent[0]?.[0]).toBe(0x03);
  });
});
