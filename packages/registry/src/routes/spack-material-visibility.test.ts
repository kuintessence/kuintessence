import { afterEach, describe, expect, test } from "bun:test";
import { SpackMaterialVisibilityError } from "@kuintessence/db";
import {
  SpackMaterialCatalogSchema,
  SpackMaterialManagementCatalogSchema,
  SpackMaterialVisibilityViewSchema,
} from "@kuintessence/shared";
import type { RbacPrincipal } from "../services/namespace";
import {
  HIDE,
  OWNER,
  READER,
  visibilityFixture,
} from "../services/spack-material-visibility.test-helpers";
import {
  BASE,
  cleanupMaterials,
  materialApp,
  materialFixture,
  SOURCE_BLOB,
} from "./spack-materials.test-helpers";
import { headers, ORG, OTHER_ORG } from "./spack-repositories.test-helpers";

afterEach(cleanupMaterials);
const METHODS: ("GET" | "POST")[] = ["GET", "POST"];

type NamespaceCase = {
  actor: RbacPrincipal;
  repository: string;
  status: 200 | 403;
};

describe("visibility management authorization", () => {
  test.each(METHODS)("%s requires authentication and an explicit backend", async (method) => {
    const f = await materialFixture();
    const path = `${BASE}/${"a".repeat(64)}/releases/${SOURCE_BLOB.digest}/visibility`;
    const request = {
      method,
      ...(method === "POST" ? { body: JSON.stringify(HIDE) } : {}),
    };
    expect((await f.app.request(path, request)).status).toBe(401);
    const response = await f.app.request(path, { ...request, headers: headers(OWNER) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "MATERIAL_VISIBILITY_UNAVAILABLE" },
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  const cases: NamespaceCase[] = [
    { actor: READER, repository: "public/materials", status: 403 },
    { actor: OWNER, repository: "public/materials", status: 200 },
    {
      actor: { ...OWNER, orgIds: [] },
      repository: `org/${ORG}/materials`,
      status: 403,
    },
    {
      actor: { ...OWNER, role: "org_admin" },
      repository: `org/${ORG}/materials`,
      status: 200,
    },
    {
      actor: { ...OWNER, orgIds: [OTHER_ORG] },
      repository: `org/${ORG}/materials`,
      status: 403,
    },
    { actor: OWNER, repository: `user/${OWNER.sub}/materials`, status: 200 },
    { actor: OWNER, repository: `user/${READER.sub}/materials`, status: 403 },
  ];
  test.each(cases)("requires canonical namespace read and write: $repository / $status", async ({
    actor,
    repository,
    status,
  }) => {
    const f = await visibilityFixture(repository);
    f.control.canonical = actor;
    for (const method of METHODS) {
      const response = await f.app.request(`${f.path}/visibility`, {
        method,
        headers: headers({ ...actor, role: "super_admin", orgIds: [ORG, OTHER_ORG] }),
        ...(method === "POST" ? { body: JSON.stringify(HIDE) } : {}),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const body = await response.json();
      if (status === 200) {
        expect(body).toEqual(SpackMaterialVisibilityViewSchema.parse(body));
        expect(body).toMatchObject({ binding: f.binding, repository });
      } else {
        expect(body).toMatchObject({ error: { code: "MATERIAL_VISIBILITY_FORBIDDEN" } });
        expect(JSON.stringify(body)).not.toContain(repository);
      }
    }
  });

  test("publisher configuration still restricts management", async () => {
    const f = await visibilityFixture();
    const app = materialApp(f.store, { allowTestHeader: true, publisherRoles: [] });
    const management = await app.request(`${f.path}/visibility`, { headers: headers(OWNER) });
    expect(management.status).toBe(403);
    expect((await app.request(f.path, { headers: headers(OWNER) })).status).toBe(200);
  });

  test("management bypasses allowlist and withdrawal but never recipe restrictions", async () => {
    const f = await visibilityFixture();
    const update = await f.app.request(`${f.path}/visibility`, {
      method: "POST",
      headers: headers(OWNER),
      body: JSON.stringify(HIDE),
    });
    expect(update.status).toBe(200);
    f.withdrawn.add(f.key(f.binding));
    const inspect = await f.app.request(`${f.path}/visibility`, { headers: headers(OWNER) });
    expect(inspect.status).toBe(200);
    expect(await inspect.json()).toMatchObject({ revision: 1, policy: HIDE.policy });
    const catalog = await f.app.request(`${BASE}/management?repository=public/materials`, {
      headers: headers(OWNER),
    });
    expect(catalog.status).toBe(200);
    expect(SpackMaterialManagementCatalogSchema.parse(await catalog.json()).releases).toHaveLength(
      1,
    );
    expect(f.port.assertReadable).not.toHaveBeenCalled();
    f.recipe.repository = `org/${OTHER_ORG}/recipes`;
    const forbidden = await f.app.request(`${f.path}/visibility`, { headers: headers(OWNER) });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).not.toContain(OTHER_ORG);
  });

  test("old rollout and backend corruption are 503 with no private diagnostics", async () => {
    const f = await visibilityFixture();
    for (const failure of [
      new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE"),
      new Error("private SQL, policy row or database address"),
    ]) {
      f.control.failure = failure;
      for (const method of METHODS) {
        const response = await f.app.request(`${f.path}/visibility`, {
          method,
          headers: headers(OWNER),
          ...(method === "POST" ? { body: JSON.stringify(HIDE) } : {}),
        });
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("private");
      }
    }
  });
});

describe("ordinary visibility admission", () => {
  test("empty allowlist hides catalog, manifest and blob even from its maintainer", async () => {
    const f = await visibilityFixture();
    const update = await f.app.request(`${f.path}/visibility`, {
      method: "POST",
      headers: headers(OWNER),
      body: JSON.stringify(HIDE),
    });
    expect(update.status).toBe(200);
    for (const path of [f.path, `${f.path}/blobs/${SOURCE_BLOB.digest}`]) {
      const response = await f.app.request(path, { headers: headers(OWNER) });
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Material release not found" },
      });
    }
    const catalog = await f.app.request(BASE, { headers: headers(OWNER) });
    expect(catalog.status).toBe(200);
    expect(SpackMaterialCatalogSchema.parse(await catalog.json()).releases).toEqual([]);
    const managed = await f.app.request(`${BASE}/management?repository=public/materials`, {
      headers: headers(OWNER),
    });
    expect(SpackMaterialManagementCatalogSchema.parse(await managed.json()).releases).toHaveLength(
      1,
    );
  });

  test.each([
    "user",
    "org",
  ] as const)("allowlist %s admission intersects canonical namespace rights", async (mode) => {
    const f = await visibilityFixture(`org/${ORG}/materials`);
    const policy = {
      mode: "allowlist" as const,
      userIds: mode === "user" ? [READER.sub] : [],
      orgIds: mode === "org" ? [ORG] : [],
    };
    const update = await f.app.request(`${f.path}/visibility`, {
      method: "POST",
      headers: headers(OWNER),
      body: JSON.stringify({ ...HIDE, policy }),
    });
    expect(update.status).toBe(200);
    f.control.canonical = READER;
    expect((await f.app.request(f.path, { headers: headers(READER) })).status).toBe(200);
    f.control.canonical = { ...READER, orgIds: [] };
    const denied = await f.app.request(f.path, {
      headers: headers({ ...READER, role: "super_admin", orgIds: [ORG] }),
    });
    expect(denied.status).toBe(404);
  });

  test("inherit rechecks suspension and membership after middleware admission", async () => {
    const f = await visibilityFixture(`org/${ORG}/materials`);
    f.control.canonical = READER;
    expect((await f.app.request(f.path, { headers: headers(READER) })).status).toBe(200);
    for (const mode of ["membership", "suspended"]) {
      f.control.canonical = mode === "membership" ? { ...READER, orgIds: [] } : READER;
      f.control.suspended = mode === "suspended";
      const response = await f.app.request(f.path, { headers: headers(READER) });
      expect(response.status).toBe(404);
    }
    expect(f.port.assertReadable).toHaveBeenCalledTimes(3);
  });

  test("storage and policy failures never become an empty successful catalog", async () => {
    const f = await visibilityFixture();
    f.control.failure = new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
    for (const path of [BASE, f.path, `${f.path}/blobs/${SOURCE_BLOB.digest}`]) {
      const response = await f.app.request(path, { headers: headers(OWNER) });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "MATERIAL_VISIBILITY_UNAVAILABLE" },
      });
    }
  });

  test("reimport succeeds without resetting policy or granting ordinary reads", async () => {
    const f = await visibilityFixture();
    const update = await f.app.request(`${f.path}/visibility`, {
      method: "POST",
      headers: headers(OWNER),
      body: JSON.stringify(HIDE),
    });
    expect(update.status).toBe(200);
    const before = structuredClone(f.current(f.binding));
    const response = await f.app.request(`${BASE}/releases`, {
      method: "POST",
      headers: headers(OWNER),
      body: JSON.stringify(f.input),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(f.binding);
    expect(f.current(f.binding)).toEqual(before);
    expect(f.port.transition).toHaveBeenCalledTimes(1);
    expect(f.port.assertReadable).not.toHaveBeenCalled();
    const catalog = await f.app.request(BASE, { headers: headers(OWNER) });
    expect(catalog.status).toBe(200);
    expect(SpackMaterialCatalogSchema.parse(await catalog.json()).releases).toEqual([]);
    for (const path of [f.path, `${f.path}/blobs/${SOURCE_BLOB.digest}`]) {
      const denied = await f.app.request(path, { headers: headers(OWNER) });
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Material release not found" },
      });
    }
  });

  test("CAS conflicts preserve policy and changing to inherit restores subsequent reads", async () => {
    const f = await visibilityFixture();
    const request = (body: unknown) =>
      f.app.request(`${f.path}/visibility`, {
        method: "POST",
        headers: headers(OWNER),
        body: JSON.stringify(body),
      });
    expect((await request(HIDE)).status).toBe(200);
    const conflict = await request({ ...HIDE, policy: { mode: "inherit" } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "MATERIAL_VISIBILITY_CONFLICT" },
    });
    expect(f.current(f.binding).policy).toEqual(HIDE.policy);
    const restored = await request({ ...HIDE, expectedRevision: 1, policy: { mode: "inherit" } });
    expect(restored.status).toBe(200);
    expect((await f.app.request(f.path, { headers: headers(OWNER) })).status).toBe(200);
  });
});

describe("visibility request validation", () => {
  test.each([
    { policy: { mode: "public" } },
    { policy: { mode: "allowlist", userIds: [OWNER.sub, OWNER.sub], orgIds: [] } },
    { policy: { mode: "allowlist", userIds: ["not-a-uuid"], orgIds: [] } },
    {
      policy: {
        mode: "allowlist",
        userIds: Array.from({ length: 101 }, () => OWNER.sub),
        orgIds: [],
      },
    },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: 2_147_483_647 },
    { reason: "" },
    { reason: " reason" },
    { reason: "reason\n" },
    { role: "super_admin" },
    { operatorId: OWNER.sub },
  ])("rejects invalid writes before the backend: %j", async (patch) => {
    const f = await visibilityFixture();
    const response = await f.app.request(`${f.path}/visibility`, {
      method: "POST",
      headers: headers(OWNER),
      body: JSON.stringify({ ...HIDE, ...patch }),
    });
    expect(response.status).toBe(422);
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test.each(METHODS)("%s rejects query overrides and invalid binding", async (method) => {
    const f = await visibilityFixture();
    for (const path of [
      `${f.path}/visibility?role=super_admin`,
      `${f.path}/visibility?url=https://example.invalid`,
      `${BASE}/invalid/releases/${f.binding.manifestDigest}/visibility`,
      `${BASE}/${f.binding.repositoryId}/releases/latest/visibility`,
    ]) {
      const response = await f.app.request(path, {
        method,
        headers: headers(OWNER),
        ...(method === "POST" ? { body: JSON.stringify(HIDE) } : {}),
      });
      expect(response.status).toBe(422);
    }
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test("POST enforces JSON, body size and a nonempty body", async () => {
    const f = await visibilityFixture();
    for (const [type, body, length, status] of [
      ["text/plain", JSON.stringify(HIDE), undefined, 415],
      ["application/json", JSON.stringify(HIDE), "2097153", 413],
      ["application/json", "{", undefined, 400],
      ["application/json", undefined, undefined, 400],
    ] as const) {
      const response = await f.app.request(`${f.path}/visibility`, {
        method: "POST",
        body,
        headers: { ...headers(OWNER, type), ...(length ? { "Content-Length": length } : {}) },
      });
      expect(response.status).toBe(status);
    }
    expect(f.port.transition).not.toHaveBeenCalled();
  });
});
