import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { OrganizationResourceScope } from "../middleware/organization-resource-scope";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { ComputeProviderService } from "../services/compute-providers";
import { createComputeProviderRoutes } from "./compute-providers";

const org = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
function app(role: string, memberships: BoundPrincipal["memberships"] = [], authz?: AuthzService) {
  const calls: OrganizationResourceScope[] = [];
  const service = {
    list: async (scope: OrganizationResourceScope) => {
      calls.push(scope);
      return { items: [], total: 0, canManage: scope.canManage };
    },
    save: async (scope: OrganizationResourceScope) => {
      calls.push(scope);
      return { id: org };
    },
    remove: async (scope: OrganizationResourceScope) => {
      calls.push(scope);
      return { deleted: true };
    },
  } as unknown as ComputeProviderService;
  const r = new Hono();
  r.onError(createErrorHandler(pino({ level: "silent" })));
  r.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: other,
      userId: other,
      role,
      email: "test@example.test",
      orgId: memberships[0]?.orgId,
      memberships,
    });
    await next();
  });
  r.route("/providers", createComputeProviderRoutes(service, authz));
  return { r, calls };
}
function write(
  r: Hono,
  path: string,
  method = "PUT",
  body: unknown = { name: "Provider", profile: {} },
  active = org,
) {
  return r.request(`/providers/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-KQ-Active-Organization": active },
    ...(method !== "DELETE" ? { body: JSON.stringify(body) } : {}),
  });
}
describe("compute provider permissions", () => {
  test("ordinary users denied, operators read only, platform admins CRUD", async () => {
    const user = app("user");
    expect((await user.r.request("/providers/operator/list")).status).toBe(403);
    const operator = app("operator");
    expect((await operator.r.request("/providers/operator/list")).status).toBe(200);
    expect(operator.calls[0]?.canManage).toBe(false);
    for (const method of ["PUT", "DELETE"])
      expect((await write(operator.r, `operator/organizations/${org}`, method)).status).toBe(403);
    expect((await write(operator.r, "operator/organizations", "POST")).status).toBe(403);
    const admin = app("platform_admin");
    expect((await write(admin.r, "operator/organizations", "POST")).status).toBe(201);
    expect((await write(admin.r, `operator/organizations/${org}`)).status).toBe(200);
    expect((await write(admin.r, `operator/organizations/${org}`, "DELETE")).status).toBe(200);
  });
  test("provider can update only through its scoped service; cannot create or delete organizations", async () => {
    const { r, calls } = app("user", [{ orgId: org, role: "admin" }]);
    expect((await write(r, `provider/organizations/${org}`)).status).toBe(200);
    expect(calls[0]?.orgIds).toEqual([org]);
    expect(
      (await write(r, `provider/organizations/${other}`, "PUT", undefined, other)).status,
    ).toBe(403);
    expect((await write(r, "provider/organizations", "POST")).status).toBe(403);
    expect((await write(r, `provider/organizations/${org}`, "DELETE")).status).toBe(403);
  });
  test("provider operator cannot use another membership's admin permission", async () => {
    const { r, calls } = app("user", [
      { orgId: org, role: "operator" },
      { orgId: other, role: "admin" },
    ]);
    expect((await write(r, `provider/organizations/${org}`)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  test("enforced denial and malformed profiles never reach persistence", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
      },
    } as unknown as AuthzService;
    const denied = app("org_admin", [{ orgId: org, role: "admin" }], authz);
    expect((await write(denied.r, `provider/organizations/${org}`)).status).toBe(403);
    expect(denied.calls).toHaveLength(0);
    const admin = app("platform_admin");
    for (const body of [
      { name: " ", profile: {} },
      { name: "A", profile: { email: "bad" } },
      { name: "A", profile: { website: "javascript:alert(1)" } },
      { name: "A", profile: {}, role: "super_admin" },
    ])
      expect((await write(admin.r, "operator/organizations", "POST", body)).status).toBe(400);
    expect(admin.calls).toHaveLength(0);
  });
});
