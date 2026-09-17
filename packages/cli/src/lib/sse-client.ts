// Server-Sent Events client with Bearer header support.
//
// Browser EventSource cannot set custom headers — we need Bearer auth
// so we implement a minimal SSE parser over fetch streams.
//
// Async-iterable surface so callers can `for await (const ev of sse.events())`.

import { ApiError, unwrapApiResponse } from "@kuintessence/shared";

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Loose fetch shape so test fakes can be passed in without ceremony. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SseClientOptions {
  /** Injectable fetch for tests. */
  fetch?: FetchLike;
  /** Reconnect base delay (ms). 0 disables reconnect. */
  reconnectMs?: number;
}

export class SseClient {
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly fetchFn: FetchLike;
  private readonly reconnectMs: number;

  constructor(url: string, token?: string, opts: SseClientOptions = {}) {
    this.url = url;
    this.token = token;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input as string, init));
    this.reconnectMs = opts.reconnectMs ?? 0;
  }

  async *events(): AsyncIterable<SseEvent> {
    while (true) {
      try {
        yield* this.openOnce();
        // Stream ended cleanly. If reconnect not enabled, stop.
        if (this.reconnectMs === 0) return;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (this.reconnectMs === 0) throw err;
      }
      await new Promise((r) => setTimeout(r, this.reconnectMs));
    }
  }

  private async *openOnce(): AsyncIterable<SseEvent> {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const r = await this.fetchFn(this.url, { headers });
    if (!r.ok) {
      await unwrapApiResponse<never>(r);
      throw new ApiError(r.status, "SSE_HTTP", `SSE connect failed: ${r.status}`);
    }
    if (!r.body) return;
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n\n");
      while (nl !== -1) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const ev = parseEvent(block);
        if (ev) yield ev;
        nl = buf.indexOf("\n\n");
      }
    }
  }
}

export function parseEvent(block: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  let id: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim();
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n"), id };
}
