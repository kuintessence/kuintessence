import { AppError, ErrorCode } from "@kuintessence/shared";
import {
  FederationAssetRefSchema,
  FederationDigestSchema,
  FederationError,
} from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationAssetService } from "../federation/assets";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationAssetRoutes(service: FederationAssetService) {
  const r = new Hono<{ Variables: { federationActor: FederationActor } }>();
  r.use("/federation/assets/*", async (c, next) => {
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
  r.use("/federation/assets/*", bodyLimit({ maxSize: 1100000 }));
  r.onError((error, c) => {
    if (error instanceof FederationError) {
      const status =
        error.code === "POLICY_DENIED" ? 403 : error.code === "INVALID_MESSAGE" ? 400 : 409;
      return c.json({ error: { code: error.code } }, status);
    }
    throw error;
  });
  r.get(
    "/federation/assets/mappings",
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
    "/federation/assets/mappings",
    kqValidator(
      "json",
      z.strictObject({ reference: FederationAssetRefSchema, localRevisionId: z.uuid() }),
    ),
    async (c) =>
      c.json(
        {
          success: true,
          data: await service.register(c.get("federationActor"), c.req.valid("json")),
        },
        201,
      ),
  );
  r.post(
    "/federation/assets/mappings/:id/revoke",
    kqValidator("param", z.object({ id: z.uuid() })),
    async (c) => {
      await service.revoke(c.get("federationActor"), c.req.valid("param").id);
      return c.json({ success: true });
    },
  );
  r.post(
    "/federation/assets/materials",
    kqValidator("json", z.strictObject({ originSiteId: z.uuid(), content: z.unknown() })),
    async (c) => {
      const { originSiteId, content } = c.req.valid("json");
      return c.json(
        {
          success: true,
          data: await service.putMaterial(c.get("federationActor"), originSiteId, content),
        },
        201,
      );
    },
  );
  r.get(
    "/federation/assets/materials/:originSiteId/:digest",
    kqValidator("param", z.object({ originSiteId: z.uuid(), digest: FederationDigestSchema })),
    async (c) => {
      const { originSiteId, digest } = c.req.valid("param");
      return c.json({
        success: true,
        data: await service.getMaterial(c.get("federationActor"), originSiteId, digest),
      });
    },
  );
  return r;
}
