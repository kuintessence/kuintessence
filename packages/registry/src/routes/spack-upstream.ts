import { SPACK_UPSTREAM_IMPORT_MAX_BYTES, SpackUpstreamImportSchema } from "@kuintessence/shared";
import { Hono, type MiddlewareHandler } from "hono";
import {
  createPrincipalMiddleware,
  type PrincipalMiddlewareOptions,
  type RegistryEnv,
} from "../middleware/principal";
import { assertPublisherRole, checkNamespaceAccess, parseNamespace } from "../services/namespace";
import {
  cancelMaterialInput,
  readMaterialJson,
  SpackMaterialError,
} from "../services/spack-material-storage";
import { parseMaterial } from "../services/spack-material-store";
import {
  type SpackUpstreamImportService,
  sanitizeSpackUpstreamError,
  unavailableSpackUpstreamImport,
} from "../services/spack-upstream-import";

export function createSpackUpstreamRoutes(
  service: SpackUpstreamImportService | undefined,
  opts: PrincipalMiddlewareOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  const principal = createPrincipalMiddleware({
    ...opts,
    requireCanonicalPrincipal: true,
    requirePublisher: false,
  });
  const authenticate: MiddlewareHandler<RegistryEnv> = async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    try {
      const response = await principal(c, async () => {});
      if (response) {
        // Canonical resolution failures may contain arbitrary upstream error text.
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Invalid principal" } },
          response.status as 401 | 403,
        );
      }
      if (!service) throw unavailableSpackUpstreamImport();
      await next();
    } finally {
      const body = c.req.raw.body;
      if (body && !body.locked) cancelMaterialInput(body);
    }
  };
  r.onError((error, c) => {
    const safe = sanitizeSpackUpstreamError(error);
    return c.json({ error: { code: safe.code, message: safe.message } }, safe.status);
  });
  r.post("/spack/upstream-imports", authenticate, async (c) => {
    if (!service) throw unavailableSpackUpstreamImport();
    const actor = c.get("principal");
    assertPublisherRole(actor, opts.publisherRoles);
    if (Object.keys(c.req.queries()).length > 0) {
      throw new SpackMaterialError(422, "Query parameters are not accepted");
    }
    if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new SpackMaterialError(415, "Expected application/json");
    }
    const length = c.req.header("Content-Length");
    if (length !== undefined) {
      if (!/^\d+$/.test(length)) throw new SpackMaterialError(400, "Invalid Content-Length");
      if (BigInt(length) > BigInt(SPACK_UPSTREAM_IMPORT_MAX_BYTES)) {
        throw new SpackMaterialError(413, "Upstream import body exceeds 2 MiB");
      }
    }
    const body = c.req.raw.body;
    if (!body) throw new SpackMaterialError(400, "Upstream import body is empty");
    const request = parseMaterial(
      SpackUpstreamImportSchema,
      await readMaterialJson(body),
      "import",
    );
    const repository = request.kind === "recipe" ? request.repository : request.release.repository;
    const namespace = parseNamespace(repository);
    checkNamespaceAccess(actor, namespace, "read", opts.publisherRoles);
    checkNamespaceAccess(actor, namespace, "write", opts.publisherRoles);
    return c.json(await service.import(request, actor, c.req.raw.signal), 201);
  });
  return r;
}
