import { createHash } from "node:crypto";
import type {
  SpackMaterialBinding,
  SpackMaterialLifecycleChange,
  SpackMaterialLifecycleView,
} from "@kuintessence/shared/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwareError } from "./software-client";
import {
  changeSpackMaterialLifecycle,
  getSpackMaterialLifecycle,
} from "./spack-material-lifecycle-client";

const repository = "org/research/sources";
const binding: SpackMaterialBinding = {
  repositoryId: createHash("sha256").update(repository).digest("hex"),
  manifestDigest: `sha256:${"b".repeat(64)}`,
};
const PATH = `/software/api/spack/material-repositories/${binding.repositoryId}/releases/${encodeURIComponent(binding.manifestDigest)}/lifecycle`;
const change: SpackMaterialLifecycleChange = {
  action: "withdraw",
  expectedRevision: 0,
  reason: "Source needs review",
};

function view(revision = 1): SpackMaterialLifecycleView {
  const history = Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
    revision: revision - index,
    state: (revision - index) % 2 ? ("withdrawn" as const) : ("available" as const),
    operatorId: "11111111-1111-4111-8111-111111111111",
    reason: change.reason,
    epoch: "22222222-2222-4222-8222-222222222222",
    rolloutRevision: 1,
    createdAt: "2026-09-21T00:00:00.000Z",
  }));
  return {
    binding: { ...binding },
    repository,
    revision,
    state: history[0]?.state ?? "available",
    history,
    historyTruncated: revision > 100,
  };
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const operations = [
  {
    method: "GET",
    run: (signal?: AbortSignal) => getSpackMaterialLifecycle(binding, signal),
    runBinding: (input: SpackMaterialBinding) => getSpackMaterialLifecycle(input),
  },
  {
    method: "POST",
    run: (signal?: AbortSignal) => changeSpackMaterialLifecycle(binding, change, signal),
    runBinding: (input: SpackMaterialBinding) => changeSpackMaterialLifecycle(input, change),
  },
];
const invalidResponse = { status: 502, code: "REGISTRY_INVALID_RESPONSE" };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(operations)("$method material lifecycle client", ({ method, run, runBinding }) => {
  test("uses authenticated same-origin transport with no redirects or cache", async () => {
    localStorage.setItem("kq_token", "lifecycle-token");
    const result = view();
    const fetcher = vi.fn().mockResolvedValue(respond(result));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();
    await expect(run(signal)).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      PATH,
      expect.objectContaining({
        method,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: expect.objectContaining({ Authorization: "Bearer lifecycle-token" }),
      }),
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(method === "POST" ? JSON.stringify(change) : undefined);
    if (method === "POST") {
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    }
  });

  test("supports an omitted signal and missing bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue(respond(view()));
    vi.stubGlobal("fetch", fetcher);
    await run();
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeUndefined();
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    { ...binding, repositoryId: "../another-namespace" },
    { ...binding, repositoryId: binding.repositoryId.toUpperCase() },
    { ...binding, manifestDigest: `${binding.manifestDigest}?url=https://example.test` },
    { ...binding, repository: "user/other/sources" },
    { ...binding, url: "https://example.test" },
  ])("validates the exact binding before fetch: %j", async (input) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(runBinding(input)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    null,
    {},
    { ...view(), binding: undefined },
    { ...view(), repository: undefined },
    { ...view(), repository: "https://example.test" },
    { ...view(), state: "deleted" },
    { ...view(), history: [] },
    { ...view(), historyTruncated: true },
    { ...view(), revision: 0 },
    { ...view(), history: [{ ...view().history[0], reason: " leading" }] },
    { ...view(), history: [{ ...view().history[0], operatorId: "not-a-uuid" }] },
    { ...view(), history: [{ ...view().history[0], epoch: "not-a-uuid" }] },
    { ...view(), history: [{ ...view().history[0], rolloutRevision: 0 }] },
    { ...view(), history: [{ ...view().history[0], createdAt: "yesterday" }] },
    { ...view(), history: [{ ...view().history[0], revision: 2 }] },
    { ...view(), history: Array.from({ length: 101 }, () => view().history[0]) },
    { ...view(), url: "https://example.test/private-token" },
    { ...view(), binding: { ...binding, repositoryId: "c".repeat(64) } },
    { ...view(), binding: { ...binding, manifestDigest: `sha256:${"d".repeat(64)}` } },
    { ...view(), repository: "org/other/sources" },
  ])("rejects malformed or mismatched views without retrying", async (body) => {
    const fetcher = vi.fn().mockResolvedValue(respond(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject({
      ...invalidResponse,
      message: "Invalid Spack material lifecycle response",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    () => new Response("<html>private upstream detail</html>"),
    () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 302, headers: { location: "https://example.test" } }),
  ])("rejects invalid HTTP bodies and redirects without following or retrying", async (make) => {
    const fetcher = vi.fn().mockResolvedValue(make());
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject({ code: "REGISTRY_INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    { status: 401, code: "UNAUTHORIZED" },
    { status: 403, code: "FORBIDDEN" },
    { status: 409, code: "MATERIAL_LIFECYCLE_CONFLICT" },
    { status: 503, code: "MATERIAL_LIFECYCLE_UNAVAILABLE" },
  ])("preserves HTTP $status errors without retrying", async ({ status, code }) => {
    const error = { code, message: "Request rejected", details: { revision: 3 } };
    const fetcher = vi.fn().mockResolvedValue(respond({ error }, status));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject({ status, ...error });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("returns a safe network error without leaking fetch details or retrying", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("private upstream detail"));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject({
      status: 503,
      code: "REGISTRY_UNREACHABLE",
      message: "Registry is unreachable",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("does not fetch when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Stopped before request"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(run(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    "fetch rejection",
    "fetch resolution",
    "body rejection",
    "body resolution",
  ])("preserves cancellation during %s", async (stage) => {
    const controller = new AbortController();
    const reason = new DOMException("Cancelled by user", "AbortError");
    const fetcher = vi.fn(async () => {
      const result = respond(view());
      if (stage.startsWith("body")) {
        vi.spyOn(result, "json").mockImplementation(async () => {
          controller.abort(reason);
          if (stage === "body rejection") throw reason;
          return view();
        });
      } else {
        controller.abort(reason);
        if (stage === "fetch rejection") throw reason;
      }
      return result;
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(run(controller.signal)).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each(["resolution", "rejection"])(
    "preserves custom cancellation during browser digest %s",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error("Stopped during namespace verification");
      vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => {
        controller.abort(reason);
        if (stage === "rejection") throw reason;
        return new ArrayBuffer(32);
      });
      const fetcher = vi.fn().mockResolvedValue(respond(view()));
      vi.stubGlobal("fetch", fetcher);
      await expect(run(controller.signal)).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  test.each(["missing", "failure"])("fails safely on %s browser crypto", async (stage) => {
    if (stage === "missing") vi.stubGlobal("crypto", undefined);
    else {
      vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("private crypto detail"));
    }
    const fetcher = vi.fn().mockResolvedValue(respond(view()));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject({
      ...invalidResponse,
      message: "Invalid Spack material lifecycle response",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("material lifecycle reads and changes", () => {
  test.each(["public/sources", "org/research/sources", "user/alice/sources"])(
    "verifies the exact %s namespace using browser SHA-256",
    async (namespace) => {
      const expected = {
        ...binding,
        repositoryId: createHash("sha256").update(namespace).digest("hex"),
      };
      const result = { ...view(), binding: expected, repository: namespace };
      const digest = vi.spyOn(crypto.subtle, "digest");
      const fetcher = vi.fn().mockResolvedValue(respond(result));
      vi.stubGlobal("fetch", fetcher);
      await expect(getSpackMaterialLifecycle(expected)).resolves.toEqual(result);
      expect(digest).toHaveBeenCalledExactlyOnceWith(
        "SHA-256",
        new TextEncoder().encode(namespace),
      );
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  test.each([0, 1, 2, 100, 101, 2_147_483_647])(
    "reads revision %i independently of immutable manifest availability",
    async (revision) => {
      const result = view(revision);
      const fetcher = vi.fn(async (path: string) => {
        if (path === PATH) return respond(result);
        return respond({ error: { code: "MATERIAL_RELEASE_WITHDRAWN" } }, 409);
      });
      vi.stubGlobal("fetch", fetcher);
      await expect(getSpackMaterialLifecycle(binding)).resolves.toEqual(result);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(PATH, expect.any(Object));
    },
  );

  test.each([
    { action: "withdraw" as const, expectedRevision: 0 },
    { action: "restore" as const, expectedRevision: 1 },
    { action: "withdraw" as const, expectedRevision: 2_147_483_646 },
  ])("accepts a verified $action receipt at revision $expectedRevision", async (patch) => {
    const command = { ...change, ...patch };
    const result = view(command.expectedRevision + 1);
    const fetcher = vi.fn().mockResolvedValue(respond(result));
    vi.stubGlobal("fetch", fetcher);
    await expect(changeSpackMaterialLifecycle(binding, command)).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      PATH,
      expect.objectContaining({ body: JSON.stringify(command) }),
    );
  });

  test.each([
    { ...change, expectedRevision: -1 },
    { ...change, expectedRevision: 0.5 },
    { ...change, expectedRevision: 2_147_483_647 },
    { ...change, reason: "" },
    { ...change, reason: " leading" },
    { ...change, reason: "trailing " },
    { ...change, reason: "line\nbreak" },
    { ...change, reason: "x".repeat(1001) },
    { ...change, operatorId: "11111111-1111-4111-8111-111111111111" },
    { ...change, repository: "org/other/sources" },
  ])("rejects invalid commands before fetch: %j", async (command) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(changeSpackMaterialLifecycle(binding, command)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    view(0),
    view(3),
    { ...view(), state: "available", history: [{ ...view().history[0], state: "available" }] },
    { ...view(), history: [{ ...view().history[0], reason: "Different reason" }] },
  ])("rejects an unconfirmed POST receipt without retry or follow-up GET", async (body) => {
    const fetcher = vi.fn().mockResolvedValue(respond(body));
    vi.stubGlobal("fetch", fetcher);
    const error = await changeSpackMaterialLifecycle(binding, change).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SoftwareError);
    expect(error).toMatchObject(invalidResponse);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      PATH,
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("uses snapshots of binding and command while the request is in flight", async () => {
    const input = { ...binding };
    const command = { ...change };
    const fetcher = vi.fn(async () => {
      input.repositoryId = "e".repeat(64);
      input.manifestDigest = `sha256:${"f".repeat(64)}`;
      command.reason = "Changed during request";
      command.action = "restore";
      command.expectedRevision = 1;
      return respond(view());
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(changeSpackMaterialLifecycle(input, command)).resolves.toEqual(view());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      PATH,
      expect.objectContaining({ body: JSON.stringify(change) }),
    );
  });
});
