import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { MarketProposalInputSchema } from "@kuintessence/shared/federation/market";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationMarketService } from "../federation/market";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
export function createFederationMarketRoutes(service: FederationMarketService) {
  const r = new Hono<{ Variables: { federationActor: FederationActor } }>();
  r.use("/federation/market/*", async (c, next) => {
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId || !principal.orgId || c.get("automation" as never))
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "A human session and active organization are required",
        403,
      );
    c.set("federationActor", { userId: principal.userId, orgId: principal.orgId });
    c.header("cache-control", "no-store");
    await next();
  });
  r.use("/federation/market/*", bodyLimit({ maxSize: 32768 }));
  r.onError((error, c) => {
    if (error instanceof FederationError)
      return c.json(
        { error: { code: error.code } },
        error.code === "POLICY_DENIED" ? 403 : error.code === "INVALID_MESSAGE" ? 400 : 409,
      );
    throw error;
  });
  const id = z.object({ id: z.uuid() }),
    page = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });
  r.post(
    "/federation/market/operations",
    kqValidator("json", MarketProposalInputSchema),
    async (c) =>
      c.json(
        {
          success: true,
          data: await service.enqueue(c.get("federationActor"), c.req.valid("json")),
        },
        202,
      ),
  );
  r.get("/federation/market/operations", kqValidator("query", page), async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json({
      success: true,
      data: await service.list(c.get("federationActor"), limit, offset),
    });
  });
  r.get(
    "/federation/market/operations/:id",
    kqValidator("param", id),
    kqValidator("query", page),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json({
        success: true,
        data: await service.get(c.get("federationActor"), c.req.valid("param").id, limit, offset),
      });
    },
  );
  r.post(
    "/federation/market/operations/:id/retry",
    kqValidator("param", id),
    kqValidator("json", z.strictObject({})),
    async (c) => {
      await service.retry(c.get("federationActor"), c.req.valid("param").id);
      return c.json({ success: true });
    },
  );
  return r;
}
