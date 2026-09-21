import { createHash } from "node:crypto";
import type {
  SpackMaterialBinding,
  SpackMaterialVisibilityChange,
  SpackMaterialVisibilityPolicy,
  SpackMaterialVisibilityView,
} from "@kuintessence/shared/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  changeSpackMaterialVisibility,
  getSpackMaterialVisibility,
} from "./spack-material-visibility-client";

const repository = "org/research/sources";
const binding = {
  repositoryId: createHash("sha256").update(repository).digest("hex"),
  manifestDigest: `sha256:${"b".repeat(64)}`,
};
const first = "11111111-1111-1111-1111-111111111111";
const second = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const policy: SpackMaterialVisibilityPolicy = {
  mode: "allowlist",
  userIds: [first, second],
  orgIds: [],
};
const change: SpackMaterialVisibilityChange = {
  policy,
  expectedRevision: 0,
  reason: "Restrict source access",
};
const path = `/software/api/spack/material-repositories/${binding.repositoryId}/releases/${encodeURIComponent(binding.manifestDigest)}/visibility`;
const invalid = { status: 502, code: "REGISTRY_INVALID_RESPONSE" };

function view(revision = 1): SpackMaterialVisibilityView {
  const current: SpackMaterialVisibilityPolicy = revision % 2 ? policy : { mode: "inherit" };
  return {
    binding,
    repository,
    revision,
    policy: current,
    history: Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
      revision: revision - index,
      policy: (revision - index) % 2 ? policy : { mode: "inherit" },
      operatorId: first,
      reason: change.reason,
      epoch: "22222222-2222-4222-8222-222222222222",
      rolloutRevision: 3,
      createdAt: "2026-09-21T00:00:00.000Z",
    })),
    historyTruncated: revision > 100,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const operations = [
  {
    method: "GET",
    run: (signal?: AbortSignal) => getSpackMaterialVisibility(binding, signal),
    runBinding: (input: SpackMaterialBinding) => getSpackMaterialVisibility(input),
  },
  {
    method: "POST",
    run: (signal?: AbortSignal) => changeSpackMaterialVisibility(binding, change, signal),
    runBinding: (input: SpackMaterialBinding) => changeSpackMaterialVisibility(input, change),
  },
];

describe.each(operations)("$method visibility client", ({ method, run, runBinding }) => {
  test("uses authenticated same-origin no-store transport without redirects", async () => {
    localStorage.setItem("kq_token", "visibility-token");
    const fetcher = vi.fn().mockResolvedValue(response(view()));
    vi.stubGlobal("fetch", fetcher);
    const hash = vi.spyOn(crypto.subtle, "digest");
    const { signal } = new AbortController();
    await expect(run(signal)).resolves.toEqual(view());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      path,
      expect.objectContaining({
        method,
        signal,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer visibility-token" }),
      }),
    );
    expect(hash).toHaveBeenCalledExactlyOnceWith("SHA-256", new TextEncoder().encode(repository));
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).body).toBe(
      method === "POST" ? JSON.stringify(change) : undefined,
    );
  });

  test.each([
    { ...binding, repositoryId: "../other" },
    { ...binding, repositoryId: binding.repositoryId.toUpperCase() },
    { ...binding, manifestDigest: "latest" },
    { ...binding, url: "https://example.test" },
  ])("rejects invalid binding before fetch: %j", async (input) => {
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
    { ...view(), enabled: true },
    { ...view(), history: [] },
    { ...view(), historyTruncated: true },
    { ...view(), policy: { mode: "inherit" } },
    { ...view(), repository: "org/other/sources" },
    { ...view(), binding: { ...binding, repositoryId: "d".repeat(64) } },
    { ...view(), binding: { ...binding, manifestDigest: `sha256:${"e".repeat(64)}` } },
    { ...view(), policy: { mode: "allowlist", userIds: [second, first], orgIds: [] } },
    { ...view(), history: [{ ...view().history[0], reason: " leading" }] },
  ])("rejects malformed or mismatched responses: %j", async (body) => {
    const fetcher = vi.fn().mockResolvedValue(response(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject(invalid);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    { status: 401, code: "UNAUTHORIZED" },
    { status: 403, code: "MATERIAL_VISIBILITY_FORBIDDEN" },
    { status: 409, code: "MATERIAL_VISIBILITY_CONFLICT" },
    { status: 422, code: "MATERIAL_VISIBILITY_INVALID" },
    { status: 503, code: "MATERIAL_VISIBILITY_UNAVAILABLE" },
  ])("preserves $code without retrying", async ({ status, code }) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ error: { code, message: "Rejected" } }, status));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject({ status, code });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    () => new Response("<html>private diagnostic</html>"),
    () => new Response("{bad", { headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 302, headers: { location: "https://example.test" } }),
  ])("rejects invalid HTTP bodies and redirects", async (make) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(make()));
    await expect(run()).rejects.toMatchObject({ code: "REGISTRY_INVALID_RESPONSE" });
  });

  test("does not fetch after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(run(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    "fetch resolution",
    "fetch rejection",
    "body resolution",
    "body rejection",
    "hash resolution",
    "hash rejection",
  ])("preserves abort reason during %s", async (stage) => {
    const controller = new AbortController();
    const reason = new Error("Stopped during verification");
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
        const result = response(view());
        if (stage.startsWith("body")) {
          vi.spyOn(result, "json").mockImplementation(async () => {
            cancel();
            return view();
          });
        }
        return result;
      }),
    );
    await expect(run(controller.signal)).rejects.toBe(reason);
  });

  test.each(["missing", "failure"])("fails closed on %s crypto", async (mode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(view())));
    if (mode === "missing") vi.stubGlobal("crypto", undefined);
    else vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("Private detail"));
    await expect(run()).rejects.toMatchObject({
      ...invalid,
      message: "Invalid Spack material visibility response",
    });
  });
});

test("POST canonicalizes input order without mutation and validates the receipt", async () => {
  const input = {
    ...change,
    policy: { mode: "allowlist" as const, userIds: [second, first], orgIds: [] },
  };
  const fetcher = vi.fn().mockResolvedValue(response(view()));
  vi.stubGlobal("fetch", fetcher);
  await expect(changeSpackMaterialVisibility(binding, input)).resolves.toEqual(view());
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    path,
    expect.objectContaining({ body: JSON.stringify(change) }),
  );
  expect(input.policy.userIds).toEqual([second, first]);
});

test.each([
  view(0),
  view(3),
  {
    ...view(),
    policy: { mode: "inherit" },
    history: [{ ...view().history[0], policy: { mode: "inherit" } }],
  },
  { ...view(), history: [{ ...view().history[0], reason: "Different reason" }] },
])("rejects unconfirmed receipts without POST retry or follow-up GET", async (body) => {
  const fetcher = vi.fn().mockResolvedValue(response(body));
  vi.stubGlobal("fetch", fetcher);
  await expect(changeSpackMaterialVisibility(binding, change)).rejects.toMatchObject(invalid);
  expect(fetcher).toHaveBeenCalledOnce();
});

test.each([
  { policy: { mode: "allowlist", userIds: [first, first], orgIds: [] } },
  { policy: { mode: "allowlist", userIds: [second.toUpperCase()], orgIds: [] } },
  { policy: { mode: "inherit", extra: true } },
  { expectedRevision: 2_147_483_647 },
  { reason: " leading" },
  { operatorId: second },
])("validates POST input before transport: %j", async (patch) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    changeSpackMaterialVisibility(binding, {
      ...change,
      ...patch,
    } as SpackMaterialVisibilityChange),
  ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  expect(fetcher).not.toHaveBeenCalled();
});
