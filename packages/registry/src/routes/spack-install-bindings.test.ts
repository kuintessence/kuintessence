import { describe, expect, mock, test } from "bun:test";
import { type SpackInstallBindings, SpackMaterialLifecycleError } from "@kuintessence/db";
import {
  type SpackInstallBindingChange,
  type SpackInstallBindingView,
  SpackInstallBindingViewSchema,
  type SpackMaterialManifest,
} from "@kuintessence/shared";
import { Hono } from "hono";
import type { PrincipalMiddlewareOptions } from "../middleware/principal";
import type { RbacPrincipal } from "../services/namespace";
import { RecipeStoreError } from "../services/recipe-git";
import { SpackInstallBindingAccess } from "../services/spack-install-bindings";
import { MATERIAL_METADATA_BYTES, SpackMaterialError } from "../services/spack-material-storage";
import { createSpackInstallBindingRoutes } from "./spack-install-bindings";
import {
  COMMIT,
  JWT_OPTIONS,
  ORG,
  OTHER_ORG,
  repository,
  token,
} from "./spack-repositories.test-helpers";

type Port = Pick<SpackInstallBindings, "inspect" | "transition">;
const BASE = "/api/spack/install-bindings";
const ACTOR: RbacPrincipal = {
  sub: "44444444-4444-4444-8444-444444444444",
  role: "org_admin",
  orgIds: [ORG],
};
const QUERY = { scope: ORG, spec: "hello@1.0" };
const DISABLE: SpackInstallBindingChange = {
  ...QUERY,
  action: "disable",
  expectedRevision: 0,
  reason: "Pause installations",
};
const BIND = {
  ...QUERY,
  action: "bind",
  expectedRevision: 0,
  reason: "Reviewed release",
  binding: { repositoryId: "b".repeat(64), manifestDigest: `sha256:${"c".repeat(64)}` },
} satisfies SpackInstallBindingChange;
const ENDPOINTS = [
  { path: `${BASE}/inspect`, input: QUERY },
  { path: BASE, input: DISABLE },
];

function fixture(options: PrincipalMiddlewareOptions = {}, unavailable = false) {
  const view: SpackInstallBindingView = {
    ...QUERY,
    revision: 0,
    state: "absent",
    binding: null,
    history: [],
    historyTruncated: false,
  };
  const canonical = mock(async (_subject: string) => ({ ...ACTOR, suspended: false }));
  const port = {
    inspect: mock(async (..._args: Parameters<Port["inspect"]>) => view),
    transition: mock(async (...[change, subject, authorize]: Parameters<Port["transition"]>) => {
      await authorize(ACTOR);
      const state: "enabled" | "disabled" = change.action === "bind" ? "enabled" : "disabled";
      const binding = change.action === "bind" ? change.binding : null;
      return {
        ...view,
        revision: 1,
        state,
        binding,
        history: [
          {
            revision: 1,
            state,
            binding,
            source: "web" as const,
            operatorId: subject,
            reason: change.reason,
            createdAt: "2026-09-30T00:00:00.000Z",
          },
        ],
      };
    }),
  } satisfies Port;
  const recipe = repository();
  const snapshot = recipe.snapshots[0];
  if (!snapshot) throw new Error("Missing fixture snapshot");
  const blob = { digest: `sha256:${"d".repeat(64)}`, size: 1 };
  const manifest: SpackMaterialManifest = {
    version: 1,
    repository: `org/${ORG}/materials`,
    spec: QUERY.spec,
    spackVersion: "1.0.0",
    target: "linux-ubuntu24.04-x86_64",
    redistribution: "unrestricted",
    recipes: [{ repositoryId: recipe.id, commit: COMMIT, roots: ["repo"], archive: blob }],
    sources: [{ path: "hello.tar.gz", blob }],
    lockfile: blob,
  };
  const store = {
    getManifest: mock(async () => ({ manifest, bytes: new Uint8Array() })),
  };
  const recipes = {
    getSnapshot: mock(async () => ({ id: recipe.id, repository: recipe.repository, snapshot })),
  };
  const access = new SpackInstallBindingAccess(port, store, recipes);
  const app = new Hono();
  app.route(
    "/api",
    createSpackInstallBindingRoutes(unavailable ? undefined : access, {
      ...JWT_OPTIONS,
      resolveCanonicalPrincipal: canonical,
      ...options,
    }),
  );
  const headers = {
    Authorization: `Bearer ${token({ ...ACTOR, role: "super_admin", orgIds: [OTHER_ORG] })}`,
    "Content-Type": "application/json",
  };
  const request = (path = BASE, input: unknown = DISABLE) =>
    app.request(path, { method: "POST", headers, body: JSON.stringify(input) });
  return { app, port, store, recipes, canonical, headers, request, view };
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  const body = await response.json();
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
  for (const privateValue of [ORG, OTHER_ORG, ACTOR.sub, BIND.binding.manifestDigest, "private"]) {
    expect(JSON.stringify(body)).not.toContain(privateValue);
  }
}

describe("install binding API contract and identity", () => {
  test("bind returns the pinned release and canonical audit actor", async () => {
    const f = fixture();
    const response = await f.request(BASE, BIND);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(SpackInstallBindingViewSchema.parse(await response.json())).toMatchObject({
      ...QUERY,
      revision: 1,
      state: "enabled",
      binding: BIND.binding,
      history: [{ binding: BIND.binding, operatorId: ACTOR.sub, reason: BIND.reason }],
    });
    expect(f.port.transition).toHaveBeenCalledWith(BIND, ACTOR.sub, expect.any(Function));
    expect(f.store.getManifest).toHaveBeenCalledWith(
      BIND.binding.repositoryId,
      BIND.binding.manifestDigest,
      { checkpoint: expect.any(Function) },
    );
  });

  test("inspect and disable return shared-schema receipts without reading a manifest", async () => {
    const f = fixture();
    const inspect = await f.request(`${BASE}/inspect`, QUERY);
    expect(inspect.status).toBe(200);
    expect(inspect.headers.get("Cache-Control")).toBe("private, no-store");
    expect(SpackInstallBindingViewSchema.parse(await inspect.json())).toEqual(f.view);
    const changed = await f.request();
    expect(changed.status).toBe(200);
    expect(changed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(SpackInstallBindingViewSchema.parse(await changed.json())).toMatchObject({
      revision: 1,
      state: "disabled",
      binding: null,
      history: [{ operatorId: ACTOR.sub, reason: DISABLE.reason, source: "web" }],
    });
    expect(f.canonical).toHaveBeenCalledWith(ACTOR.sub);
    expect(f.port.inspect).toHaveBeenCalledWith(QUERY, ACTOR.sub);
    expect(f.port.transition).toHaveBeenCalledWith(DISABLE, ACTOR.sub, expect.any(Function));
    expect(f.store.getManifest).not.toHaveBeenCalled();
    expect(f.recipes.getSnapshot).not.toHaveBeenCalled();
  });

  test.each(ENDPOINTS)("$path requires authentication before reaching the port", async ({
    path,
    input,
  }) => {
    const f = fixture();
    const response = await f.app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    await expectError(response, 403, "FORBIDDEN");
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test.each([
    "missing resolver",
    "missing user",
    "suspended",
    "failure",
  ] as const)("canonical %s fails closed despite privileged JWT claims and a test header", async (mode) => {
    const f = fixture({
      resolveCanonicalPrincipal:
        mode === "missing resolver"
          ? undefined
          : async () => {
              if (mode === "failure") throw new Error("private identity database address");
              return mode === "missing user" ? null : { ...ACTOR, suspended: true };
            },
    });
    const response = await f.app.request(BASE, {
      method: "POST",
      headers: {
        ...f.headers,
        "X-Test-Principal": JSON.stringify({ ...ACTOR, role: "super_admin" }),
      },
      body: JSON.stringify(DISABLE),
    });
    await expectError(response, 403, "FORBIDDEN");
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test("a stale privileged token cannot override the canonical scope gate", async () => {
    const f = fixture();
    f.port.inspect.mockRejectedValue(new SpackMaterialLifecycleError("INSTALL_BINDING_FORBIDDEN"));
    await expectError(
      await f.request(BASE, { ...BIND, scope: OTHER_ORG }),
      403,
      "INSTALL_BINDING_FORBIDDEN",
    );
    expect(f.port.inspect).toHaveBeenCalledWith({ ...QUERY, scope: OTHER_ORG }, ACTOR.sub);
    expect(f.store.getManifest).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test.each(ENDPOINTS)("$path requires an explicit backend", async ({ path, input }) => {
    const f = fixture({}, true);
    await expectError(await f.request(path, input), 503, "INSTALL_BINDING_UNAVAILABLE");
    expect(f.port.inspect).not.toHaveBeenCalled();
  });
});

describe("install binding request validation", () => {
  test.each([
    { scope: "all" },
    { spec: "" },
    { spec: " hello@1.0" },
    { spec: "hello@1.0\n" },
    { spec: "x".repeat(501) },
    { action: "delete" },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: 2_147_483_647 },
    { expectedRevision: "0" },
    { reason: "" },
    { reason: "review\tneeded" },
    { reason: "x".repeat(1001) },
    { operatorId: ACTOR.sub },
    { role: "super_admin" },
    { orgIds: [OTHER_ORG] },
    { binding: BIND.binding },
  ])("rejects malformed or authority-expanding disable input: %j", async (patch) => {
    const f = fixture();
    await expectError(await f.request(BASE, { ...DISABLE, ...patch }), 422, "VALIDATION_ERROR");
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test.each([
    { ...BIND, binding: { ...BIND.binding, manifestDigest: "latest" } },
    { ...BIND, binding: { ...BIND.binding, repositoryId: "../repository" } },
    { ...BIND, binding: { ...BIND.binding, url: "https://example.invalid" } },
    { ...BIND, binding: undefined },
  ])("bind requires an immutable locator without extra authority: %j", async (input) => {
    const f = fixture();
    await expectError(await f.request(BASE, input), 422, "VALIDATION_ERROR");
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.store.getManifest).not.toHaveBeenCalled();
  });

  test.each(ENDPOINTS)("$path rejects query overrides, non-JSON and malformed bodies", async ({
    path,
    input,
  }) => {
    const f = fixture();
    const suffixes = ["?scope=platform", "?role=super_admin", "?url=https://example.invalid"];
    for (const suffix of suffixes) {
      await expectError(await f.request(`${path}${suffix}`, input), 422, "INSTALL_BINDING_INVALID");
    }
    for (const [contentType, body, code] of [
      ["text/plain", JSON.stringify(input), "INSTALL_BINDING_INVALID"],
      ["application/json", undefined, "INSTALL_BINDING_INVALID"],
      ["application/json", "{", "VALIDATION_ERROR"],
      ["application/json", "null", "VALIDATION_ERROR"],
      ["application/json", JSON.stringify({ ...input, operatorId: ACTOR.sub }), "VALIDATION_ERROR"],
    ] as const) {
      await expectError(
        await f.app.request(path, {
          method: "POST",
          headers: { ...f.headers, "Content-Type": contentType },
          body,
        }),
        422,
        code,
      );
    }
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test("rejects an oversized body without trusting Content-Length", async () => {
    const f = fixture();
    await expectError(
      await f.request(BASE, { ...DISABLE, reason: "x".repeat(MATERIAL_METADATA_BYTES) }),
      422,
      "VALIDATION_ERROR",
    );
    expect(f.port.inspect).not.toHaveBeenCalled();
  });
});

describe("install binding error receipts", () => {
  test.each([
    { code: "INSTALL_BINDING_CONFLICT", status: 409 },
    { code: "MATERIAL_RELEASE_WITHDRAWN", status: 404 },
    { code: "MATERIAL_VISIBILITY_DENIED", status: 404 },
    { code: "INSTALL_BINDING_UNAVAILABLE", status: 503 },
  ] as const)("preserves $code without returning a success receipt", async ({ code, status }) => {
    const f = fixture();
    f.port.transition.mockRejectedValue(new SpackMaterialLifecycleError(code));
    const response = await f.request();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expectError(response, status, code);
  });

  test("failure after a transition does not claim rollback or replay the write", async () => {
    const f = fixture();
    const committed = mock(() => {});
    f.port.transition.mockImplementation(async () => {
      committed();
      throw new Error("private connection lost after commit");
    });
    await expectError(await f.request(), 503, "INSTALL_BINDING_UNAVAILABLE");
    expect(committed).toHaveBeenCalledTimes(1);
    expect(f.port.transition).toHaveBeenCalledTimes(1);
  });

  test.each([
    403, 404, 422,
  ] as const)("hides material and recipe details for status %s", async (status) => {
    for (const error of [
      new SpackMaterialError(status, "private manifest path"),
      new RecipeStoreError(status, "private recipe diagnostic"),
    ]) {
      const f = fixture();
      if (error instanceof RecipeStoreError) f.recipes.getSnapshot.mockRejectedValue(error);
      else f.store.getManifest.mockRejectedValue(error);
      await expectError(
        await f.request(BASE, BIND),
        status === 422 ? 422 : 403,
        "VALIDATION_ERROR",
      );
      expect(f.port.transition).not.toHaveBeenCalled();
    }
  });

  test.each([
    500, 503,
  ] as const)("storage status %s is unavailable, not a client validation error", async (status) => {
    for (const error of [
      new SpackMaterialError(status, "private corrupt manifest"),
      new RecipeStoreError(status, "private snapshot storage"),
    ]) {
      const f = fixture();
      if (error instanceof RecipeStoreError) f.recipes.getSnapshot.mockRejectedValue(error);
      else f.store.getManifest.mockRejectedValue(error);
      await expectError(await f.request(BASE, BIND), 503, "INSTALL_BINDING_UNAVAILABLE");
      expect(f.port.transition).not.toHaveBeenCalled();
    }
  });
});
