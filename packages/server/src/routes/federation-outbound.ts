import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationDelegationSchema, FederationError } from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationOutboundService } from "../federation/outbound";
import { FederationDeliveryError } from "../federation/outbound-client";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationOutboundRoutes(service: FederationOutboundService) {
  const r = new Hono<{ Variables: { federationActor: FederationActor } }>();
  r.use("/federation/outbound/*", async (c, next) => {
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId || !principal.orgId || c.get("automation" as never))
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "A human session and active organization are required",
        403,
      );
    c.set("federationActor", { userId: principal.userId, orgId: principal.orgId });
    await next();
  });
  r.use("/federation/outbound/*", bodyLimit({ maxSize: 524288 }));
  r.onError((error, c) => {
    if (error instanceof FederationDeliveryError)
      return c.json(
        { error: { code: error.code } },
        error.code === "DELIVERY_UNAVAILABLE" ? 503 : 502,
      );
    if (error instanceof FederationError)
      return c.json(
        { error: { code: error.code } },
        error.code === "POLICY_DENIED" ? 403 : error.code === "INVALID_MESSAGE" ? 400 : 409,
      );
    throw error;
  });
  r.post("/federation/outbound", kqValidator("json", FederationDelegationSchema), async (c) =>
    c.json(
      { success: true, data: await service.enqueue(c.get("federationActor"), c.req.valid("json")) },
      202,
    ),
  );
  r.get(
    "/federation/outbound",
    kqValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    ),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json({
        success: true,
        data: await service.list(c.get("federationActor"), limit, offset),
      });
    },
  );
  r.post(
    "/federation/outbound/:operationId/retry",
    kqValidator("param", z.object({ operationId: z.uuid() })),
    async (c) => {
      await service.retry(c.get("federationActor"), c.req.valid("param").operationId);
      return c.json({ success: true });
    },
  );
  r.get(
    "/federation/outbound/:operationId/remote-status",
    kqValidator("param", z.object({ operationId: z.uuid() })),
    async (c) => {
      c.header("cache-control", "no-store");
      return c.json({
        success: true,
        data: await service.remoteStatus(
          c.get("federationActor"),
          c.req.valid("param").operationId,
        ),
      });
    },
  );
  for (const action of ["cancel", "cancel-retry"] as const) {
    r.post(
      `/federation/outbound/:operationId/${action}`,
      kqValidator("param", z.object({ operationId: z.uuid() })),
      async (c) =>
        c.json(
          {
            success: true,
            data: await service.cancellations.request(
              c.get("federationActor"),
              c.req.valid("param").operationId,
              action === "cancel-retry",
            ),
          },
          202,
        ),
    );
  }
  return r;
}
