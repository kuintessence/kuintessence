import { AppError, FORGE_DELIVERY_GAPS } from "@kuintessence/shared";
import { Hono } from "hono";
import {
  createPrincipalMiddleware,
  type PrincipalMiddlewareOptions,
  type RegistryEnv,
} from "../middleware/principal";
import { NamespacePermissionError } from "../services/namespace";
import { DeliveryError, type OfflineDeliveryService } from "../services/offline-delivery";
import { readMaterialJson } from "../services/spack-material-storage";

export function createOfflineDeliveryRoutes(
  service: OfflineDeliveryService | undefined,
  opts: PrincipalMiddlewareOptions,
  seedSubject?: string,
) {
  const app = new Hono<RegistryEnv>();
  const principal = createPrincipalMiddleware({
    ...opts,
    requireCanonicalPrincipal: true,
    requirePublisher: true,
  });
  app.onError((error, c) => {
    if (error instanceof DeliveryError)
      return c.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        error.status as 403 | 409 | 422 | 503,
      );
    if (error instanceof AppError)
      return c.json(error.toJSON(), error.statusCode as 400 | 403 | 409 | 422 | 503);
    if (error instanceof NamespacePermissionError)
      return c.json(
        { error: { code: "FORBIDDEN", message: "Delivery namespace access denied" } },
        403,
      );
    if (error instanceof Error && error.message === "DELIVERY_BUSY")
      return c.json(
        { error: { code: "DELIVERY_BUSY", message: "An import is running; retry later" } },
        409,
      );
    throw error;
  });
  app.get("/offline-deliveries/formats", principal, (c) =>
    c.json({ version: 1, forge: FORGE_DELIVERY_GAPS }),
  );
  app.get("/offline-deliveries/seed-status", principal, async (c) => {
    if (!["platform_admin", "super_admin"].includes(c.get("principal").role))
      throw new DeliveryError("DELIVERY_PLATFORM_ADMIN_REQUIRED", 403);
    c.header("Cache-Control", "private, no-store");
    return c.json(
      service && seedSubject
        ? await service.options.receipts.history(`delivery-seed:${seedSubject}`)
        : [],
    );
  });
  for (const action of ["preflight", "import", "history"] as const) {
    app.post(`/offline-deliveries/${action}`, principal, async (c) => {
      if (!service) throw new DeliveryError("DELIVERY_UNAVAILABLE", 503);
      if (
        Object.keys(c.req.queries()).length ||
        c.req.header("Content-Type")?.split(";")[0] !== "application/json" ||
        !c.req.raw.body
      )
        throw new DeliveryError("DELIVERY_CONTRACT_INVALID");
      const input = await readMaterialJson(c.req.raw.body);
      const subject = c.get("principal").sub;
      c.header("Cache-Control", "private, no-store");
      return c.json(
        action === "preflight"
          ? await service.preflight(input, subject)
          : action === "history"
            ? await service.history(input, subject)
            : await service.run(input, subject),
      );
    });
  }
  return app;
}
