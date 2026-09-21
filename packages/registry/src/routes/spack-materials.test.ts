import { afterEach, describe, expect, mock, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  SPACK_LOCK_MAX_BYTES,
  type SpackMaterialBinding,
  type SpackMaterialManifest,
} from "@kuintessence/shared";
import { MATERIAL_METADATA_BYTES, materialDigest } from "../services/spack-material-storage";
import {
  BASE,
  cleanupMaterials,
  LOCK,
  LOCK_BLOB,
  materialApp,
  materialFixture,
  SOURCE,
  SOURCE_BLOB,
} from "./spack-materials.test-helpers";
import {
  byteStream,
  headers,
  JWT_OPTIONS,
  ORG,
  OTHER_ORG,
  OWNER,
  PLATFORM,
  repository,
  SUPER,
  token,
  USER,
} from "./spack-repositories.test-helpers";

afterEach(cleanupMaterials);

async function expectError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  const body = (await response.json()) as {
    error: { code: string; message: string };
    errors?: unknown;
  };
  expect(typeof body.error.code).toBe("string");
  expect(typeof body.error.message).toBe("string");
  expect(body.errors).toBeUndefined();
}

function releasePath(binding: SpackMaterialBinding): string {
  return `${BASE}/${binding.repositoryId}/releases/${binding.manifestDigest}`;
}

describe("material routes authentication and isolation", () => {
  const paths = [
    { path: `${BASE}/blobs?repository=public/test&digest=${SOURCE_BLOB.digest}`, method: "POST" },
    { path: `${BASE}/releases`, method: "POST" },
    { path: `${BASE}/lock-preflight`, method: "POST" },
    { path: `${BASE}/${"a".repeat(64)}/releases/${SOURCE_BLOB.digest}`, method: "GET" },
    {
      path: `${BASE}/${"a".repeat(64)}/releases/${SOURCE_BLOB.digest}/blobs/${LOCK_BLOB.digest}`,
      method: "GET",
    },
  ];
  test.each(paths)("requires principal and explicit storage: $method $path", async ({
    path,
    method,
  }) => {
    const app = materialApp(undefined);
    await expectError(await app.request(path, { method }), 401);
    await expectError(await app.request(path, { method, headers: headers() }), 503);
  });

  test("does not attach authentication to unrelated routes", async () => {
    expect((await materialApp(undefined).request("/api/health")).status).toBe(200);
  });

  test("a request canceled during publication does not commit a new release", async () => {
    const f = await materialFixture();
    await f.seed();
    const controller = new AbortController();
    f.recipes.get.mockImplementation(async () => {
      controller.abort();
      return f.recipe;
    });
    const response = await f.app.request(`${BASE}/releases`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(f.input),
      signal: controller.signal,
    });
    expect(response.status).not.toBe(201);
    expect(f.recipes.archive).not.toHaveBeenCalled();
    expect((await readdir(f.root)).includes("manifests")).toBe(false);
  });

  test("requires canonical JWT identity, ignores stale privileges and enforces suspension", async () => {
    const f = await materialFixture();
    const request = {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(f.input),
    };
    await expectError(
      await materialApp(f.store, JWT_OPTIONS).request(`${BASE}/releases`, request),
      401,
    );
    for (const canonical of [null, { ...SUPER, suspended: true }]) {
      await expectError(
        await materialApp(f.store, {
          ...JWT_OPTIONS,
          resolveCanonicalPrincipal: async () => canonical,
        }).request(`${BASE}/releases`, request),
        401,
      );
    }
    const app = materialApp(f.store, {
      ...JWT_OPTIONS,
      resolveCanonicalPrincipal: async () => ({ ...USER, suspended: false }),
    });
    await expectError(await app.request(`${BASE}/releases`, request), 403);
    await expectError(
      await app.request(`${BASE}/releases`, { ...request, headers: headers(SUPER) }),
      401,
    );
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test.each([
    USER,
    PLATFORM,
    { ...OWNER, orgIds: [OTHER_ORG] },
  ])("requires publisher and namespace read/write access", async (actor) => {
    const f = await materialFixture();
    const upload = `${BASE}/blobs?repository=${f.input.repository}&digest=${SOURCE_BLOB.digest}`;
    await expectError(
      await f.app.request(upload, {
        method: "POST",
        headers: headers({ ...actor, orgIds: [...actor.orgIds] }, "application/octet-stream"),
        body: byteStream(SOURCE),
      }),
      403,
    );
    for (const endpoint of ["releases", "lock-preflight"]) {
      await expectError(
        await f.app.request(`${BASE}/${endpoint}`, {
          method: "POST",
          headers: headers({ ...actor, orgIds: [...actor.orgIds] }),
          body: JSON.stringify(f.input),
        }),
        403,
      );
    }
  });

  test("publisher role configuration is enforced without disabling reads", async () => {
    const f = await materialFixture();
    await f.seed();
    const binding = await f.store.publish(f.input, OWNER);
    const app = materialApp(f.store, { allowTestHeader: true, publisherRoles: [] });
    expect((await app.request(releasePath(binding), { headers: headers(USER) })).status).toBe(200);
    await expectError(
      await app.request(`${BASE}/releases`, {
        method: "POST",
        headers: headers(SUPER),
        body: JSON.stringify(f.input),
      }),
      403,
    );
  });

  test("conceals cross-organization manifests and blobs from even platform admins", async () => {
    const f = await materialFixture();
    await f.seed();
    const binding = await f.store.publish(f.input, OWNER);
    for (const actor of [PLATFORM, { ...USER, orgIds: [OTHER_ORG] }]) {
      for (const suffix of ["", `/blobs/${SOURCE_BLOB.digest}`]) {
        await expectError(
          await f.app.request(`${releasePath(binding)}${suffix}`, { headers: headers(actor) }),
          404,
        );
      }
    }
  });

  test("checks the recipe namespace during publication, not merely material write permission", async () => {
    const f = await materialFixture({}, repository(`org/${OTHER_ORG}/recipes`));
    f.input.repository = `org/${ORG}/materials`;
    await f.seed();
    await expectError(await f.publish(), 404);
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("forbids promoting private recipes into public releases", async () => {
    const f = await materialFixture({}, repository("user/root/recipes"));
    f.input.repository = "public/materials";
    await f.seed();
    await expectError(
      await f.app.request(`${BASE}/releases`, {
        method: "POST",
        headers: headers(SUPER),
        body: JSON.stringify(f.input),
      }),
      403,
    );
  });
});

describe("material upload, validation and exact delivery", () => {
  test("lock-preflight returns diagnostics without publishing and rejects invalid locks on publish", async () => {
    const f = await materialFixture();
    await f.seed();
    const preflight = () =>
      f.app.request(`${BASE}/lock-preflight`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(f.input),
      });
    const response = await preflight();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ valid: true, validation: "static-only" });
    expect(f.recipes.archive).not.toHaveBeenCalled();

    f.input.target = "linux-ubuntu24.04-aarch64";
    const invalid = await preflight();
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ valid: false, validation: "static-only" });
    const publication = await f.publish();
    expect(publication.status).toBe(422);
    expect(await publication.json()).toMatchObject({
      error: { lockPreflight: { valid: false, validation: "static-only" } },
    });
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("preflight honors canonical JWT publisher identity and cannot read another namespace", async () => {
    const f = await materialFixture();
    await f.seed();
    for (const actor of [null, { ...SUPER, suspended: true }, { ...USER, suspended: false }]) {
      const app = materialApp(f.store, {
        ...JWT_OPTIONS,
        resolveCanonicalPrincipal: async () => actor,
      });
      await expectError(
        await app.request(`${BASE}/lock-preflight`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
          body: JSON.stringify(f.input),
        }),
        actor && !actor.suspended ? 403 : 401,
      );
    }
    f.recipe.repository = `org/${OTHER_ORG}/recipes`;
    await expectError(
      await f.app.request(`${BASE}/lock-preflight`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(f.input),
      }),
      404,
    );
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("preflight enforces JSON, query and lock byte limits before opening blobs", async () => {
    const f = await materialFixture();
    for (const [suffix, type, input, status] of [
      ["?url=https://outside.example", "application/json", f.input, 422],
      ["", "text/plain", f.input, 415],
      [
        "",
        "application/json",
        { ...f.input, lockfile: { ...LOCK_BLOB, size: SPACK_LOCK_MAX_BYTES + 1 } },
        413,
      ],
    ] as const) {
      await expectError(
        await f.app.request(`${BASE}/lock-preflight${suffix}`, {
          method: "POST",
          headers: headers(OWNER, type),
          body: JSON.stringify(input),
        }),
        status,
      );
    }
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("cancels rejected request streams before any storage work", async () => {
    const f = await materialFixture();
    for (const requestHeaders of [{}, headers(USER), headers(OWNER, "text/plain")]) {
      const cancel = mock(() => {});
      const response = await f.app.request(
        `${BASE}/blobs?repository=${f.input.repository}&digest=${SOURCE_BLOB.digest}`,
        {
          method: "POST",
          headers: requestHeaders,
          body: new ReadableStream<Uint8Array>({ cancel }),
        },
      );
      expect([401, 403, 415]).toContain(response.status);
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  test("uploads raw bytes, publishes, and serves exact manifest/archive/source/lock bytes", async () => {
    const f = await materialFixture();
    const uploaded = await f.upload();
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toEqual(SOURCE_BLOB);
    expect((await f.upload(LOCK)).status).toBe(201);
    const publication = await f.publish();
    expect(publication.status).toBe(201);
    const binding = (await publication.json()) as SpackMaterialBinding;
    const response = await f.app.request(releasePath(binding), { headers: headers(USER) });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(materialDigest(bytes)).toBe(binding.manifestDigest);
    expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as SpackMaterialManifest;
    for (const [blob, expected] of [
      [SOURCE_BLOB, SOURCE],
      [LOCK_BLOB, LOCK],
      [manifest.recipes[0]?.archive, new Uint8Array([0, 1, 254, 255])],
    ] as const) {
      if (!blob) throw new Error("Missing recipe archive");
      const download = await f.app.request(`${releasePath(binding)}/blobs/${blob.digest}`, {
        headers: headers(USER),
      });
      expect(download.status).toBe(200);
      expect(download.headers.get("Content-Length")).toBe(String(blob.size));
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(expected);
    }
    const unknown = await f.app.request(`${releasePath(binding)}/blobs/sha256:${"e".repeat(64)}`, {
      headers: headers(),
    });
    await expectError(unknown, 404);
  });

  test.each([
    "url=https://example.invalid/source",
    "repository=public/second",
    `digest=${LOCK_BLOB.digest}`,
  ])("rejects ambiguous upload or URL query: %s", async (query) => {
    const f = await materialFixture();
    await expectError(
      await f.app.request(
        `${BASE}/blobs?repository=${f.input.repository}&digest=${SOURCE_BLOB.digest}&${query}`,
        {
          method: "POST",
          headers: headers(OWNER, "application/octet-stream"),
          body: byteStream(SOURCE),
        },
      ),
      422,
    );
  });

  test.each([
    "/tmp/source",
    "https://example.invalid/source",
    "sha256:../escape",
    `sha256:${"A".repeat(64)}`,
  ])("validates digest before touching storage: %s", async (digest) => {
    const f = await materialFixture();
    await expectError(await f.upload(SOURCE, f.input.repository, digest), 422);
  });

  test("rejects unknown receipts and checksum mismatch through the HTTP boundary", async () => {
    const f = await materialFixture();
    await expectError(await f.publish(), 422);
    await expectError(await f.upload(LOCK, f.input.repository, SOURCE_BLOB.digest), 422);
    await expectError(await f.publish(), 422);
  });

  test.each([
    "-1",
    "1.5",
    "garbage",
    "1e3",
  ])("rejects invalid Content-Length: %s", async (length) => {
    const f = await materialFixture();
    await expectError(
      await f.app.request(
        `${BASE}/blobs?repository=${f.input.repository}&digest=${SOURCE_BLOB.digest}`,
        {
          method: "POST",
          headers: { ...headers(OWNER, "application/octet-stream"), "Content-Length": length },
          body: byteStream(SOURCE),
        },
      ),
      400,
    );
  });

  test.each([
    undefined,
    "1",
    "999999999999999999999",
  ])("enforces size despite Content-Length %s", async (length) => {
    const f = await materialFixture({ maxBlobBytes: 4 });
    const requestHeaders = new Headers(headers(OWNER, "application/octet-stream"));
    if (length) requestHeaders.set("Content-Length", length);
    await expectError(
      await f.app.request(
        `${BASE}/blobs?repository=${f.input.repository}&digest=${SOURCE_BLOB.digest}`,
        { method: "POST", headers: requestHeaders, body: byteStream(SOURCE) },
      ),
      413,
    );
  });

  test("requires raw upload and JSON release content types; rejects empty or malformed data", async () => {
    const f = await materialFixture();
    const path = `${BASE}/blobs?repository=${f.input.repository}&digest=${SOURCE_BLOB.digest}`;
    await expectError(
      await f.app.request(path, { method: "POST", headers: headers(), body: "{}" }),
      415,
    );
    await expectError(
      await f.app.request(path, {
        method: "POST",
        headers: headers(OWNER, "application/octet-stream"),
      }),
      400,
    );
    await expectError(await f.upload(new Uint8Array()), 400);
    await expectError(
      await f.app.request(`${BASE}/releases`, { method: "POST", headers: headers(), body: "{" }),
      400,
    );
    await expectError(
      await f.app.request(`${BASE}/releases`, {
        method: "POST",
        headers: headers(OWNER, "text/plain"),
        body: "{}",
      }),
      415,
    );
  });

  test("bounds JSON bytes before parsing, including a forged small Content-Length", async () => {
    const f = await materialFixture();
    await expectError(
      await f.app.request(`${BASE}/releases`, {
        method: "POST",
        headers: { ...headers(), "Content-Length": "1" },
        body: byteStream(new Uint8Array(MATERIAL_METADATA_BYTES + 1)),
      }),
      413,
    );
  });

  test("accepts only unrestricted redistribution and rejects URL-bearing release input", async () => {
    const f = await materialFixture();
    for (const changes of [
      { redistribution: "restricted" },
      { sourceUrl: "https://example.invalid/source" },
      { repository: "public/../escape" },
      { sources: [{ path: "../outside", blob: SOURCE_BLOB }] },
    ]) {
      await expectError(await f.publish({ ...f.input, ...changes }), 422);
    }
  });

  test("rejects unknown releases, unsafe ids and query parameters on release endpoints", async () => {
    const f = await materialFixture();
    for (const [path, status] of [
      [`${BASE}/${"a".repeat(64)}/releases/${SOURCE_BLOB.digest}`, 404],
      [`${BASE}/bad/releases/${SOURCE_BLOB.digest}`, 422],
      [`${BASE}/${"a".repeat(64)}/releases/latest`, 422],
      [`${BASE}/${"a".repeat(64)}/releases/${SOURCE_BLOB.digest}?url=https://example.invalid`, 422],
    ] as const) {
      await expectError(await f.app.request(path, { headers: headers() }), status);
    }
    await expectError(
      await f.app.request(`${BASE}/releases?url=https://example.invalid`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(f.input),
      }),
      422,
    );
  });
});
