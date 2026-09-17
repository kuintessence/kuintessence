import { zValidator } from "@hono/zod-validator";
import { AppError, ErrorCode, usecase } from "@kuintessence/shared";
import { Hono } from "hono";
import { z } from "zod";
import {
  createPrincipalMiddleware,
  type PrincipalMiddlewareOptions,
  type RegistryEnv,
  readOptionalPrincipal,
} from "../middleware/principal";
import { parseUuidParam } from "../middleware/uuid-param";
import type { RbacPrincipal, RegistryRole } from "../services/namespace";
import type {
  UsecasePackageScope,
  UsecasePackageService,
} from "../services/usecase-package-service";

interface UsecasePackageRouteOptions extends PrincipalMiddlewareOptions {
  publisherRoles?: RegistryRole[];
}

export function createUsecasePackageRoutes(
  service: UsecasePackageService,
  opts: UsecasePackageRouteOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  // Registry writes require a principal; reads remain public.
  // Usecase packages feed materialize() → cluster execution, so this is the
  // most supply-chain-sensitive of the registry write surfaces.
  const requirePrincipal = createPrincipalMiddleware({ ...opts, requirePublisher: true });

  r.post(
    "/usecase-packages",
    requirePrincipal,
    zValidator("json", usecase.UsecasePackageCreateSchema),
    async (c) => {
      const data = c.req.valid("json");
      const principal = c.get("principal");
      const pkg = await service.create(
        data,
        writeScope(principal, c.req.query("orgId")),
        canonicalUserId(principal.sub),
      );
      return c.json(pkg, 201);
    },
  );

  r.get("/usecase-packages", async (c) => {
    const principal = await optionalPrincipal(c, opts);
    const orgId = readOrgId(c.req.query("orgId"), principal);
    const result = await service.listPage({
      principal,
      orgId,
      page: parsePositiveInteger(c.req.query("page"), "page"),
      pageSize: parsePositiveInteger(c.req.query("pageSize"), "pageSize"),
      q: c.req.query("q"),
      tag: c.req.query("tag"),
    });
    return c.json({
      usecasePackages: result.packages,
      packages: result.packages,
      tags: result.tags,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
      hasNext: result.hasNext,
    });
  });

  r.get("/usecase-packages/:id", async (c) => {
    const id = parseUuidParam(c.req.param("id"), "usecase package id");
    const principal = await optionalPrincipal(c, opts);
    const pkg = await service.getById(id, principal, readOrgId(c.req.query("orgId"), principal));
    if (!pkg) {
      throw new AppError(ErrorCode.NOT_FOUND, "Usecase package not found", 404);
    }
    return c.json(pkg);
  });

  r.put(
    "/usecase-packages/:id",
    requirePrincipal,
    zValidator("json", usecase.UsecasePackageUpdateSchema),
    async (c) => {
      const id = parseUuidParam(c.req.param("id"), "usecase package id");
      return c.json(await service.updateById(id, c.req.valid("json"), c.get("principal")));
    },
  );

  r.delete("/usecase-packages/:id", requirePrincipal, async (c) => {
    const id = parseUuidParam(c.req.param("id"), "usecase package id");
    return c.json(await service.deleteById(id, c.get("principal")));
  });

  return r;
}

async function optionalPrincipal(
  c: Parameters<typeof readOptionalPrincipal>[0],
  opts: UsecasePackageRouteOptions,
) {
  try {
    return await readOptionalPrincipal(c, opts);
  } catch (err) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      err instanceof Error ? err.message : "invalid principal",
      401,
    );
  }
}

function readOrgId(orgId: string | undefined, principal: RbacPrincipal | null): string | undefined {
  if (orgId === undefined) return undefined;
  const parsed = z.string().uuid().safeParse(orgId);
  if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_ERROR, "orgId must be a UUID", 422);
  if (!principal) throw new AppError(ErrorCode.UNAUTHORIZED, "orgId requires a principal", 401);
  if (
    principal.role !== "super_admin" &&
    principal.role !== "platform_admin" &&
    !principal.orgIds.includes(parsed.data)
  ) {
    throw new AppError(ErrorCode.FORBIDDEN, "Organization namespace is outside scope", 403);
  }
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

function canonicalUserId(subject: string): string | undefined {
  const parsed = z.string().uuid().safeParse(subject);
  return parsed.success ? parsed.data : undefined;
}

function writeScope(principal: RbacPrincipal, orgId?: string): UsecasePackageScope {
  if (orgId) {
    const parsedOrgId = z.string().uuid().safeParse(orgId);
    if (!parsedOrgId.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "orgId must be a UUID", 422);
    }
    if (
      principal.role !== "super_admin" &&
      principal.role !== "platform_admin" &&
      !principal.orgIds.includes(parsedOrgId.data)
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Organization namespace is outside scope", 403);
    }
    return { namespace: "org", ownerOrgId: parsedOrgId.data, ownerSubject: principal.sub };
  }
  if (principal.role === "platform_admin" || principal.role === "super_admin") {
    return { namespace: "platform", ownerSubject: principal.sub };
  }
  if (principal.role === "org_admin") {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Organization administrators must provide an owned orgId namespace",
      422,
    );
  }
  return { namespace: "user", ownerSubject: principal.sub };
}
