import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SpackMaterialDelivery } from "../software-governance/spack-material-delivery";

export function createAgentSpackMaterialRoutes(
  delivery: Pick<SpackMaterialDelivery, "download"> &
    Partial<Pick<SpackMaterialDelivery, "refresh">>,
) {
  const app = new Hono();
  const base = "/agent/spack/operations/:operationId";
  app.post(`${base}/ticket`, bodyLimit({ maxSize: 24 * 1024 }), async (c) => {
    if (!delivery.refresh) return c.notFound();
    return c.json(await delivery.refresh(c.req.param("operationId"), await c.req.json()));
  });
  app.use("/agent/spack/*", async (c, next) => {
    if (new URL(c.req.url).search) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Spack downloads do not accept query parameters",
        400,
      );
    }
    const authorization = c.req.header("Authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 16_384) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "Spack material ticket required", 401);
    }
    await next();
  });
  app.get(`${base}/manifest`, async (c) =>
    c.req.header("Range")
      ? c.json({ error: "Manifest ranges are unsupported" }, 400)
      : delivery.download(
          c.req.param("operationId"),
          c.req.header("Authorization")?.slice(7) ?? "",
        ),
  );
  app.get(`${base}/blobs/:digest`, async (c) =>
    delivery.download(
      c.req.param("operationId"),
      c.req.header("Authorization")?.slice(7) ?? "",
      c.req.param("digest"),
      { range: c.req.header("Range"), ifRange: c.req.header("If-Range") },
    ),
  );
  return app;
}
