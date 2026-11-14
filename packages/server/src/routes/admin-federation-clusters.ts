import { AppError, ErrorCode } from "@kuintessence/shared";
import {
  FederationClusterQueueConfigSchema,
  FederationError,
} from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { FederationClusterQueueService } from "../federation/cluster-queues";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createAdminFederationClusterRoutes(
  service: FederationClusterQueueService,
  authz?: AuthzService,
) {
  const r = new Hono<{ Variables: { clusterActor: FederationActor } }>();
  r.use("/admin/federation/clusters/*", async (c, next) => {
    await requirePlatformPermission(c, authz, "manage", "admin-federation-clusters");
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId || !principal.orgId || c.get("automation" as never))
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "An administrator session and active organization are required",
        403,
      );
    c.set("clusterActor", { userId: principal.userId, orgId: principal.orgId });
    c.header("cache-control", "no-store");
    await next();
  });
  r.use("/admin/federation/clusters/*", bodyLimit({ maxSize: 1048576 }));
  r.onError((error, c) => {
    if (error instanceof FederationError)
      return c.json({ error: { code: error.code } }, error.code === "POLICY_DENIED" ? 403 : 409);
    throw error;
  });
  r.get("/admin/federation/clusters", async (c) =>
    c.json({ data: await service.list(c.get("clusterActor")) }),
  );
  r.post(
    "/admin/federation/clusters",
    kqValidator("json", FederationClusterQueueConfigSchema),
    async (c) =>
      c.json({ data: await service.save(c.get("clusterActor"), c.req.valid("json")) }, 201),
  );
  r.put(
    "/admin/federation/clusters/:id",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator("json", FederationClusterQueueConfigSchema),
    async (c) =>
      c.json({
        data: await service.save(
          c.get("clusterActor"),
          c.req.valid("json"),
          c.req.valid("param").id,
        ),
      }),
  );
  r.delete(
    "/admin/federation/clusters/:id",
    kqValidator("param", z.object({ id: z.uuid() })),
    async (c) => {
      await service.remove(c.get("clusterActor"), c.req.valid("param").id);
      return c.json({ success: true });
    },
  );
  return r;
}
