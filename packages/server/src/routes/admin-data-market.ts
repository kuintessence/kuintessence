import { AppError, ErrorCode, hasRole, type RoleName } from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { DataMarketActor, DataMarketService } from "../services/data-market";

const ReviewQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const ReviewSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

const OwnerEntitlementReviewSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().min(1).max(2_000),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();

const OwnerEntitlementRevocationSchema = z
  .object({ reason: z.string().trim().min(1).max(2_000) })
  .strict();

export function createAdminDataMarketRoutes(service: DataMarketService): Hono {
  const r = new Hono();
  r.get("/admin/data-market/assets/reviewing", async (c) => {
    const actor = requirePlatformAdmin(c);
    const query = parseReviewQuery(c);
    const data = await service.listReviewingPublicAssets(actor, query);
    return c.json({ success: true, data });
  });
  r.post("/admin/data-market/assets/:assetId/review", async (c) => {
    const actor = requirePlatformAdmin(c);
    const review = parseReview(await c.req.json());
    const data = await service.reviewPublicAsset(actor, c.req.param("assetId"), review);
    return c.json({ success: true, data });
  });
  r.post("/admin/data-market/owner-entitlement-requests/:requestId/review", async (c) => {
    const actor = requirePlatformAdmin(c);
    const review = parseOwnerEntitlementReview(await c.req.json());
    const data = await service.reviewOwnerEntitlement(actor, c.req.param("requestId"), review);
    return c.json({ success: true, data });
  });
  r.post("/admin/data-market/owner-entitlements/:grantId/revoke", async (c) => {
    const actor = requirePlatformAdmin(c);
    const { reason } = parseOwnerEntitlementRevocation(await c.req.json());
    const data = await service.revokeOwnerEntitlement(actor, c.req.param("grantId"), reason);
    return c.json({ success: true, data });
  });
  return r;
}

function parseReviewQuery(c: Context) {
  const result = ReviewQuerySchema.safeParse({
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!result.success)
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid review queue query", 400);
  return result.data;
}

function parseReview(body: unknown) {
  const result = ReviewSchema.safeParse(body);
  if (!result.success)
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid data asset review", 400);
  return result.data;
}

function parseOwnerEntitlementReview(body: unknown) {
  const result = OwnerEntitlementReviewSchema.safeParse(body);
  if (!result.success)
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid owner entitlement review", 400);
  return result.data;
}

function parseOwnerEntitlementRevocation(body: unknown) {
  const result = OwnerEntitlementRevocationSchema.safeParse(body);
  if (!result.success)
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid owner entitlement revocation", 400);
  return result.data;
}

function requirePlatformAdmin(c: Context): DataMarketActor {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId || !hasRole(principal.role as RoleName, "platform_admin")) {
    throw new AppError(ErrorCode.FORBIDDEN, "Platform administrator required", 403);
  }
  return {
    userId: principal.userId,
    role: principal.role as RoleName,
    orgId: principal.orgId,
    orgIds: principal.orgIds,
  };
}
