import { mock } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import type { RecipeRepository } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import type { PrincipalMiddlewareOptions } from "../middleware/principal";
import type { RbacPrincipal } from "../services/namespace";
import { DEFAULT_RECIPE_LIMITS, RecipeStoreError } from "../services/recipe-git";
import { healthRoutes } from "./health";
import { createSpackRepositoryRoutes, type RecipeRepositoryStore } from "./spack-repositories";

export const BASE = "/api/spack/recipe-repositories";
export const ORG = "22222222-2222-4222-8222-222222222222";
export const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
export const COMMIT = "a".repeat(40);
export const PREVIOUS = "b".repeat(40);
export const OWNER: RbacPrincipal = { sub: "publisher", role: "org_admin", orgIds: [ORG] };
export const USER: RbacPrincipal = { sub: "reader", role: "user", orgIds: [ORG] };
export const PLATFORM: RbacPrincipal = { sub: "platform", role: "platform_admin", orgIds: [] };
export const SUPER: RbacPrincipal = { sub: "root", role: "super_admin", orgIds: [] };
export const JWT_OPTIONS: PrincipalMiddlewareOptions = {
  authMode: "jwt",
  allowTestHeader: false,
  jwtSecret: "recipe-route-test-secret",
  jwtIssuer: "recipe-test-issuer",
  jwtAudience: "recipe-test-audience",
};

export function repository(name = `org/${ORG}/recipes`): RecipeRepository {
  return {
    id: createHash("sha256").update(name).digest("hex"),
    repository: name,
    activeCommit: null,
    snapshots: [
      {
        commit: COMMIT,
        importedAt: "2026-09-17T00:00:00.000Z",
        importedBy: "original-publisher",
        bundleSha256: "c".repeat(64),
        fileCount: 2,
        totalBytes: 200,
        roots: [{ path: "repo", namespace: "science", api: "v2.0", packageCount: 1 }],
        diagnostics: [
          { severity: "warning", code: "UNRESOLVED_DEPENDENCY", message: "Static analysis only" },
        ],
        validation: "static-only",
      },
    ],
  };
}

export function createStore(repositories: RecipeRepository[] = [repository()]) {
  const limits = { ...DEFAULT_RECIPE_LIMITS, maxBundleBytes: 16 };
  const imports: Array<{ repository: string; bytes: Uint8Array; actor: string }> = [];
  const get = mock(async (id: string) => {
    const result = repositories.find((item) => item.id === id);
    if (!result) throw new RecipeStoreError(404, "Recipe repository not found");
    return result;
  });
  const store = {
    limits,
    list: mock(async () => repositories),
    get,
    getSnapshot: mock(async (id: string, commit: string, checkpoint?: () => void) => {
      checkpoint?.();
      const recipe = await get(id);
      const snapshot = recipe.snapshots.find((item) => item.commit === commit);
      if (!snapshot) throw new RecipeStoreError(404, "Recipe snapshot not found");
      checkpoint?.();
      return { id: recipe.id, repository: recipe.repository, snapshot };
    }),
    importBundle: mock(
      async (name: string, input: Uint8Array | ReadableStream<Uint8Array>, actor: string) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = input instanceof Uint8Array ? null : input.getReader();
        try {
          if (input instanceof Uint8Array) {
            chunks.push(input);
            size = input.byteLength;
          } else if (reader) {
            for (;;) {
              const result = await reader.read();
              if (result.done) break;
              chunks.push(result.value);
              size += result.value.byteLength;
              if (size > limits.maxBundleBytes) {
                throw new RecipeStoreError(413, "Recipe bundle exceeds the upload limit");
              }
            }
          }
        } finally {
          if (reader) {
            await reader.cancel();
            reader.releaseLock();
          }
        }
        if (size === 0) throw new RecipeStoreError(400, "Recipe bundle is empty");
        if (size > limits.maxBundleBytes) {
          throw new RecipeStoreError(413, "Recipe bundle exceeds the upload limit");
        }
        imports.push({ repository: name, bytes: Buffer.concat(chunks), actor });
        return repository(name);
      },
    ),
    activate: mock(
      async (id: string, commit: string, _expected: string | null, _actor: string) => ({
        ...(await get(id)),
        activeCommit: commit,
      }),
    ),
    deactivate: mock(async (id: string, _expected: string, _actor: string) => ({
      ...(await get(id)),
      activeCommit: null,
    })),
    archive: mock(async (_id: string, _commit: string) => ({
      stream: byteStream(new Uint8Array([0, 1]), new Uint8Array([254, 255])),
      size: 4,
    })),
  } satisfies RecipeRepositoryStore;
  return { store, imports };
}

export function createApp(
  store: RecipeRepositoryStore | undefined,
  opts: PrincipalMiddlewareOptions = { allowTestHeader: true },
) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.route("/api", createSpackRepositoryRoutes(store, opts));
  // Mounted after recipes deliberately: a wildcard recipe middleware would intercept these.
  app.route("/api", healthRoutes);
  app.get("/api/spack/catalog", (c) => c.json({ packages: [] }));
  app.get("/api/spack/recipe-repositories-other", (c) => c.json({ public: true }));
  return app;
}

export function headers(principal: RbacPrincipal = OWNER, type = "application/json") {
  return { "X-Test-Principal": JSON.stringify(principal), "Content-Type": type };
}

export function token(principal: RbacPrincipal = SUPER) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      ...principal,
      iss: JWT_OPTIONS.jwtIssuer,
      aud: JWT_OPTIONS.jwtAudience,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", JWT_OPTIONS.jwtSecret ?? "")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function byteStream(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
