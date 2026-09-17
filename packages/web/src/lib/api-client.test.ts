import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, downloadAuthedFile, uploadFileToNetDrive } from "./api-client";

type FetchSpy = ReturnType<typeof makeFetchSpy>;

function makeFetchSpy(body: BodyInit, init: ResponseInit) {
  return vi.fn((_url: RequestInfo | URL, _opts?: RequestInit) =>
    Promise.resolve(new Response(body, init)),
  );
}

function getInit(spy: FetchSpy, callIndex = 0): RequestInit | undefined {
  return spy.mock.calls[callIndex]?.[1];
}

function getUrl(spy: FetchSpy, callIndex = 0): string {
  const u = spy.mock.calls[callIndex]?.[0];
  return typeof u === "string" ? u : (u as URL).toString();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.__KQ_LOCAL__ = undefined;
});

describe("api.get", () => {
  test("returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", makeFetchSpy(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(api.get<{ ok: boolean }>("/jobs")).resolves.toEqual({ ok: true });
  });

  test("attaches Authorization header when a token exists", async () => {
    localStorage.setItem("kq_token", "tok-xyz");
    const spy = makeFetchSpy(JSON.stringify({}), { status: 200 });
    vi.stubGlobal("fetch", spy);
    await api.get("/jobs");
    expect(getInit(spy)?.headers).toEqual({ Authorization: "Bearer tok-xyz" });
    expect(getInit(spy)?.credentials).toBe("same-origin");
  });

  test("attaches the active organization header to queue reads", async () => {
    localStorage.setItem("kq_active_organization_id", "00000000-0000-4000-8000-000000000123");
    const spy = makeFetchSpy(JSON.stringify({ queues: [] }), { status: 200 });
    vi.stubGlobal("fetch", spy);

    await api.get("/queues/visible");

    expect(getInit(spy)?.headers).toEqual({
      "X-KQ-Active-Organization": "00000000-0000-4000-8000-000000000123",
    });
  });

  test("throws ApiError shaped from the JSON body on a 4xx response", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchSpy(
        JSON.stringify({ error: { code: "FORBIDDEN", message: "no", details: { reason: "R" } } }),
        {
          status: 403,
        },
      ),
    );
    try {
      await api.get("/audit-log");
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(403);
      expect(err.code).toBe("FORBIDDEN");
      expect(err.message).toBe("no");
      expect(err.details).toEqual({ reason: "R" });
    }
  });

  test("falls back to HTTP_ERROR + statusText when body parse fails", async () => {
    vi.stubGlobal("fetch", makeFetchSpy("plain text", { status: 500, statusText: "Server Error" }));
    try {
      await api.get("/jobs");
      throw new Error("did not throw");
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(500);
      expect(err.code).toBe("HTTP_ERROR");
      expect(err.message).toBe("Server Error");
    }
  });

  test("refreshes a cookie session once and retries the request after 401", async () => {
    localStorage.setItem("kq_token", "expired-access-token");
    const spy = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "expired" }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            expiresIn: 900,
            user: { email: "user@test.com", role: "user" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await expect(api.get<{ jobs: unknown[] }>("/jobs")).resolves.toEqual({ jobs: [] });
    expect(getUrl(spy, 1)).toBe("/platform/api/auth/session");
    expect(getUrl(spy, 2)).toBe("/platform/api/auth/session/refresh");
    expect(getUrl(spy, 3)).toBe("/platform/api/jobs");
    expect(getInit(spy, 3)?.headers).toEqual({});
    expect(localStorage.getItem("kq_token")).toBeNull();
    expect(localStorage.getItem("kq_role")).toBe("user");
  });
});

describe("api.post", () => {
  test("sends JSON content-type + body", async () => {
    const spy = makeFetchSpy(JSON.stringify({ id: "x" }), { status: 201 });
    vi.stubGlobal("fetch", spy);
    await api.post("/jobs", { name: "n" });
    const init = getInit(spy);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect((init?.headers as Record<string, string>)?.["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ name: "n" }));
  });

  test("body is undefined when no payload is given", async () => {
    const spy = makeFetchSpy(JSON.stringify({}), { status: 200 });
    vi.stubGlobal("fetch", spy);
    await api.post("/jobs/abc/cancel");
    expect(getInit(spy)?.body).toBeUndefined();
  });
});

describe("api.delete", () => {
  test("sends DELETE", async () => {
    const spy = makeFetchSpy(JSON.stringify({ ok: true }), { status: 200 });
    vi.stubGlobal("fetch", spy);
    await api.delete("/agents/abc");
    expect(getInit(spy)?.method).toBe("DELETE");
    expect(getInit(spy)?.credentials).toBe("same-origin");
  });
});

describe("downloadAuthedFile", () => {
  test("throws ApiError shaped from the JSON body on a failed file response", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchSpy(
        JSON.stringify({
          error: {
            code: "EXPORT_FORMAT_NOT_SUPPORTED",
            message: "Parquet export is not enabled",
            details: { reason: "EXPORT_FORMAT_NOT_SUPPORTED" },
          },
        }),
        { status: 422 },
      ),
    );

    try {
      await downloadAuthedFile("/metering/export?format=parquet", "metering.parquet");
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(422);
      expect(err.code).toBe("EXPORT_FORMAT_NOT_SUPPORTED");
      expect(err.message).toBe("Parquet export is not enabled");
      expect(err.details).toEqual({ reason: "EXPORT_FORMAT_NOT_SUPPORTED" });
    }
  });
});

describe("uploadFileToNetDrive", () => {
  test("normalizes non-POSIX directory names before minting an upload URL", async () => {
    const committed = {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3399",
      path: "workflows/drafts/draft-1/_/input.gro",
      size: 3,
      sha256: "a".repeat(64),
      contentType: "text/plain",
      storageKey: "owner/workflows/drafts/draft-1/_/input.gro",
      mtime: "2026-07-15T00:00:00.000Z",
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: "https://storage.example/upload",
              storageKey: committed.storageKey,
              commitToken: "token",
              expiresAt: "2026-07-15T01:00:00.000Z",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { etag: "etag" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: committed }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await uploadFileToNetDrive(
      new File(["gro"], "input.gro", { type: "text/plain" }),
      "workflows/drafts/draft-1/苹果硬件资料",
    );

    const mintBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as { path: string };
    expect(mintBody.path).toBe("workflows/drafts/draft-1/_/input.gro");
  });
});

describe("local mode (window.__KQ_LOCAL__)", () => {
  test("targets the injected base URL + token", async () => {
    window.__KQ_LOCAL__ = { baseUrl: "http://127.0.0.1:8799/api", token: "t" };
    const spy = makeFetchSpy(JSON.stringify({}), { status: 200 });
    vi.stubGlobal("fetch", spy);

    await api.get("/jobs");

    expect(getUrl(spy)).toBe("http://127.0.0.1:8799/api/jobs");
    expect(getInit(spy)?.headers).toEqual({ Authorization: "Bearer t" });
  });

  test("injected token takes precedence over localStorage", async () => {
    localStorage.setItem("kq_token", "stale-local-storage-token");
    window.__KQ_LOCAL__ = { baseUrl: "http://127.0.0.1:8799/api", token: "injected" };
    const spy = makeFetchSpy(JSON.stringify({}), { status: 200 });
    vi.stubGlobal("fetch", spy);

    await api.get("/jobs");

    expect(getInit(spy)?.headers).toEqual({ Authorization: "Bearer injected" });
  });

  test("uses the platform API prefix and localStorage token outside local mode", async () => {
    window.__KQ_LOCAL__ = undefined;
    localStorage.setItem("kq_token", "tok-xyz");
    const spy = makeFetchSpy(JSON.stringify({}), { status: 200 });
    vi.stubGlobal("fetch", spy);

    await api.get("/jobs");

    expect(getUrl(spy)).toBe("/platform/api/jobs");
    expect(getInit(spy)?.headers).toEqual({ Authorization: "Bearer tok-xyz" });
  });
});
