import { afterEach, describe, expect, test } from "bun:test";
import { SpackMaterialManagementCatalogSchema } from "@kuintessence/shared";
import { z } from "zod";
import { ACTOR, managementFixture, QUERY } from "../services/spack-material-management.test-helpers";
import { BASE, cleanupMaterials } from "./spack-materials.test-helpers";
import { headers, ORG, OTHER_ORG, SUPER } from "./spack-repositories.test-helpers";

afterEach(cleanupMaterials);
const path = `${BASE}/management?repository=public%2Fmaterials`;

describe("management catalog routes", () => {
  test("discovers available and withdrawn releases without audit data or changing downloads", async () => {
    const f = await managementFixture(2);
    const binding = f.bindings[0];
    if (!binding) throw new Error("Missing binding");
    f.control.withdrawn.add(binding.manifestDigest);
    const response = await f.app.request(path, { headers: headers(ACTOR) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const result = SpackMaterialManagementCatalogSchema.parse(await response.json());
    expect(result.releases.map((release) => release.state)).toEqual(["withdrawn", "available"]);
    expect(result.releases.map((release) => release.manifestDigest)).toEqual(
      f.bindings.map((value) => value.manifestDigest),
    );
    expect(result.nextCursor).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/history|operatorId|reason|sources|recipes/);
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
    expect((await f.store.list({ repository: QUERY.repository }, ACTOR)).releases).toHaveLength(1);
    const download = await f.app.request(
      `${BASE}/${binding.repositoryId}/releases/${binding.manifestDigest}`,
      { headers: headers(ACTOR) },
    );
    expect(download.status).toBe(404);
  });

  test.each([
    "",
    "?state=all",
    "?repository=../private",
    "?repository=public/materials&repository=public/other",
    "?repository=public/materials&state=all&state=withdrawn",
    "?repository=public/materials&limit=01",
    "?repository=public/materials&limit=21",
    "?repository=public/materials&limit=1e1",
    "?repository=public/materials&after=sha256:aaaaaaaa",
    "?repository=public/materials&actor=admin",
    "?repository=public/materials&url=https://example.invalid",
  ])("rejects malformed filters before loading manifests: %s", async (query) => {
    const f = await managementFixture();
    f.recipes.getSnapshot.mockClear();
    const response = await f.app.request(`${BASE}/management${query}`, { headers: headers(ACTOR) });
    expect(response.status).toBe(422);
    expect(f.recipes.getSnapshot).not.toHaveBeenCalled();
  });

  test("requires authentication and does not use a forged token role for management", async () => {
    const f = await managementFixture();
    expect((await f.app.request(path)).status).toBe(401);
    f.control.canonical = { ...ACTOR, role: "user" };
    f.recipes.getSnapshot.mockClear();
    const response = await f.app.request(path, {
      headers: headers({ ...ACTOR, role: "super_admin" }),
    });
    expect(response.status).toBe(403);
    expect(f.recipes.getSnapshot).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(QUERY.repository);
  });

  test("foreign organizations remain unreadable even for platform administrators", async () => {
    const f = await managementFixture(1, `org/${OTHER_ORG}/materials`);
    const response = await f.app.request(
      `${BASE}/management?repository=org/${OTHER_ORG}/materials`,
      { headers: headers(ACTOR) },
    );
    expect(response.status).toBe(403);
    f.control.canonical = { ...ACTOR, role: "org_admin", orgIds: [OTHER_ORG] };
    expect((await f.list({ ...QUERY, repository: `org/${OTHER_ORG}/materials` })).releases).toHaveLength(1);
    f.control.canonical.orgIds = [ORG];
    await expect(f.list({ ...QUERY, repository: `org/${OTHER_ORG}/materials` })).rejects.toMatchObject({ status: 403 });
  });

  test("empty and unknown repositories still require canonical readiness", async () => {
    const f = await managementFixture(0);
    expect(await f.list()).toEqual({ releases: [], nextCursor: null });
    f.control.ready = false;
    expect((await f.app.request(path, { headers: headers(SUPER) })).status).toBe(503);
  });

  test("corrupt snapshot JSON and schema are storage errors, not invalid GET bodies", async () => {
    const f = await managementFixture();
    const parsed = z.string().safeParse(123);
    if (parsed.success) throw new Error("Expected invalid fixture");
    for (const error of [new SyntaxError("private disk metadata"), parsed.error]) {
      f.recipes.getSnapshot.mockImplementationOnce(async () => { throw error; });
      const response = await f.app.request(path, { headers: headers(ACTOR) });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: "INTERNAL_ERROR", message: "Corrupt material management metadata" },
      });
    }
  });
});
