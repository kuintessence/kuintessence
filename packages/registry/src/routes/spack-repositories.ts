import {
  AppError,
  ErrorCode,
  RecipeActivationSchema,
  RecipeCommitSchema,
  RecipeDeactivationSchema,
  RecipeGrantSchema,
  RecipeMigrationSchema,
  type RecipeRepository,
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
import { RecipeGitStore } from "../services/recipe-git-store";
import { SpackMaterialError } from "../services/spack-material-storage";
import type { SpackMaterialStore } from "../services/spack-material-store";

export type RecipeRepositoryStore = Pick<
  RecipeGitStore,
  | "list"
  | "get"
  | "importBundle"
  | "activate"
  | "deactivate"
  | "archive"
  | "limits"
  | "grants"
  | "setGrant"
  | "migrate"
  | "collectSnapshot"
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
  materials?: Pick<SpackMaterialStore, "withUnreferencedRecipe">,
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
  function nativeWrite(actor: RbacPrincipal, name: string) {
    const ns = parseNamespace(name);
    checkNamespaceAccess(actor, ns, "read", opts.publisherRoles);
    checkNamespaceAccess(actor, ns, "write", opts.publisherRoles);
  }

  async function writeMode(actor: RbacPrincipal, name: string) {
    try {
      nativeWrite(actor, name);
      return "namespace" as const;
    } catch (error) {
      if (!(error instanceof NamespacePermissionError)) throw error;
      const grants = await getStore().grants(RecipeGitStore.repositoryId(name));
      if (!grants.some((grant) => grant.subject === actor.sub && grant.access === "write"))
        throw error;
      return "delegated" as const;
    }
  }

  async function visible(repository: RecipeRepository, actor: RbacPrincipal) {
    const grants = await getStore().grants(repository.id);
    const grant = grants.find((item) => item.subject === actor.sub);
    if (!grant && !canRead(actor, repository.repository)) return undefined;
    if (grant?.access === "write" && !repository.migrated) {
      try {
        assertPublisherRole(actor, opts.publisherRoles);
        return { ...repository, delegatedWrite: true as const };
      } catch (error) {
        if (!(error instanceof NamespacePermissionError)) throw error;
      }
    }
    return repository;
  }

  async function requireVisible(repository: RecipeRepository, actor: RbacPrincipal) {
    const view = await visible(repository, actor);
    if (!view) throw new RecipeStoreError(404, "Recipe repository not found");
    return view;
  }
  async function readableRepository(id: string, actor: RbacPrincipal) {
    const repository = await getStore().get(parse(RecipeRepositoryIdSchema, id, "repository id"));
    return requireVisible(repository, actor);
  }
  async function writableRepository(c: Context<RegistryEnv>, id: string) {
    requirePublisher(c);
    const actor = c.get("principal");
    const repository = await readableRepository(id, actor);
    return { repository, mode: await writeMode(actor, repository.repository) };
  }
  async function managedRepository(c: Context<RegistryEnv>, id: string) {
    requirePublisher(c);
    const repository = await readableRepository(id, c.get("principal"));
    nativeWrite(c.get("principal"), repository.repository);
    return repository;
  }

  r.onError((error, c) => {
    if (error instanceof RecipeStoreError) {
      return c.json(
        { error: { code: error.code ?? STORE_ERROR_CODES[error.status], message: error.message } },
        error.status,
      );
    }
    if (error instanceof SpackMaterialError) {
      return c.json(
        { error: { code: "RECIPE_REFERENCE_CHECK_FAILED", message: error.message } },
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
    const views = [];
    for (const repository of repositories) {
      const view = await visible(repository, c.get("principal"));
      if (view) views.push(view);
    }
    return c.json({ repositories: views });
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
    const actor = c.get("principal");
    const mode = await writeMode(actor, repository);
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
    const result = await activeStore.importBundle(
      repository,
      body,
      actor.sub,
      c.req.raw.signal,
      mode === "delegated",
    );
    return c.json(await requireVisible(result, c.get("principal")), 201);
  });

  r.get(`${BASE}/:id`, authenticate, async (c) => {
    return c.json(await readableRepository(c.req.param("id"), c.get("principal")));
  });

  r.put(`${BASE}/:id/active`, authenticate, async (c) => {
    const { repository, mode } = await writableRepository(c, c.req.param("id"));
    const input = parse(RecipeActivationSchema, await readJson(c), "recipe activation");
    const result = await getStore().activate(
      repository.id,
      input.commit,
      input.expectedActiveCommit,
      c.get("principal").sub,
      mode === "delegated",
    );
    return c.json(await requireVisible(result, c.get("principal")));
  });

  r.delete(`${BASE}/:id/active`, authenticate, async (c) => {
    const { repository, mode } = await writableRepository(c, c.req.param("id"));
    const input = parse(RecipeDeactivationSchema, await readJson(c), "recipe deactivation");
    const result = await getStore().deactivate(
      repository.id,
      input.expectedActiveCommit,
      c.get("principal").sub,
      mode === "delegated",
    );
    return c.json(await requireVisible(result, c.get("principal")));
  });

  r.get(`${BASE}/:id/grants`, authenticate, async (c) => {
    const repository = await managedRepository(c, c.req.param("id"));
    return c.json({ grants: await getStore().grants(repository.id) });
  });

  r.put(`${BASE}/:id/grants`, authenticate, async (c) => {
    const repository = await managedRepository(c, c.req.param("id"));
    const grant = parse(RecipeGrantSchema, await readJson(c), "recipe grant");
    if (opts.resolveCanonicalPrincipal) {
      const principal = await opts.resolveCanonicalPrincipal(grant.subject);
      if (principal?.sub !== grant.subject || principal.suspended)
        throw new RecipeStoreError(422, "Recipe grant requires an active account");
    }
    return c.json({
      grants: await getStore().setGrant(repository.id, grant.subject, grant.access),
    });
  });

  r.delete(`${BASE}/:id/grants/:subject`, authenticate, async (c) => {
    const repository = await managedRepository(c, c.req.param("id"));
    const subject = parse(RecipeGrantSchema.shape.subject, c.req.param("subject"), "subject");
    return c.json({ grants: await getStore().setGrant(repository.id, subject, null) });
  });

  r.post(`${BASE}/:id/migrate`, authenticate, async (c) => {
    const source = await managedRepository(c, c.req.param("id"));
    const input = parse(RecipeMigrationSchema, await readJson(c), "recipe migration");
    nativeWrite(c.get("principal"), input.repository);
    if (
      !source.repository.startsWith("public/") &&
      input.repository.startsWith("public/") &&
      !input.acknowledgePublicHistory
    )
      throw new RecipeStoreError(422, "Confirm publication of the complete recipe history");
    return c.json(await getStore().migrate(source.id, input.repository, c.get("principal").sub));
  });

  r.delete(`${BASE}/:id/snapshots/:commit`, authenticate, async (c) => {
    const repository = await managedRepository(c, c.req.param("id"));
    const commit = parse(RecipeCommitSchema, c.req.param("commit"), "recipe commit");
    if (!materials) throw new RecipeStoreError(503, "Material reference check is unavailable");
    await getStore().collectSnapshot(repository.id, commit, materials);
    return c.body(null, 204);
  });

  r.get(`${BASE}/:id/snapshots/:commit/archive`, authenticate, async (c) => {
    const id = parse(RecipeRepositoryIdSchema, c.req.param("id"), "repository id");
    const commit = parse(RecipeCommitSchema, c.req.param("commit"), "recipe commit");
    const repository = await readableRepository(id, c.get("principal"));
    const actor = c.get("principal");
    const archive = canRead(actor, repository.repository)
      ? await getStore().archive(repository.id, commit)
      : await getStore().archive(repository.id, commit, actor.sub);
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
