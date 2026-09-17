import { zValidator } from "@hono/zod-validator";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import { z } from "zod";
import {
  createPrincipalMiddleware,
  ociErrorJson,
  type PrincipalMiddlewareOptions,
  type RegistryEnv,
  readOptionalPrincipal,
} from "../middleware/principal";
import { parseUuidParam } from "../middleware/uuid-param";
import type { SpackCatalogService, SpackCatalogSource } from "../services/spack-catalog-service";
import { parseSpackCompilers, parseSpackPackageFile } from "../services/spack-package-parser";

type SpackCatalogRouteOptions = PrincipalMiddlewareOptions;

const SpackCatalogPackageSchema = z.strictObject({
  name: z.string().min(1).max(255),
  source: z.enum(["official", "vendor"]),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  packageFile: z.string().max(500_000).optional(),
});

const SpackParseSourceSchema = z.strictObject({
  source: z.string().min(1).max(500_000),
});

const SnapshotPathSegmentSchema = z.string().min(1).max(255).regex(/^\S+$/);

const LegacySupersessionSchema = z.strictObject({
  legacyAssetId: z.string().uuid(),
  legacyRevisionId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1_000),
});

function parseSource(value: string | undefined): SpackCatalogSource | "all" | undefined {
  if (!value || value === "all") return value === "all" ? "all" : undefined;
  if (value === "upstream" || value === "official" || value === "vendor") return value;
  return undefined;
}

export function createSpackCatalogRoutes(
  service: SpackCatalogService,
  opts: SpackCatalogRouteOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  const requirePrincipal = createPrincipalMiddleware({ ...opts, requirePublisher: true });
  const requireSnapshotPrincipal = createPrincipalMiddleware({
    ...opts,
    requireCanonicalPrincipal: true,
  });

  r.get("/spack/catalog", async (c) => {
    let principal = null;
    try {
      principal = await readOptionalPrincipal(c, opts);
    } catch (err) {
      return ociErrorJson(
        c,
        401,
        "INVALID_TOKEN",
        err instanceof Error ? err.message : "invalid token",
      );
    }
    const rawSource = c.req.query("source");
    const source = parseSource(rawSource);
    if (rawSource !== undefined && source === undefined) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "source is invalid", 400);
    }
    if (source === "vendor" && !principal) {
      return ociErrorJson(c, 401, "UNAUTHORIZED", "vendor catalog requires a principal");
    }
    const limit = parsePositiveInteger(c.req.query("limit"), "limit");
    const page = parsePositiveInteger(c.req.query("page"), "page");
    const pageSize = parsePositiveInteger(c.req.query("pageSize"), "pageSize");
    return c.json(
      await service.list({
        q: c.req.query("q"),
        limit,
        page,
        pageSize,
        principal,
        source,
      }),
    );
  });

  r.post("/spack/parse/package", zValidator("json", SpackParseSourceSchema), async (c) => {
    return c.json(parseSpackPackageFile(c.req.valid("json").source));
  });

  r.post("/spack/parse/compilers", zValidator("json", SpackParseSourceSchema), async (c) => {
    return c.json({ compilers: parseSpackCompilers(c.req.valid("json").source) });
  });

  r.post(
    "/spack/catalog/upstream/:name/versions/:version/snapshot",
    requireSnapshotPrincipal,
    async (c) => {
      const name = readSnapshotPathSegment(c.req.param("name"), "name");
      const version = readSnapshotPathSegment(c.req.param("version"), "version");
      const result = await service.snapshotUpstreamVersion(name, version, c.get("principal"));
      return c.json(result, result.created ? 201 : 200);
    },
  );

  r.post(
    "/spack/catalog/upstream/:name/versions/:version/supersede-legacy",
    requireSnapshotPrincipal,
    zValidator("json", LegacySupersessionSchema),
    async (c) => {
      const name = readSnapshotPathSegment(c.req.param("name"), "name");
      const version = readSnapshotPathSegment(c.req.param("version"), "version");
      const result = await service.supersedeLegacyUpstreamVersion({
        name,
        version,
        ...c.req.valid("json"),
        principal: c.get("principal"),
      });
      return c.json(result, result.created ? 201 : 200);
    },
  );

  r.post(
    "/spack/catalog/packages",
    requirePrincipal,
    zValidator("json", SpackCatalogPackageSchema),
    async (c) => {
      const created = await service.create(
        c.req.valid("json"),
        c.get("principal"),
        readOrgId(c.req.query("orgId")),
      );
      return c.json(created, 201);
    },
  );

  r.put(
    "/spack/catalog/packages/:id",
    requirePrincipal,
    zValidator("json", SpackCatalogPackageSchema),
    async (c) => {
      const id = parseUuidParam(c.req.param("id"), "spack catalog package id");
      return c.json(
        await service.updateById(
          id,
          c.req.valid("json"),
          c.get("principal"),
          readOrgId(c.req.query("orgId")),
        ),
      );
    },
  );

  r.delete("/spack/catalog/packages/:id", requirePrincipal, async (c) => {
    const id = parseUuidParam(c.req.param("id"), "spack catalog package id");
    return c.json(await service.deleteById(id, c.get("principal")));
  });

  return r;
}

function readOrgId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_ERROR, "orgId must be a UUID", 422);
  return parsed.data;
}

function parsePositiveInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `${field} must be a positive integer`, 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `${field} must be a safe integer`, 400);
  }
  return parsed;
}

function readSnapshotPathSegment(value: string, field: string): string {
  const parsed = SnapshotPathSegmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `${field} is invalid`, 422);
  }
  return parsed.data;
}
