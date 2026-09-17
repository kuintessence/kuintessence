import {
  AppError,
  DataAccessModeSchema,
  DataAssetEntryPathSchema,
  DataAssetKindSchema,
  DataLocationKindSchema,
  DataSensitivitySchema,
  DataVisibilitySchema,
  ErrorCode,
  type RoleName,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import type { DataAssetInput, DataMarketActor, DataMarketService } from "../services/data-market";
import { normalizeChemicalElements } from "../services/data-market";

const ChemicalElementsSchema = z
  .array(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z]{1,2}$/),
  )
  .max(118)
  .transform(normalizeChemicalElements);

const CatalogQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    tag: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const DataMarketAssetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(10_000).nullable().optional(),
    visibility: DataVisibilitySchema,
    kind: DataAssetKindSchema.default("scientific-dataset"),
    accessMode: DataAccessModeSchema.default("request"),
    sensitivity: DataSensitivitySchema.default("internal"),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    elements: ChemicalElementsSchema.optional(),
    providerOrgId: z.string().uuid().nullable().optional(),
  })
  .strict();

const ManifestSchema = z
  .object({
    checksum: z.string().regex(/^[a-f0-9]{64}$/i),
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().trim().min(1).max(255),
    source: DataLocationKindSchema,
  })
  .strict();

export const DataMarketVersionInputSchema = z
  .object({
    version: z.string().trim().min(1).max(100),
    manifest: ManifestSchema,
    files: z
      .array(
        z
          .object({
            path: DataAssetEntryPathSchema,
            checksum: z.string().regex(/^[a-f0-9]{64}$/i),
            sizeBytes: z.number().int().nonnegative(),
            mediaType: z.string().trim().min(1).max(255).nullable(),
            objectKey: z.string().trim().min(1).max(2_048).nullable(),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

const UploadSessionSchema = z
  .object({
    version: z.string().trim().min(1).max(100),
    path: DataAssetEntryPathSchema,
    sizeBytes: z.number().int().positive(),
    mediaType: z.string().trim().min(1).max(255),
  })
  .strict();

const UploadCommitSchema = z
  .object({
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strict();

export const DataMarketReplicaInputSchema = z
  .object({
    agentId: z.string().trim().min(1).max(255),
    siteId: z.string().trim().min(1).max(255),
    clusterId: z.string().trim().min(1).max(255),
    locationKind: DataLocationKindSchema,
    managedRootId: z.string().uuid().optional(),
    relativePath: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict();

export const CpDataImportInputSchema = z
  .object({
    assetId: z.string().uuid(),
    version: z.string().trim().min(1).max(100),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("platform-object"), uploadSessionId: z.string().uuid() }).strict(),
      z.object({ kind: z.literal("netdrive"), netdriveFileId: z.string().uuid() }).strict(),
      z
        .object({
          kind: z.literal("cp-local"),
          agentId: z.string().trim().min(1).max(255),
          managedRootId: z.string().uuid(),
          relativePath: z
            .string()
            .trim()
            .min(1)
            .max(2_048)
            .refine(
              (value) =>
                !value.startsWith("/") &&
                !value.split(/[\\/]/).some((part) => part === "" || part === ".."),
              "relativePath must be relative without parent traversal",
            ),
        })
        .strict(),
    ]),
  })
  .strict();

const AccessRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(2_000).nullable().optional() })
  .strict();

const OwnerEntitlementRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(2_000) })
  .strict();

export interface DataMarketRoutesDeps {
  service: DataMarketService;
}

export function createDataMarketRoutes(deps: DataMarketRoutesDeps): Hono {
  const r = new Hono();

  r.get("/data-market/catalog", async (c) => {
    const query = parseQuery(c, CatalogQuerySchema);
    const data = await deps.service.listCatalog(requireActor(c), query);
    return c.json({ success: true, data });
  });

  r.get("/data-market/access-requests/mine", async (c) => {
    const assetIds = parseAssetIds(c);
    const data = await deps.service.getMyAccessState(requireActor(c), assetIds);
    return c.json({ success: true, data });
  });

  r.get("/data-market/assets/:assetId", async (c) => {
    const data = await deps.service.getAsset(requireActor(c), c.req.param("assetId"));
    return c.json({ success: true, data });
  });

  r.get("/data-market/assets/:assetId/versions/:version", async (c) => {
    const data = await deps.service.getVersion(
      requireActor(c),
      c.req.param("assetId"),
      c.req.param("version"),
    );
    return c.json({ success: true, data });
  });

  r.get("/data-market/assets/:assetId/versions/:version/files", async (c) => {
    const data = await deps.service.listFiles(
      requireActor(c),
      c.req.param("assetId"),
      c.req.param("version"),
    );
    return c.json({ success: true, data });
  });

  r.post(
    "/data-market/private/assets",
    kqValidator("json", DataMarketAssetInputSchema, "Invalid private data asset body"),
    async (c) => {
      const data = await deps.service.createPrivateAsset(
        requireActor(c),
        c.req.valid("json") as DataAssetInput,
        requireIdempotencyKey(c),
      );
      return c.json({ success: true, data }, 201);
    },
  );

  r.post(
    "/data-market/assets/:assetId/upload-sessions",
    kqValidator("json", UploadSessionSchema, "Invalid data upload session body"),
    async (c) => {
      const data = await deps.service.createUploadSession(
        requireActor(c),
        { assetId: c.req.param("assetId"), ...c.req.valid("json") },
        requireIdempotencyKey(c),
      );
      return c.json({ success: true, data }, 201);
    },
  );

  r.post(
    "/data-market/upload-sessions/:sessionId/commit",
    kqValidator("json", UploadCommitSchema, "Invalid data upload commit body"),
    async (c) => {
      const data = await deps.service.commitUploadSession(
        requireActor(c),
        c.req.param("sessionId"),
        c.req.valid("json").sha256,
      );
      return c.json({ success: true, data });
    },
  );

  r.post("/data-market/cp/assets", async () => {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "CP data assets must be created through /api/cp/data/assets",
      409,
    );
  });

  r.post("/data-market/cp/assets/:assetId/versions", async () => {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "CP data versions must be created through /api/cp/data/imports",
      400,
    );
  });

  r.post("/data-market/cp/versions/:versionId/replicas", async () => {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "CP data replicas must be created through /api/cp/data/versions/:versionId/replicas",
      409,
    );
  });

  r.post(
    "/data-market/assets/:assetId/access-requests",
    kqValidator("json", AccessRequestSchema, "Invalid data access request body"),
    async (c) => {
      const data = await deps.service.requestAccess(
        requireActor(c),
        c.req.param("assetId"),
        c.req.valid("json").reason ?? null,
        requireIdempotencyKey(c),
      );
      return c.json({ success: true, data }, 201);
    },
  );

  r.post(
    "/data-market/private/assets/:assetId/owner-entitlement-requests",
    kqValidator("json", OwnerEntitlementRequestSchema, "Invalid owner entitlement request body"),
    async (c) => {
      const data = await deps.service.requestOwnerEntitlement(
        requireActor(c),
        c.req.param("assetId"),
        c.req.valid("json").reason,
        requireIdempotencyKey(c),
      );
      return c.json({ success: true, data }, 201);
    },
  );

  return r;
}

function requireActor(c: Context): DataMarketActor {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return {
    userId: principal.userId,
    role: principal.role as RoleName,
    orgId: principal.orgId,
    orgIds: principal.orgIds,
  };
}

function requireIdempotencyKey(c: Context): string {
  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key || key.length > 255) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Idempotency-Key header is required", 400);
  }
  return key;
}

function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.output<T> {
  const result = schema.safeParse({
    query: c.req.query("query"),
    tag: c.req.query("tag"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!result.success) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid data catalog query",
      400,
      result.error.issues,
    );
  }
  return result.data;
}

function parseAssetIds(c: Context) {
  const result = z
    .object({
      assetIds: z
        .string()
        .min(1)
        .transform((value) => value.split(","))
        .pipe(z.array(z.string().uuid()).min(1).max(100)),
    })
    .strict()
    .safeParse({ assetIds: c.req.query("assetIds") });
  if (!result.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid data access request query", 400);
  }
  return result.data.assetIds;
}
