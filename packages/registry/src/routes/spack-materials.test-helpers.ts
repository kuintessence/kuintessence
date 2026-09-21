import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecipeRepository, SpackMaterialPublish } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import type { PrincipalMiddlewareOptions } from "../middleware/principal";
import { materialDigest } from "../services/spack-material-storage";
import { type SpackMaterialLimits, SpackMaterialStore } from "../services/spack-material-store";
import { createSpackMaterialRoutes } from "./spack-materials";
import {
  byteStream,
  COMMIT,
  createStore,
  headers,
  OWNER,
  repository,
} from "./spack-repositories.test-helpers";

export const BASE = "/api/spack/material-repositories";
export const SOURCE = new TextEncoder().encode("offline source archive");
// Synthetic native-format lock; this is not a concretization or source-coverage fixture.
export const LOCK = new TextEncoder().encode(
  JSON.stringify({
    _meta: { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5 },
    spack: { version: "1.0.0", type: "release" },
    roots: [{ spec: "hello@1.0", hash: "a".repeat(32) }],
    concrete_specs: {
      ["a".repeat(32)]: {
        name: "hello",
        version: "1.0",
        namespace: "builtin",
        hash: "a".repeat(32),
        arch: { platform: "linux", platform_os: "ubuntu24.04", target: "x86_64" },
        parameters: {},
      },
    },
  }),
);
export const SOURCE_BLOB = { digest: materialDigest(SOURCE), size: SOURCE.byteLength };
export const LOCK_BLOB = { digest: materialDigest(LOCK), size: LOCK.byteLength };
const directories: string[] = [];

export async function cleanupMaterials() {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

export function materialApp(
  store: SpackMaterialStore | undefined,
  opts: PrincipalMiddlewareOptions = { allowTestHeader: true },
) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.route("/api", createSpackMaterialRoutes(store, opts));
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
}

export async function materialFixture(
  limits: Partial<SpackMaterialLimits> = {},
  recipe: RecipeRepository = repository(),
) {
  const root = await mkdtemp(join(tmpdir(), "kq-material-test-"));
  directories.push(root);
  const recipes = createStore([recipe]).store;
  const store = new SpackMaterialStore(root, recipes, limits);
  const input: SpackMaterialPublish = {
    version: 1,
    repository: recipe.repository,
    spec: "hello@1.0",
    spackVersion: "1.0.0",
    target: "linux-ubuntu24.04-x86_64",
    redistribution: "unrestricted",
    recipes: [{ repositoryId: recipe.id, commit: COMMIT, roots: ["repo"] }],
    sources: [{ path: "hello/hello-1.0.tar.gz", blob: SOURCE_BLOB }],
    lockfile: LOCK_BLOB,
  };
  const app = materialApp(store);
  const upload = (bytes = SOURCE, name = input.repository, digest = materialDigest(bytes)) =>
    app.request(`${BASE}/blobs?repository=${encodeURIComponent(name)}&digest=${digest}`, {
      method: "POST",
      headers: headers(OWNER, "application/octet-stream"),
      body: byteStream(bytes),
    });
  const seed = async (name = input.repository) => {
    await store.upload(name, SOURCE_BLOB.digest, byteStream(SOURCE));
    await store.upload(name, LOCK_BLOB.digest, byteStream(LOCK));
  };
  const publish = (value: unknown = input) =>
    app.request(`${BASE}/releases`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(value),
    });
  return { root, recipes, recipe, store, app, input, upload, seed, publish };
}
