import {
  CenterInputSchema,
  ClusterInputSchema,
  LinkInputSchema,
  MapViewSchema,
} from "@kuintessence/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthzService } from "../authz/service";
import {
  organizationResourceScope,
  type ResourceScopeEnv,
} from "../middleware/organization-resource-scope";
import { kqValidator } from "../middleware/validator";
import type { InterconnectService } from "../services/interconnect";

export function createInterconnectRoutes(service: InterconnectService, authz?: AuthzService) {
  const r = new Hono<ResourceScopeEnv>();
  r.use("/:view/*", organizationResourceScope(authz));
  r.get("/:view/snapshot", async (c) => c.json(await service.snapshot(c.get("resourceScope"))));
  r.put("/:view/default-view", kqValidator("json", MapViewSchema), async (c) => {
    await service.saveView(c.get("resourceScope"), c.req.valid("json"));
    return c.json({ saved: true });
  });
  const idValidator = kqValidator("param", z.object({ id: z.string().uuid() }));
  r.post("/:view/centers", kqValidator("json", CenterInputSchema), async (c) =>
    c.json(await service.saveCenter(c.get("resourceScope"), null, c.req.valid("json")), 201),
  );
  r.put("/:view/centers/:id", idValidator, kqValidator("json", CenterInputSchema), async (c) =>
    c.json(
      await service.saveCenter(
        c.get("resourceScope"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  );
  r.post("/:view/clusters", kqValidator("json", ClusterInputSchema), async (c) =>
    c.json(await service.saveCluster(c.get("resourceScope"), null, c.req.valid("json")), 201),
  );
  r.put("/:view/clusters/:id", idValidator, kqValidator("json", ClusterInputSchema), async (c) =>
    c.json(
      await service.saveCluster(
        c.get("resourceScope"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  );
  r.post("/:view/links", kqValidator("json", LinkInputSchema), async (c) =>
    c.json(await service.saveLink(c.get("resourceScope"), null, c.req.valid("json")), 201),
  );
  r.put("/:view/links/:id", idValidator, kqValidator("json", LinkInputSchema), async (c) =>
    c.json(
      await service.saveLink(c.get("resourceScope"), c.req.valid("param").id, c.req.valid("json")),
    ),
  );
  for (const [path, kind] of [
    ["centers", "center"],
    ["clusters", "cluster"],
    ["links", "link"],
  ] as const) {
    r.delete(`/:view/${path}/:id`, idValidator, async (c) =>
      c.json(await service.remove(c.get("resourceScope"), kind, c.req.valid("param").id)),
    );
  }
  return r;
}
