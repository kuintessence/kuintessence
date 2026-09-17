/**
 * Minimal HTTP-client abstraction so the Agent staging helpers can be
 * tested without touching real network or MinIO. The default
 * implementation is global `fetch`; tests inject a fake.
 *
 * The shape mirrors the subset of the WHATWG Fetch surface we use:
 * `text()`, `arrayBuffer()`, and the json-parsed body. Status, ok,
 * headers are kept simple on purpose — full Fetch is overkill here.
 */
export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  json<T = unknown>(): Promise<T>;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | Uint8Array | string;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * Build the default HTTP client backed by global `fetch`. Centralised
 * here so the Agent's other modules can pass it in without each
 * re-implementing the same fetch-to-HttpResponse adapter.
 */
export function createDefaultHttpClient(): HttpClient {
  return async (req) => {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
    };
    if (req.body !== undefined) {
      init.body = req.body as RequestInit["body"];
    }
    const res = await fetch(req.url, init);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: res.status,
      ok: res.ok,
      headers,
      text: () => res.text(),
      arrayBuffer: () => res.arrayBuffer(),
      json: <T>() => res.json() as Promise<T>,
    };
  };
}
