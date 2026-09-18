import { afterEach, describe, expect, test } from "bun:test";
import { SpackMaterialCatalogSchema } from "@kuintessence/shared";
import { SpackMaterialCatalogLimitError } from "../services/spack-material-catalog";
import {
  BASE,
  cleanupMaterials,
  materialApp,
  materialFixture,
} from "./spack-materials.test-helpers";
import {
  headers,
  JWT_OPTIONS,
  ORG,
  OWNER,
  PLATFORM,
  SUPER,
  token,
  USER,
} from "./spack-repositories.test-helpers";

afterEach(cleanupMaterials);

describe("material catalog route", () => {
  test("requires authentication and configured storage without intercepting unrelated routes", async () => {
    const app = materialApp(undefined);
    expect((await app.request(BASE)).status).toBe(401);
    expect((await app.request(BASE, { headers: headers() })).status).toBe(503);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  test("lists compact authorized summaries without publisher privileges and disables caching", async () => {
    const f = await materialFixture();
    await f.seed();
    const binding = await f.store.publish(f.input, OWNER);
    const response = await f.app.request(BASE, { headers: headers(USER) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = SpackMaterialCatalogSchema.parse(await response.json());
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]).toMatchObject({ ...binding, repository: f.input.repository });
    expect(body.releases[0]).not.toHaveProperty("sources");
    expect(body.releases[0]).not.toHaveProperty("recipes");
    expect(body).not.toHaveProperty("totalCount");
    expect(await (await f.app.request(BASE, { headers: headers(PLATFORM) })).json()).toEqual({
      releases: [],
    });
  });

  test("accepts exactly one optional namespace filter and hides unauthorized existence", async () => {
    const f = await materialFixture();
    await f.seed();
    await f.store.publish(f.input, OWNER);
    for (const name of [`org/${ORG}/recipes`, "public/missing"]) {
      const response = await f.app.request(`${BASE}?repository=${encodeURIComponent(name)}`, {
        headers: headers(USER),
      });
      expect(response.status).toBe(200);
      const body = SpackMaterialCatalogSchema.parse(await response.json());
      expect(body.releases).toHaveLength(name === f.input.repository ? 1 : 0);
    }
    const hidden = await f.app.request(
      `${BASE}?repository=${encodeURIComponent(f.input.repository)}`,
      {
        headers: headers(PLATFORM),
      },
    );
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toEqual({ releases: [] });
  });

  test.each([
    "repository=",
    "repository=public/a&repository=public/b",
    "repository=https%3A%2F%2Fexample.test",
    "repository=public%2F..%2Fprivate",
    "repository[]=public/a",
    "repository=public/a&cursor=guess",
    "limit=10",
    "url=https://example.test",
  ])("rejects ambiguous, path and unsupported queries: %s", async (query) => {
    const f = await materialFixture();
    const response = await f.app.request(`${BASE}?${query}`, { headers: headers(USER) });
    expect(response.status).toBe(422);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  test("resolves live membership rather than JWT role/org claims on each list", async () => {
    const f = await materialFixture();
    await f.seed();
    await f.store.publish(f.input, OWNER);
    let canonical = { ...USER, suspended: false };
    const app = materialApp(f.store, {
      ...JWT_OPTIONS,
      resolveCanonicalPrincipal: async () => canonical,
    });
    const request = { headers: { Authorization: `Bearer ${token(SUPER)}` } };
    expect(
      SpackMaterialCatalogSchema.parse(await (await app.request(BASE, request)).json()).releases,
    ).toHaveLength(1);
    canonical = { ...canonical, orgIds: [] };
    expect(await (await app.request(BASE, request)).json()).toEqual({ releases: [] });
    canonical = { ...canonical, suspended: true };
    expect((await app.request(BASE, request)).status).toBe(401);
    expect((await materialApp(f.store, JWT_OPTIONS).request(BASE, request)).status).toBe(401);
  });

  test("reports a distinct scan-limit error without a partial list or internal paths", async () => {
    const f = await materialFixture();
    f.store.list = async () => {
      throw new SpackMaterialCatalogLimitError();
    };
    const response = await f.app.request(BASE, { headers: headers(USER) });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "MATERIAL_CATALOG_LIMIT" } });
    expect(body).not.toHaveProperty("releases");
    expect(JSON.stringify(body)).not.toContain(f.root);
  });

  test("passes caller cancellation through to the scan and never returns stale success", async () => {
    const f = await materialFixture();
    await f.seed();
    await f.store.publish(f.input, OWNER);
    const controller = new AbortController();
    f.recipes.get.mockImplementation(async () => {
      controller.abort();
      return f.recipe;
    });
    const response = await f.app.request(BASE, {
      headers: headers(USER),
      signal: controller.signal,
    });
    expect(response.status).not.toBe(200);
    expect(await response.json()).not.toHaveProperty("releases");
  });
});
