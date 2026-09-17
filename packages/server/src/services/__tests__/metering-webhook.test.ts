// Webhook dispatcher tests.
import { describe, expect, it } from "bun:test";
import { type WebhookConfig, WebhookDispatcher, type WebhookEvent } from "../metering-webhook";

const PUBLIC_TARGET = async (url: string) => ({
  url: new URL(url),
  addresses: [{ address: "203.0.113.5", family: 4 as const }],
});

function webhook(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: "wh-1",
    orgId: "org-A",
    url: "https://billing.example.com/usage",
    secret: "very-secret-key",
    enabled: true,
    events: ["usage.daily"],
    failures: 0,
    ...overrides,
  };
}

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    event: "usage.daily",
    orgId: "org-A",
    payload: { totalCpu: 100 },
    occurredAt: new Date("2026-04-15T00:00:00Z"),
    ...overrides,
  };
}

describe("WebhookDispatcher.send", () => {
  it("signs payload with HMAC-SHA256", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response("", { status: 200 });
    };
    const d = new WebhookDispatcher({ fetch: fakeFetch, resolveTarget: PUBLIC_TARGET });
    const r = await d.send(webhook(), event());
    expect(r.ok).toBe(true);
    expect(captured.url).toBe("https://billing.example.com/usage");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["x-kq-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["x-kq-event"]).toBe("usage.daily");
  });

  it("retries up to 3 times on 5xx", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      if (calls < 3) return new Response("", { status: 503 });
      return new Response("", { status: 200 });
    };
    const sleeps: number[] = [];
    const d = new WebhookDispatcher({
      fetch: fakeFetch,
      resolveTarget: PUBLIC_TARGET,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const r = await d.send(webhook(), event());
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("does NOT retry on 4xx (permanent)", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      return new Response("", { status: 401 });
    };
    const d = new WebhookDispatcher({
      fetch: fakeFetch,
      resolveTarget: PUBLIC_TARGET,
      sleep: async () => {},
    });
    const r = await d.send(webhook(), event());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("returns failure after exhausted retries", async () => {
    const fakeFetch = async () => new Response("", { status: 503 });
    const d = new WebhookDispatcher({
      fetch: fakeFetch,
      resolveTarget: PUBLIC_TARGET,
      sleep: async () => {},
      maxAttempts: 2,
    });
    const r = await d.send(webhook(), event());
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
  });

  it("revalidates a redirect target before sending the signed body", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response("", {
        status: 307,
        headers: { location: "http://metadata.internal/latest" },
      });
    };
    const d = new WebhookDispatcher({
      fetch: fakeFetch,
      resolveTarget: async (url) => {
        if (url.includes("metadata.internal")) throw new Error("non-public redirect");
        return PUBLIC_TARGET(url);
      },
      sleep: async () => {},
      maxAttempts: 1,
    });
    const r = await d.send(webhook(), event());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("non-public redirect");
    expect(calls).toBe(1);
  });

  it("aborts a hung endpoint at the per-hop timeout", async () => {
    const fakeFetch = async (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const d = new WebhookDispatcher({
      fetch: fakeFetch,
      resolveTarget: PUBLIC_TARGET,
      timeoutMs: 5,
      maxAttempts: 1,
    });
    const r = await d.send(webhook(), event());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("aborted");
  });

  it("skips disabled webhooks", async () => {
    const d = new WebhookDispatcher({ resolveTarget: PUBLIC_TARGET });
    const r = await d.send(webhook({ enabled: false }), event());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("webhook disabled");
  });

  it("skips events the webhook is not subscribed to", async () => {
    const d = new WebhookDispatcher({ resolveTarget: PUBLIC_TARGET });
    const r = await d.send(webhook({ events: ["usage.monthly"] }), event());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("event not subscribed");
  });
});

describe("WebhookDispatcher.fanout", () => {
  it("dispatches to subscribed webhooks for matching org only", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      return new Response("", { status: 200 });
    };
    const d = new WebhookDispatcher({ fetch: fakeFetch, resolveTarget: PUBLIC_TARGET });
    const results = await d.fanout(event({ orgId: "org-A" }), [
      webhook({ id: "w1", orgId: "org-A" }),
      webhook({ id: "w2", orgId: "org-A", enabled: false }),
      webhook({ id: "w3", orgId: "org-B" }),
      webhook({ id: "w4", orgId: "org-A", events: ["usage.monthly"] }),
    ]);
    expect(results.length).toBe(1);
    expect(results[0]?.webhookId).toBe("w1");
    expect(calls).toBe(1);
  });

  it("bounds simultaneous deliveries", async () => {
    let active = 0;
    let peak = 0;
    const fakeFetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return new Response("", { status: 200 });
    };
    const d = new WebhookDispatcher({
      fetch: fakeFetch,
      resolveTarget: PUBLIC_TARGET,
      maxConcurrency: 2,
    });
    const results = await d.fanout(
      event(),
      Array.from({ length: 5 }, (_, index) => webhook({ id: `w${index}` })),
    );
    expect(results).toHaveLength(5);
    expect(peak).toBe(2);
  });
});
