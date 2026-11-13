import { AppError, ErrorCode } from "@kuintessence/shared";
import {
  FederationError,
  FederationStorageReconciliationSchema,
} from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { FederationInputTransfers } from "../federation/input-transfers";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

/** An operator's documented storage drain is trusted explicitly; it is never inferred from absence. */
export function createAdminFederationStorageRoutes(
  transfers: FederationInputTransfers,
  authz?: AuthzService,
) {
  const r = new Hono<{ Variables: { storageActor: string } }>();
  r.use("/admin/federation/input-reconciliation/*", async (c, next) => {
    await requirePlatformPermission(c, authz, "manage", "admin-federation-storage");
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId)
      throw new AppError(ErrorCode.FORBIDDEN, "Bound administrator required", 403);
    c.set("storageActor", principal.userId);
    c.header("cache-control", "no-store");
    await next();
  });
  r.use("/admin/federation/input-reconciliation/*", bodyLimit({ maxSize: 4096 }));
  r.onError((error, c) => {
    if (error instanceof FederationError)
      return c.json({ error: { code: error.code } }, error.code === "POLICY_DENIED" ? 403 : 409);
    throw error;
  });
  r.get(
    "/admin/federation/input-reconciliation",
    kqValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) })),
    async (c) =>
      c.json({
        success: true,
        data: await transfers.reconciliationCandidates(c.req.valid("query").limit),
      }),
  );
  const path = "/admin/federation/input-reconciliation/:generation";
  const params = z.strictObject({ generation: z.uuid() });
  r.get(path, kqValidator("param", params), async (c) =>
    c.json({
      success: true,
      data: await transfers.reconciliationPlan(c.req.valid("param").generation),
    }),
  );
  r.post(
    path,
    kqValidator("param", params),
    kqValidator("json", FederationStorageReconciliationSchema),
    async (c) =>
      c.json(
        {
          success: true,
          data: await transfers.reconcile(
            c.req.valid("param").generation,
            c.req.valid("json"),
            c.get("storageActor"),
          ),
        },
        202,
      ),
  );
  return r;
}
