import { AppError, ErrorCode } from "@kuintessence/shared";
import {
  FederationDatasetPublicationSchema,
  FederationDatasetUseApprovalSchema,
  FederationError,
  FederationMediaExportApprovalSchema,
  FederationMediaImportApprovalSchema,
  FederationMediaRegistrationSchema,
  FederationMediaRevocationSchema,
  MediaDeviceRegistrationSchema,
  MediaDeviceUpdateSchema,
  MediaHandoffSchema,
  MediaShipmentRegistrationSchema,
} from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationDatasetPublicationService } from "../federation/dataset-publication";
import type { FederationDatasetUsePolicies } from "../federation/dataset-use-policies";
import type { FederationMediaExportOperations } from "../federation/media-export-operations";
import type { FederationMediaExportService } from "../federation/media-exports";
import type { FederationMediaImportOperations } from "../federation/media-import-operations";
import type { FederationMediaLogistics } from "../federation/media-logistics";
import type { FederationMediaPackageService } from "../federation/media-packages";
import type {
  FederationMediaReceiptReceiver,
  FederationMediaReceiptSender,
} from "../federation/media-receipts";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationMediaRoutes(
  service: FederationMediaPackageService,
  exports?: FederationMediaExportService,
  exportOperations?: FederationMediaExportOperations,
  importOperations?: FederationMediaImportOperations,
  datasetUse?: FederationDatasetUsePolicies,
  publication?: FederationDatasetPublicationService,
  receipts?: { sender?: FederationMediaReceiptSender; receiver?: FederationMediaReceiptReceiver },
  logistics?: FederationMediaLogistics,
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
  const receiptSender = () => {
    if (!receipts?.sender)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "MEDIA_RECEIPT_UNAVAILABLE", 503);
    return receipts.sender;
  };
  const transport = () => {
    if (!logistics)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "MEDIA_LOGISTICS_UNAVAILABLE", 503);
    return logistics;
  };
  const page = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().nonnegative().default(0),
  });
  const id = z.object({ id: z.uuid() });
  r.get("/federation/media/logistics-context", async (c) =>
    c.json({ data: await transport().context(c.get("federationActor")) }),
  );
  r.get("/federation/media/transport-packages", kqValidator("query", page), async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json(await transport().transportPackages(c.get("federationActor"), limit, offset));
  });
  r.get("/federation/media/devices", kqValidator("query", page), async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json(await transport().listDevices(c.get("federationActor"), limit, offset));
  });
  r.post(
    "/federation/media/devices",
    kqValidator("json", MediaDeviceRegistrationSchema),
    async (c) =>
      c.json(
        { data: await transport().registerDevice(c.get("federationActor"), c.req.valid("json")) },
        201,
      ),
  );
  r.patch(
    "/federation/media/devices/:id",
    kqValidator("param", id),
    kqValidator("json", MediaDeviceUpdateSchema),
    async (c) =>
      c.json({
        data: await transport().updateDevice(
          c.get("federationActor"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      }),
  );
  r.get("/federation/media/shipments", kqValidator("query", page), async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json(await transport().listShipments(c.get("federationActor"), limit, offset));
  });
  r.post(
    "/federation/media/shipments",
    kqValidator("json", MediaShipmentRegistrationSchema),
    async (c) =>
      c.json(
        { data: await transport().registerShipment(c.get("federationActor"), c.req.valid("json")) },
        201,
      ),
  );
  r.get(
    "/federation/media/shipments/:id",
    kqValidator("param", id),
    kqValidator("query", page),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json({
        data: await transport().shipmentDetails(
          c.get("federationActor"),
          c.req.valid("param").id,
          limit,
          offset,
        ),
      });
    },
  );
  r.post(
    "/federation/media/shipments/:id/handoffs",
    kqValidator("param", id),
    kqValidator("json", MediaHandoffSchema),
    async (c) =>
      c.json(
        {
          data: await transport().recordHandoff(
            c.get("federationActor"),
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        },
        201,
      ),
  );
  r.get(
    "/federation/media/packages/:id/import-authorizations/:authorizationId/receipt",
    kqValidator("param", z.object({ id: z.uuid(), authorizationId: z.uuid() })),
    async (c) => {
      const { id, authorizationId } = c.req.valid("param");
      return c.json({
        success: true,
        data: await receiptSender().status(c.get("federationActor"), id, authorizationId),
      });
    },
  );
  r.post(
    "/federation/media/packages/:id/import-authorizations/:authorizationId/receipt/retry",
    kqValidator("param", z.object({ id: z.uuid(), authorizationId: z.uuid() })),
    async (c) => {
      const { id, authorizationId } = c.req.valid("param");
      await receiptSender().retry(c.get("federationActor"), id, authorizationId);
      return c.json({ success: true });
    },
  );
  r.get(
    "/federation/media/exports/:id/receipts",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().nonnegative().default(0),
      }),
    ),
    async (c) => {
      if (!receipts?.receiver)
        throw new AppError(ErrorCode.INTERNAL_ERROR, "MEDIA_RECEIPT_UNAVAILABLE", 503);
      return c.json({
        success: true,
        data: await receipts.receiver.list(
          c.get("federationActor"),
          c.req.valid("param").id,
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      });
    },
  );
  const datasets = () => {
    if (!publication)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "DATASET_PUBLICATION_UNAVAILABLE", 503);
    return publication;
  };
  r.post(
    "/federation/media/packages/:id/datasets",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator("json", FederationDatasetPublicationSchema),
    async (c) =>
      c.json(
        {
          success: true,
          data: await datasets().publish(
            c.get("federationActor"),
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        },
        201,
      ),
  );
  r.get(
    "/federation/media/datasets",
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
        data: await datasets().list(
          c.get("federationActor"),
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      }),
  );
  r.post(
    "/federation/media/datasets/:id/revoke",
    kqValidator("param", z.object({ id: z.uuid() })),
    kqValidator("json", FederationMediaRevocationSchema),
    async (c) => {
      await datasets().revoke(
        c.get("federationActor"),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json({ success: true });
    },
  );
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
