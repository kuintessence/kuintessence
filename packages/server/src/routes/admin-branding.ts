import { auditLog, type PgDb, platformBranding } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  type PlatformBranding,
  PlatformBrandingSchema,
} from "@kuintessence/shared";
import { sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import { loadPlatformBranding, savePlatformBranding } from "../services/platform-branding-store";

export interface AdminBrandingRouteOptions {
  authz?: AuthzService;
}

export function createAdminBrandingRoutes(db: PgDb, opts: AdminBrandingRouteOptions = {}): Hono {
  const routes = new Hono();

  routes.get("/admin/branding", async (c) => {
    await requirePlatformPermission(c, opts.authz, "view", "admin-branding");
    return c.json(await loadPlatformBranding(db));
  });

  routes.put(
    "/admin/branding",
    kqValidator("json", PlatformBrandingSchema, "Invalid platform branding body"),
    async (c) => {
      await requirePlatformPermission(c, opts.authz, "manage", "admin-branding");
      const actorUserId = requireCanonicalBrandingAdminActor(c);
      const input = c.req.valid("json");

      const after = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE ${platformBranding} IN EXCLUSIVE MODE`);
        const before = await loadPlatformBranding(tx);
        await savePlatformBranding(tx, input, actorUserId);
        await tx.insert(auditLog).values({
          actor: actorUserId,
          orgId: null,
          action: "platform.branding.update",
          target: "platform_branding",
          diff: { before: configAuditView(before), after: configAuditView(input) },
        });
        return loadPlatformBranding(tx);
      });

      return c.json(after);
    },
  );

  return routes;
}

function configAuditView(config: PlatformBranding) {
  return {
    locales: config.locales,
    logoUrl: config.logoUrl,
    faviconUrl: config.faviconUrl,
  };
}

function requireCanonicalBrandingAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}
