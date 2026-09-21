import { afterEach, describe, expect, mock, test } from "bun:test";
import { SpackMaterialLifecycleError, type SpackMaterialLifecycleStatus } from "@kuintessence/db";
import {
  type SpackMaterialBinding,
  SpackMaterialCatalogSchema,
  SpackMaterialLifecycleViewSchema,
  type SpackMaterialManifest,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import type { RbacPrincipal } from "../services/namespace";
import { materialDigest } from "../services/spack-material-storage";
import {
  type SpackMaterialLifecyclePort,
  SpackMaterialStore,
} from "../services/spack-material-store";
import {
  BASE,
  cleanupMaterials,
  materialApp,
  materialFixture,
  SOURCE_BLOB,
} from "./spack-materials.test-helpers";
import {
  COMMIT,
  headers,
  JWT_OPTIONS,
  ORG,
  OTHER_ORG,
  OWNER as RECIPE_OWNER,
  PLATFORM as RECIPE_PLATFORM,
  SUPER as RECIPE_SUPER,
  USER as RECIPE_USER,
  repository,
  token,
} from "./spack-repositories.test-helpers";

afterEach(cleanupMaterials);

const OWNER: RbacPrincipal = { ...RECIPE_OWNER, sub: "44444444-4444-4444-8444-444444444444" };
const PLATFORM: RbacPrincipal = { ...RECIPE_PLATFORM, sub: "55555555-5555-4555-8555-555555555555" };
const SUPER: RbacPrincipal = { ...RECIPE_SUPER, sub: "66666666-6666-4666-8666-666666666666" };
const USER: RbacPrincipal = { ...RECIPE_USER, sub: "77777777-7777-4777-8777-777777777777" };
const INITIAL: SpackMaterialLifecycleStatus = {
  revision: 0,
  state: "available",
  history: [],
  historyTruncated: false,
};
const WITHDRAW = { action: "withdraw", expectedRevision: 0, reason: "Source needs review" };
const RESTORE = { action: "restore", expectedRevision: 1, reason: "Source review completed" };
const METHODS: ("GET" | "POST")[] = ["GET", "POST"];

function releasePath(binding: SpackMaterialBinding): string {
  return `${BASE}/${binding.repositoryId}/releases/${binding.manifestDigest}`;
}

function lifecycleFake() {
  const control: { canonical: RbacPrincipal; referenced: boolean } = {
    canonical: OWNER,
    referenced: false,
  };
  const states = new Map<string, SpackMaterialLifecycleStatus>();
  const key = (binding: SpackMaterialBinding) =>
    `${binding.repositoryId}/${binding.manifestDigest}`;
  const current = (binding: SpackMaterialBinding) => states.get(key(binding)) ?? INITIAL;
  // Model the trusted callback boundary only; real PG locking is tested by the DB suite.
  const authorizeCanonical = async (
    subject: string,
    authorize: Parameters<SpackMaterialLifecyclePort["inspect"]>[2],
  ) => {
    if (subject !== control.canonical.sub) {
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
    }
    try {
      await authorize({ ...control.canonical, orgIds: [...control.canonical.orgIds] });
    } catch (error) {
      if (error instanceof SpackMaterialLifecycleError) throw error;
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
    }
  };
  const port = {
    assertAvailable: mock(async (binding: SpackMaterialBinding) => {
      if (current(binding).state === "withdrawn") {
        throw new SpackMaterialLifecycleError("MATERIAL_RELEASE_WITHDRAWN");
      }
    }),
    inspect: mock(
      async (
        ...[binding, subject, authorize]: Parameters<SpackMaterialLifecyclePort["inspect"]>
      ) => {
        await authorizeCanonical(subject, authorize);
        return current(binding);
      },
    ),
    transition: mock(
      async (
        ...[binding, subject, change, authorize]: Parameters<
          SpackMaterialLifecyclePort["transition"]
        >
      ) => {
        await authorizeCanonical(subject, authorize);
        const previous = current(binding);
        const state = change.action === "withdraw" ? "withdrawn" : "available";
        if (previous.revision !== change.expectedRevision || previous.state === state) {
          throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_CONFLICT");
        }
        if (change.action === "withdraw" && control.referenced) {
          throw new SpackMaterialLifecycleError("MATERIAL_RELEASE_REFERENCED");
        }
        const revision = previous.revision + 1;
        const next: SpackMaterialLifecycleStatus = {
          revision,
          state,
          history: [
            {
              revision,
              state,
              operatorId: subject,
              reason: change.reason,
              epoch: "11111111-1111-4111-8111-111111111111",
              rolloutRevision: 2,
              createdAt: "2026-09-21T00:00:00.000Z",
            },
            ...previous.history,
          ],
          historyTruncated: false,
        };
        states.set(key(binding), next);
        return next;
      },
    ),
  } satisfies SpackMaterialLifecyclePort;
  return { control, port };
}

async function fixture(name = `org/${ORG}/recipes`) {
  const f = await materialFixture({}, repository(name));
  await f.seed();
  const binding = await f.store.publish(f.input, SUPER);
  const fake = lifecycleFake();
  const store = new SpackMaterialStore(f.root, f.recipes, {}, undefined, fake.port);
  const app = materialApp(store);
  const path = `${releasePath(binding)}/lifecycle`;
  const request = (method: "GET" | "POST", actor = OWNER, body: unknown = WITHDRAW) =>
    app.request(path, {
      method,
      headers: headers(actor),
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  const identity = { binding, repository: f.input.repository };
  return { ...f, ...fake, store, app, binding, identity, path, request };
}

async function expectError(
  response: Response,
  status: number,
  code: string,
  identity?: { binding: SpackMaterialBinding; repository: string },
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  const body = await response.json();
  expect(body).toEqual({
    error: { code, message: expect.any(String) },
  });
  expect(body).not.toHaveProperty("errors");
  if (identity) {
    const serialized = JSON.stringify(body);
    for (const value of [
      identity.repository,
      identity.binding.repositoryId,
      identity.binding.manifestDigest,
    ]) {
      expect(serialized).not.toContain(value);
    }
  }
}

describe("material lifecycle authentication and authorization", () => {
  test.each(
    METHODS,
  )("%s requires authentication and an explicit lifecycle backend", async (method) => {
    const f = await materialFixture();
    const path = `${releasePath({
      repositoryId: SpackMaterialStore.repositoryId(f.input.repository),
      manifestDigest: SOURCE_BLOB.digest,
    })}/lifecycle`;
    const request = {
      method,
      ...(method === "POST" ? { body: JSON.stringify(WITHDRAW) } : {}),
    };
    await expectError(await f.app.request(path, request), 401, "UNAUTHORIZED");
    const unavailable = await f.app.request(path, { ...request, headers: headers(OWNER) });
    await expectError(unavailable, 503, "MATERIAL_LIFECYCLE_UNAVAILABLE");
    expect(unavailable.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await f.app.request("/api/health")).status).toBe(200);
  });

  test.each([
    { name: "org member reader", actor: USER, status: 403 },
    { name: "platform admin without org read", actor: PLATFORM, status: 403 },
    {
      name: "foreign org admin",
      actor: { ...OWNER, orgIds: [OTHER_ORG] },
      status: 403,
    },
    { name: "member org admin", actor: OWNER, status: 200 },
    {
      name: "member platform admin",
      actor: { ...PLATFORM, orgIds: [ORG] },
      status: 200,
    },
    { name: "super admin", actor: SUPER, status: 200 },
  ])("requires namespace read and write for $name", async ({ actor, status }) => {
    const f = await fixture();
    const current = { ...actor, orgIds: [...actor.orgIds] };
    f.control.canonical = current;
    for (const method of METHODS) {
      const response = await f.request(method, current);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      if (status === 403) {
        await expectError(response, 403, "MATERIAL_LIFECYCLE_FORBIDDEN", f.identity);
      } else {
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual(SpackMaterialLifecycleViewSchema.parse(body));
        expect(body).toMatchObject({
          revision: method === "GET" ? 0 : 1,
          state: method === "GET" ? "available" : "withdrawn",
          ...f.identity,
        });
      }
    }
  });

  test.each([
    { name: "public/materials", actor: OWNER, status: 403 },
    { name: "public/materials", actor: PLATFORM, status: 200 },
    { name: `user/${OWNER.sub}/materials`, actor: OWNER, status: 200 },
    { name: "user/someone-else/materials", actor: OWNER, status: 403 },
  ])("enforces $name ownership for $actor.role", async ({ name, actor, status }) => {
    const f = await fixture(name);
    f.control.canonical = actor;
    for (const method of METHODS) {
      expect((await f.request(method, actor)).status).toBe(status);
    }
  });

  test("publisher configuration preserves namespace write checks and ordinary reads", async () => {
    const f = await fixture();
    for (const [actor, publisherRoles] of [
      [SUPER, []],
      [USER, ["user"]],
    ] as const) {
      f.control.canonical = actor;
      const app = materialApp(f.store, {
        allowTestHeader: true,
        publisherRoles: [...publisherRoles],
      });
      const manifest = await app.request(releasePath(f.binding), { headers: headers(actor) });
      expect(manifest.status).toBe(200);
      for (const method of METHODS) {
        await expectError(
          await app.request(f.path, {
            method,
            headers: headers(actor),
            ...(method === "POST" ? { body: JSON.stringify(WITHDRAW) } : {}),
          }),
          403,
          "MATERIAL_LIFECYCLE_FORBIDDEN",
        );
      }
    }
  });

  test.each([
    {
      name: "revoked role",
      canonical: { ...OWNER, role: USER.role },
      stale: OWNER,
      status: 403,
    },
    {
      name: "revoked membership",
      canonical: { ...OWNER, orgIds: [] },
      stale: OWNER,
      status: 403,
    },
    {
      name: "new role and membership",
      canonical: OWNER,
      stale: { ...OWNER, role: USER.role, orgIds: [] },
      status: 200,
    },
  ])("uses the port's current principal after $name", async ({ canonical, stale, status }) => {
    const f = await fixture();
    f.control.canonical = { ...canonical, orgIds: [...canonical.orgIds] };
    const app = materialApp(f.store, {
      ...JWT_OPTIONS,
      resolveCanonicalPrincipal: async () => ({
        ...stale,
        orgIds: [...stale.orgIds],
        suspended: false,
      }),
    });
    for (const method of METHODS) {
      const response = await app.request(f.path, {
        method,
        headers: {
          Authorization: `Bearer ${token({ ...OWNER, role: SUPER.role })}`,
          "Content-Type": "application/json",
        },
        ...(method === "POST" ? { body: JSON.stringify(WITHDRAW) } : {}),
      });
      if (status === 403) {
        await expectError(response, 403, "MATERIAL_LIFECYCLE_FORBIDDEN", f.identity);
      } else {
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual(SpackMaterialLifecycleViewSchema.parse(body));
        expect(body).toMatchObject({
          revision: method === "GET" ? 0 : 1,
          state: method === "GET" ? "available" : "withdrawn",
          ...f.identity,
        });
      }
    }
    expect(f.port.inspect).toHaveBeenCalledWith(f.binding, OWNER.sub, expect.any(Function));
    expect(f.port.transition).toHaveBeenCalledWith(
      f.binding,
      OWNER.sub,
      WITHDRAW,
      expect.any(Function),
    );
  });

  test.each([
    "namespace",
    "visibility",
    "snapshot",
    "roots",
    "diagnostics",
  ])("rechecks referenced recipe %s even when inspecting a withdrawn release", async (change) => {
    const f = await fixture();
    expect((await f.request("POST")).status).toBe(200);
    if (change === "namespace" || change === "visibility") {
      f.recipe.repository = `org/${OTHER_ORG}/recipes`;
      if (change === "visibility") {
        f.control.canonical = { ...OWNER, orgIds: [ORG, OTHER_ORG] };
      }
    } else if (change === "snapshot") {
      f.recipe.snapshots = [];
    } else {
      const snapshot = f.recipe.snapshots[0];
      if (!snapshot) throw new Error("Missing fixture snapshot");
      if (change === "roots") {
        snapshot.roots = [];
      } else {
        snapshot.diagnostics = [{ severity: "error", code: "INVALID", message: "Invalid recipe" }];
      }
    }
    f.port.inspect.mockClear();
    f.port.transition.mockClear();
    await expectError(await f.request("GET"), 403, "MATERIAL_LIFECYCLE_FORBIDDEN", f.identity);
    await expectError(
      await f.request("POST", OWNER, RESTORE),
      403,
      "MATERIAL_LIFECYCLE_FORBIDDEN",
      f.identity,
    );
    if (change === "snapshot") {
      expect(f.port.inspect).not.toHaveBeenCalled();
      expect(f.port.transition).not.toHaveBeenCalled();
    }
  });

  test("revoked canonical membership cannot inspect withdrawn history or restore", async () => {
    const f = await fixture();
    expect((await f.request("POST")).status).toBe(200);
    const withdrawn = await (await f.request("GET")).json();
    f.control.canonical = { ...OWNER, orgIds: [] };
    await expectError(await f.request("GET"), 403, "MATERIAL_LIFECYCLE_FORBIDDEN", f.identity);
    await expectError(
      await f.request("POST", OWNER, RESTORE),
      403,
      "MATERIAL_LIFECYCLE_FORBIDDEN",
      f.identity,
    );
    f.control.canonical = OWNER;
    expect(await (await f.request("GET")).json()).toEqual(withdrawn);
  });
});

describe("material lifecycle metadata admission", () => {
  test.each(METHODS)("%s preloads deduplicated snapshots without full history", async (method) => {
    const f = await fixture();
    const binding = await f.store.publish(
      { ...f.input, recipes: [...f.input.recipes, ...f.input.recipes] },
      OWNER,
    );
    const snapshot = f.recipe.snapshots[0];
    if (!snapshot) throw new Error("Missing fixture snapshot");
    f.recipes.get.mockClear();
    f.recipes.getSnapshot.mockClear();
    f.recipes.archive.mockClear();
    f.recipes.get.mockImplementation(async () => {
      throw new Error("Lifecycle management must not read full recipe history");
    });
    f.recipes.getSnapshot.mockImplementation(async (id, commit, checkpoint) => {
      expect(f.port.inspect).not.toHaveBeenCalled();
      expect(f.port.transition).not.toHaveBeenCalled();
      expect(id).toBe(f.recipe.id);
      expect(commit).toBe(COMMIT);
      expect(checkpoint).toEqual(expect.any(Function));
      checkpoint?.();
      return { id, repository: f.recipe.repository, snapshot };
    });
    const response = await f.app.request(`${releasePath(binding)}/lifecycle`, {
      method,
      headers: headers(OWNER),
      ...(method === "POST" ? { body: JSON.stringify(WITHDRAW) } : {}),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: method === "GET" ? 0 : 1,
      state: method === "GET" ? "available" : "withdrawn",
      binding,
      repository: f.input.repository,
    });
    expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(1);
    expect(f.recipes.getSnapshot).toHaveBeenCalledWith(f.recipe.id, COMMIT, expect.any(Function));
    expect(f.recipes.get).not.toHaveBeenCalled();
    expect(f.recipes.archive).not.toHaveBeenCalled();
    expect(f.port.inspect).toHaveBeenCalledTimes(method === "GET" ? 1 : 0);
    expect(f.port.transition).toHaveBeenCalledTimes(method === "POST" ? 1 : 0);
  });

  test.each(METHODS)("%s rejects storage failures before entering the backend", async (method) => {
    const f = await fixture();
    f.recipes.getSnapshot.mockImplementation(async () => {
      throw new Error("Private snapshot storage failure");
    });
    const response = await f.request(method);
    expect(await response.clone().text()).not.toContain("Private snapshot storage failure");
    await expectError(response, 503, "MATERIAL_LIFECYCLE_UNAVAILABLE", f.identity);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(1);
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test.each(METHODS)("%s cancellation before callback preserves the journal", async (method) => {
    const f = await fixture();
    const controller = new AbortController();
    const inspect = f.port.inspect;
    const transition = f.port.transition;
    f.port.inspect = mock(async (...args: Parameters<SpackMaterialLifecyclePort["inspect"]>) => {
      controller.abort();
      return inspect(...args);
    });
    f.port.transition = mock(
      async (...args: Parameters<SpackMaterialLifecyclePort["transition"]>) => {
        controller.abort();
        return transition(...args);
      },
    );
    const response = await f.app.request(f.path, {
      method,
      headers: headers(OWNER),
      signal: controller.signal,
      ...(method === "POST" ? { body: JSON.stringify(WITHDRAW) } : {}),
    });
    await expectError(response, 503, "MATERIAL_LIFECYCLE_UNAVAILABLE", f.identity);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(1);
    expect(f.port.inspect).toHaveBeenCalledTimes(method === "GET" ? 1 : 0);
    expect(f.port.transition).toHaveBeenCalledTimes(method === "POST" ? 1 : 0);
    f.port.inspect = inspect;
    f.port.transition = transition;
    const journal = await f.request("GET");
    expect(journal.status).toBe(200);
    expect(await journal.json()).toEqual({ ...INITIAL, ...f.identity });
  });

  test.each(METHODS)("%s never enters the backend after request cancellation", async (method) => {
    for (const phase of ["before metadata", "during snapshot"]) {
      const f = await fixture();
      const controller = new AbortController();
      const snapshot = f.recipe.snapshots[0];
      if (!snapshot) throw new Error("Missing fixture snapshot");
      f.recipes.getSnapshot.mockImplementation(async (id) => {
        controller.abort();
        return { id, repository: f.recipe.repository, snapshot };
      });
      if (phase === "before metadata") controller.abort();
      const response = await f.app.request(f.path, {
        method,
        headers: headers(OWNER),
        signal: controller.signal,
        ...(method === "POST" ? { body: JSON.stringify(WITHDRAW) } : {}),
      });
      await expectError(response, 503, "MATERIAL_LIFECYCLE_UNAVAILABLE", f.identity);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(phase === "before metadata" ? 0 : 1);
      expect(f.port.inspect).not.toHaveBeenCalled();
      expect(f.port.transition).not.toHaveBeenCalled();
    }
  });
});

describe("material lifecycle state and delivery", () => {
  test.each(METHODS)("%s returns manifest identity, not recipe identity", async (method) => {
    const f = await fixture("public/recipes");
    const materialRepository = `org/${ORG}/materials`;
    await f.seed(materialRepository);
    const binding = await f.store.publish({ ...f.input, repository: materialRepository }, SUPER);
    expect(materialRepository).not.toBe(f.recipe.repository);
    const response = await f.app.request(`${releasePath(binding)}/lifecycle`, {
      method,
      headers: headers(OWNER),
      ...(method === "POST" ? { body: JSON.stringify(WITHDRAW) } : {}),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toEqual(SpackMaterialLifecycleViewSchema.parse(body));
    expect(body).toMatchObject({
      revision: method === "GET" ? 0 : 1,
      state: method === "GET" ? "available" : "withdrawn",
      binding,
      repository: materialRepository,
    });
  });

  test("withdrawal hides only its release; restore preserves every delivered byte", async () => {
    const f = await fixture();
    const sibling = await f.store.publish(
      {
        ...f.input,
        sources: [...f.input.sources, { path: "hello/alternate-1.0.tar.gz", blob: SOURCE_BLOB }],
      },
      OWNER,
    );
    expect(sibling.manifestDigest).not.toBe(f.binding.manifestDigest);
    const before = await f.app.request(releasePath(f.binding), { headers: headers(USER) });
    expect(before.status).toBe(200);
    const manifestBytes = new Uint8Array(await before.arrayBuffer());
    expect(materialDigest(manifestBytes)).toBe(f.binding.manifestDigest);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SpackMaterialManifest;
    const downloads = [{ path: releasePath(f.binding), bytes: manifestBytes }];
    for (const blob of spackMaterialBlobs(manifest)) {
      const path = `${releasePath(f.binding)}/blobs/${blob.digest}`;
      const response = await f.app.request(path, { headers: headers(USER) });
      expect(response.status).toBe(200);
      downloads.push({ path, bytes: new Uint8Array(await response.arrayBuffer()) });
    }
    expect(await (await f.request("GET")).json()).toEqual({ ...INITIAL, ...f.identity });
    const withdrawn = await f.request("POST");
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.headers.get("Cache-Control")).toBe("private, no-store");
    const status = await withdrawn.json();
    expect(status).toEqual(SpackMaterialLifecycleViewSchema.parse(status));
    expect(status).toEqual({
      revision: 1,
      state: "withdrawn",
      history: [
        {
          revision: 1,
          state: "withdrawn",
          operatorId: OWNER.sub,
          reason: WITHDRAW.reason,
          epoch: "11111111-1111-4111-8111-111111111111",
          rolloutRevision: 2,
          createdAt: "2026-09-21T00:00:00.000Z",
        },
      ],
      historyTruncated: false,
      ...f.identity,
    });
    const inspect = await f.request("GET");
    expect(inspect.status).toBe(200);
    const inspected = await inspect.json();
    expect(inspected).toEqual(SpackMaterialLifecycleViewSchema.parse(inspected));
    expect(inspected).toEqual(status);
    for (const download of downloads) {
      await expectError(
        await f.app.request(download.path, { headers: headers(USER) }),
        404,
        "NOT_FOUND",
      );
    }
    for (const suffix of ["", `?repository=${encodeURIComponent(f.input.repository)}`]) {
      const catalog = await f.app.request(`${BASE}${suffix}`, { headers: headers(USER) });
      expect(catalog.status).toBe(200);
      expect(catalog.headers.get("Cache-Control")).toBe("private, no-store");
      const releases = SpackMaterialCatalogSchema.parse(await catalog.json()).releases;
      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject(sibling);
    }
    const siblingStatus = await f.app.request(`${releasePath(sibling)}/lifecycle`, {
      headers: headers(OWNER),
    });
    expect(siblingStatus.status).toBe(200);
    const siblingBody = await siblingStatus.json();
    expect(siblingBody).toEqual(SpackMaterialLifecycleViewSchema.parse(siblingBody));
    expect(siblingBody).toEqual({
      ...INITIAL,
      binding: sibling,
      repository: f.input.repository,
    });
    const siblingDownload = await f.app.request(
      `${releasePath(sibling)}/blobs/${SOURCE_BLOB.digest}`,
      { headers: headers(USER) },
    );
    expect(siblingDownload.status).toBe(200);
    expect(materialDigest(new Uint8Array(await siblingDownload.arrayBuffer()))).toBe(
      SOURCE_BLOB.digest,
    );
    const republished = await f.app.request(`${BASE}/releases`, {
      method: "POST",
      headers: headers(OWNER),
      body: JSON.stringify(f.input),
    });
    await expectError(republished, 404, "NOT_FOUND");
    expect(await (await f.request("GET")).json()).toEqual(status);
    const restored = await f.request("POST", OWNER, RESTORE);
    expect(restored.status).toBe(200);
    expect(restored.headers.get("Cache-Control")).toBe("private, no-store");
    const restoredStatus = await restored.json();
    expect(restoredStatus).toEqual(SpackMaterialLifecycleViewSchema.parse(restoredStatus));
    expect(restoredStatus).toMatchObject({
      revision: 2,
      state: "available",
      history: [
        { revision: 2, state: "available", reason: RESTORE.reason },
        { revision: 1, state: "withdrawn", reason: WITHDRAW.reason },
      ],
      ...f.identity,
    });
    for (const download of downloads) {
      const response = await f.app.request(download.path, { headers: headers(USER) });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(download.bytes);
    }
    const catalog = await f.app.request(BASE, { headers: headers(USER) });
    expect(catalog.status).toBe(200);
    expect(SpackMaterialCatalogSchema.parse(await catalog.json()).releases).toHaveLength(2);
  });

  test("reference and CAS conflicts preserve lifecycle history", async () => {
    const f = await fixture();
    f.control.referenced = true;
    const referenced = await f.request("POST");
    await expectError(referenced, 409, "MATERIAL_RELEASE_REFERENCED", f.identity);
    expect(referenced.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await (await f.request("GET")).json()).toEqual({ ...INITIAL, ...f.identity });
    f.control.referenced = false;
    await expectError(
      await f.request("POST", OWNER, { ...RESTORE, expectedRevision: 0 }),
      409,
      "MATERIAL_LIFECYCLE_CONFLICT",
      f.identity,
    );
    expect((await f.request("POST")).status).toBe(200);
    const status = await (await f.request("GET")).json();
    for (const change of [
      WITHDRAW,
      { ...WITHDRAW, expectedRevision: 1 },
      { ...RESTORE, expectedRevision: 0 },
    ]) {
      const conflict = await f.request("POST", OWNER, change);
      await expectError(conflict, 409, "MATERIAL_LIFECYCLE_CONFLICT", f.identity);
      expect(conflict.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await (await f.request("GET")).json()).toEqual(status);
    }
    expect((await f.request("POST", OWNER, RESTORE)).status).toBe(200);
  });
});

describe("material lifecycle request validation", () => {
  test.each([
    { action: "delete" },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: 2_147_483_647 },
    { expectedRevision: "0" },
    { reason: "" },
    { reason: " " },
    { reason: " leading" },
    { reason: "trailing " },
    { reason: "x".repeat(1001) },
    { reason: "review\nrequired" },
    { reason: "review\trequired" },
    { reason: "review\u0000required" },
    { reason: "review\u007frequired" },
    { role: "super_admin" },
    { orgId: OTHER_ORG },
    { orgIds: [OTHER_ORG] },
    { operatorId: "someone-else" },
    { url: "https://example.test/material" },
  ])("rejects invalid or expanded JSON before calling the backend: %j", async (patch) => {
    const f = await fixture();
    const response = await f.request("POST", OWNER, { ...WITHDRAW, ...patch });
    await expectError(response, 422, "VALIDATION_ERROR");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test.each(METHODS)("%s rejects query authority, URLs and invalid locators", async (method) => {
    const f = await fixture();
    for (const path of [
      `${f.path}?role=super_admin`,
      `${f.path}?orgIds=${OTHER_ORG}`,
      `${f.path}?url=https://example.test/material`,
      `${BASE}/invalid/releases/${f.binding.manifestDigest}/lifecycle`,
      `${BASE}/${f.binding.repositoryId}/releases/latest/lifecycle`,
    ]) {
      const response = await f.app.request(path, {
        method,
        headers: headers(OWNER),
        ...(method === "POST" ? { body: JSON.stringify(WITHDRAW) } : {}),
      });
      await expectError(response, 422, "VALIDATION_ERROR");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });
});
