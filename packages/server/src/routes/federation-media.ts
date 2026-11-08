import { AppError, ErrorCode } from "@kuintessence/shared";
import {
  FederationDatasetUseApprovalSchema,
  FederationError,
  FederationMediaExportApprovalSchema,
  FederationMediaImportApprovalSchema,
  FederationMediaRegistrationSchema,
  FederationMediaRevocationSchema,
} from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationDatasetUsePolicies } from "../federation/dataset-use-policies";
import type { FederationMediaExportOperations } from "../federation/media-export-operations";
import type { FederationMediaExportService } from "../federation/media-exports";
import type { FederationMediaImportOperations } from "../federation/media-import-operations";
import type { FederationMediaPackageService } from "../federation/media-packages";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationMediaRoutes(
  service: FederationMediaPackageService,
  exports?: FederationMediaExportService,
  exportOperations?: FederationMediaExportOperations,
  importOperations?: FederationMediaImportOperations,
  datasetUse?: FederationDatasetUsePolicies,
) {
  const r = new Hono<{ Variables: { federationActor: FederationActor } }>();
  r.use("/federation/media/*", async (c, next) => {
    c.header("cache-control", "no-store");
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
  r.use("/federation/media/*", bodyLimit({ maxSize: 530_000 }));
  r.onError((error, c) => {
    if (error instanceof FederationError)
      return c.json(
        { error: { code: error.code } },
        error.code === "POLICY_DENIED" ? 403 : error.code === "INVALID_MESSAGE" ? 400 : 409,
      );
    throw error;
  });
  const source = () => {
    if (!exports) throw new AppError(ErrorCode.INTERNAL_ERROR, "MEDIA_EXPORT_UNAVAILABLE", 503);
    return exports;
  };
  const operations = () => {
    if (!exportOperations)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "MEDIA_EXPORT_UNAVAILABLE", 503);
    return exportOperations;
  };
  const usePolicies = () => {
    if (!datasetUse) throw new AppError(ErrorCode.INTERNAL_ERROR, "DATASET_USE_UNAVAILABLE", 503);
    return datasetUse;
  };
  r.post(
    "/federation/media/dataset-use-policies",
    kqValidator("json", FederationDatasetUseApprovalSchema),
    async (c) =>
      c.json(
        {
          success: true,
          data: await usePolicies().approve(c.get("federationActor"), c.req.valid("json")),
        },
        201,
      ),
  );
  r.get(
    "/federation/media/dataset-use-policies",
    kqValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().nonnegative().default(0),
      }),
    ),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json({
        success: true,
        data: await usePolicies().list(c.get("federationActor"), limit, offset),
      });
    },
  );
  r.post(
    "/federation/media/dataset-use-policies/:id/revoke",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator("json", FederationMediaRevocationSchema),
    async (c) => {
      await usePolicies().revoke(
        c.get("federationActor"),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json({ success: true });
    },
  );
  const imports = () => {
    if (!importOperations)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "MEDIA_IMPORT_UNAVAILABLE", 503);
    return importOperations;
  };
  r.post(
    "/federation/media/packages/:id/import-authorizations/:authorizationId/run",
    kqValidator("param", z.object({ id: z.uuid(), authorizationId: z.uuid() })),
    async (c) => {
      const { id, authorizationId } = c.req.valid("param");
      return c.json(
        {
          success: true,
          data: await imports().start(c.get("federationActor"), id, authorizationId),
        },
        202,
      );
    },
  );
  r.get(
    "/federation/media/packages/:id/import-authorizations/:authorizationId/operation",
    kqValidator("param", z.object({ id: z.uuid(), authorizationId: z.uuid() })),
    async (c) => {
      const { id, authorizationId } = c.req.valid("param");
      return c.json({
        success: true,
        data: await imports().status(c.get("federationActor"), id, authorizationId),
      });
    },
  );
  r.post(
    "/federation/media/exports/:id/run",
    kqValidator("param", z.object({ id: z.uuid() })),
    async (c) =>
      c.json(
        {
          success: true,
          data: await operations().start(c.get("federationActor"), c.req.valid("param").id),
        },
        202,
      ),
  );
  r.get(
    "/federation/media/exports/:id/operation",
    kqValidator("param", z.object({ id: z.uuid() })),
    async (c) =>
      c.json({
        success: true,
        data: await operations().status(c.get("federationActor"), c.req.valid("param").id),
      }),
  );
  r.post(
    "/federation/media/exports",
    kqValidator("json", FederationMediaExportApprovalSchema),
    async (c) =>
      c.json(
        {
          success: true,
          data: await source().prepare(c.get("federationActor"), c.req.valid("json")),
        },
        201,
      ),
  );
  r.get(
    "/federation/media/exports",
    kqValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().nonnegative().default(0),
      }),
    ),
    async (c) =>
      c.json({
        success: true,
        data: await source().list(
          c.get("federationActor"),
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      }),
  );
  r.get(
    "/federation/media/exports/:id",
    kqValidator("param", z.object({ id: z.uuid() })),
    async (c) =>
      c.json({
        success: true,
        data: await source().details(c.get("federationActor"), c.req.valid("param").id),
      }),
  );
  r.post(
    "/federation/media/exports/:id/revoke",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator("json", FederationMediaRevocationSchema),
    async (c) => {
      await source().revoke(c.get("federationActor"), c.req.valid("param").id, c.req.valid("json"));
      return c.json({ success: true });
    },
  );
  r.get(
    "/federation/media/packages",
    kqValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().nonnegative().default(0),
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
    "/federation/media/packages",
    kqValidator("json", FederationMediaRegistrationSchema),
    async (c) =>
      c.json(
        {
          success: true,
          data: await service.register(c.get("federationActor"), c.req.valid("json")),
        },
        201,
      ),
  );
  r.get(
    "/federation/media/packages/:id",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator(
      "query",
      z.object({ authorizationOffset: z.coerce.number().int().nonnegative().default(0) }),
    ),
    async (c) =>
      c.json({
        success: true,
        data: await service.details(
          c.get("federationActor"),
          c.req.valid("param").id,
          c.req.valid("query").authorizationOffset,
        ),
      }),
  );
  r.post(
    "/federation/media/packages/:id/import-authorizations",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator("json", FederationMediaImportApprovalSchema),
    async (c) =>
      c.json(
        {
          success: true,
          data: await service.approveImport(
            c.get("federationActor"),
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        },
        201,
      ),
  );
  r.post(
    "/federation/media/packages/:id/revoke",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator("json", FederationMediaRevocationSchema),
    async (c) => {
      await service.revoke(c.get("federationActor"), c.req.valid("param").id, c.req.valid("json"));
      return c.json({ success: true });
    },
  );
  r.post(
    "/federation/media/packages/:id/import-authorizations/:authorizationId/revoke",
    kqValidator("param", z.object({ id: z.uuid(), authorizationId: z.uuid() })),
    kqValidator("json", FederationMediaRevocationSchema),
    async (c) => {
      const { id, authorizationId } = c.req.valid("param");
      await service.revoke(c.get("federationActor"), id, c.req.valid("json"), authorizationId);
      return c.json({ success: true });
    },
  );
  return r;
}
