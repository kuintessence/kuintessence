import { AppError, ComputeProviderInputSchema, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthzService } from "../authz/service";
import {
  organizationResourceScope,
  type ResourceScopeEnv,
} from "../middleware/organization-resource-scope";
import { kqValidator } from "../middleware/validator";
import type { ComputeProviderService } from "../services/compute-providers";

export function createComputeProviderRoutes(service: ComputeProviderService, authz?: AuthzService) {
  const r = new Hono<ResourceScopeEnv>();
  r.use("/:view/*", organizationResourceScope(authz));
  const query = z.object({
    search: z.string().trim().max(255).default(""),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  });
  const id = kqValidator("param", z.object({ id: z.string().uuid() }));
  function platformOnly(view: string) {
    if (view !== "operator")
      throw new AppError(ErrorCode.FORBIDDEN, "仅平台管理员可以新增或删除提供者", 403);
  }
  r.get("/:view/list", kqValidator("query", query), async (c) => {
    const { search, page } = c.req.valid("query");
    return c.json(await service.list(c.get("resourceScope"), search, page));
  });
  r.post("/:view/organizations", kqValidator("json", ComputeProviderInputSchema), async (c) => {
    platformOnly(c.req.param("view"));
    return c.json(await service.save(c.get("resourceScope"), null, c.req.valid("json")), 201);
  });
  r.put(
    "/:view/organizations/:id",
    id,
    kqValidator("json", ComputeProviderInputSchema),
    async (c) =>
      c.json(
        await service.save(c.get("resourceScope"), c.req.valid("param").id, c.req.valid("json")),
      ),
  );
  r.delete("/:view/organizations/:id", id, async (c) => {
    platformOnly(c.req.param("view"));
    return c.json(await service.remove(c.get("resourceScope"), c.req.valid("param").id));
  });
  return r;
}
