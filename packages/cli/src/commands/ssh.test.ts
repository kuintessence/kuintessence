import { describe, expect, test } from "bun:test";
import type { SshWsLike } from "../lib/ssh-session";
import { runSshCommand } from "./ssh";

// In-process WebSocket fake — same shape as the one in ssh-session.test.ts
// but adds the URL + headers the factory was called with so we can verify
// the upgrade request was constructed correctly.
interface FakeWs extends SshWsLike {
  url: string;
  headers: Record<string, string>;
  sentText: string[];
  fireOpen(): void;
  fireMessage(data: Uint8Array | string | ArrayBuffer): void;
  fireClose(code: number, reason: string): void;
  fireError(): void;
}

function makeFakeWs(url: string, headers: Record<string, string>): FakeWs {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  const sentText: string[] = [];
  return {
    url,
    headers,
    sentText,
    send(data) {
      if (typeof data === "string") sentText.push(data);
    },
    close(_code, _reason) {
      // not exercised in command-level tests
    },
    addEventListener(type, cb) {
      listeners[type] ??= [];
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      listeners[type]?.push(cb as any);
    },
    fireOpen() {
      for (const cb of listeners.open ?? []) cb(new Event("open"));
    },
    fireMessage(data) {
      const evt = { data } as MessageEvent<unknown>;
      for (const cb of listeners.message ?? []) cb(evt);
    },
    fireClose(code, reason) {
      const evt = { code, reason, wasClean: code === 1000 } as unknown as CloseEvent;
      for (const cb of listeners.close ?? []) cb(evt);
    },
    fireError() {
      for (const cb of listeners.error ?? []) cb(new Event("error"));
    },
  };
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

interface FakeStdin {
  isRaw: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: test fake intentionally permissive
  on(event: any, cb: any): unknown;
  setRawMode(value: boolean): unknown;
  pause(): unknown;
  resume(): unknown;
}

function makeFakeStdin(): FakeStdin {
  return {
    isRaw: false,
    on() {
      return this;
    },
    setRawMode(value) {
      this.isRaw = value;
      return this;
    },
    pause() {
      return this;
    },
    resume() {
      return this;
    },
  };
}

function decode(chunks: Uint8Array[]): string {
  const dec = new TextDecoder();
  return chunks.map((c) => dec.decode(c)).join("");
}

describe("runSshCommand", () => {
  test("opens ws with the correct URL and Bearer Authorization header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const promise = runSshCommand({
      agentId: "agent-1",
      noTty: false,
      config: { serverUrl: "https://server.example.com", token: "tok-123" },
      stdin: makeFakeStdin(),
      stdout: makeFakeWriter(),
      stderr: makeFakeWriter(),
      isTty: true,
      wsFactory: (url, headers) => {
        capturedUrl = url;
        capturedHeaders = headers;
        const ws = makeFakeWs(url, headers);
        // Synchronously schedule a clean close so the promise resolves.
        queueMicrotask(() => {
          ws.fireOpen();
          ws.fireClose(1000, "ssh ended");
        });
        return ws;
      },
    });

    const result = await promise;
    expect(capturedUrl).toBe("wss://server.example.com/api/ssh/sessions/agent-1");
    expect(capturedHeaders.Authorization).toBe("Bearer tok-123");
    expect(result.exitCode).toBe(0);
  });

  test("forwards an injected resize source through to the session", async () => {
    let capturedWs: FakeWs | null = null;

    await runSshCommand({
      agentId: "agent-1",
      noTty: false,
      config: { serverUrl: "https://server.example.com", token: "tok-123" },
      stdin: makeFakeStdin(),
      stdout: makeFakeWriter(),
      stderr: makeFakeWriter(),
      isTty: true,
      resize: {
        getSize: () => ({ cols: 90, rows: 25 }),
        onResize: () => {},
      },
      wsFactory: (url, headers) => {
        const ws = makeFakeWs(url, headers);
        capturedWs = ws;
        queueMicrotask(() => {
          ws.fireOpen();
          ws.fireClose(1000, "ssh ended");
        });
        return ws;
      },
    });

    expect(capturedWs).not.toBeNull();
    expect((capturedWs as unknown as FakeWs).sentText).toContain(
      JSON.stringify({ type: "resize", cols: 90, rows: 25 }),
    );
  });

  test("normalizes http server URL to ws scheme", async () => {
    let capturedUrl = "";

    await runSshCommand({
      agentId: "agent-x",
      noTty: true,
      config: { serverUrl: "http://localhost:3000", token: "t" },
      stdin: makeFakeStdin(),
      stdout: makeFakeWriter(),
      stderr: makeFakeWriter(),
      isTty: false,
      wsFactory: (url) => {
        capturedUrl = url;
        const ws = makeFakeWs(url, {});
        queueMicrotask(() => {
          ws.fireOpen();
          ws.fireClose(1000, "ssh ended");
        });
        return ws;
      },
    });

    expect(capturedUrl).toBe("ws://localhost:3000/api/ssh/sessions/agent-x");
  });

  test("403 upgrade response surfaces a permission-denied message and exits 1", async () => {
    const stderr = makeFakeWriter();

    const result = await runSshCommand({
      agentId: "agent-1",
      noTty: true,
      config: { serverUrl: "http://localhost:3000", token: "t" },
      stdin: makeFakeStdin(),
      stdout: makeFakeWriter(),
      stderr,
      isTty: false,
      wsFactory: (url) => {
        const ws = makeFakeWs(url, {});
        // 403 manifests as upgrade rejection: error then a close with code
        // 1006 and a synthesized reason carrying the HTTP status.
        queueMicrotask(() => {
          ws.fireError();
          ws.fireClose(1006, "Unexpected server response: 403");
        });
        return ws;
      },
    });

    expect(result.exitCode).toBe(1);
    const errOut = decode(stderr.chunks);
    expect(errOut.toLowerCase()).toContain("permission denied");
    expect(errOut).toContain("org_admin");
  });

  test("aborts when no token is configured", async () => {
    const stderr = makeFakeWriter();

    const result = await runSshCommand({
      agentId: "agent-1",
      noTty: true,
      config: { serverUrl: "http://localhost:3000" },
      stdin: makeFakeStdin(),
      stdout: makeFakeWriter(),
      stderr,
      isTty: false,
      wsFactory: () => {
        throw new Error("wsFactory should not be called when token is missing");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(decode(stderr.chunks).toLowerCase()).toContain("not logged in");
  });

  test("4404 close (auth/session failure) surfaces reason on stderr and exits 1", async () => {
    const stderr = makeFakeWriter();

    const result = await runSshCommand({
      agentId: "agent-z",
      noTty: true,
      config: { serverUrl: "http://localhost:3000", token: "tok" },
      stdin: makeFakeStdin(),
      stdout: makeFakeWriter(),
      stderr,
      isTty: false,
      wsFactory: (url) => {
        const ws = makeFakeWs(url, {});
        queueMicrotask(() => {
          ws.fireClose(4404, "agent agent-z is offline");
        });
        return ws;
      },
    });

    expect(result.exitCode).toBe(1);
    expect(decode(stderr.chunks)).toContain("agent agent-z is offline");
  });

  test("--no-tty mode keeps stdin cooked", async () => {
    const stdin = makeFakeStdin();

    const result = await runSshCommand({
      agentId: "agent-1",
      noTty: true,
      config: { serverUrl: "http://localhost:3000", token: "tok" },
      stdin,
      stdout: makeFakeWriter(),
      stderr: makeFakeWriter(),
      isTty: true, // simulate a TTY but with --no-tty
      wsFactory: (url) => {
        const ws = makeFakeWs(url, {});
        queueMicrotask(() => {
          ws.fireOpen();
          ws.fireClose(1000, "ssh ended");
        });
        return ws;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(stdin.isRaw).toBe(false);
  });
});
