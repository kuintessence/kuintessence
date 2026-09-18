import {
  AppError,
  ErrorCode,
  RecipeActivationSchema,
  RecipeCommitSchema,
  RecipeDeactivationSchema,
  RecipeRepositoryIdSchema,
  RecipeRepositoryNameSchema,
} from "@kuintessence/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { z } from "zod";
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
  type RbacPrincipal,
} from "../services/namespace";
import { RecipeStoreError } from "../services/recipe-git";
import type { RecipeGitStore } from "../services/recipe-git-store";

export type RecipeRepositoryStore = Pick<
  RecipeGitStore,
  "list" | "get" | "importBundle" | "activate" | "deactivate" | "archive" | "limits"
>;

const BASE = "/spack/recipe-repositories";
const STORE_ERROR_CODES: Record<RecipeStoreError["status"], string> = {
  400: ErrorCode.VALIDATION_ERROR,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: "RECIPE_ACTIVE_CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: ErrorCode.VALIDATION_ERROR,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL_ERROR,
  503: "RECIPE_STORE_UNAVAILABLE",
};

export function createSpackRepositoryRoutes(
  store: RecipeRepositoryStore | undefined,
  opts: PrincipalMiddlewareOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  const principal = createPrincipalMiddleware({
    ...opts,
    requireCanonicalPrincipal: true,
    requirePublisher: false,
  });
  const getStore = () => {
    if (!store) throw new RecipeStoreError(503, "Recipe repository storage is not configured");
    return store;
  };
  const authenticate: MiddlewareHandler<RegistryEnv> = async (c, next) => {
    // Adapt only the principal middleware's OCI errors, not downstream route responses.
    const response = await principal(c, async () => {});
    if (response) {
      const body = (await response.json()) as {
        errors: Array<{ code: string; message: string }>;
      };
      return c.json(
        { error: body.errors[0] ?? { code: ErrorCode.UNAUTHORIZED, message: "Invalid principal" } },
        response.status as 401 | 403,
      );
    }
    getStore();
    await next();
  };
  const requirePublisher = (c: Context<RegistryEnv>) => {
    assertPublisherRole(c.get("principal"), opts.publisherRoles);
  };
  const readableRepository = async (id: string, actor: RbacPrincipal) => {
    const repository = await getStore().get(parse(RecipeRepositoryIdSchema, id, "repository id"));
    if (!canRead(actor, repository.repository)) {
      throw new RecipeStoreError(404, "Recipe repository not found");
    }
    return repository;
  };
  const writableRepository = async (c: Context<RegistryEnv>, id: string) => {
    requirePublisher(c);
    const repository = await readableRepository(id, c.get("principal"));
    checkNamespaceAccess(
      c.get("principal"),
      parseNamespace(repository.repository),
      "write",
      opts.publisherRoles,
    );
    return repository;
  };

  r.onError((error, c) => {
    if (error instanceof RecipeStoreError) {
      return c.json(
        { error: { code: STORE_ERROR_CODES[error.status], message: error.message } },
        error.status,
      );
    }
    if (error instanceof NamespacePermissionError) {
      return c.json({ error: { code: ErrorCode.FORBIDDEN, message: error.message } }, 403);
    }
    if (error instanceof AppError) {
      return c.json(error.toJSON(), error.statusCode as 400 | 415 | 422);
    }
    throw error;
  });

  r.get(BASE, authenticate, async (c) => {
    const repositories = await getStore().list();
    return c.json({
      repositories: repositories.filter((repository) =>
        canRead(c.get("principal"), repository.repository),
      ),
    });
  });

  r.post(`${BASE}/import`, authenticate, async (c) => {
    requirePublisher(c);
    const query = c.req.queries();
    if (Object.keys(query).some((key) => key !== "repository") || query.repository?.length !== 1) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Import accepts exactly one repository query parameter; paths and URLs are not supported",
        422,
      );
    }
    const repository = parse(RecipeRepositoryNameSchema, query.repository[0], "repository");
    const namespace = parseNamespace(repository);
    const actor = c.get("principal");
    // Import returns existing history, so write access alone must never grant visibility.
    checkNamespaceAccess(actor, namespace, "read", opts.publisherRoles);
    checkNamespaceAccess(actor, namespace, "write", opts.publisherRoles);
    if (
      c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/octet-stream"
    ) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Import requires a raw application/octet-stream Git bundle",
        415,
      );
    }
    const activeStore = getStore();
    const length = c.req.header("Content-Length");
    if (length !== undefined) {
      if (!/^\d+$/.test(length)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid Content-Length", 400);
      }
      if (BigInt(length) > BigInt(activeStore.limits.maxBundleBytes)) {
        throw new RecipeStoreError(413, "Recipe bundle exceeds the upload limit");
      }
    }
    const body = c.req.raw.body;
    if (!body) throw new RecipeStoreError(400, "Recipe bundle is empty");
    // The store counts actual streamed bytes even when Content-Length is absent or forged.
    return c.json(await activeStore.importBundle(repository, body, actor.sub), 201);
  });

  r.get(`${BASE}/:id`, authenticate, async (c) => {
    return c.json(await readableRepository(c.req.param("id"), c.get("principal")));
  });

  r.put(`${BASE}/:id/active`, authenticate, async (c) => {
    const repository = await writableRepository(c, c.req.param("id"));
    const input = parse(RecipeActivationSchema, await readJson(c), "recipe activation");
    return c.json(
      await getStore().activate(
        repository.id,
        input.commit,
        input.expectedActiveCommit,
        c.get("principal").sub,
      ),
    );
  });

  r.delete(`${BASE}/:id/active`, authenticate, async (c) => {
    const repository = await writableRepository(c, c.req.param("id"));
    const input = parse(RecipeDeactivationSchema, await readJson(c), "recipe deactivation");
    return c.json(
      await getStore().deactivate(
        repository.id,
        input.expectedActiveCommit,
        c.get("principal").sub,
      ),
    );
  });

  r.get(`${BASE}/:id/snapshots/:commit/archive`, authenticate, async (c) => {
    const id = parse(RecipeRepositoryIdSchema, c.req.param("id"), "repository id");
    const commit = parse(RecipeCommitSchema, c.req.param("commit"), "recipe commit");
    const repository = await readableRepository(id, c.get("principal"));
    const archive = await getStore().archive(repository.id, commit);
    return c.body(archive.stream, 200, {
      "Content-Type": "application/x-tar",
      "Content-Length": String(archive.size),
      "Content-Disposition": `attachment; filename="${repository.id}-${commit}.tar"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  return r;
}

function canRead(principal: RbacPrincipal, repository: string): boolean {
  try {
    checkNamespaceAccess(principal, parseNamespace(repository), "read");
    return true;
  } catch (error) {
    if (error instanceof NamespacePermissionError) return false;
    throw error;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${name}: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      422,
      result.error.issues,
    );
  }
  return result.data;
}

async function readJson(c: Context<RegistryEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid JSON body", 400);
    }
    throw error;
  }
}
