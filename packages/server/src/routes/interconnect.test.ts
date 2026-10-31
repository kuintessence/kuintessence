import { describe, expect, test } from "bun:test";
import { AppError, DEFAULT_MAP_VIEW, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { BoundPrincipal } from "../middleware/principal-binder";
import {
  assertInterconnectOrg,
  type InterconnectScope,
  type InterconnectService,
} from "../services/interconnect";
import { createInterconnectRoutes } from "./interconnect";

const orgId = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const center = {
  orgId,
  metadata: {
    name: "Center",
    country: "中国",
    province: "北京",
    city: "北京",
    latitude: 40,
    longitude: 116,
    status: "unknown",
  },
};
function app(role: string, memberships: BoundPrincipal["memberships"] = [], authz?: AuthzService) {
  const scopes: InterconnectScope[] = [];
  const service = {
    snapshot: async (scope: InterconnectScope) => {
      scopes.push(scope);
      return { centers: [] };
    },
    saveView: async (scope: InterconnectScope) => {
      scopes.push(scope);
    },
    saveCenter: async (scope: InterconnectScope, _id: unknown, input: { orgId: string }) => {
      assertInterconnectOrg(scope, input.orgId);
      scopes.push(scope);
      return { id: orgId };
    },
  } as unknown as InterconnectService;
  const r = new Hono();
  r.onError(createErrorHandler(pino({ level: "silent" })));
  r.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: userId,
      userId,
      role,
      email: "test@example.com",
      orgId: memberships[0]?.orgId ?? null,
      orgIds: memberships.map((m) => m.orgId),
      memberships,
      capabilities: [],
    });
    await next();
  });
  r.route("/api/interconnect", createInterconnectRoutes(service, authz));
  return { r, scopes };
}
function write(r: Hono, path: string, body: unknown, method = "POST", organization?: string) {
  return r.request(`/api/interconnect/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(organization ? { "X-KQ-Active-Organization": organization } : {}),
    },
    body: JSON.stringify(body),
  });
}
describe("interconnect access", () => {
  test("global provider view has a distinct default from the administrator's own organization", async () => {
    const { r, scopes } = app("platform_admin", [{ orgId, role: "admin" }]);
    expect((await write(r, "provider/default-view", DEFAULT_MAP_VIEW, "PUT")).status).toBe(200);
    expect((await write(r, "provider/default-view", DEFAULT_MAP_VIEW, "PUT", orgId)).status).toBe(
      200,
    );
    expect(scopes[0]?.orgIds).toBeNull();
    expect(scopes[1]?.orgIds).toEqual([orgId]);
    expect(scopes[0]?.key).not.toBe(scopes[1]?.key);
  });
  test("ordinary users cannot read platform or provider inventories", async () => {
    const { r, scopes } = app("user");
    expect((await r.request("/api/interconnect/operator/snapshot")).status).toBe(403);
    expect((await r.request("/api/interconnect/provider/snapshot")).status).toBe(403);
    expect(scopes).toHaveLength(0);
  });
  test("operator can read globally and save personal view but cannot change metadata", async () => {
    const { r, scopes } = app("operator");
    expect((await r.request("/api/interconnect/operator/snapshot")).status).toBe(200);
    expect(scopes[0]?.orgIds).toBeNull();
    expect(scopes[0]?.canManage).toBe(false);
    expect((await write(r, "operator/default-view", DEFAULT_MAP_VIEW, "PUT")).status).toBe(200);
    expect(scopes[1]?.userId).toBe(userId);
    expect((await write(r, "operator/centers", center)).status).toBe(403);
  });
  test("provider read and mutation are restricted to the selected organization", async () => {
    const { r, scopes } = app("user", [{ orgId, role: "admin" }]);
    expect((await r.request("/api/interconnect/provider/snapshot")).status).toBe(200);
    expect(scopes[0]?.orgIds).toEqual([orgId]);
    expect((await write(r, "provider/centers", center)).status).toBe(201);
    expect((await write(r, "provider/centers", { ...center, orgId: otherOrg })).status).toBe(403);
    expect((await write(r, "provider/centers", center, "POST", otherOrg)).status).toBe(403);
  });
  test("provider operator is read-only, including when admin of another organization", async () => {
    const { r } = app("user", [
      { orgId, role: "operator" },
      { orgId: otherOrg, role: "admin" },
    ]);
    expect((await write(r, "provider/centers", center, "POST", orgId)).status).toBe(403);
    expect((await write(r, "provider/default-view", DEFAULT_MAP_VIEW, "PUT", orgId)).status).toBe(
      200,
    );
  });
  test("enforced authorization denial is not bypassed by local provider admin role", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
      },
    } as unknown as AuthzService;
    const { r, scopes } = app("org_admin", [{ orgId, role: "admin" }], authz);
    expect((await r.request("/api/interconnect/provider/snapshot")).status).toBe(403);
    expect((await write(r, "provider/centers", center)).status).toBe(403);
    expect(scopes).toHaveLength(0);
  });
  test("platform admin can maintain inventory and invalid metadata is rejected", async () => {
    const { r } = app("platform_admin");
    expect((await write(r, "operator/centers", center)).status).toBe(201);
    expect(
      (
        await write(r, "operator/centers", {
          ...center,
          metadata: { ...center.metadata, latitude: 100 },
        })
      ).status,
    ).toBe(400);
    expect((await write(r, "operator/centers/not-a-uuid", center, "PUT")).status).toBe(400);
  });
});
