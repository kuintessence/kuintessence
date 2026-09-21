import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import type { SpackMaterialDelivery } from "../software-governance/spack-material-delivery";

export function createAgentSpackMaterialRoutes(delivery: Pick<SpackMaterialDelivery, "download">) {
  const app = new Hono();
  const base = "/agent/spack/operations/:operationId";
  app.use("/agent/spack/*", async (c, next) => {
    if (new URL(c.req.url).search || c.req.header("Range")) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Spack downloads do not accept query parameters or Range yet",
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
    delivery.download(c.req.param("operationId"), c.req.header("Authorization")?.slice(7) ?? ""),
  );
  app.get(`${base}/blobs/:digest`, async (c) =>
    delivery.download(
      c.req.param("operationId"),
      c.req.header("Authorization")?.slice(7) ?? "",
      c.req.param("digest"),
    ),
  );
  return app;
}
