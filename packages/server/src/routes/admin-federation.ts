import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import {
  CompletionPoolInput,
  type FederationCompletionCapacity,
} from "../federation/completion-capacity";
import type { FederationStorageGuard } from "../federation/storage-capacity";
import {
  FederationCertificateInput,
  FederationKeyInput,
  FederationSiteInput,
  type FederationTrustRegistry,
} from "../federation/trust-registry";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

const SitePath = z.strictObject({ siteId: z.uuid() });
const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Infrastructure trust only. This does not grant authority to approve commercial agreements. */
export function createAdminFederationRoutes(
  registry: FederationTrustRegistry,
  authz?: AuthzService,
  storageGuard?: FederationStorageGuard,
  completionCapacity?: FederationCompletionCapacity,
) {
  const r = new Hono<{ Variables: { federationActor: string } }>();
  r.use("/admin/federation/*", async (c, next) => {
    await requirePlatformPermission(c, authz, "manage", "admin-federation-trust");
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId)
      throw new AppError(ErrorCode.FORBIDDEN, "Bound administrator required", 403);
    c.set("federationActor", principal.userId);
    await next();
  });
  r.use("/admin/federation/*", bodyLimit({ maxSize: 32768 }));
  r.onError((error, c) => {
    if (error instanceof FederationError) {
      c.header("cache-control", "no-store");
      return c.json(
        { error: { code: error.code } },
        error.code === "STORAGE_PRESSURE" ? 503 : error.code === "OPERATION_CONFLICT" ? 409 : 400,
      );
    }
    throw error;
  });
  r.get("/admin/federation/storage", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({
      success: true,
      data: {
        enabled: !!storageGuard,
        completion: completionCapacity ? await completionCapacity.inspect() : null,
        volumes: storageGuard ? await storageGuard.inspect() : [],
      },
    });
  });
  r.put(
    "/admin/federation/storage/completion",
    kqValidator("json", CompletionPoolInput),
    async (c) => {
      c.header("cache-control", "no-store");
      if (!completionCapacity) throw new FederationError("POLICY_DENIED");
      return c.json({
        success: true,
        data: await completionCapacity.configure(c.req.valid("json"), c.get("federationActor")),
      });
    },
  );
  r.get("/admin/federation/sites", kqValidator("query", Paging), async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json({ success: true, data: await registry.list(limit, offset) });
  });
  r.post("/admin/federation/sites", kqValidator("json", FederationSiteInput), async (c) =>
    c.json(
      {
        success: true,
        data: await registry.addSite(c.req.valid("json"), c.get("federationActor")),
      },
      201,
    ),
  );
  r.get("/admin/federation/sites/:siteId", kqValidator("param", SitePath), async (c) =>
    c.json({ success: true, data: await registry.details(c.req.valid("param").siteId) }),
  );
  r.put(
    "/admin/federation/sites/:siteId",
    kqValidator("param", SitePath),
    kqValidator("json", FederationSiteInput.omit({ id: true })),
    async (c) =>
      c.json({
        success: true,
        data: await registry.updateSite(
          c.req.valid("param").siteId,
          c.req.valid("json"),
          c.get("federationActor"),
        ),
      }),
  );
  r.post(
    "/admin/federation/sites/:siteId/state",
    kqValidator("param", SitePath),
    kqValidator("json", z.strictObject({ state: z.enum(["active", "suspended", "revoked"]) })),
    async (c) => {
      await registry.setState(
        c.req.valid("param").siteId,
        c.req.valid("json").state,
        c.get("federationActor"),
      );
      return c.json({ success: true });
    },
  );
  r.post(
    "/admin/federation/sites/:siteId/keys",
    kqValidator("param", SitePath),
    kqValidator("json", FederationKeyInput),
    async (c) =>
      c.json(
        {
          success: true,
          data: await registry.addKey(
            c.req.valid("param").siteId,
            c.req.valid("json"),
            c.get("federationActor"),
          ),
        },
        201,
      ),
  );
  r.post(
    "/admin/federation/sites/:siteId/certificates",
    kqValidator("param", SitePath),
    kqValidator("json", FederationCertificateInput),
    async (c) =>
      c.json(
        {
          success: true,
          data: await registry.addCertificate(
            c.req.valid("param").siteId,
            c.req.valid("json"),
            c.get("federationActor"),
          ),
        },
        201,
      ),
  );
  r.post(
    "/admin/federation/sites/:siteId/revoke",
    kqValidator("param", SitePath),
    kqValidator(
      "json",
      z.union([
        z.strictObject({ keyId: FederationKeyInput.shape.keyId }),
        z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
      ]),
    ),
    async (c) => {
      await registry.revoke(
        c.req.valid("param").siteId,
        c.req.valid("json"),
        c.get("federationActor"),
      );
      return c.json({ success: true });
    },
  );
  return r;
}
