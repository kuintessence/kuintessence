import { zValidator } from "@hono/zod-validator";
import {
  AppError,
  ErrorCode,
  WorkflowTemplateCreateSchema,
  WorkflowTemplateUpdateSchema,
} from "@kuintessence/shared";
import { Hono } from "hono";
import { z } from "zod";
import { createPrincipalMiddleware, type RegistryEnv } from "../middleware/principal";
import { parseUuidParam } from "../middleware/uuid-param";
import type { RegistryRole } from "../services/namespace";
import type { WorkflowTemplateService } from "../services/workflow-template-service";

const PLATFORM_WORKFLOW_TEMPLATE_PUBLISHER_ROLES: RegistryRole[] = [
  "super_admin",
  "platform_admin",
];

interface TemplateRouteOptions {
  authMode?: "dev" | "jwt";
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  publisherRoles?: RegistryRole[];
  resolveCanonicalPrincipal?: (
    subject: string,
  ) => Promise<{ sub: string; role: RegistryRole; orgIds: string[]; suspended: boolean } | null>;
}

export function createWorkflowTemplateRoutes(
  service: WorkflowTemplateService,
  opts: TemplateRouteOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  // Registry writes require a principal; reads remain public.
  const requirePrincipal = createPrincipalMiddleware({
    ...opts,
    requireCanonicalPrincipal: opts.authMode === "jwt",
    requirePublisher: true,
    publisherRoles: PLATFORM_WORKFLOW_TEMPLATE_PUBLISHER_ROLES,
  });

  r.post(
    "/workflow-templates",
    requirePrincipal,
    zValidator("json", WorkflowTemplateCreateSchema),
    async (c) => {
      const data = c.req.valid("json");
      const result = await service.createWithStatus(data, canonicalUserId(c.get("principal").sub));
      c.header("Location", templateLocation("collection", result.template.id));
      return c.json(result.template, result.created ? 201 : 200);
    },
  );

  r.get("/workflow-templates", async (c) => {
    const page = parsePositiveInteger(c.req.query("page"), "page");
    const pageSize = parsePositiveInteger(c.req.query("pageSize"), "pageSize");
    const result = await service.listPage({
      page,
      pageSize,
      q: c.req.query("q"),
      tag: c.req.query("tag"),
    });
    return c.json({
      workflowTemplates: result.templates,
      templates: result.templates,
      tags: result.tags,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
      hasNext: result.hasNext,
    });
  });

  r.get("/workflow-templates/:id", async (c) => {
    const id = parseUuidParam(c.req.param("id"), "workflow template id");
    const t = await service.getById(id);
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, "Workflow template not found", 404);
    return c.json(t);
  });

  r.put(
    "/workflow-templates/:id",
    requirePrincipal,
    zValidator("json", WorkflowTemplateUpdateSchema),
    async (c) => {
      const id = parseUuidParam(c.req.param("id"), "workflow template id");
      const result = await service.updateByIdWithStatus(
        id,
        c.req.valid("json"),
        canonicalUserId(c.get("principal").sub),
      );
      c.header("Location", templateLocation("item", result.template.id));
      return c.json(result.template, result.created ? 201 : 200);
    },
  );

  r.delete("/workflow-templates/:id", requirePrincipal, async (c) => {
    const id = parseUuidParam(c.req.param("id"), "workflow template id");
    const t = await service.deleteById(id);
    return c.json(t);
  });

  return r;
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
  const result = z.string().uuid().safeParse(subject);
  return result.success ? result.data : undefined;
}

function templateLocation(source: "collection" | "item", id: string): string {
  return source === "collection" ? `workflow-templates/${id}` : `./${id}`;
}
