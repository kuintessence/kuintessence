import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import {
  FederationCapabilitySchema,
  type FederationPermissionService,
} from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createAdminFederationPermissionRoutes(
  service: FederationPermissionService,
  authz?: AuthzService,
) {
  const r = new Hono<{ Variables: { federationGrantActor: string } }>();
  r.use("/admin/federation/capabilities/*", async (c, next) => {
    await requirePlatformPermission(c, authz, "manage", "admin-federation-capabilities");
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId)
      throw new AppError(ErrorCode.FORBIDDEN, "Bound administrator required", 403);
    c.set("federationGrantActor", principal.userId);
    await next();
  });
  r.use("/admin/federation/capabilities/*", bodyLimit({ maxSize: 4096 }));
  r.onError((error, c) => {
    if (error instanceof FederationError) return c.json({ error: { code: error.code } }, 403);
    throw error;
  });
  r.get(
    "/admin/federation/capabilities",
    kqValidator(
      "query",
      z.object({
        orgId: z.uuid(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    ),
    async (c) => {
      const { orgId, limit, offset } = c.req.valid("query");
      return c.json({ success: true, data: await service.list(orgId, limit, offset) });
    },
  );
  r.put(
    "/admin/federation/capabilities",
    kqValidator(
      "json",
      z.strictObject({
        orgId: z.uuid(),
        userId: z.uuid(),
        capability: FederationCapabilitySchema,
        enabled: z.boolean(),
      }),
    ),
    async (c) => {
      await service.set(c.req.valid("json"), c.get("federationGrantActor"));
      return c.json({ success: true });
    },
  );
  return r;
}
