import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  SPACK_UPSTREAM_IMPORT_MAX_BYTES,
  SPACK_UPSTREAM_RECIPE_MAX_BYTES,
  type SpackUpstreamImport,
  SpackUpstreamImportResultSchema,
  SpackUpstreamImportSchema,
} from "@kuintessence/shared/browser";
import { Hono } from "hono";
import type { PrincipalMiddlewareOptions } from "../middleware/principal";
import { materialDigest, SpackMaterialError } from "../services/spack-material-storage";
import {
  type SpackUpstreamDownloadPort,
  SpackUpstreamImportService,
} from "../services/spack-upstream-import";
import { SpackUpstreamError } from "../services/spack-upstream-policy";
import {
  cleanupMaterials,
  LOCK,
  LOCK_BLOB,
  materialFixture,
  SOURCE,
  SOURCE_BLOB,
} from "./spack-materials.test-helpers";
import {
  byteStream,
  headers,
  JWT_OPTIONS,
  OTHER_ORG,
  OWNER,
  PLATFORM,
  SUPER,
  token,
  USER,
} from "./spack-repositories.test-helpers";
import { createSpackUpstreamRoutes } from "./spack-upstream";

afterEach(cleanupMaterials);

const BASE = "/api/spack/upstream-imports";
const BUNDLE = new TextEncoder().encode("bundle");
const URL = "https://sources.example.org/recipes.bundle";

function app(
  service?: SpackUpstreamImportService,
  opts: PrincipalMiddlewareOptions = { allowTestHeader: true },
) {
  const root = new Hono();
  root.route("/api", createSpackUpstreamRoutes(service, opts));
  root.get("/api/health", (c) => c.json({ ok: true }));
  return root;
}

async function fixture() {
  const f = await materialFixture();
  const calls: Parameters<SpackUpstreamDownloadPort["withDownload"]>[0][] = [];
  const downloads = new Map([
    [URL, BUNDLE],
    ["https://sources.example.org/spack.lock", LOCK],
    ["https://sources.example.org/source.tar.gz", SOURCE],
  ]);
  const downloader: SpackUpstreamDownloadPort = {
    async withDownload(input, signal, consume) {
      calls.push(input);
      signal.throwIfAborted();
      const bytes = downloads.get(input.url);
      if (!bytes || materialDigest(bytes) !== input.digest || bytes.byteLength !== input.size) {
        throw new SpackUpstreamError("integrity");
      }
      return consume(byteStream(bytes));
    },
  };
  const service = new SpackUpstreamImportService({
    recipeStore: f.recipes,
    materialStore: f.store,
    downloader,
  });
  const recipe: SpackUpstreamImport = {
    kind: "recipe",
    repository: f.input.repository,
    url: URL,
    digest: materialDigest(BUNDLE),
    size: BUNDLE.byteLength,
  };
  const material: SpackUpstreamImport = {
    kind: "material",
    files: [
      { url: "https://sources.example.org/spack.lock", blob: LOCK_BLOB },
      { url: "https://sources.example.org/source.tar.gz", blob: SOURCE_BLOB },
    ],
    release: f.input,
  };
  return { ...f, app: app(service), service, downloader, calls, recipe, material };
}

function request(value: unknown, actor = OWNER): RequestInit {
  return { method: "POST", headers: headers(actor), body: JSON.stringify(value) };
}

async function expectError(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const body = (await response.json()) as {
    error: { code: string; message: string };
    errors?: unknown;
  };
  expect(typeof body.error.code).toBe("string");
  expect(typeof body.error.message).toBe("string");
  if (code) expect(body.error.code).toBe(code);
  expect(body.errors).toBeUndefined();
  return body.error;
}

describe("Spack upstream import HTTP authorization", () => {
  test("authenticates disabled mode without intercepting unrelated routes", async () => {
    const root = app();
    await expectError(await root.request(BASE, { method: "POST" }), 401);
    await expectError(await root.request(BASE, request({})), 503, "UPSTREAM_IMPORT_UNAVAILABLE");
    expect((await root.request("/api/health")).status).toBe(200);
  });

  test.each([
    USER,
    PLATFORM,
    { ...OWNER, orgIds: [OTHER_ORG] },
  ])("rejects publishers without both namespace read and write access before any download", async (actor) => {
    const f = await fixture();
    for (const input of [f.recipe, f.material]) {
      await expectError(await f.app.request(BASE, request(input, actor)), 403);
    }
    expect(f.calls).toEqual([]);
    expect(f.recipes.importBundle).not.toHaveBeenCalled();
    expect(f.recipes.get).not.toHaveBeenCalled();
  });

  test("rejects noncanonical, suspended and stale privileged JWT identities", async () => {
    const f = await fixture();
    const init = {
      ...request(f.recipe),
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    };
    await expectError(await app(f.service, JWT_OPTIONS).request(BASE, init), 401);
    for (const canonical of [null, { ...SUPER, suspended: true }]) {
      await expectError(
        await app(f.service, {
          ...JWT_OPTIONS,
          resolveCanonicalPrincipal: async () => canonical,
        }).request(BASE, init),
        401,
      );
    }
    await expectError(
      await app(f.service, {
        ...JWT_OPTIONS,
        resolveCanonicalPrincipal: async () => ({ ...USER, suspended: false }),
      }).request(BASE, init),
      403,
    );
    await expectError(
      await app(f.service, JWT_OPTIONS).request(BASE, request(f.recipe, SUPER)),
      401,
    );
    expect(f.calls).toEqual([]);
  });

  test("canonical identity is used for successful recipe imports", async () => {
    const f = await fixture();
    const root = app(f.service, {
      ...JWT_OPTIONS,
      resolveCanonicalPrincipal: async () => ({ ...OWNER, suspended: false }),
    });
    const response = await root.request(BASE, {
      ...request(f.recipe),
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    });
    expect(response.status).toBe(201);
    expect(SpackUpstreamImportResultSchema.safeParse(await response.json()).success).toBe(true);
    expect(f.recipes.importBundle).toHaveBeenCalledWith(
      f.recipe.repository,
      expect.any(ReadableStream),
      OWNER.sub,
      expect.any(AbortSignal),
    );
    expect(f.calls).toEqual([
      { url: URL, digest: materialDigest(BUNDLE), size: BUNDLE.byteLength },
    ]);
  });

  test("respects route publisher restrictions and referenced recipe visibility", async () => {
    const f = await fixture();
    await expectError(
      await app(f.service, { allowTestHeader: true, publisherRoles: [] }).request(
        BASE,
        request(f.recipe, SUPER),
      ),
      403,
    );
    f.recipe.repository = "public/recipes";
    await expectError(await f.app.request(BASE, request(f.recipe)), 403);
    f.recipe.repository = "user/another-user/recipes";
    await expectError(await f.app.request(BASE, request(f.recipe)), 403);
    expect(f.calls).toEqual([]);
  });

  test("checks recipe namespaces and visibility before downloading", async () => {
    const f = await fixture();
    const original = await f.recipes.get(f.material.release.recipes[0]?.repositoryId ?? "");
    original.repository = `org/${OTHER_ORG}/recipes`;
    await expectError(await f.app.request(BASE, request(f.material)), 404);
    f.material.release.repository = "public/materials";
    await expectError(await f.app.request(BASE, request(f.material, SUPER)), 403);
    expect(f.calls).toEqual([]);
  });

  test("publishes real material bytes and returns the browser result contract", async () => {
    const f = await fixture();
    const response = await f.app.request(BASE, request(f.material));
    expect(response.status).toBe(201);
    const result = SpackUpstreamImportResultSchema.parse(await response.json());
    if (result.kind !== "material") throw new Error("Expected material result");
    const blob = await f.store.getBlob(
      result.binding.repositoryId,
      result.binding.manifestDigest,
      SOURCE_BLOB.digest,
      USER,
    );
    expect(new Uint8Array(await new Response(blob.stream).arrayBuffer())).toEqual(SOURCE);
  });
});

describe("Spack upstream import request boundaries", () => {
  test("enforces JSON, query restrictions and actual body byte limits", async () => {
    const f = await fixture();
    for (const [suffix, init, status] of [
      ["?url=https://private.example/token", request(f.recipe), 422],
      ["", { ...request(f.recipe), headers: headers(OWNER, "text/plain") }, 415],
      ["", { method: "POST", headers: headers() }, 400],
      ["", { ...request(f.recipe), body: "{" }, 400],
      ["", { ...request(f.recipe), headers: { ...headers(), "Content-Length": "-1" } }, 400],
      [
        "",
        {
          ...request(f.recipe),
          headers: { ...headers(), "Content-Length": String(SPACK_UPSTREAM_IMPORT_MAX_BYTES + 1) },
        },
        413,
      ],
      [
        "",
        {
          method: "POST",
          headers: { ...headers(), "Content-Length": "1" },
          body: byteStream(new Uint8Array(SPACK_UPSTREAM_IMPORT_MAX_BYTES + 1)),
        },
        413,
      ],
    ] as const) {
      await expectError(await f.app.request(`${BASE}${suffix}`, init), status);
    }
    expect(f.calls).toEqual([]);
  });

  test("cancels unread bodies after authentication and content-type rejection", async () => {
    const f = await fixture();
    for (const requestHeaders of [{}, headers(USER), headers(OWNER, "text/plain")]) {
      const cancel = mock(() => {});
      const response = await f.app.request(BASE, {
        method: "POST",
        headers: requestHeaders,
        body: new ReadableStream<Uint8Array>({ cancel }),
      });
      expect([401, 403, 415]).toContain(response.status);
      expect(cancel).toHaveBeenCalledTimes(1);
    }
    expect(f.calls).toEqual([]);
  });

  test.each([
    "http://sources.example.org/source",
    "https://user:secret@sources.example.org/source",
    "https://@sources.example.org/source",
    "https://sources.example.org/source?token=secret",
    "https://sources.example.org/source?",
    "https://sources.example.org/source#secret",
    "https://sources.example.org/source#",
    "https://sources.example.org:8443/source",
    "https://[2001:4860:4860::8888]/source",
    "https://sources.example.org\\source",
    " https://sources.example.org/source",
    "https://sources.example.org/\u0000secret",
    "file:///private/source",
  ])("rejects unsafe URL without reflecting it: %s", async (url) => {
    const f = await fixture();
    const error = await expectError(await f.app.request(BASE, request({ ...f.recipe, url })), 422);
    expect(JSON.stringify(error)).not.toContain(url);
    f.material.files[0] = { url, blob: LOCK_BLOB };
    await expectError(await f.app.request(BASE, request(f.material)), 422);
    expect(f.calls).toEqual([]);
  });

  test("rejects duplicate, extra, missing and wrong-size files before downloading", async () => {
    const f = await fixture();
    const [lock, source] = f.material.files;
    if (!lock || !source) throw new Error("Missing fixture files");
    for (const files of [
      [lock],
      [lock, source, source],
      [lock, { ...source, url: lock.url }],
      [lock, { ...source, blob: { ...source.blob, size: source.blob.size + 1 } }],
      [lock, source, { url: URL, blob: { digest: materialDigest(BUNDLE), size: BUNDLE.length } }],
    ]) {
      await expectError(await f.app.request(BASE, request({ ...f.material, files })), 422);
    }
    await expectError(
      await f.app.request(BASE, request({ ...f.recipe, authorization: "secret" })),
      422,
    );
    expect(f.calls).toEqual([]);
  });

  test("browser schema enforces recipe, blob, file count and total byte limits", async () => {
    const f = await fixture();
    expect(
      SpackUpstreamImportSchema.safeParse({
        ...f.recipe,
        size: SPACK_UPSTREAM_RECIPE_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
    for (const [count, size] of [
      [256, 1],
      [1, 16 * 1024 ** 3 + 1],
      [32, 16 * 1024 ** 3],
    ] as const) {
      const sources = Array.from({ length: count }, (_, index) => ({
        path: `source-${index}.tar.gz`,
        blob: { digest: `sha256:${index.toString(16).padStart(64, "0")}`, size },
      }));
      const input = {
        ...f.material,
        files: [
          { url: "https://sources.example.org/spack.lock", blob: LOCK_BLOB },
          ...sources.map((source) => ({
            url: `https://sources.example.org/${source.path}`,
            blob: source.blob,
          })),
        ],
        release: { ...f.material.release, sources },
      };
      expect(SpackUpstreamImportSchema.safeParse(input).success).toBe(false);
    }
    expect(SpackUpstreamImportSchema.safeParse(f.material).success).toBe(true);
    expect(
      SpackUpstreamImportSchema.safeParse({
        ...f.recipe,
        url: "https://sources.example.org:443/recipes.bundle",
      }).success,
    ).toBe(true);
  });

  test("never reflects raw store, downloader, cancellation or resolver errors", async () => {
    const f = await fixture();
    const secret = "https://private.example/path?token=not-a-real-token";
    for (const error of [new Error(secret), new SpackMaterialError(422, secret)]) {
      f.downloader.withDownload = async () => {
        throw error;
      };
      const response = await f.app.request(BASE, request(f.recipe));
      expect(response.status).toBe(error instanceof SpackMaterialError ? 422 : 502);
      expect(await response.text()).not.toContain(secret);
    }
    const root = app(f.service, {
      ...JWT_OPTIONS,
      resolveCanonicalPrincipal: async () => {
        throw new Error(secret);
      },
    });
    const response = await root.request(BASE, {
      ...request(f.recipe),
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(secret);
  });

  test("preserves fixed transport classifications and sanitized cancellation", async () => {
    const f = await fixture();
    f.downloader.withDownload = async () => {
      throw new SpackUpstreamError("policy");
    };
    await expectError(await f.app.request(BASE, request(f.recipe)), 422, "SPACK_UPSTREAM_POLICY");
    const controller = new AbortController();
    controller.abort(new Error("private-reason"));
    const error = await expectError(
      await f.app.request(BASE, { ...request(f.recipe), signal: controller.signal }),
      408,
      "UPSTREAM_IMPORT_CANCELLED",
    );
    expect(error.message).not.toContain("private-reason");
  });
});
