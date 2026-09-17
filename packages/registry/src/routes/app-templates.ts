import { zValidator } from "@hono/zod-validator";
import {
  AppError,
  AppTemplateCreateSchema,
  AppTemplateUpdateSchema,
  ErrorCode,
} from "@kuintessence/shared";
import { Hono } from "hono";
import { z } from "zod";
import { createPrincipalMiddleware, type RegistryEnv } from "../middleware/principal";
import { parseUuidParam } from "../middleware/uuid-param";
import type { AppTemplateService } from "../services/app-template-service";
import type { RbacPrincipal, RegistryRole } from "../services/namespace";

interface TemplateRouteOptions {
  authMode?: "dev" | "jwt";
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  publisherRoles?: RegistryRole[];
}

export function createAppTemplateRoutes(
  service: AppTemplateService,
  opts: TemplateRouteOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  // Registry WRITES require a principal (fail-closed, like /v2 + /buildcache).
  // Registry writes require a principal; reads remain public.
  const requirePrincipal = createPrincipalMiddleware({ ...opts, requirePublisher: true });

  r.post(
    "/app-templates",
    requirePrincipal,
    zValidator("json", AppTemplateCreateSchema),
    async (c) => {
      const principal = requireLegacyTemplateAdmin(c.get("principal"));
      const data = c.req.valid("json");
      const t = await service.create(data, canonicalUserId(principal.sub));
      return c.json(t, 201);
    },
  );

  r.get("/app-templates", async (c) => {
    const tag = c.req.query("tag");
    const list = tag ? await service.listByTag(tag) : await service.list();
    return c.json({ appTemplates: list });
  });

  r.get("/app-templates/:id", async (c) => {
    const id = parseUuidParam(c.req.param("id"), "app template id");
    const t = await service.getById(id);
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, "App template not found", 404);
    return c.json(t);
  });

  r.put(
    "/app-templates/:id",
    requirePrincipal,
    zValidator("json", AppTemplateUpdateSchema),
    async (c) => {
      requireLegacyTemplateAdmin(c.get("principal"));
      const id = parseUuidParam(c.req.param("id"), "app template id");
      const t = await service.updateById(id, c.req.valid("json"));
      return c.json(t);
    },
  );

  r.delete("/app-templates/:id", requirePrincipal, async (c) => {
    requireLegacyTemplateAdmin(c.get("principal"));
    const id = parseUuidParam(c.req.param("id"), "app template id");
    const t = await service.deleteById(id);
    return c.json(t);
  });

  return r;
}

function requireLegacyTemplateAdmin(principal: RbacPrincipal): RbacPrincipal {
  if (principal.role === "platform_admin" || principal.role === "super_admin") return principal;
  throw new AppError(ErrorCode.FORBIDDEN, "Legacy app templates require platform_admin", 403);
}

function canonicalUserId(subject: string): string | undefined {
  const parsed = z.string().uuid().safeParse(subject);
  return parsed.success ? parsed.data : undefined;
}
