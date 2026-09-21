import { createHash } from "node:crypto";
import type { SpackMaterialManagementCatalog } from "@kuintessence/shared/browser";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listSpackMaterialManagement } from "./spack-material-management-client";

const repository = "org/research/sources";
const repositoryId = createHash("sha256").update(repository).digest("hex");
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const cursor = (value: string) => `v1.${value.repeat(64)}`;
const invalidResponse = { status: 502, code: "REGISTRY_INVALID_RESPONSE" };

function release(value = "b"): SpackMaterialManagementCatalog["releases"][number] {
  return {
    repository,
    repositoryId,
    manifestDigest: digest(value),
    spec: "source@1.0",
    target: "x86_64",
    spackVersion: "1.0.0",
    redistribution: "unrestricted",
    sourceCount: 1,
    totalBytes: 32,
    state: "withdrawn",
    revision: 1,
  };
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(body: unknown) {
  const fetcher = vi.fn().mockResolvedValue(respond(body));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("defaults to all/10 with authenticated, uncached, non-redirecting same-origin GET", async () => {
  localStorage.setItem("kq_token", "management-token");
  const catalog = { releases: [release()], nextCursor: cursor("d") };
  const fetcher = stub(catalog);
  const hash = vi.spyOn(crypto.subtle, "digest");
  const { signal } = new AbortController();
  await expect(listSpackMaterialManagement({ repository }, signal)).resolves.toEqual(catalog);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "/software/api/spack/material-repositories/management?repository=org%2Fresearch%2Fsources&state=all&limit=10",
    expect.objectContaining({
      method: "GET",
      signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer management-token" }),
    }),
  );
  expect(hash).toHaveBeenCalledExactlyOnceWith("SHA-256", new TextEncoder().encode(repository));
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).body).toBeUndefined();
});

test("serializes state, limit and opaque cursor from a snapshot of the query", async () => {
  const query = { repository, state: "withdrawn" as const, limit: 1, after: cursor("a") };
  const fetcher = vi.fn(async () => {
    query.repository = "org/other/sources";
    query.after = cursor("f");
    query.limit = 20;
    return respond({ releases: [release()], nextCursor: cursor("b") });
  });
  vi.stubGlobal("fetch", fetcher);
  await listSpackMaterialManagement(query);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `/software/api/spack/material-repositories/management?repository=org%2Fresearch%2Fsources&state=withdrawn&limit=1&after=v1.${"a".repeat(64)}`,
    expect.any(Object),
  );
});

test.each([
  { repository: "" },
  { repository: "public/sources?state=all" },
  { repository, state: "deleted" },
  { repository, state: null },
  { repository, after: "not-a-digest" },
  { repository, after: digest("B") },
  { repository, after: digest("a") },
  { repository, after: "v1.short" },
  { repository, after: `v1.${"a".repeat(513)}` },
  { repository, after: `${cursor("a")}/` },
  { repository, limit: 0 },
  { repository, limit: 21 },
  { repository, limit: 1.5 },
  { repository, limit: "10" },
  { repository, url: "https://example.test" },
])("rejects invalid query before fetch: %j", async (query) => {
  const fetcher = stub({});
  // Exercise the runtime boundary with untrusted input as well as the typed API.
  await expect(
    listSpackMaterialManagement(query as Parameters<typeof listSpackMaterialManagement>[0]),
  ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  null,
  {},
  { releases: [] },
  { releases: [], nextCursor: "bad" },
  { releases: [], nextCursor: digest("a") },
  { releases: [], nextCursor: "v1.short" },
  { releases: [], nextCursor: `v1.${"a".repeat(513)}` },
  { releases: [], nextCursor: null, extra: true },
  { releases: [{ ...release(), extra: true }], nextCursor: null },
  { releases: [{ ...release(), state: "deleted" }], nextCursor: null },
  { releases: [{ ...release(), revision: 0 }], nextCursor: null },
  { releases: [{ ...release(), revision: -1 }], nextCursor: null },
  { releases: [{ ...release(), revision: 2_147_483_648 }], nextCursor: null },
  { releases: [{ ...release(), repository: "org/other/sources" }], nextCursor: null },
  { releases: [{ ...release(), repositoryId: "f".repeat(64) }], nextCursor: null },
  { releases: [release(), release()], nextCursor: null },
  { releases: [release("c"), release("b")], nextCursor: null },
  { releases: [release("c")], nextCursor: cursor("a") },
  { releases: [], nextCursor: cursor("a") },
  { releases: Array.from({ length: 21 }, () => release()), nextCursor: null },
])("rejects strict schema, namespace, order and cursor violations", async (body) => {
  const fetcher = stub(body);
  await expect(
    listSpackMaterialManagement({ repository, after: cursor("a") }),
  ).rejects.toMatchObject(invalidResponse);
  expect(fetcher).toHaveBeenCalledOnce();
});

test.each(["available", "withdrawn"] as const)("enforces the %s filter", async (state) => {
  const opposite = state === "available" ? "withdrawn" : "available";
  stub({ releases: [{ ...release(), state: opposite }], nextCursor: null });
  await expect(listSpackMaterialManagement({ repository, state })).rejects.toMatchObject(
    invalidResponse,
  );
});

test("enforces the requested limit even within the schema's maximum", async () => {
  stub({ releases: [release("b"), release("c")], nextCursor: null });
  await expect(listSpackMaterialManagement({ repository, limit: 1 })).rejects.toMatchObject(
    invalidResponse,
  );
});

test.each([
  { releases: [], nextCursor: null },
  { releases: [], nextCursor: cursor("c") },
  { releases: [release()], nextCursor: cursor("b") },
  { releases: [release()], nextCursor: cursor("0") },
  { releases: [release("0")], nextCursor: cursor("Z") },
  { releases: [release("b"), release("c")], nextCursor: null },
  { releases: [{ ...release(), state: "available", revision: 0 }], nextCursor: null },
])("accepts ascending releases and opaque cursors, including empty pages", async (catalog) => {
  stub(catalog);
  await expect(
    listSpackMaterialManagement({ repository, after: cursor("a") }),
  ).resolves.toEqual(catalog);
});

test.each([1, 5, 10, 20])("accepts page size %i", async (limit) => {
  stub({ releases: [], nextCursor: null });
  await expect(listSpackMaterialManagement({ repository, limit })).resolves.toEqual({
    releases: [],
    nextCursor: null,
  });
});

test.each([401, 403, 503])("preserves HTTP %i errors without retry", async (status) => {
  const error = { code: "FORBIDDEN", message: "Request rejected" };
  const fetcher = vi.fn().mockResolvedValue(respond({ error }, status));
  vi.stubGlobal("fetch", fetcher);
  await expect(listSpackMaterialManagement({ repository })).rejects.toMatchObject({
    status,
    ...error,
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

test.each([
  () => new Response("<html>private detail</html>"),
  () => new Response("{broken", { headers: { "content-type": "application/json" } }),
  () => new Response(null, { status: 302, headers: { location: "https://example.test" } }),
])("rejects malformed HTTP responses without retry", async (make) => {
  const fetcher = vi.fn().mockResolvedValue(make());
  vi.stubGlobal("fetch", fetcher);
  await expect(listSpackMaterialManagement({ repository })).rejects.toMatchObject({
    code: "REGISTRY_INVALID_RESPONSE",
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

test("does not fetch when already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Stopped"));
  const fetcher = stub({});
  await expect(listSpackMaterialManagement({ repository }, controller.signal)).rejects.toBe(
    controller.signal.reason,
  );
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  "fetch resolution",
  "fetch rejection",
  "body resolution",
  "body rejection",
  "hash resolution",
  "hash rejection",
])("preserves cancellation during %s", async (stage) => {
  const controller = new AbortController();
  const reason = new Error("Stopped during request");
  const catalog = { releases: [release()], nextCursor: null };
  const cancel = () => {
    controller.abort(reason);
    if (stage.endsWith("rejection")) throw reason;
  };
  if (stage.startsWith("hash")) {
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => {
      cancel();
      return new ArrayBuffer(32);
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (stage.startsWith("fetch")) cancel();
      const response = respond(catalog);
      if (stage.startsWith("body")) {
        vi.spyOn(response, "json").mockImplementation(async () => {
          cancel();
          return catalog;
        });
      }
      return response;
    }),
  );
  await expect(listSpackMaterialManagement({ repository }, controller.signal)).rejects.toBe(
    reason,
  );
});

test.each([
  "missing",
  "failure",
])("fails closed on %s crypto without leaking details", async (mode) => {
  if (mode === "missing") vi.stubGlobal("crypto", undefined);
  else vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("private crypto detail"));
  const fetcher = stub({ releases: [release()], nextCursor: null });
  await expect(listSpackMaterialManagement({ repository })).rejects.toMatchObject({
    ...invalidResponse,
    message: "Invalid Spack material management response",
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
