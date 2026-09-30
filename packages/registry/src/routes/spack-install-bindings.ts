import { SpackMaterialLifecycleError } from "@kuintessence/db";
import {
  ErrorCode,
  SpackInstallBindingChangeSchema,
  SpackInstallBindingQuerySchema,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import {
  createPrincipalMiddleware,
  type PrincipalMiddlewareOptions,
  type RegistryEnv,
} from "../middleware/principal";
import { RecipeStoreError } from "../services/recipe-git";
import type { SpackInstallBindingAccess } from "../services/spack-install-bindings";
import {
  cancelMaterialInput,
  readMaterialJson,
  SpackMaterialError,
} from "../services/spack-material-storage";
import { parseMaterial } from "../services/spack-material-store";

export function createSpackInstallBindingRoutes(
  access: SpackInstallBindingAccess | undefined,
  opts: PrincipalMiddlewareOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  const principal = createPrincipalMiddleware({
    ...opts,
    requireCanonicalPrincipal: true,
    requirePublisher: false,
  });
  r.use("/spack/install-bindings*", async (c, next) => {
    try {
      const response = await principal(c, async () => {});
      if (response) {
        return c.json({ error: { code: ErrorCode.FORBIDDEN, message: "Invalid principal" } }, 403);
      }
      if (!access) throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
      c.header("Cache-Control", "private, no-store");
      await next();
    } finally {
      if (c.req.raw.body && !c.req.raw.body.locked) cancelMaterialInput(c.req.raw.body);
    }
  });
  r.onError((error, c) => {
    if (error instanceof SpackMaterialLifecycleError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof SpackMaterialError || error instanceof RecipeStoreError) {
      if (error.status >= 500) {
        return c.json(
          {
            error: {
              code: "INSTALL_BINDING_UNAVAILABLE",
              message: "Install binding is unavailable",
            },
          },
          503,
        );
      }
      const status = error.status === 403 || error.status === 404 ? 403 : 422;
      return c.json(
        { error: { code: ErrorCode.VALIDATION_ERROR, message: "Invalid or inaccessible material" } },
        status,
      );
    }
    return c.json(
      { error: { code: "INSTALL_BINDING_UNAVAILABLE", message: "Install binding is unavailable" } },
      503,
    );
  });
  r.post("/spack/install-bindings/inspect", async (c) => {
    if (!access) throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
    const query = parseMaterial(
      SpackInstallBindingQuerySchema,
      await body(c),
      "install binding query",
    );
    return c.json(await access.inspect(query, c.get("principal").sub));
  });
  r.post("/spack/install-bindings", async (c) => {
    if (!access) throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
    const input = parseMaterial(
      SpackInstallBindingChangeSchema,
      await body(c),
      "install binding change",
    );
    return c.json(await access.change(input, c.get("principal").sub, c.req.raw.signal));
  });
  return r;
}

async function body(c: Context) {
  if (
    Object.keys(c.req.queries()).length > 0 ||
    c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new SpackMaterialLifecycleError("INSTALL_BINDING_INVALID");
  }
  const stream = c.req.raw.body;
  if (!stream) throw new SpackMaterialLifecycleError("INSTALL_BINDING_INVALID");
  return readMaterialJson(stream);
}
