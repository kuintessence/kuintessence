import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appTemplates, createPgDb, type PgDb } from "@kuintessence/db";
import { like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { AppTemplateService } from "../services/app-template-service";
import { createAppTemplateRoutes } from "./app-templates";

// Registry writes are now principal-gated (tbd #17). Enable the test-principal
// path and send an admin principal on writes; reads stay public.
process.env.REGISTRY_ALLOW_TEST_PRINCIPAL = "1";
const PRINCIPAL = JSON.stringify({ sub: "admin@test", role: "platform_admin", orgIds: [] });
const ORG_ADMIN_PRINCIPAL = JSON.stringify({
  sub: "org-admin@test",
  role: "org_admin",
  orgIds: ["22222222-2222-4222-8222-222222222222"],
});
const USER_PRINCIPAL = JSON.stringify({ sub: "user@test", role: "user", orgIds: [] });
const W = { "Content-Type": "application/json", "X-Test-Principal": PRINCIPAL };

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

describe("App template routes", () => {
  let db: PgDb;
  let app: Hono;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    const service = new AppTemplateService(db);
    app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.route("/api", createAppTemplateRoutes(service));
  });

  afterAll(async () => {
    await db.delete(appTemplates).where(like(appTemplates.name, "approute-test-%"));
  });

  test("POST /api/app-templates creates a template", async () => {
    const res = await app.request("/api/app-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-wrf",
        version: "4.4",
        spec: "wrf@4.4 +netcdf",
        specKind: "spack",
        tags: ["climate"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; specKind: string };
    expect(body.name).toBe("approute-test-wrf");
    expect(body.specKind).toBe("spack");
    expect(body.id).toBeDefined();
  });

  test("POST /api/app-templates rejects invalid body", async () => {
    const res = await app.request("/api/app-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-invalid",
        // missing version, spec, specKind
      }),
    });
    expect(res.status).toBe(400);
  });

  test("legacy app template writes require platform_admin", async () => {
    const headers = {
      "Content-Type": "application/json",
      "X-Test-Principal": ORG_ADMIN_PRINCIPAL,
    };
    const create = await app.request("/api/app-templates", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "approute-test-org-denied",
        version: "1.0.0",
        spec: "denied@1.0.0",
        specKind: "spack",
      }),
    });
    expect(create.status).toBe(403);

    const platformCreate = await app.request("/api/app-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-platform-owned",
        version: "1.0.0",
        spec: "owned@1.0.0",
        specKind: "spack",
      }),
    });
    const created = (await platformCreate.json()) as { id: string };
    const update = await app.request(`/api/app-templates/${created.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "approute-test-platform-owned",
        version: "1.0.1",
        spec: "owned@1.0.1",
        specKind: "spack",
      }),
    });
    expect(update.status).toBe(403);
    const remove = await app.request(`/api/app-templates/${created.id}`, {
      method: "DELETE",
      headers,
    });
    expect(remove.status).toBe(403);
  });

  test("POST /api/app-templates rejects invalid specKind", async () => {
    const res = await app.request("/api/app-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-badkind",
        version: "1.0.0",
        spec: "x@1.0.0",
        specKind: "invalid-kind",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/app-templates returns list", async () => {
    const res = await app.request("/api/app-templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appTemplates: Array<{ id: string }> };
    expect(body.appTemplates).toBeInstanceOf(Array);
  });

  test("GET /api/app-templates?tag=climate filters by tag", async () => {
    const res = await app.request("/api/app-templates?tag=climate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appTemplates: Array<{ name: string }> };
    expect(body.appTemplates.some((t) => t.name === "approute-test-wrf")).toBe(true);
  });

  test("GET /api/app-templates/:id returns template", async () => {
    const create = await app.request("/api/app-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-get",
        version: "1.0.0",
        spec: "x@1.0.0",
        specKind: "oci",
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/app-templates/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(created.id);
  });

  test("GET /api/app-templates/:id returns 404 for unknown", async () => {
    const res = await app.request("/api/app-templates/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("GET /api/app-templates/:id returns 400 for non-UUID id (ISSUE-011)", async () => {
    const res = await app.request("/api/app-templates/not-a-uuid");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("app template id");
  });

  test("DELETE /api/app-templates/:id returns 400 for non-UUID id (ISSUE-011)", async () => {
    const res = await app.request("/api/app-templates/zzz", {
      method: "DELETE",
      headers: { "X-Test-Principal": PRINCIPAL },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("DELETE /api/app-templates/:id removes template", async () => {
    const create = await app.request("/api/app-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-del",
        version: "0.0.1",
        spec: "del@0.0.1",
        specKind: "module",
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/app-templates/${created.id}`, {
      method: "DELETE",
      headers: { "X-Test-Principal": PRINCIPAL },
    });
    expect(res.status).toBe(200);
    // verify gone
    const get = await app.request(`/api/app-templates/${created.id}`);
    expect(get.status).toBe(404);
  });

  test("PUT /api/app-templates/:id updates a template", async () => {
    const create = await app.request("/api/app-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-update",
        version: "1.0.0",
        spec: "gromacs@2024",
        specKind: "spack",
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/app-templates/${created.id}`, {
      method: "PUT",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-update-renamed",
        version: "2025.1",
        description: "updated",
        spec: "gromacs@2025.1%gcc@13.2.0 +mpi",
        specKind: "spack",
        tags: ["spack", "compiler:gcc@13.2.0"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      description: string | null;
      spec: string;
      tags: string[];
    };
    expect(body.name).toBe("approute-test-update-renamed");
    expect(body.version).toBe("2025.1");
    expect(body.description).toBe("updated");
    expect(body.spec).toBe("gromacs@2025.1%gcc@13.2.0 +mpi");
    expect(body.tags).toContain("compiler:gcc@13.2.0");
  });

  test("generic app template APIs do not expose or mutate Spack catalog rows", async () => {
    const [catalogRow] = await db
      .insert(appTemplates)
      .values({
        name: "approute-test-catalog-row",
        version: "catalog",
        spec: "{}",
        specKind: "spack",
        tags: ["spack-catalog", "source:vendor"],
      })
      .returning();
    expect(catalogRow).toBeDefined();
    if (!catalogRow) return;

    const list = await app.request("/api/app-templates");
    const listBody = (await list.json()) as { appTemplates: Array<{ id: string }> };
    expect(listBody.appTemplates.some((item) => item.id === catalogRow.id)).toBe(false);

    const get = await app.request(`/api/app-templates/${catalogRow.id}`);
    expect(get.status).toBe(404);

    const update = await app.request(`/api/app-templates/${catalogRow.id}`, {
      method: "PUT",
      headers: W,
      body: JSON.stringify({
        name: "approute-test-catalog-row",
        version: "catalog",
        spec: "changed",
        specKind: "spack",
      }),
    });
    expect(update.status).toBe(403);

    const remove = await app.request(`/api/app-templates/${catalogRow.id}`, {
      method: "DELETE",
      headers: W,
    });
    expect(remove.status).toBe(403);
  });

  // Security (tbd #17): writes require a principal; an unauthenticated write is
  // rejected before it reaches the service. Reads remain public.
  test("POST without a principal is rejected (401)", async () => {
    const res = await app.request("/api/app-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "approute-test-noauth",
        version: "1.0.0",
        spec: "x@1",
        specKind: "oci",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("POST with a non-publisher principal is rejected (403)", async () => {
    const res = await app.request("/api/app-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Principal": USER_PRINCIPAL },
      body: JSON.stringify({
        name: "approute-test-user-publish",
        version: "1.0.0",
        spec: "x@1",
        specKind: "oci",
      }),
    });
    expect(res.status).toBe(403);
  });

  test("DELETE without a principal is rejected (401)", async () => {
    const res = await app.request("/api/app-templates/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
