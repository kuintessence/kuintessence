import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appTemplates, createPgDb, orgs, type PgDb, softwareAssets } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { SoftwareAssetService } from "../services/software-asset-service";
import { SpackCatalogService } from "../services/spack-catalog-service";
import { createSpackCatalogRoutes } from "./spack-catalog";

process.env.REGISTRY_ALLOW_TEST_PRINCIPAL = "1";
const PLATFORM = JSON.stringify({ sub: "admin@test", role: "platform_admin", orgIds: [] });
const ORG_VENDOR = "22222222-2222-4222-8222-222222222222";
const ORG_OTHER = "33333333-3333-4333-8333-333333333333";
const VENDOR = JSON.stringify({ sub: "cp@test", role: "org_admin", orgIds: [ORG_VENDOR] });
const OTHER_VENDOR = JSON.stringify({ sub: "other@test", role: "org_admin", orgIds: [ORG_OTHER] });
const USER = JSON.stringify({ sub: "user@test", role: "user", orgIds: [ORG_VENDOR] });
const PLATFORM_HEADERS = { "Content-Type": "application/json", "X-Test-Principal": PLATFORM };
const VENDOR_HEADERS = { "Content-Type": "application/json", "X-Test-Principal": VENDOR };
const OTHER_VENDOR_HEADERS = {
  "Content-Type": "application/json",
  "X-Test-Principal": OTHER_VENDOR,
};
const USER_HEADERS = { "Content-Type": "application/json", "X-Test-Principal": USER };

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

describe("Spack catalog routes", () => {
  let db: PgDb;
  let app: Hono;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    await db
      .insert(orgs)
      .values([
        { id: ORG_VENDOR, name: "catalogroute-test-vendor-org" },
        { id: ORG_OTHER, name: "catalogroute-test-other-org" },
      ])
      .onConflictDoNothing();
    app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.route(
      "/api",
      createSpackCatalogRoutes(new SpackCatalogService(db, new SoftwareAssetService(db))),
    );
  });

  afterAll(async () => {
    await db.delete(softwareAssets).where(like(softwareAssets.name, "catalogroute-test-%"));
    await db.delete(appTemplates).where(like(appTemplates.name, "catalogroute-test-%"));
    await db.delete(orgs).where(eq(orgs.id, ORG_VENDOR));
    await db.delete(orgs).where(eq(orgs.id, ORG_OTHER));
  });

  test("GET /api/spack/catalog returns upstream packages from the local official mirror", async () => {
    const res = await app.request("/api/spack/catalog?q=openfoam&limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      page: number;
      pageSize: number;
      sourceRepository: string;
      totalCount: number;
      upstreamCount: number;
      packages: Array<{ name: string; source: string; tags: string[]; metadata?: unknown }>;
    };
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(5);
    expect(body.sourceRepository).toBe("spack/spack-packages");
    expect(body.totalCount).toBeGreaterThanOrEqual(body.packages.length);
    expect(body.upstreamCount).toBeGreaterThan(1000);
    expect(body.packages).toContainEqual(
      expect.objectContaining({
        name: "openfoam",
        source: "upstream",
        tags: [],
        metadata: expect.objectContaining({ name: "openfoam" }),
      }),
    );
  });

  test("GET /api/spack/catalog pages package results instead of returning every match", async () => {
    const res = await app.request("/api/spack/catalog?q=openfoam&page=2&pageSize=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasPrevious: boolean;
      page: number;
      pageSize: number;
      packages: Array<{ name: string; source: string; tags: string[] }>;
      totalCount: number;
      totalPages: number;
    };
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(1);
    expect(body.packages).toHaveLength(1);
    expect(body.totalCount).toBeGreaterThan(1);
    expect(body.totalPages).toBeGreaterThan(1);
    expect(body.hasPrevious).toBe(true);
  });

  test("POST /api/spack/catalog/packages creates official and vendor packages", async () => {
    const official = await app.request("/api/spack/catalog/packages", {
      method: "POST",
      headers: PLATFORM_HEADERS,
      body: JSON.stringify({
        name: "catalogroute-test-platform-cfd",
        source: "official",
        description: "platform maintained package",
        tags: ["cfd"],
      }),
    });
    expect(official.status).toBe(201);
    const officialBody = (await official.json()) as {
      id: string;
      name: string;
      source: string;
      tags: string[];
    };
    expect(officialBody.name).toBe("catalogroute-test-platform-cfd");
    expect(officialBody.source).toBe("official");
    expect(officialBody.tags).toEqual(["cfd"]);

    const vendor = await app.request(`/api/spack/catalog/packages?orgId=${ORG_VENDOR}`, {
      method: "POST",
      headers: VENDOR_HEADERS,
      body: JSON.stringify({
        name: "catalogroute-test-vendor-solver",
        source: "vendor",
        tags: ["solver"],
      }),
    });
    expect(vendor.status).toBe(201);
    const vendorBody = (await vendor.json()) as {
      name: string;
      source: string;
      ownerOrgId: string | null;
    };
    expect(vendorBody.name).toBe("catalogroute-test-vendor-solver");
    expect(vendorBody.source).toBe("vendor");
    expect(vendorBody.ownerOrgId).toBe(ORG_VENDOR);

    const assets = await db
      .select()
      .from(softwareAssets)
      .where(like(softwareAssets.name, "catalogroute-test-%"));
    expect(assets.some((asset) => asset.source === "platform-fork")).toBe(true);
    expect(assets.some((asset) => asset.source === "cp-private")).toBe(true);
  });

  test("POST /api/spack/catalog/packages requires an explicit vendor organization", async () => {
    const res = await app.request("/api/spack/catalog/packages", {
      method: "POST",
      headers: VENDOR_HEADERS,
      body: JSON.stringify({ name: "catalogroute-test-missing-org", source: "vendor" }),
    });
    expect(res.status).toBe(422);
  });

  test("POST /api/spack/parse extracts package and compiler metadata", async () => {
    const packageRes = await app.request("/api/spack/parse/package", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: `
class CatalogrouteTestParsed(Package):
    version("1.0", sha256="abc")
    variant("mpi", default=True, description="MPI")
    provides("solver")
`,
      }),
    });
    expect(packageRes.status).toBe(200);
    const packageBody = (await packageRes.json()) as {
      name: string;
      versions: string[];
      variants: Array<{ name: string }>;
      provides: string[];
    };
    expect(packageBody.name).toBe("catalogroute-test-parsed");
    expect(packageBody.versions).toEqual(["1.0"]);
    expect(packageBody.variants).toContainEqual(expect.objectContaining({ name: "mpi" }));
    expect(packageBody.provides).toEqual(["solver"]);

    const compilerRes = await app.request("/api/spack/parse/compilers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "spec: gcc@13.2.0\nspec: clang@17.0.6" }),
    });
    expect(compilerRes.status).toBe(200);
    const compilerBody = (await compilerRes.json()) as {
      compilers: Array<{ spec: string; name: string; version: string }>;
    };
    expect(compilerBody.compilers).toContainEqual({
      spec: "gcc@13.2.0",
      name: "gcc",
      version: "13.2.0",
    });
  });

  test("POST /api/spack/catalog/packages stores parsed package metadata", async () => {
    const created = await app.request("/api/spack/catalog/packages", {
      method: "POST",
      headers: PLATFORM_HEADERS,
      body: JSON.stringify({
        name: "catalogroute-test-metadata",
        source: "official",
        packageFile: `
class CatalogrouteTestMetadata(Package):
    version("2.0", sha256="abc")
    variant("cuda", default=False, description="CUDA")
`,
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      metadata?: { versions: string[]; variants: Array<{ name: string }> };
    };
    expect(body.metadata?.versions).toEqual(["2.0"]);
    expect(body.metadata?.variants).toContainEqual(expect.objectContaining({ name: "cuda" }));
  });

  test("GET /api/spack/catalog keeps vendor packages scoped to the owning org", async () => {
    const official = await app.request("/api/spack/catalog?source=official&q=platform-cfd");
    expect(official.status).toBe(200);
    const officialBody = (await official.json()) as {
      packages: Array<{ name: string; source: string }>;
    };
    expect(officialBody.packages).toContainEqual(
      expect.objectContaining({
        name: "catalogroute-test-platform-cfd",
        source: "official",
      }),
    );

    const anonymousAll = await app.request("/api/spack/catalog?source=all&q=vendor-solver");
    expect(anonymousAll.status).toBe(200);
    const anonymousAllBody = (await anonymousAll.json()) as {
      packages: Array<{ name: string; source: string }>;
    };
    expect(anonymousAllBody.packages).not.toContainEqual(
      expect.objectContaining({
        name: "catalogroute-test-vendor-solver",
        source: "vendor",
      }),
    );

    const anonymousVendor = await app.request("/api/spack/catalog?source=vendor&q=vendor-solver");
    expect(anonymousVendor.status).toBe(401);

    const otherOrg = await app.request("/api/spack/catalog?source=vendor&q=vendor-solver", {
      headers: OTHER_VENDOR_HEADERS,
    });
    expect(otherOrg.status).toBe(200);
    const otherOrgBody = (await otherOrg.json()) as {
      packages: Array<{ name: string; source: string }>;
    };
    expect(otherOrgBody.packages).not.toContainEqual(
      expect.objectContaining({
        name: "catalogroute-test-vendor-solver",
        source: "vendor",
      }),
    );

    const vendor = await app.request("/api/spack/catalog?source=vendor&q=vendor-solver", {
      headers: VENDOR_HEADERS,
    });
    expect(vendor.status).toBe(200);
    const vendorBody = (await vendor.json()) as {
      packages: Array<{ name: string; source: string; ownerOrgId?: string | null }>;
    };
    expect(vendorBody.packages).toContainEqual(
      expect.objectContaining({
        name: "catalogroute-test-vendor-solver",
        ownerOrgId: ORG_VENDOR,
        source: "vendor",
      }),
    );
  });

  test("PUT and DELETE update custom packages but reject non-publisher writes", async () => {
    const create = await app.request("/api/spack/catalog/packages", {
      method: "POST",
      headers: PLATFORM_HEADERS,
      body: JSON.stringify({
        name: "catalogroute-test-update",
        source: "official",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };

    const forbidden = await app.request(`/api/spack/catalog/packages/${created.id}`, {
      method: "PUT",
      headers: USER_HEADERS,
      body: JSON.stringify({
        name: "catalogroute-test-denied",
        source: "vendor",
      }),
    });
    expect(forbidden.status).toBe(403);

    const update = await app.request(`/api/spack/catalog/packages/${created.id}`, {
      method: "PUT",
      headers: PLATFORM_HEADERS,
      body: JSON.stringify({
        name: "catalogroute-test-updated",
        source: "official",
        description: "updated",
      }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { name: string; description: string | null };
    expect(updated.name).toBe("catalogroute-test-updated");
    expect(updated.description).toBe("updated");

    const del = await app.request(`/api/spack/catalog/packages/${created.id}`, {
      method: "DELETE",
      headers: { "X-Test-Principal": PLATFORM },
    });
    expect(del.status).toBe(200);
    const after = await app.request(
      `/api/spack/catalog?source=official&q=catalogroute-test-updated`,
    );
    const body = (await after.json()) as { packages: unknown[] };
    expect(body.packages).toHaveLength(0);
  });

  test("PUT preserves the vendor organization and rejects transfer attempts", async () => {
    const create = await app.request(`/api/spack/catalog/packages?orgId=${ORG_VENDOR}`, {
      method: "POST",
      headers: VENDOR_HEADERS,
      body: JSON.stringify({ name: "catalogroute-test-no-transfer", source: "vendor" }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; ownerOrgId: string };
    expect(created.ownerOrgId).toBe(ORG_VENDOR);

    const transfer = await app.request(
      `/api/spack/catalog/packages/${created.id}?orgId=${ORG_OTHER}`,
      {
        method: "PUT",
        headers: PLATFORM_HEADERS,
        body: JSON.stringify({ name: "catalogroute-test-no-transfer", source: "vendor" }),
      },
    );
    expect(transfer.status).toBe(409);

    const update = await app.request(`/api/spack/catalog/packages/${created.id}`, {
      method: "PUT",
      headers: VENDOR_HEADERS,
      body: JSON.stringify({
        name: "catalogroute-test-no-transfer-updated",
        source: "vendor",
      }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { ownerOrgId: string };
    expect(updated.ownerOrgId).toBe(ORG_VENDOR);
  });

  test("GET /api/spack/catalog rejects malformed pagination", async () => {
    for (const query of ["page=2junk", "pageSize=1e3", "limit=0"]) {
      const res = await app.request(`/api/spack/catalog?${query}`);
      expect(res.status).toBe(400);
    }
  });
});
