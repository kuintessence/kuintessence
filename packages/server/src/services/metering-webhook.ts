// Metering webhook dispatcher.
//
// Signs payloads with HMAC-SHA256 using the per-row secret and POSTs to
// the subscriber URL. Retries 3 times with exponential backoff. On
// exceeding the retry budget, the dispatcher increments the row's
// `failures` counter so the UI / admin can disable a flapping endpoint.

import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  type ResolvedWebhookAddress,
  type ResolvedWebhookTarget,
  resolvePublicWebhookTarget,
} from "./webhook-url-guard";

export interface WebhookConfig {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  enabled: boolean;
  events: string[];
  failures: number;
}

export interface WebhookEvent {
  event: string; // 'usage.daily' | 'usage.monthly' | ...
  orgId: string;
  payload: unknown;
  occurredAt: Date;
}

export interface WebhookSendResult {
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export interface WebhookDispatcherOptions {
  fetch?: FetchLike;
  sleep?: SleepFn;
  /** Max attempts including the first try. Default 4 (1 + 3 retries). */
  maxAttempts?: number;
  /** Base backoff in ms. Default 250 — sequence: 250, 500, 1000. */
  baseBackoffMs?: number;
  /** Per-hop DNS + request timeout. Default 10 seconds. */
  timeoutMs?: number;
  /** Maximum redirects, with DNS and address validation repeated per hop. */
  maxRedirects?: number;
  /** Maximum simultaneous deliveries in one fanout. */
  maxConcurrency?: number;
  resolveTarget?: (url: string) => Promise<ResolvedWebhookTarget>;
}

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export class WebhookDispatcher {
  private readonly fetchFn: FetchLike;
  private readonly sleep: SleepFn;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxConcurrency: number;
  private readonly resolveTarget: (url: string) => Promise<ResolvedWebhookTarget>;
  private readonly usesInjectedFetch: boolean;

  constructor(opts: WebhookDispatcherOptions = {}) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.baseBackoffMs = opts.baseBackoffMs ?? 250;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRedirects = opts.maxRedirects ?? 3;
    this.maxConcurrency = opts.maxConcurrency ?? 10;
    this.resolveTarget = opts.resolveTarget ?? resolvePublicWebhookTarget;
    this.usesInjectedFetch = opts.fetch !== undefined;
  }

  /**
   * Sign the payload, POST it to the webhook URL with retries. Returns a
   * result describing whether the dispatch ultimately succeeded.
   */
  async send(webhook: WebhookConfig, event: WebhookEvent): Promise<WebhookSendResult> {
    if (!webhook.enabled) {
      return { ok: false, error: "webhook disabled", attempts: 0 };
    }
    if (!webhook.events.includes(event.event)) {
      return { ok: false, error: "event not subscribed", attempts: 0 };
    }
    const body = JSON.stringify({
      event: event.event,
      orgId: event.orgId,
      occurredAt: event.occurredAt.toISOString(),
      payload: event.payload,
    });
    const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");

    let lastError: string | undefined;
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const headers = {
          "content-type": "application/json",
          "x-kq-signature": `sha256=${signature}`,
          "x-kq-event": event.event,
          "x-kq-delivery-attempt": String(attempt),
        };
        const r = await this.dispatchWithRedirects(webhook.url, headers, body);
        lastStatus = r.status;
        if (r.status >= 200 && r.status < 300) {
          return { ok: true, status: r.status, attempts: attempt };
        }
        // 4xx is a permanent failure — don't retry.
        if (r.status >= 400 && r.status < 500) {
          return { ok: false, status: r.status, error: `http ${r.status}`, attempts: attempt };
        }
        lastError = `http ${r.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(this.baseBackoffMs * 2 ** (attempt - 1));
      }
    }
    return {
      ok: false,
      status: lastStatus,
      error: lastError ?? "exhausted retries",
      attempts: this.maxAttempts,
    };
  }

  /**
   * Send a single event to all webhooks subscribed to it for an org.
   * Returns a per-webhook result list so callers can update failure
   * counters.
   */
  async fanout(
    event: WebhookEvent,
    webhooks: WebhookConfig[],
  ): Promise<Array<{ webhookId: string; result: WebhookSendResult }>> {
    const subscribed = webhooks.filter(
      (w) => w.enabled && w.events.includes(event.event) && w.orgId === event.orgId,
    );
    const results = new Array<{ webhookId: string; result: WebhookSendResult }>(subscribed.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.maxConcurrency, subscribed.length) },
      async () => {
        while (next < subscribed.length) {
          const index = next;
          next += 1;
          const webhook = subscribed[index];
          if (webhook) {
            results[index] = { webhookId: webhook.id, result: await this.send(webhook, event) };
          }
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async dispatchWithRedirects(
    initialUrl: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number }> {
    let current = initialUrl;
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      const target = await withTimeout(this.resolveTarget(current), this.timeoutMs);
      const response = this.usesInjectedFetch
        ? await this.fetchOnce(target.url.toString(), headers, body)
        : await pinnedRequest(target, headers, body, this.timeoutMs);
      if (response.status < 300 || response.status >= 400) return { status: response.status };
      if (!response.location || redirect === this.maxRedirects) {
        return { status: response.status };
      }
      current = new URL(response.location, target.url).toString();
    }
    throw new Error("webhook redirect limit exceeded");
  }

  private async fetchOnce(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; location: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      await response.body?.cancel();
      return { status: response.status, location: response.headers.get("location") };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function pinnedRequest(
  target: ResolvedWebhookTarget,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; location: string | null }> {
  const address = target.addresses[0];
  if (!address) throw new Error("webhook hostname did not resolve");
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      target.url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        lookup: createPinnedLookup(address),
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = Array.isArray(response.headers.location)
          ? (response.headers.location[0] ?? null)
          : (response.headers.location ?? null);
        response.resume();
        resolve({ status, location });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function createPinnedLookup(address: ResolvedWebhookAddress) {
  return (
    _hostname: string,
    _options: unknown,
    callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void => callback(null, address.address, address.family);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("webhook target resolution timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
