import { describe, expect, test } from "bun:test";
import {
  buildClientFetch,
  buildServerTransportOptions,
  createServerClient,
  createServerReachabilityProbe,
} from "./server-client";

describe("createServerClient", () => {
  test("creates a no-deadline Node streaming transport", () => {
    expect(createServerClient("http://localhost:13000")).toBeDefined();
    const options = buildServerTransportOptions("http://localhost:13000");
    expect(options).not.toHaveProperty("defaultTimeoutMs");
    expect(options.pingIntervalMs).toBe(30_000);
    expect(options.pingTimeoutMs).toBe(10_000);
  });

  test("configures HTTP/2 PING liveness independently from RPC deadlines", () => {
    const options = buildServerTransportOptions(
      "http://localhost:13000",
      { enabled: false },
      { pingIntervalMs: 45_000, pingTimeoutMs: 12_000 },
    );

    expect(options.pingIntervalMs).toBe(45_000);
    expect(options.pingTimeoutMs).toBe(12_000);
    expect(options).not.toHaveProperty("defaultTimeoutMs");
  });

  test("requires a fingerprint when mTLS is enabled", () => {
    expect(() => createServerClient("https://server.example", { enabled: true })).toThrow(
      "mtls.fingerprintSha256 is required",
    );
  });
});

describe("createServerReachabilityProbe", () => {
  test("treats any HTTP response as reachable and cancels its body", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel: () => {
        cancelled = true;
      },
    });
    const baseFetch = (async (_input: Request | string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response(body, { status: 404 });
    }) as typeof fetch;
    const probe = createServerReachabilityProbe(
      "https://server.example:3001/connect",
      { enabled: false },
      100,
      baseFetch,
    );

    await probe(new AbortController().signal);

    expect(cancelled).toBe(true);
  });

  test("fails when the network request exceeds its timeout", async () => {
    const baseFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const probe = createServerReachabilityProbe(
      "https://server.example:3001",
      { enabled: false },
      1,
      baseFetch,
    );

    await expect(probe(new AbortController().signal)).rejects.toThrow(
      "Server reachability probe timed out",
    );
  });

  test("parent abort ends an in-flight probe", async () => {
    const baseFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const parent = new AbortController();
    const probe = createServerReachabilityProbe(
      "https://server.example:3001",
      { enabled: false },
      10_000,
      baseFetch,
    );
    const pending = probe(parent.signal);
    parent.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("stop");
  });
});

describe("buildClientFetch (mTLS)", () => {
  test("when mtls disabled, returns globalThis.fetch unchanged", () => {
    const fn = buildClientFetch({ mtls: { enabled: false } });
    expect(fn).toBe(globalThis.fetch);
  });

  test("when mtls enabled, returns a fetch that injects fingerprint header", async () => {
    const fp = "ab".repeat(32);
    let captured: Headers | null = null;
    const fakeFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init);
      captured = req.headers;
      return new Response("ok");
    }) as typeof fetch;

    const fn = buildClientFetch({
      mtls: { enabled: true, fingerprintSha256: fp, certPem: "C", keyPem: "K", caCertPem: "CA" },
      baseFetch: fakeFetch,
    });
    await fn("http://x", { method: "POST" });
    expect(captured).not.toBeNull();
    expect((captured as unknown as Headers).get("x-agent-cert-fingerprint")).toBe(fp);
  });

  test("preserves user-provided headers when injecting fingerprint", async () => {
    const fp = "cd".repeat(32);
    let captured: Headers | null = null;
    const fakeFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init);
      captured = req.headers;
      return new Response("ok");
    }) as typeof fetch;
    const fn = buildClientFetch({
      mtls: { enabled: true, fingerprintSha256: fp, certPem: "C", keyPem: "K", caCertPem: "CA" },
      baseFetch: fakeFetch,
    });
    await fn("http://x", {
      method: "POST",
      headers: { "x-trace-id": "abc" },
    });
    expect((captured as unknown as Headers).get("x-trace-id")).toBe("abc");
    expect((captured as unknown as Headers).get("x-agent-cert-fingerprint")).toBe(fp);
  });

  test("injects the tls client-cert option for https url calls", async () => {
    let init: RequestInit | undefined;
    const fakeFetch = (async (_i: Request | string | URL, i2?: RequestInit) => {
      init = i2;
      return new Response("ok");
    }) as typeof fetch;
    const fn = buildClientFetch({
      mtls: {
        enabled: true,
        fingerprintSha256: "ab".repeat(32),
        certPem: "CERT",
        keyPem: "KEY",
        caCertPem: "CA",
      },
      baseFetch: fakeFetch,
    });
    await fn("https://x", { method: "POST" });
    const tls = (init as { tls?: { cert: string; key: string; ca?: string } }).tls;
    expect(tls?.cert).toBe("CERT");
    expect(tls?.key).toBe("KEY");
    expect(tls?.ca).toBe("CA");
  });

  test("injects the tls option for https Request calls too", async () => {
    let init: RequestInit | undefined;
    const fakeFetch = (async (_i: Request | string | URL, i2?: RequestInit) => {
      init = i2;
      return new Response("ok");
    }) as typeof fetch;
    const fn = buildClientFetch({
      mtls: { enabled: true, fingerprintSha256: "ab".repeat(32), certPem: "CERT", keyPem: "KEY" },
      baseFetch: fakeFetch,
    });
    await fn(new Request("https://x", { method: "POST" }));
    const tls = (init as { tls?: { cert: string; key: string } } | undefined)?.tls;
    expect(tls?.cert).toBe("CERT");
    expect(tls?.key).toBe("KEY");
  });

  test("preserves Request-path fetch init while injecting mtls headers", async () => {
    const signal = new AbortController().signal;
    let capturedRequest: Request | null = null;
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      capturedRequest = input instanceof Request ? input : new Request(input.toString(), init);
      capturedInit = init;
      return new Response("ok");
    }) as typeof fetch;
    const fn = buildClientFetch({
      mtls: { enabled: true, fingerprintSha256: "ab".repeat(32), certPem: "CERT", keyPem: "KEY" },
      baseFetch: fakeFetch,
    });
    const originalRequest = new Request("http://x", { method: "POST" });
    await fn(originalRequest, {
      keepalive: true,
      signal,
    });

    expect(capturedRequest as unknown).toBe(originalRequest);
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-agent-cert-fingerprint")).toBe("ab".repeat(32));
    expect(capturedInit?.keepalive).toBe(true);
    expect(capturedInit?.signal).toBe(signal);
  });

  test("omits tls for http calls while keeping the fingerprint header", async () => {
    let capturedRequest: Request | null = null;
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      capturedRequest = input instanceof Request ? input : new Request(input.toString(), init);
      capturedInit = init;
      return new Response("ok");
    }) as typeof fetch;
    const fn = buildClientFetch({
      mtls: { enabled: true, fingerprintSha256: "ab".repeat(32), certPem: "CERT", keyPem: "KEY" },
      baseFetch: fakeFetch,
    });
    await fn("http://x", { method: "POST" });

    expect(capturedRequest).toBeInstanceOf(Request);
    const request = capturedRequest as unknown as Request;
    expect(request.headers.get("x-agent-cert-fingerprint")).toBe("ab".repeat(32));
    expect((capturedInit as { tls?: unknown } | undefined)?.tls).toBeUndefined();
  });

  test("omits tls when cert material is absent (fingerprint-only mode)", async () => {
    let init: RequestInit | undefined;
    const fakeFetch = (async (_i: Request | string | URL, i2?: RequestInit) => {
      init = i2;
      return new Response("ok");
    }) as typeof fetch;
    const fn = buildClientFetch({
      mtls: { enabled: true, fingerprintSha256: "ab".repeat(32) },
      baseFetch: fakeFetch,
    });
    await fn("http://x", { method: "POST" });
    expect((init as { tls?: unknown }).tls).toBeUndefined();
  });
});
