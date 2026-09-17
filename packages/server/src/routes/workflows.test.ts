import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode, type RoleName, type RunResult } from "@kuintessence/shared";
import { Hono } from "hono";
import type { AuthzCheck, AuthzService, AuthzTuple, ShadowCheckInput } from "../authz/service";
import type { WorkflowAsyncRunner, WorkflowAsyncSubmit } from "../workflow/async-runner";
import type { WorkflowDraftService } from "../workflow/draft-service";
import type { WorkflowRunRegistry } from "../workflow/run-registry";
import { createWorkflowRoutes, type WorkflowRouteDeps } from "./workflows";

const okResult: RunResult = {
  status: { solve: "Succeeded" },
  values: { solve: { status: "Succeeded", values: { residual: 0.001 } } },
};

// Registry stub — list/detail aren't exercised by the submit tests, so empty reads suffice.
const stubRegistry = {
  listPage: async () => ({
    runs: [],
    total: 0,
    summary: { active: 0, completed: 0, failed: 0, cancelled: 0 },
  }),
  getById: async () => null,
} as unknown as WorkflowRunRegistry;
const stubAsyncRunner = {
  submit: async () => ({ runId: "async-run-1", name: "async-wf", status: "submitted" as const }),
  cancel: async () => "cancelling" as const,
} as unknown as WorkflowAsyncRunner;

// Mounts the route behind a middleware that injects an authenticated user
// (so c.get("user") is populated, mirroring the real auth layer).
type AuthUser = { sub: string; role: RoleName; email: string };
const DEFAULT_USER: AuthUser = { sub: "s1", role: "user", email: "a@b.c" };

const mount = (
  deps: WorkflowRouteDeps,
  user: AuthUser | null = DEFAULT_USER,
  principalRole: string | null = user?.role ?? "guest",
  principalUserId: string | null = user ? "user-uuid" : null,
  principalEmail: string | null = user?.email ?? null,
) => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) {
      (c as unknown as { set: (k: string, v: unknown) => void }).set("user", user);
      (c as unknown as { set: (k: string, v: unknown) => void }).set("principal", {
        sub: user.sub,
        role: principalRole,
        email: principalEmail ?? user.email,
        userId: principalUserId,
        orgId: null,
        orgIds: [],
      });
    }
    await next();
  });
  app.route("/api", createWorkflowRoutes(deps));
  return app;
};

const baseDeps = (over: Partial<WorkflowRouteDeps> = {}): WorkflowRouteDeps => ({
  resolveUser: async () => "user-uuid",
  makeRunner: () => async () => okResult,
  registry: stubRegistry,
  asyncRunner: stubAsyncRunner,
  ...over,
});

function fakeEnforceAuthz(seen: AuthzCheck[]): AuthzService {
  const authz: Pick<
    AuthzService,
    "mode" | "lookupResources" | "requirePermission" | "shadowCheck"
  > = {
    mode: "enforce",
    lookupResources: async () => [],
    requirePermission: async (check: AuthzCheck) => {
      seen.push(check);
    },
    shadowCheck: async (input: ShadowCheckInput) => input.localAllowed,
  };
  return authz as unknown as AuthzService;
}

function fakeEnforceAuthzWithFallback(
  seen: Array<{ check: AuthzCheck; isPlatformAdmin: boolean }>,
): AuthzService {
  const authz: Pick<
    AuthzService,
    "mode" | "lookupResources" | "requirePermission" | "shadowCheck"
  > = {
    mode: "enforce",
    lookupResources: async () => [],
    requirePermission: async (check: AuthzCheck, isPlatformAdmin: boolean) => {
      seen.push({ check, isPlatformAdmin });
    },
    shadowCheck: async (input: ShadowCheckInput) => input.localAllowed,
  };
  return authz as unknown as AuthzService;
}

function fakeShadowAuthz(seen: ShadowCheckInput[]): AuthzService {
  const authz: Pick<AuthzService, "mode" | "requirePermission" | "shadowCheck"> = {
    mode: "shadow",
    requirePermission: async () => undefined,
    shadowCheck: async (input: ShadowCheckInput) => {
      seen.push(input);
      return input.localAllowed;
    },
  };
  return authz as unknown as AuthzService;
}

describe("workflow draft routes", () => {
  const draftId = "11111111-1111-4111-8111-111111111111";
  const draftYaml = "name: draft\nspec:\n  nodeDrafts: []\n";

  test("creates and lists owner-scoped drafts without submitting a run", async () => {
    const seen: string[] = [];
    const drafts = {
      create: async (ownerId: string, input: { name: string; yaml: string }) => {
        seen.push(`create:${ownerId}:${input.name}`);
        return { id: draftId, ownerId, ...input, placementConfig: {} };
      },
      listOwned: async (ownerId: string) => {
        seen.push(`list:${ownerId}`);
        return [{ id: draftId, ownerId, name: "工作流260716-1", yaml: draftYaml }];
      },
    } as unknown as WorkflowDraftService;
    const app = mount(baseDeps({ drafts }));

    const createRes = await app.request("/api/workflows/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "工作流260716-1", yaml: draftYaml }),
    });
    const listRes = await app.request("/api/workflows/drafts");

    expect(createRes.status).toBe(201);
    expect(listRes.status).toBe(200);
    expect(seen).toEqual(["create:user-uuid:工作流260716-1", "list:user-uuid"]);
  });

  test("updates, reads, and deletes only through the bound owner", async () => {
    const seen: string[] = [];
    const drafts = {
      getOwned: async (id: string, ownerId: string) => {
        seen.push(`get:${id}:${ownerId}`);
        return { id, ownerId, name: "draft", yaml: draftYaml, placementConfig: {} };
      },
      updateOwned: async (id: string, ownerId: string, input: { name: string; yaml: string }) => {
        seen.push(`update:${id}:${ownerId}:${input.name}`);
        return { id, ownerId, ...input, placementConfig: {} };
      },
      deleteOwned: async (id: string, ownerId: string) => {
        seen.push(`delete:${id}:${ownerId}`);
        return true;
      },
    } as unknown as WorkflowDraftService;
    const app = mount(baseDeps({ drafts }));

    const readRes = await app.request(`/api/workflows/drafts/${draftId}`);
    const updateRes = await app.request(`/api/workflows/drafts/${draftId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed", yaml: draftYaml }),
    });
    const deleteRes = await app.request(`/api/workflows/drafts/${draftId}`, {
      method: "DELETE",
    });

    expect(readRes.status).toBe(200);
    expect(updateRes.status).toBe(200);
    expect(deleteRes.status).toBe(200);
    expect(seen).toEqual([
      `get:${draftId}:user-uuid`,
      `update:${draftId}:user-uuid:renamed`,
      `delete:${draftId}:user-uuid`,
    ]);
  });

  test("rejects blank draft names and unbound principals", async () => {
    const drafts = {
      create: async () => {
        throw new Error("should not create");
      },
    } as unknown as WorkflowDraftService;

    const invalidRes = await mount(baseDeps({ drafts })).request("/api/workflows/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: " ", yaml: draftYaml }),
    });
    const forbiddenRes = await mount(baseDeps({ drafts }), DEFAULT_USER, "user", null).request(
      "/api/workflows/drafts",
    );

    expect(invalidRes.status).toBe(400);
    expect(forbiddenRes.status).toBe(403);
  });

  test("rejects bound guests before draft storage access", async () => {
    const drafts = {
      create: async () => {
        throw new Error("guest must not create a draft");
      },
      listOwned: async () => {
        throw new Error("guest must not list drafts");
      },
    } as unknown as WorkflowDraftService;
    const app = mount(baseDeps({ drafts }), {
      sub: "guest",
      role: "guest",
      email: "guest@example.test",
    });

    const create = await app.request("/api/workflows/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "guest draft", yaml: draftYaml }),
    });
    const list = await app.request("/api/workflows/drafts");
    const unavailable = await mount(baseDeps(), {
      sub: "guest",
      role: "guest",
      email: "guest@example.test",
    }).request("/api/workflows/drafts");

    expect(create.status).toBe(403);
    expect(list.status).toBe(403);
    expect(unavailable.status).toBe(403);
  });
});

const post = (app: Hono, body: unknown) =>
  app.request("/api/workflows/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/workflows/run", () => {
  test("rejects bound guests before creating, listing, reading, or cancelling workflow runs", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const calls: string[] = [];
    const app = mount(
      baseDeps({
        asyncRunner: {
          ...stubAsyncRunner,
          submit: async () => {
            calls.push("submit");
            return { runId, name: "guest", status: "submitted" };
          },
        } as unknown as WorkflowAsyncRunner,
        registry: {
          ...stubRegistry,
          listPage: async () => {
            calls.push("list");
            return {
              runs: [],
              total: 0,
              summary: { active: 0, completed: 0, failed: 0, cancelled: 0 },
            };
          },
          getById: async () => {
            calls.push("get");
            return { id: runId, submittedBy: "guest-user" };
          },
        } as unknown as WorkflowRunRegistry,
      }),
      { sub: "guest", role: "guest", email: "guest@example.test" },
      "guest",
      "guest-user",
    );
    const requests = [
      app.request("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: "name: guest\nspec:\n  nodeDrafts: []\n" }),
      }),
      app.request("/api/workflows"),
      app.request(`/api/workflows/${runId}`),
      app.request(`/api/workflows/${runId}/cancel`, { method: "POST" }),
    ];

    for (const request of requests) {
      expect((await request).status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test("POST /api/workflows returns immediately with an async run id", async () => {
    const seen: string[] = [];
    const app = mount(
      baseDeps({
        asyncRunner: {
          submit: async ({ submittedBy, role }: WorkflowAsyncSubmit) => {
            seen.push(`${submittedBy}:${role}`);
            return { runId: "async-run-2", name: "async-wf", status: "submitted" };
          },
        } as unknown as WorkflowAsyncRunner,
      }),
    );
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: "name: w\nspec:\n  nodeDrafts: []\n" }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      runId: "async-run-2",
      name: "async-wf",
      status: "submitted",
    });
    expect(seen).toEqual(["user-uuid:user"]);
  });

  test("an enforce submission synchronously projects ownership before the first detail read", async () => {
    const runId = "11111111-1111-4111-8111-111111111112";
    const calls: string[] = [];
    let ownerWritten = false;
    const authz = {
      mode: "enforce",
      writeRelationships: async (tuples: AuthzTuple[]) => {
        calls.push("write");
        ownerWritten = tuples.some(
          (tuple) =>
            tuple.resource.type === "workflow" &&
            tuple.resource.id === runId &&
            tuple.relation === "owner" &&
            tuple.subject.id === "user-uuid",
        );
      },
      enqueueMany: async () => {
        calls.push("enqueue");
      },
      requirePermission: async () => {
        if (!ownerWritten) throw new Error("Authorization denied");
      },
    } as unknown as AuthzService;
    const app = mount(
      baseDeps({
        authz,
        asyncRunner: {
          ...stubAsyncRunner,
          submit: async (input: WorkflowAsyncSubmit) => {
            await input.authorizeRun?.(runId);
            return { runId, name: "immediate", status: "submitted" as const };
          },
        } as unknown as WorkflowAsyncRunner,
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "user-uuid" }),
        } as unknown as WorkflowRunRegistry,
      }),
    );

    const submit = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: "name: w\nspec:\n  nodeDrafts: []\n" }),
    });
    const detail = await app.request(`/api/workflows/${runId}`);

    expect(submit.status).toBe(202);
    expect(detail.status).toBe(200);
    expect(calls).toEqual(["write", "enqueue"]);
  });

  test("runs a posted workflow for the authenticated user", async () => {
    const seen: string[] = [];
    const app = mount(
      baseDeps({
        makeRunner: (by, role) => async () => {
          seen.push(`${by}:${role}`);
          return okResult;
        },
      }),
    );
    const res = await post(app, { yaml: "name: w\nspec:\n  nodeDrafts: []\n" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okResult);
    // submittedBy AND the Server-bound role are threaded into the runner.
    expect(seen).toEqual(["user-uuid:user"]);
  });

  test("returns 404 for the synchronous route when disabled", async () => {
    let called = false;
    const app = mount(
      baseDeps({
        syncRunEnabled: false,
        makeRunner: () => async () => {
          called = true;
          return okResult;
        },
      }),
    );

    const res = await post(app, { yaml: "name: w\nspec:\n  nodeDrafts: []\n" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Workflow synchronous run endpoint is disabled",
    });
    expect(called).toBe(false);
  });

  test("threads the bound Server role (not a hard-coded 'user') into the runner", async () => {
    let seenRole: string | undefined;
    const app = mount(
      baseDeps({
        makeRunner: (_by, role) => async () => {
          seenRole = role;
          return okResult;
        },
      }),
      { sub: "operator-1", role: "operator", email: "operator@b.c" },
    );
    await post(app, { yaml: "name: w\nspec:\n  nodeDrafts: []\n" });
    expect(seenRole).toBe("operator");
  });

  test("does not thread stale JWT platform_admin into the runner", async () => {
    let seenRole: string | undefined;
    const app = mount(
      baseDeps({
        makeRunner: (_by, role) => async () => {
          seenRole = role;
          return okResult;
        },
      }),
      { sub: "stale-admin", role: "platform_admin", email: "a@b.c" },
      "user",
    );

    await post(app, { yaml: "name: w\nspec:\n  nodeDrafts: []\n" });

    expect(seenRole).toBe("user");
  });

  test("POST /api/workflows uses the bound Server role for async submit", async () => {
    const seen: string[] = [];
    const app = mount(
      baseDeps({
        asyncRunner: {
          submit: async ({ submittedBy, role }: WorkflowAsyncSubmit) => {
            seen.push(`${submittedBy}:${role}`);
            return { runId: "async-run-bound-role", name: "async-wf", status: "submitted" };
          },
        } as unknown as WorkflowAsyncRunner,
      }),
      { sub: "stale-admin", role: "platform_admin", email: "a@b.c" },
      "user",
    );

    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: "name: w\nspec:\n  nodeDrafts: []\n" }),
    });

    expect(res.status).toBe(202);
    expect(seen).toEqual(["user-uuid:user"]);
  });

  test("POST /api/workflows uses canonical principal id instead of resolving token email", async () => {
    const seen: string[] = [];
    const app = mount(
      baseDeps({
        resolveUser: async () => "email-resolved-user",
        asyncRunner: {
          submit: async ({ submittedBy, role }: WorkflowAsyncSubmit) => {
            seen.push(`${submittedBy}:${role}`);
            return { runId: "async-run-canonical", name: "async-wf", status: "submitted" };
          },
        } as unknown as WorkflowAsyncRunner,
      }),
      DEFAULT_USER,
      "operator",
      "canonical-workflow-user",
    );

    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: "name: w\nspec:\n  nodeDrafts: []\n" }),
    });

    expect(res.status).toBe(202);
    expect(seen).toEqual(["canonical-workflow-user:operator"]);
  });

  test("returns 401 when unauthenticated", async () => {
    const res = await post(mount(baseDeps(), null), { yaml: "x" });
    expect(res.status).toBe(401);
  });

  test("returns 403 when the canonical principal is missing", async () => {
    const res = await post(mount(baseDeps(), DEFAULT_USER, "user", null), { yaml: "x" });
    expect(res.status).toBe(403);
  });

  test("returns 400 when the runner rejects an invalid workflow", async () => {
    const app = mount(
      baseDeps({
        makeRunner: () => async () => {
          throw new Error("Workflow name must not be empty");
        },
      }),
    );
    const res = await post(app, { yaml: "bad" });
    expect(res.status).toBe(400);
  });

  test("returns 400 when the yaml field is missing", async () => {
    const res = await post(mount(baseDeps()), {});
    expect(res.status).toBe(400);
  });

  test("preserves a Dataset authorization failure instead of reporting invalid YAML", async () => {
    const app = mount(
      baseDeps({
        asyncRunner: {
          ...stubAsyncRunner,
          submit: async () => {
            throw new AppError(
              ErrorCode.FORBIDDEN,
              "Not authorized to use the selected Data Market version",
              403,
              { blocker: "DATASET_ACCESS_REVOKED" },
            );
          },
        } as unknown as WorkflowAsyncRunner,
      }),
    );

    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        yaml: "name: w\nspec:\n  nodeDrafts: []\n",
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Not authorized to use the selected Data Market version",
        details: { blocker: "DATASET_ACCESS_REVOKED" },
      },
    });
  });

  test("POST /api/workflows/:runId/cancel requests cancellation for the owner", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: string[] = [];
    const app = mount(
      baseDeps({
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "user-uuid" }),
        } as unknown as WorkflowRunRegistry,
        asyncRunner: {
          ...stubAsyncRunner,
          cancel: async (id: string) => {
            seen.push(id);
            return "cancelling";
          },
        } as unknown as WorkflowAsyncRunner,
      }),
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId, status: "cancelling" });
    expect(seen).toEqual([runId]);
  });

  test("POST /api/workflows/:runId/cancel hides another user's run", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const app = mount(
      baseDeps({
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "other-user" }),
        } as unknown as WorkflowRunRegistry,
      }),
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(404);
  });

  test("GET /api/workflows uses bound principal role for local admin scope", async () => {
    const calls: string[] = [];
    const run = { id: "11111111-1111-4111-8111-111111111111", submittedBy: "user-uuid" };
    const app = mount(
      baseDeps({
        registry: {
          ...stubRegistry,
          listPage: async (options: { submittedBy?: string }) => {
            calls.push(`listPage:${options.submittedBy}`);
            return {
              runs: [run],
              total: 1,
              summary: { active: 1, completed: 0, failed: 0, cancelled: 0 },
            };
          },
        } as unknown as WorkflowRunRegistry,
      }),
      { sub: "stale-admin", role: "platform_admin", email: "a@b.c" },
      "user",
    );

    const res = await app.request("/api/workflows");

    expect(res.status).toBe(200);
    expect(calls).toEqual(["listPage:user-uuid"]);
    expect(await res.json()).toEqual({
      runs: [run],
      total: 1,
      summary: { active: 1, completed: 0, failed: 0, cancelled: 0 },
      limit: 25,
      offset: 0,
    });
  });

  test("GET /api/workflows applies list filters and pagination before returning a page", async () => {
    const seen: unknown[] = [];
    const app = mount(
      baseDeps({
        registry: {
          ...stubRegistry,
          listPage: async (options: unknown) => {
            seen.push(options);
            return {
              runs: [],
              total: 7,
              summary: { active: 2, completed: 3, failed: 1, cancelled: 1 },
            };
          },
        } as unknown as WorkflowRunRegistry,
      }),
    );

    const res = await app.request(
      "/api/workflows?limit=10&offset=20&status=failed&q=climate%20model",
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        limit: 10,
        offset: 20,
        status: "failed",
        query: "climate model",
        submittedBy: "user-uuid",
      },
    ]);
    expect(await res.json()).toMatchObject({ total: 7, limit: 10, offset: 20 });
  });

  test("GET /api/workflows rejects invalid pagination", async () => {
    const res = await mount(baseDeps()).request("/api/workflows?limit=101&offset=-1");

    expect(res.status).toBe(400);
  });

  test("GET /api/workflows discovers delegated runs before SQL pagination in enforce mode", async () => {
    const run = { id: "11111111-1111-4111-8111-111111111111", submittedBy: "other-user" };
    const lookups: unknown[] = [];
    const checks: AuthzCheck[] = [];
    const pages: unknown[] = [];
    const authz = fakeEnforceAuthz(checks);
    authz.lookupResources = async (input) => {
      lookups.push(input);
      return [run.id];
    };
    const app = mount(
      baseDeps({
        authz,
        registry: {
          ...stubRegistry,
          listPage: async (options: unknown) => {
            pages.push(options);
            return {
              runs: [run],
              total: 1,
              summary: { active: 1, completed: 0, failed: 0, cancelled: 0 },
            };
          },
        } as unknown as WorkflowRunRegistry,
      }),
    );

    const res = await app.request("/api/workflows");

    expect(res.status).toBe(200);
    expect(lookups).toEqual([
      {
        resourceType: "workflow",
        permission: "view",
        subject: { type: "user", id: "user-uuid" },
      },
    ]);
    expect(pages).toEqual([{ limit: 25, offset: 0, ids: [run.id] }]);
    const body = (await res.json()) as { runs: (typeof run)[] };
    expect(body.runs).toEqual([run]);
    expect(checks).toHaveLength(1);
  });

  test("POST /api/workflows/:runId/cancel uses bound principal role in local mode", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const cancelled: string[] = [];
    const app = mount(
      baseDeps({
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "other-user" }),
        } as unknown as WorkflowRunRegistry,
        asyncRunner: {
          ...stubAsyncRunner,
          cancel: async (id: string) => {
            cancelled.push(id);
            return "cancelling";
          },
        } as unknown as WorkflowAsyncRunner,
      }),
      { sub: "stale-admin", role: "platform_admin", email: "a@b.c" },
      "user",
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(404);
    expect(cancelled).toEqual([]);
  });

  test("GET /api/workflows/:runId can be authorized by workflow#view in enforce mode", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: AuthzCheck[] = [];
    const app = mount(
      baseDeps({
        authz: fakeEnforceAuthz(seen),
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "other-user", graph: null }),
        } as unknown as WorkflowRunRegistry,
      }),
      { sub: "token-sub", role: "user", email: "stale-token@workflow.test" },
      "user",
      "user-uuid",
      "bound-workflow@workflow.test",
    );

    const res = await app.request(`/api/workflows/${runId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: runId, submittedBy: "other-user" });
    expect(seen).toEqual([
      {
        actorUserId: "user-uuid",
        actorEmail: "bound-workflow@workflow.test",
        resource: { type: "workflow", id: runId },
        permission: "view",
        subject: { type: "user", id: "user-uuid" },
        context: { route: "workflow#view" },
      },
    ]);
  });

  test("POST /api/workflows/:runId/cancel can be authorized by workflow#cancel in enforce mode", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: AuthzCheck[] = [];
    const cancelled: string[] = [];
    const app = mount(
      baseDeps({
        authz: fakeEnforceAuthz(seen),
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "other-user" }),
        } as unknown as WorkflowRunRegistry,
        asyncRunner: {
          ...stubAsyncRunner,
          cancel: async (id: string) => {
            cancelled.push(id);
            return "cancelling";
          },
        } as unknown as WorkflowAsyncRunner,
      }),
      { sub: "token-sub", role: "user", email: "stale-token@workflow.test" },
      "user",
      "user-uuid",
      "bound-workflow@workflow.test",
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId, status: "cancelling" });
    expect(cancelled).toEqual([runId]);
    expect(seen).toEqual([
      {
        actorUserId: "user-uuid",
        actorEmail: "bound-workflow@workflow.test",
        resource: { type: "workflow", id: runId },
        permission: "cancel",
        subject: { type: "user", id: "user-uuid" },
        context: { route: "workflow#cancel" },
      },
    ]);
  });

  test("POST /api/workflows/:runId/cancel degraded fallback uses bound principal role", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: Array<{ check: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const app = mount(
      baseDeps({
        authz: fakeEnforceAuthzWithFallback(seen),
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "other-user" }),
        } as unknown as WorkflowRunRegistry,
      }),
      { sub: "stale-admin", role: "platform_admin", email: "a@b.c" },
      "user",
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(seen[0]?.isPlatformAdmin).toBe(false);
  });

  test("POST /api/workflows/:runId/cancel rejects a bound guest even with a stale JWT admin role", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: Array<{ check: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const app = mount(
      baseDeps({
        authz: fakeEnforceAuthzWithFallback(seen),
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "other-user" }),
        } as unknown as WorkflowRunRegistry,
      }),
      { sub: "stale-admin", role: "platform_admin", email: "a@b.c" },
      null,
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  test("GET /api/workflows fails closed before listing without canonical user id", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: AuthzCheck[] = [];
    const registryCalls: string[] = [];
    const app = mount(
      baseDeps({
        authz: fakeEnforceAuthz(seen),
        registry: {
          ...stubRegistry,
          listPage: async () => {
            registryCalls.push("list");
            return {
              runs: [{ id: runId, submittedBy: "other-user" }],
              total: 1,
              summary: { active: 1, completed: 0, failed: 0, cancelled: 0 },
            };
          },
        } as unknown as WorkflowRunRegistry,
      }),
      DEFAULT_USER,
      "user",
      null,
    );

    const res = await app.request("/api/workflows");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Authorization principal is not bound" });
    expect(seen).toEqual([]);
    expect(registryCalls).toEqual([]);
  });

  test("GET /api/workflows/:runId fails closed in enforce mode without canonical user id", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: AuthzCheck[] = [];
    const registryCalls: string[] = [];
    const app = mount(
      baseDeps({
        authz: fakeEnforceAuthz(seen),
        registry: {
          ...stubRegistry,
          getById: async () => {
            registryCalls.push("getById");
            return { id: runId, submittedBy: "other-user", graph: null };
          },
        } as unknown as WorkflowRunRegistry,
      }),
      DEFAULT_USER,
      "user",
      null,
    );

    const res = await app.request(`/api/workflows/${runId}`);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Authorization principal is not bound" });
    expect(seen).toEqual([]);
    expect(registryCalls).toEqual([]);
  });

  test("POST /api/workflows/:runId/cancel fails closed in enforce mode without canonical user id", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: AuthzCheck[] = [];
    const cancelled: string[] = [];
    const registryCalls: string[] = [];
    const app = mount(
      baseDeps({
        authz: fakeEnforceAuthz(seen),
        registry: {
          ...stubRegistry,
          getById: async () => {
            registryCalls.push("getById");
            return { id: runId, submittedBy: "other-user" };
          },
        } as unknown as WorkflowRunRegistry,
        asyncRunner: {
          ...stubAsyncRunner,
          cancel: async (id: string) => {
            cancelled.push(id);
            return "cancelling";
          },
        } as unknown as WorkflowAsyncRunner,
      }),
      DEFAULT_USER,
      "user",
      null,
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Authorization principal is not bound" });
    expect(seen).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(registryCalls).toEqual([]);
  });

  test("POST /api/workflows/:runId/cancel fails closed in shadow mode without canonical user id", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const seen: ShadowCheckInput[] = [];
    const cancelled: string[] = [];
    const registryCalls: string[] = [];
    const app = mount(
      baseDeps({
        authz: fakeShadowAuthz(seen),
        registry: {
          ...stubRegistry,
          getById: async () => {
            registryCalls.push("getById");
            return { id: runId, submittedBy: "other-user" };
          },
        } as unknown as WorkflowRunRegistry,
        asyncRunner: {
          ...stubAsyncRunner,
          cancel: async (id: string) => {
            cancelled.push(id);
            return "cancelling";
          },
        } as unknown as WorkflowAsyncRunner,
      }),
      { sub: "admin-sub", role: "platform_admin", email: "admin@example.com" },
      "platform_admin",
      null,
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Authorization principal is not bound" });
    expect(seen).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(registryCalls).toEqual([]);
  });

  test("POST /api/workflows/:runId/cancel returns 401 when unauthenticated", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const app = mount(
      baseDeps({
        registry: {
          ...stubRegistry,
          getById: async () => ({ id: runId, submittedBy: "user-uuid" }),
        } as unknown as WorkflowRunRegistry,
      }),
      null,
    );

    const res = await app.request(`/api/workflows/${runId}/cancel`, { method: "POST" });

    expect(res.status).toBe(401);
  });
});
