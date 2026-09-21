import { SpackMaterialLifecycleError } from "@kuintessence/db";
import {
  ErrorCode,
  RecipeRepositoryNameSchema,
  SpackMaterialCatalogQuerySchema,
  SpackMaterialDigestSchema,
  SpackMaterialLifecycleChangeSchema,
  SpackMaterialPublishSchema,
} from "@kuintessence/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  createPrincipalMiddleware,
  type PrincipalMiddlewareOptions,
  type RegistryEnv,
} from "../middleware/principal";
import {
  assertPublisherRole,
  checkNamespaceAccess,
  NamespacePermissionError,
  parseNamespace,
} from "../services/namespace";
import { RecipeStoreError } from "../services/recipe-git";
import { SpackMaterialCatalogLimitError } from "../services/spack-material-catalog";
import {
  cancelMaterialInput,
  MATERIAL_METADATA_BYTES,
  readMaterialJson,
  SpackMaterialError,
} from "../services/spack-material-storage";
import { parseMaterial, type SpackMaterialStore } from "../services/spack-material-store";

const BASE = "/spack/material-repositories";
const ERROR_CODES: Record<SpackMaterialError["status"], string> = {
  400: ErrorCode.VALIDATION_ERROR,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  408: "UPLOAD_TIMEOUT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: ErrorCode.VALIDATION_ERROR,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL_ERROR,
  503: "MATERIAL_STORE_UNAVAILABLE",
};

export function createSpackMaterialRoutes(
  store: SpackMaterialStore | undefined,
  opts: PrincipalMiddlewareOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  const principal = createPrincipalMiddleware({
    ...opts,
    requireCanonicalPrincipal: true,
    requirePublisher: false,
  });
  const getStore = () => {
    if (!store) throw new SpackMaterialError(503, "Material repository storage is not configured");
    return store;
  };
  const authenticate: MiddlewareHandler<RegistryEnv> = async (c, next) => {
    try {
      const response = await principal(c, async () => {});
      if (response) {
        const body = (await response.json()) as {
          errors: Array<{ code: string; message: string }>;
        };
        return c.json(
          {
            error: body.errors[0] ?? { code: ErrorCode.UNAUTHORIZED, message: "Invalid principal" },
          },
          response.status as 401 | 403,
        );
      }
      getStore();
      await next();
    } finally {
      const body = c.req.raw.body;
      if (body && !body.locked) cancelMaterialInput(body);
    }
  };
  const writable = (c: Context<RegistryEnv>, repository: string) => {
    const namespace = parseNamespace(repository);
    const actor = c.get("principal");
    checkNamespaceAccess(actor, namespace, "read", opts.publisherRoles);
    checkNamespaceAccess(actor, namespace, "write", opts.publisherRoles);
  };

  r.onError((error, c) => {
    if (error instanceof SpackMaterialLifecycleError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof SpackMaterialError) {
      return c.json(
        {
          error: {
            code:
              error instanceof SpackMaterialCatalogLimitError
                ? "MATERIAL_CATALOG_LIMIT"
                : ERROR_CODES[error.status],
            message: error.message,
            ...(error.lockPreflight ? { lockPreflight: error.lockPreflight } : {}),
          },
        },
        error.status,
      );
    }
    if (error instanceof NamespacePermissionError) {
      return c.json({ error: { code: ErrorCode.FORBIDDEN, message: error.message } }, 403);
    }
    if (error instanceof RecipeStoreError) {
      return c.json(
        {
          error: {
            code: error.status === 409 ? "RECIPE_CONFLICT" : ERROR_CODES[error.status],
            message: error.message,
          },
        },
        error.status,
      );
    }
    throw error;
  });

  r.get(BASE, authenticate, async (c) => {
    c.header("Cache-Control", "private, no-store");
    const query = c.req.queries();
    if (
      Object.keys(query).some((key) => key !== "repository") ||
      (query.repository !== undefined && query.repository.length !== 1)
    ) {
      throw new SpackMaterialError(422, "Catalog accepts only one optional repository filter");
    }
    const input = parseMaterial(
      SpackMaterialCatalogQuerySchema,
      query.repository === undefined ? {} : { repository: query.repository[0] },
      "catalog query",
    );
    return c.json(await getStore().list(input, c.get("principal"), c.req.raw.signal));
  });

  r.post(`${BASE}/blobs`, authenticate, async (c) => {
    assertPublisherRole(c.get("principal"), opts.publisherRoles);
    const query = c.req.queries();
    if (
      Object.keys(query).some((key) => key !== "repository" && key !== "digest") ||
      query.repository?.length !== 1 ||
      query.digest?.length !== 1
    ) {
      throw new SpackMaterialError(
        422,
        "Upload requires exactly one repository and digest; URLs are not accepted",
      );
    }
    const repository = parseMaterial(RecipeRepositoryNameSchema, query.repository[0], "repository");
    const digest = parseMaterial(SpackMaterialDigestSchema, query.digest[0], "digest");
    writable(c, repository);
    requireContentType(c, "application/octet-stream");
    checkLength(c, getStore().limits.maxBlobBytes);
    const body = c.req.raw.body;
    if (!body) throw new SpackMaterialError(400, "Material blob is empty");
    return c.json(await getStore().upload(repository, digest, body), 201);
  });

  const readRelease = async (c: Context<RegistryEnv>) => {
    assertPublisherRole(c.get("principal"), opts.publisherRoles);
    rejectQueries(c);
    requireContentType(c, "application/json");
    checkLength(c, MATERIAL_METADATA_BYTES);
    const body = c.req.raw.body;
    if (!body) throw new SpackMaterialError(400, "Material release body is empty");
    const input = parseMaterial(
      SpackMaterialPublishSchema,
      await readMaterialJson(body),
      "release",
    );
    writable(c, input.repository);
    return input;
  };

  r.post(`${BASE}/lock-preflight`, authenticate, async (c) => {
    const input = await readRelease(c);
    c.header("Cache-Control", "private, no-store");
    return c.json(await getStore().preflightLock(input, c.get("principal")));
  });

  r.post(`${BASE}/releases`, authenticate, async (c) => {
    const input = await readRelease(c);
    return c.json(await getStore().publish(input, c.get("principal"), c.req.raw.signal), 201);
  });

  r.get(`${BASE}/:id/releases/:digest`, authenticate, async (c) => {
    rejectQueries(c);
    const stored = await getStore().getManifest(c.req.param("id"), c.req.param("digest"));
    await getStore().authorizeManifest(stored.manifest, c.get("principal"));
    return new Response(stored.bytes, {
      headers: {
        ...downloadHeaders(stored.bytes.byteLength),
        "Content-Type": "application/json",
        ETag: `"${c.req.param("digest")}"`,
      },
    });
  });

  r.get(`${BASE}/:id/releases/:digest/lifecycle`, authenticate, async (c) => {
    c.header("Cache-Control", "private, no-store");
    rejectQueries(c);
    return c.json(
      await getStore().manageLifecycle(
        c.req.param("id"),
        c.req.param("digest"),
        c.get("principal").sub,
        undefined,
        opts.publisherRoles,
        c.req.raw.signal,
      ),
    );
  });

  r.post(`${BASE}/:id/releases/:digest/lifecycle`, authenticate, async (c) => {
    c.header("Cache-Control", "private, no-store");
    rejectQueries(c);
    requireContentType(c, "application/json");
    checkLength(c, MATERIAL_METADATA_BYTES);
    const body = c.req.raw.body;
    if (!body) throw new SpackMaterialError(400, "Material lifecycle body is empty");
    const change = parseMaterial(
      SpackMaterialLifecycleChangeSchema,
      await readMaterialJson(body),
      "material lifecycle change",
    );
    return c.json(
      await getStore().manageLifecycle(
        c.req.param("id"),
        c.req.param("digest"),
        c.get("principal").sub,
        change,
        opts.publisherRoles,
        c.req.raw.signal,
      ),
    );
  });

  r.get(`${BASE}/:id/releases/:manifestDigest/blobs/:digest`, authenticate, async (c) => {
    rejectQueries(c);
    const blob = await getStore().getBlob(
      c.req.param("id"),
      c.req.param("manifestDigest"),
      c.req.param("digest"),
      c.get("principal"),
    );
    return c.body(blob.stream, 200, {
      ...downloadHeaders(blob.size),
      "Content-Type": "application/octet-stream",
      ETag: `"${c.req.param("digest")}"`,
    });
  });
  return r;
}

function rejectQueries(c: Context<RegistryEnv>): void {
  if (Object.keys(c.req.queries()).length > 0) {
    throw new SpackMaterialError(422, "Query parameters and URLs are not accepted");
  }
}

function requireContentType(c: Context<RegistryEnv>, expected: string): void {
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== expected) {
    throw new SpackMaterialError(415, `Expected ${expected}`);
  }
}

function checkLength(c: Context<RegistryEnv>, limit: number): void {
  const length = c.req.header("Content-Length");
  if (length === undefined) return;
  if (!/^\d+$/.test(length)) throw new SpackMaterialError(400, "Invalid Content-Length");
  if (BigInt(length) > BigInt(limit)) {
    throw new SpackMaterialError(413, "Material exceeds the byte limit");
  }
}

function downloadHeaders(size: number): Record<string, string> {
  return {
    "Content-Length": String(size),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
