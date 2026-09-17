import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient, ApiError } from "./api-client";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(responder: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    responder(url.toString(), init)) as typeof fetch;
}

describe("ApiClient", () => {
  test("GET prepends /api and parses JSON", async () => {
    let requestedUrl = "";
    mockFetch(async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new ApiClient("http://localhost:3000");
    const result = await client.get<{ ok: boolean }>("/health");
    expect(requestedUrl).toBe("http://localhost:3000/api/health");
    expect(result.ok).toBe(true);
  });

  test("POST sends JSON body and Authorization header when token set", async () => {
    let receivedHeaders: Headers | undefined;
    let receivedBody = "";
    mockFetch(async (_url, init) => {
      receivedHeaders = new Headers(init?.headers as Record<string, string>);
      receivedBody = init?.body as string;
      return new Response(JSON.stringify({ id: "x" }), { status: 201 });
    });
    const client = new ApiClient("http://localhost:3000", "tok-123");
    const result = await client.post<{ id: string }>("/jobs", { name: "t" });
    expect(result.id).toBe("x");
    expect(receivedHeaders?.get("authorization")).toBe("Bearer tok-123");
    expect(receivedHeaders?.get("content-type")).toBe("application/json");
    expect(JSON.parse(receivedBody).name).toBe("t");
  });

  test("throws ApiError on non-2xx with structured body", async () => {
    mockFetch(async () => {
      return new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "Job not found" } }),
        { status: 404 },
      );
    });
    const client = new ApiClient("http://localhost:3000");
    await expect(client.get("/jobs/x")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  test("throws ApiError on non-2xx with non-JSON body", async () => {
    mockFetch(async () => new Response("plain text", { status: 500 }));
    const client = new ApiClient("http://localhost:3000");
    await expect(client.get("/jobs")).rejects.toBeInstanceOf(ApiError);
  });
});
