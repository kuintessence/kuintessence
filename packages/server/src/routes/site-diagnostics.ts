import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SiteDiagnosticsService } from "../services/site-diagnostics";

/** Machine routes authenticate proof/capability themselves; never consume a registration token. */
export function siteDiagnosticsRoutes(service: SiteDiagnosticsService) {
  const routes = new Hono();
  routes.use("/agent/site-diagnostics*", bodyLimit({ maxSize: 32 * 1024 }));
  routes.post("/agent/site-diagnostics", async (c) => {
    try {
      return c.json(await service.create(await c.req.json()));
    } catch {
      return c.json(
        {
          error: {
            code: "SITE_DIAGNOSTIC_REJECTED",
            message: "Diagnostic identity or fixture initialization rejected",
          },
        },
        403,
      );
    }
  });
  routes.get("/agent/site-diagnostics/material", async (c) => {
    try {
      const body = await service.material(c.req.query("ticket"));
      return new Response(body, {
        headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
      });
    } catch {
      return c.json({ error: { code: "SITE_DIAGNOSTIC_REJECTED" } }, 403);
    }
  });
  routes.post("/agent/site-diagnostics/complete", async (c) => {
    try {
      await service.complete(c.req.query("ticket"), await c.req.json());
      return c.json({ ok: true });
    } catch {
      return c.json({ error: { code: "SITE_DIAGNOSTIC_REJECTED" } }, 403);
    }
  });
  routes.delete("/agent/site-diagnostics/session", async (c) => {
    try {
      await service.cleanup(c.req.query("ticket"));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: { code: "SITE_DIAGNOSTIC_REJECTED" } }, 403);
    }
  });
  return routes;
}
