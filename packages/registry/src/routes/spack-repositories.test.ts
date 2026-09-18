import { describe, expect, mock, test } from "bun:test";
import type { RecipeRepository } from "@kuintessence/shared";
import { RecipeStoreError } from "../services/recipe-git";
import {
  BASE,
  byteStream,
  COMMIT,
  createApp,
  createStore,
  headers,
  JWT_OPTIONS,
  ORG,
  OTHER_ORG,
  OWNER,
  PLATFORM,
  PREVIOUS,
  repository,
  SUPER,
  token,
  USER,
} from "./spack-repositories.test-helpers";

const REPO = repository();
const ACTIVE = `${BASE}/${REPO.id}/active`;
const ARCHIVE = `${BASE}/${REPO.id}/snapshots/${COMMIT}/archive`;
const IMPORT = `${BASE}/import?repository=${encodeURIComponent(REPO.repository)}`;
const ACTIVATION = {
  commit: COMMIT,
  expectedActiveCommit: null,
  acknowledgeExecutableRecipes: true,
};
const ENDPOINTS = [
  { path: BASE, method: "GET" },
  { path: `${BASE}/${REPO.id}`, method: "GET" },
  { path: IMPORT, method: "POST" },
  { path: ACTIVE, method: "PUT" },
  { path: ACTIVE, method: "DELETE" },
  { path: ARCHIVE, method: "GET" },
];

async function expectError(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  const body = (await response.json()) as {
    error: { code: string; message: string };
    errors?: unknown;
  };
  expect(typeof body.error.code).toBe("string");
  expect(typeof body.error.message).toBe("string");
  if (code) expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.errors).toBeUndefined();
}

describe("recipe repository authentication and visibility", () => {
  test.each(ENDPOINTS)("requires authentication for $method $path", async ({ path, method }) => {
    const { store } = createStore();
    await expectError(await createApp(store).request(path, { method }), 401);
    expect(store.list).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.importBundle).not.toHaveBeenCalled();
    expect(store.archive).not.toHaveBeenCalled();
  });

  test.each(ENDPOINTS)("reports disabled store after authentication for $method", async (route) => {
    const app = createApp(undefined);
    await expectError(await app.request(route.path, { method: route.method }), 401);
    await expectError(
      await app.request(route.path, { method: route.method, headers: headers(USER) }),
      503,
    );
  });

  test("does not attach recipe middleware to health, catalog, or similar prefixes", async () => {
    const app = createApp(undefined, JWT_OPTIONS);
    for (const path of [
      "/api/health",
      "/api/spack/catalog",
      "/api/spack/recipe-repositories-other",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
    }
  });

  test("filters the list by public, organization membership, and personal ownership", async () => {
    const publicRepo = repository("public/builtin");
    const personal = repository(`user/${USER.sub}/personal`);
    const foreign = repository(`org/${OTHER_ORG}/secret`);
    const { store } = createStore([
      publicRepo,
      REPO,
      personal,
      foreign,
      repository("user/other/x"),
    ]);
    const app = createApp(store);
    const response = await app.request(BASE, { headers: headers(USER) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ repositories: [publicRepo, REPO, personal] });
    const admin = await app.request(BASE, { headers: headers(SUPER) });
    expect(
      ((await admin.json()) as { repositories: RecipeRepository[] }).repositories,
    ).toHaveLength(5);
  });

  test("returns the complete static report for an authorized detail read", async () => {
    const { store } = createStore();
    const response = await createApp(store).request(`${BASE}/${REPO.id}`, {
      headers: headers(USER),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(REPO);
  });

  test("conceals private organization and user details and exports with 404", async () => {
    for (const privateRepo of [REPO, repository("user/other/private")]) {
      const { store } = createStore([privateRepo]);
      const app = createApp(store);
      for (const suffix of ["", `/snapshots/${COMMIT}/archive`]) {
        await expectError(
          await app.request(`${BASE}/${privateRepo.id}${suffix}`, { headers: headers(PLATFORM) }),
          404,
          "NOT_FOUND",
        );
      }
      expect(store.archive).not.toHaveBeenCalled();
    }
  });

  test("rejects unknown repositories without exposing storage errors", async () => {
    const { store } = createStore([]);
    await expectError(
      await createApp(store).request(`${BASE}/${REPO.id}`, { headers: headers() }),
      404,
      "NOT_FOUND",
    );
  });

  test("delegates unexpected failures to the parent error handler without leaking details", async () => {
    const { store } = createStore();
    store.list.mockImplementation(async () => {
      throw new Error("Cannot open /private/internal/recipes");
    });
    const response = await createApp(store).request(BASE, { headers: headers() });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });

  test("production JWT cannot bypass canonical resolution or trust test headers", async () => {
    const { store } = createStore();
    const app = createApp(store, { ...JWT_OPTIONS, requireCanonicalPrincipal: false });
    await expectError(
      await app.request(BASE, { headers: { Authorization: `Bearer ${token()}` } }),
      401,
    );
    await expectError(await app.request(BASE, { headers: headers(SUPER) }), 401);
    expect(store.list).not.toHaveBeenCalled();
  });

  test.each([
    null,
    { ...SUPER, suspended: true },
  ])("rejects a missing or suspended canonical principal", async (canonical) => {
    const { store } = createStore();
    const app = createApp(store, {
      ...JWT_OPTIONS,
      resolveCanonicalPrincipal: async () => canonical,
    });
    await expectError(
      await app.request(BASE, { headers: { Authorization: `Bearer ${token()}` } }),
      401,
    );
    expect(store.list).not.toHaveBeenCalled();
  });

  test("uses canonical role and memberships instead of stale privileged JWT claims", async () => {
    const { store } = createStore([REPO, repository("public/builtin")]);
    const resolveCanonicalPrincipal = mock(async () => ({
      ...USER,
      orgIds: [],
      suspended: false,
    }));
    const app = createApp(store, { ...JWT_OPTIONS, resolveCanonicalPrincipal });
    const auth = { Authorization: `Bearer ${token()}`, "Content-Type": "application/octet-stream" };
    const response = await app.request(BASE, { headers: auth });
    expect(((await response.json()) as { repositories: RecipeRepository[] }).repositories).toEqual([
      repository("public/builtin"),
    ]);
    await expectError(
      await app.request(IMPORT, { method: "POST", headers: auth, body: "bundle" }),
      403,
    );
    expect(resolveCanonicalPrincipal).toHaveBeenCalledWith(SUPER.sub);
    expect(store.importBundle).not.toHaveBeenCalled();
  });

  test("passes the canonical subject as the mutation actor", async () => {
    const { store, imports } = createStore();
    const app = createApp(store, {
      ...JWT_OPTIONS,
      resolveCanonicalPrincipal: async () => ({ ...OWNER, suspended: false }),
    });
    const response = await app.request(IMPORT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/octet-stream" },
      body: "bundle",
    });
    expect(response.status).toBe(201);
    expect(imports[0]?.actor).toBe(OWNER.sub);
  });
});

describe("recipe repository writes and validation", () => {
  test.each(["POST", "PUT", "DELETE"])("denies non-publisher %s writes", async (method) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(method === "POST" ? IMPORT : ACTIVE, {
        method,
        headers: headers(USER, method === "POST" ? "application/octet-stream" : "application/json"),
        body: method === "POST" ? "bundle" : JSON.stringify(ACTIVATION),
      }),
      403,
    );
    expect(store.importBundle).not.toHaveBeenCalled();
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.deactivate).not.toHaveBeenCalled();
  });

  test("enforces publisherRoles for all writes without blocking ordinary reads", async () => {
    const { store } = createStore();
    const app = createApp(store, { allowTestHeader: true, publisherRoles: [] });
    expect((await app.request(BASE, { headers: headers(SUPER) })).status).toBe(200);
    for (const method of ["POST", "PUT", "DELETE"]) {
      await expectError(
        await app.request(method === "POST" ? IMPORT : ACTIVE, {
          method,
          headers: headers(SUPER),
          body: JSON.stringify(ACTIVATION),
        }),
        403,
      );
    }
  });

  test("a configured personal publisher still needs namespace write scope", async () => {
    const { store } = createStore();
    const app = createApp(store, { allowTestHeader: true, publisherRoles: ["user"] });
    const personal = `${BASE}/import?repository=user/${USER.sub}/personal`;
    expect(
      (
        await app.request(personal, {
          method: "POST",
          headers: headers(USER, "application/octet-stream"),
          body: "bundle",
        })
      ).status,
    ).toBe(201);
    await expectError(
      await app.request(IMPORT, {
        method: "POST",
        headers: headers(USER, "application/octet-stream"),
        body: "bundle",
      }),
      403,
    );
  });

  test.each([
    PLATFORM,
    { ...OWNER, orgIds: [OTHER_ORG] },
  ])("import requires read and write scope before invoking the store", async (principal) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(IMPORT, {
        method: "POST",
        headers: headers(
          { ...principal, orgIds: [...principal.orgIds] },
          "application/octet-stream",
        ),
        body: "bundle",
      }),
      403,
    );
    expect(store.importBundle).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });

  test("organization publishers cannot write the public namespace", async () => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(`${BASE}/import?repository=public/builtin`, {
        method: "POST",
        headers: headers(OWNER, "application/octet-stream"),
        body: "bundle",
      }),
      403,
    );
  });

  test.each([
    "PUT",
    "DELETE",
  ])("%s requires write scope even when the publisher can read", async (method) => {
    const publicRepo = repository("public/builtin");
    const { store } = createStore([publicRepo]);
    const app = createApp(store);
    expect((await app.request(`${BASE}/${publicRepo.id}`, { headers: headers() })).status).toBe(
      200,
    );
    await expectError(
      await app.request(`${BASE}/${publicRepo.id}/active`, {
        method,
        headers: headers(),
        body: JSON.stringify(method === "PUT" ? ACTIVATION : { expectedActiveCommit: COMMIT }),
      }),
      403,
    );
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.deactivate).not.toHaveBeenCalled();
  });

  test.each(["PUT", "DELETE"])("conceals unreadable targets for %s", async (method) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(ACTIVE, {
        method,
        headers: headers(PLATFORM),
        body: JSON.stringify(ACTIVATION),
      }),
      404,
    );
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.deactivate).not.toHaveBeenCalled();
  });

  test.each([
    "not-an-id",
    ORG,
    "a".repeat(63),
    "A".repeat(64),
    "%2e%2e%2fsecret",
  ])("rejects invalid repository id %s before storage access", async (id) => {
    const { store } = createStore();
    const app = createApp(store);
    for (const [suffix, method] of [
      ["", "GET"],
      ["/active", "PUT"],
      ["/active", "DELETE"],
      [`/snapshots/${COMMIT}/archive`, "GET"],
    ]) {
      await expectError(
        await app.request(`${BASE}/${id}${suffix}`, { method, headers: headers() }),
        422,
        "VALIDATION_ERROR",
      );
    }
    expect(store.get).not.toHaveBeenCalled();
  });

  test.each([
    "HEAD",
    "main",
    "a".repeat(39),
    "A".repeat(40),
    "--output=oops",
  ])("exports reject non-immutable commit %s", async (commit) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(`${BASE}/${REPO.id}/snapshots/${commit}/archive`, {
        headers: headers(),
      }),
      422,
    );
    expect(store.archive).not.toHaveBeenCalled();
  });

  test.each([
    "",
    "/tmp/recipes.bundle",
    "file:///tmp/recipes.bundle",
    "https://example.invalid/repo.git",
    "org/../recipes",
    "public//recipes",
    "public/.git",
    "public/a%2fb",
  ])("import rejects invalid namespace %s", async (name) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(`${BASE}/import?repository=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: headers(SUPER, "application/octet-stream"),
        body: "bundle",
      }),
      422,
    );
    expect(store.importBundle).not.toHaveBeenCalled();
  });

  test.each([
    "bundlePath=/tmp/recipes.bundle",
    "url=https://example.invalid/repo.git",
    "repository=public/second",
  ])("import rejects unsupported or ambiguous query input %s", async (query) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(`${IMPORT}&${query}`, {
        method: "POST",
        headers: headers(OWNER, "application/octet-stream"),
        body: "bundle",
      }),
      422,
    );
    expect(store.importBundle).not.toHaveBeenCalled();
  });

  test.each([
    "application/json",
    "text/plain",
    "multipart/form-data",
  ])("import rejects %s rather than interpreting local paths or URLs", async (type) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(IMPORT, {
        method: "POST",
        headers: headers(OWNER, type),
        body: JSON.stringify({ bundlePath: "/tmp/recipes.bundle", url: "https://example.invalid" }),
      }),
      415,
    );
    expect(store.importBundle).not.toHaveBeenCalled();
  });

  test.each(["PUT", "DELETE"])("%s reports malformed JSON as 400", async (method) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(ACTIVE, { method, headers: headers(), body: "{" }),
      400,
      "VALIDATION_ERROR",
    );
  });

  test.each([
    { commit: COMMIT, expectedActiveCommit: null },
    { ...ACTIVATION, acknowledgeExecutableRecipes: false },
    { commit: COMMIT, acknowledgeExecutableRecipes: true },
    { ...ACTIVATION, expectedActiveCommit: "HEAD" },
    { ...ACTIVATION, commit: "HEAD" },
    { ...ACTIVATION, bundlePath: "/tmp/recipes.bundle" },
    null,
  ])("activation requires explicit trust and CAS: %j", async (body) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(ACTIVE, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(body),
      }),
      422,
      "VALIDATION_ERROR",
    );
    expect(store.activate).not.toHaveBeenCalled();
  });

  test.each([
    {},
    { expectedActiveCommit: null },
    { expectedActiveCommit: "HEAD" },
  ])("deactivation requires a valid expected commit: %j", async (body) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(ACTIVE, {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify(body),
      }),
      422,
    );
    expect(store.deactivate).not.toHaveBeenCalled();
  });

  test.each([
    null,
    PREVIOUS,
  ])("activation preserves expected CAS %s and actor", async (expected) => {
    const { store } = createStore();
    const response = await createApp(store).request(ACTIVE, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ ...ACTIVATION, expectedActiveCommit: expected }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...REPO, activeCommit: COMMIT });
    expect(store.activate).toHaveBeenCalledWith(REPO.id, COMMIT, expected, OWNER.sub);
  });

  test("deactivation preserves CAS and returns history without deleting it", async () => {
    const { store } = createStore();
    const response = await createApp(store).request(ACTIVE, {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ expectedActiveCommit: COMMIT }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(REPO);
    expect(store.deactivate).toHaveBeenCalledWith(REPO.id, COMMIT, OWNER.sub);
  });

  test.each(["PUT", "DELETE"])("%s preserves store CAS conflicts as 409", async (method) => {
    const { store } = createStore();
    const fail = async () => {
      throw new RecipeStoreError(409, "Active recipe changed");
    };
    store.activate.mockImplementation(fail);
    store.deactivate.mockImplementation(fail);
    await expectError(
      await createApp(store).request(ACTIVE, {
        method,
        headers: headers(),
        body: JSON.stringify(method === "PUT" ? ACTIVATION : { expectedActiveCommit: COMMIT }),
      }),
      409,
    );
  });
});

describe("recipe bundle upload and archive streaming", () => {
  test("imports the raw stream without buffering or losing bytes", async () => {
    const { store, imports } = createStore();
    const bytes = new Uint8Array([0, 255, 10, 13]);
    const response = await createApp(store).request(IMPORT, {
      method: "POST",
      headers: headers(OWNER, "application/octet-stream"),
      body: byteStream(bytes),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(REPO);
    expect(store.importBundle.mock.calls[0]?.[1]).toBeInstanceOf(ReadableStream);
    expect(imports).toEqual([
      { repository: REPO.repository, bytes: Buffer.from(bytes), actor: OWNER.sub },
    ]);
  });

  test("rejects excessive Content-Length before passing the body to the store", async () => {
    const { store } = createStore();
    const response = await createApp(store).request(IMPORT, {
      method: "POST",
      headers: { ...headers(OWNER, "application/octet-stream"), "Content-Length": "17" },
      body: byteStream(new Uint8Array([1])),
    });
    await expectError(response, 413);
    expect(store.importBundle).not.toHaveBeenCalled();
  });

  test.each([
    "-1",
    "garbage",
    "1.5",
    "1e3",
    "1,2",
  ])("rejects invalid Content-Length %s", async (length) => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(IMPORT, {
        method: "POST",
        headers: { ...headers(OWNER, "application/octet-stream"), "Content-Length": length },
        body: "bundle",
      }),
      400,
    );
    expect(store.importBundle).not.toHaveBeenCalled();
  });

  test.each([
    undefined,
    "1",
    "0",
  ])("enforces actual streaming size despite Content-Length %s", async (length) => {
    const { store } = createStore();
    const requestHeaders = new Headers(headers(OWNER, "application/octet-stream"));
    if (length !== undefined) requestHeaders.set("Content-Length", length);
    await expectError(
      await createApp(store).request(IMPORT, {
        method: "POST",
        headers: requestHeaders,
        body: byteStream(new Uint8Array(8), new Uint8Array(9)),
      }),
      413,
    );
    expect(store.importBundle).toHaveBeenCalledTimes(1);
    expect(store.importBundle.mock.calls[0]?.[1]).toBeInstanceOf(ReadableStream);
  });

  test("accepts the exact upload limit", async () => {
    const { store, imports } = createStore();
    const response = await createApp(store).request(IMPORT, {
      method: "POST",
      headers: { ...headers(OWNER, "application/octet-stream"), "Content-Length": "16" },
      body: byteStream(new Uint8Array(16)),
    });
    expect(response.status).toBe(201);
    expect(imports[0]?.bytes.byteLength).toBe(16);
  });

  test("rejects a missing bundle body", async () => {
    const { store } = createStore();
    await expectError(
      await createApp(store).request(IMPORT, {
        method: "POST",
        headers: headers(OWNER, "application/octet-stream"),
      }),
      400,
    );
  });

  test.each([
    400, 413, 422, 429, 503,
  ] as const)("preserves store upload error %s", async (status) => {
    const { store } = createStore();
    store.importBundle.mockImplementation(async () => {
      throw new RecipeStoreError(status, "Recipe upload rejected");
    });
    await expectError(
      await createApp(store).request(IMPORT, {
        method: "POST",
        headers: headers(OWNER, "application/octet-stream"),
        body: "bundle",
      }),
      status,
    );
  });

  test("exports immutable tar bytes with safe download headers", async () => {
    const { store } = createStore();
    const response = await createApp(store).request(`${ARCHIVE}?format=zip&path=/etc/passwd`, {
      headers: headers(USER),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-tar");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${REPO.id}-${COMMIT}.tar"`,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 254, 255]));
    expect(store.archive).toHaveBeenCalledWith(REPO.id, COMMIT);
  });

  test("returns the export stream directly and propagates cancellation", async () => {
    const { store } = createStore();
    const cancel = mock(() => {});
    const stream = new ReadableStream<Uint8Array>({ cancel });
    store.archive.mockImplementation(async () => ({ stream, size: 4 }));
    const response = await createApp(store).request(ARCHIVE, { headers: headers() });
    expect(response.status).toBe(200);
    expect(response.body).toBe(stream);
    await response.body?.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
