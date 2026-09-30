import type {
  SpackInstallBindingChange,
  SpackInstallBindingView,
} from "@kuintessence/shared/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setMobileManagementPolicy } from "./mobile-management-policy";
import { requestSoftwareJson } from "./software-client";
import {
  changeSpackInstallBinding,
  inspectSpackInstallBinding,
} from "./spack-install-bindings-client";

const query = { scope: "platform", spec: "hello@2.12.1" };
const binding = { repositoryId: "a".repeat(64), manifestDigest: `sha256:${"b".repeat(64)}` };
const command: SpackInstallBindingChange = {
  ...query,
  action: "bind",
  binding,
  expectedRevision: 0,
  reason: "Use reviewed release",
};
const invalid = { status: 502, code: "REGISTRY_INVALID_RESPONSE" };

function view(revision = 1): SpackInstallBindingView {
  return {
    ...query,
    revision,
    state: revision ? "enabled" : "absent",
    binding: revision ? binding : null,
    history: Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
      revision: revision - index,
      state: "enabled",
      binding,
      source: "web",
      operatorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      reason: command.reason,
      createdAt: "2026-09-30T00:00:00.000Z",
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

describe.each([
  {
    name: "inspect",
    path: "/spack/install-bindings/inspect",
    input: query,
    run: (signal?: AbortSignal) => inspectSpackInstallBinding(query, signal),
  },
  {
    name: "change",
    path: "/spack/install-bindings",
    input: command,
    run: (signal?: AbortSignal) => changeSpackInstallBinding(command, signal),
  },
])("$name client", ({ path, input, run }) => {
  test("uses authenticated no-store POST and an unwrapped view", async () => {
    localStorage.setItem("kq_token", "binding-token");
    const fetcher = vi.fn().mockResolvedValue(response(view()));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();
    await expect(run(signal)).resolves.toEqual(view());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/software/api${path}`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal,
        body: JSON.stringify(input),
        headers: expect.objectContaining({ Authorization: "Bearer binding-token" }),
      }),
    );
  });

  test.each([
    null,
    { data: view() },
    { ...view(), extra: true },
    { ...view(), scope: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    { ...view(), spec: "hello" },
    { ...view(), revision: 0 },
    { ...view(), state: "absent" },
    { ...view(), state: "disabled" },
    { ...view(), binding: null },
    { ...view(), history: [] },
    { ...view(), historyTruncated: true },
    { ...view(), history: [{ ...view().history[0], revision: 2 }] },
    { ...view(), history: [{ ...view().history[0], state: "disabled", binding: null }] },
    { ...view(), history: [{ ...view().history[0], operatorId: null }] },
    { ...view(), history: [{ ...view().history[0], createdAt: "yesterday" }] },
    {
      ...view(),
      history: [
        { ...view().history[0], binding: { ...binding, repositoryId: "c".repeat(64) } },
      ],
    },
  ])("rejects malformed or inconsistent views: %j", async (body) => {
    const fetcher = vi.fn().mockResolvedValue(response(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject(invalid);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    { status: 401, code: "UNAUTHORIZED" },
    { status: 403, code: "INSTALL_BINDING_FORBIDDEN" },
    { status: 409, code: "INSTALL_BINDING_CONFLICT" },
    { status: 422, code: "INSTALL_BINDING_INVALID" },
    { status: 503, code: "INSTALL_BINDING_UNAVAILABLE" },
  ])("preserves $code without retry", async ({ status, code }) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ error: { code, message: "Rejected" } }, status));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toMatchObject({ status, code });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("does not fetch after abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(async () => run(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each(["fetch", "body"])("preserves cancellation during %s", async (stage) => {
    const controller = new AbortController();
    const reason = new Error("Cancelled request");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (stage === "fetch") controller.abort(reason);
        const result = response(view());
        if (stage === "body") {
          vi.spyOn(result, "json").mockImplementation(async () => {
            controller.abort(reason);
            return view();
          });
        }
        return result;
      }),
    );
    await expect(run(controller.signal)).rejects.toBe(reason);
  });

  test.each([
    () => new Response("<html>diagnostic</html>"),
    () => new Response("{bad", { headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 302 }),
  ])("rejects invalid HTTP receipts", async (make) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(make()));
    await expect(run()).rejects.toMatchObject({ code: "REGISTRY_INVALID_RESPONSE" });
  });
});

test.each([
  view(0),
  view(2),
  {
    ...view(),
    state: "disabled",
    binding: null,
    history: [{ ...view().history[0], state: "disabled", binding: null }],
  },
  { ...view(), history: [{ ...view().history[0], reason: "Other reason" }] },
  { ...view(), history: [{ ...view().history[0], source: "config", operatorId: null }] },
  {
    ...view(),
    binding: { ...binding, manifestDigest: `sha256:${"c".repeat(64)}` },
    history: [
      {
        ...view().history[0],
        binding: { ...binding, manifestDigest: `sha256:${"c".repeat(64)}` },
      },
    ],
  },
])("rejects incorrect write receipts without readback or retries: %j", async (body) => {
  const fetcher = vi.fn().mockResolvedValue(response(body));
  vi.stubGlobal("fetch", fetcher);
  await expect(changeSpackInstallBinding(command)).rejects.toMatchObject(invalid);
  expect(fetcher).toHaveBeenCalledOnce();
});

test("accepts absent and bounded complete history snapshots", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(view(0)))
    .mockResolvedValueOnce(response(view(101)));
  vi.stubGlobal("fetch", fetcher);
  await expect(inspectSpackInstallBinding(query)).resolves.toEqual(view(0));
  await expect(inspectSpackInstallBinding(query)).resolves.toEqual(view(101));
});

test("disable omits binding and validates disabled receipt", async () => {
  const disabled = {
    ...view(),
    state: "disabled",
    binding: null,
    history: [{ ...view().history[0], state: "disabled", binding: null }],
  };
  const fetcher = vi.fn().mockResolvedValue(response(disabled));
  vi.stubGlobal("fetch", fetcher);
  const change: SpackInstallBindingChange = {
    ...query,
    action: "disable",
    expectedRevision: 0,
    reason: command.reason,
  };
  await expect(changeSpackInstallBinding(change)).resolves.toEqual(disabled);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "/software/api/spack/install-bindings",
    expect.objectContaining({ body: JSON.stringify(change) }),
  );
});

test.each([
  { scope: "other-org" },
  { spec: " hello" },
  { spec: "hello\n" },
  { spec: "" },
  { expectedRevision: -1 },
  { expectedRevision: 2_147_483_647 },
  { reason: " leading" },
  { reason: "" },
  { binding: { repositoryId: "latest", manifestDigest: "latest" } },
  { operatorId: "caller-supplied" },
])("rejects invalid commands before transport: %j", async (patch) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    changeSpackInstallBinding({ ...command, ...patch } as SpackInstallBindingChange),
  ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("mobile allows only the read-only inspection POST, not binding writes", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  const fetcher = vi.fn().mockResolvedValue(response(view()));
  vi.stubGlobal("fetch", fetcher);
  await expect(inspectSpackInstallBinding(query)).resolves.toEqual(view());
  await expect(changeSpackInstallBinding(command)).rejects.toMatchObject({
    code: "MOBILE_HIGH_RISK_MUTATION_BLOCKED",
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

test.each([
  "/spack/install-bindings/inspect?scope=platform",
  "/spack/install-bindings/inspect/",
  "/spack/material-repositories",
])("mobile inspection exception does not exempt %s", async (path) => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(requestSoftwareJson(path, { method: "POST" })).rejects.toMatchObject({
    code: "MOBILE_HIGH_RISK_MUTATION_BLOCKED",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
