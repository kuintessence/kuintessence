import { describe, expect, test } from "bun:test";
import { AppError } from "@kuintessence/shared";
import { Hono } from "hono";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { DataMarketService } from "../services/data-market";
import { createAdminDataMarketRoutes } from "./admin-data-market";

function appWith(service: Partial<DataMarketService>, role = "platform_admin") {
  const app = new Hono<{ Variables: { principal: BoundPrincipal } }>();
  app.use("*", async (c, next) => {
    c.set("principal", {
      sub: "admin-data-market@test",
      userId: "00000000-0000-4000-8000-000000000001",
      role,
      email: "admin-data-market@test",
      orgId: null,
      orgIds: [],
      memberships: [],
      capabilities: [],
    } as unknown as BoundPrincipal);
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { message: error.message },
      (error instanceof AppError ? error.statusCode : 500) as 403 | 400 | 500,
    ),
  );
  app.route("/api", createAdminDataMarketRoutes(service as DataMarketService));
  return app;
}

describe("admin data market routes", () => {
  test("lists reviewing assets and accepts only strict decisions with reasons", async () => {
    const reviews: unknown[] = [];
    const app = appWith({
      listReviewingPublicAssets: async (_actor, query) => ({
        assets: [],
        total: 0,
        limit: query.limit,
        offset: query.offset,
      }),
      reviewPublicAsset: async (_actor, assetId, review) => {
        reviews.push({ assetId, review });
        return { asset: { id: assetId, lifecycle: "published" }, idempotent: false } as Awaited<
          ReturnType<DataMarketService["reviewPublicAsset"]>
        >;
      },
    });
    const list = await app.request("/api/admin/data-market/assets/reviewing?limit=10&offset=1");
    const valid = await app.request("/api/admin/data-market/assets/asset-1/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve", reason: "Verified" }),
    });
    const invalid = await app.request("/api/admin/data-market/assets/asset-1/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "reject", reason: "", extra: true }),
    });
    expect(list.status).toBe(200);
    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(reviews).toEqual([
      { assetId: "asset-1", review: { decision: "approve", reason: "Verified" } },
    ]);
  });

  test("rejects non-platform administrators", async () => {
    const app = appWith({}, "org_admin");
    expect((await app.request("/api/admin/data-market/assets/reviewing")).status).toBe(403);
  });

  test("platform review and revocation endpoints require strict bodies", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      reviewOwnerEntitlement: async (_actor, requestId, review) => {
        calls.push({ requestId, review });
        return { idempotent: false, grant: { id: "grant-1" } } as Awaited<
          ReturnType<DataMarketService["reviewOwnerEntitlement"]>
        >;
      },
      revokeOwnerEntitlement: async (_actor, grantId, reason) => {
        calls.push({ grantId, reason });
        return { idempotent: false } as Awaited<
          ReturnType<DataMarketService["revokeOwnerEntitlement"]>
        >;
      },
    });
    const reviewed = await app.request(
      "/api/admin/data-market/owner-entitlement-requests/request-1/review",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve", reason: "Verified", expiresAt: null }),
      },
    );
    const revoked = await app.request("/api/admin/data-market/owner-entitlements/grant-1/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Revoked" }),
    });
    const invalid = await app.request("/api/admin/data-market/owner-entitlements/grant-1/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "", extra: true }),
    });
    expect(reviewed.status).toBe(200);
    expect(revoked.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(calls).toEqual([
      {
        requestId: "request-1",
        review: { decision: "approve", reason: "Verified", expiresAt: null },
      },
      { grantId: "grant-1", reason: "Revoked" },
    ]);
  });
});
