import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, type PgDb, users, workflowTemplates } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { WorkflowTemplateService } from "../services/workflow-template-service";
import { createWorkflowTemplateRoutes } from "./workflow-templates";

// Registry writes are now principal-gated (tbd #17). Enable the test-principal
// path and send an admin principal on writes; reads stay public.
process.env.REGISTRY_ALLOW_TEST_PRINCIPAL = "1";
const PRINCIPAL = JSON.stringify({ sub: "admin@test", role: "platform_admin", orgIds: [] });
const W = { "Content-Type": "application/json", "X-Test-Principal": PRINCIPAL };

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

const SAMPLE_YAML = `name: test-wf
parameters: []
spec:
  nodeDrafts: []
  nodeRelations: []`;

describe("Workflow template routes", () => {
  let db: PgDb;
  let app: Hono;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    const service = new WorkflowTemplateService(db);
    app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.route("/api", createWorkflowTemplateRoutes(service));
  });

  afterAll(async () => {
    await db.delete(workflowTemplates).where(like(workflowTemplates.name, "wfroute-test-%"));
  });

  test("POST /api/workflow-templates creates a template", async () => {
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "wfroute-test-climate",
        version: "1.0.0",
        yamlContent: SAMPLE_YAML,
        tags: ["hpc", "climate"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.name).toBe("wfroute-test-climate");
    expect(body.id).toBeDefined();
    expect(res.headers.get("Location")).toBe(`workflow-templates/${body.id}`);
    expect(
      new URL(res.headers.get("Location") ?? "", "http://localhost/api/workflow-templates")
        .pathname,
    ).toBe(`/api/workflow-templates/${body.id}`);

    const replay = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "wfroute-test-climate",
        version: "1.0.0",
        yamlContent: SAMPLE_YAML,
        tags: ["climate", "hpc", "climate"],
      }),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { id: string };
    expect(replayBody.id).toBe(body.id);
    expect(replay.headers.get("Location")).toBe(`workflow-templates/${body.id}`);
  });

  test("POST records a canonical user id without accepting opaque subjects as UUIDs", async () => {
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `workflow-publisher-${userId}@test.local`,
      role: "platform_admin",
    });
    try {
      const res = await app.request("/api/workflow-templates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Test-Principal": JSON.stringify({
            sub: userId,
            role: "platform_admin",
            orgIds: [],
          }),
        },
        body: JSON.stringify({
          name: "wfroute-test-canonical-publisher",
          version: "1.0.0",
          yamlContent: SAMPLE_YAML,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; createdBy: string | null };
      expect(body.createdBy).toBe(userId);
    } finally {
      await db.delete(workflowTemplates).where(eq(workflowTemplates.createdBy, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  test("POST /api/workflow-templates rejects missing yamlContent", async () => {
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "wfroute-test-invalid",
        version: "1.0.0",
        // missing yamlContent
      }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/workflow-templates returns paginated list metadata", async () => {
    const res = await app.request("/api/workflow-templates?page=1&pageSize=1&q=wfroute-test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflowTemplates: Array<{ id: string }>;
      templates: Array<{ id: string }>;
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
    };
    expect(body.workflowTemplates).toBeInstanceOf(Array);
    expect(body.templates).toEqual(body.workflowTemplates);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.totalPages).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/workflow-templates rejects malformed pagination values", async () => {
    for (const query of ["page=2junk", "pageSize=1e3", "page=0", "page="]) {
      const res = await app.request(`/api/workflow-templates?${query}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  test("GET /api/workflow-templates?tag=hpc filters by tag", async () => {
    const res = await app.request("/api/workflow-templates?tag=hpc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflowTemplates: Array<{ name: string }> };
    expect(body.workflowTemplates.some((t) => t.name === "wfroute-test-climate")).toBe(true);
  });

  test("GET /api/workflow-templates/:id returns template", async () => {
    const create = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "wfroute-test-get",
        version: "2.0.0",
        yamlContent: SAMPLE_YAML,
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/workflow-templates/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(created.id);
  });

  test("GET /api/workflow-templates/:id returns 404 for unknown", async () => {
    const res = await app.request("/api/workflow-templates/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("GET /api/workflow-templates/:id returns 400 for non-UUID id (ISSUE-011)", async () => {
    // Was returning 500 INTERNAL_ERROR by leaking the Postgres "invalid input
    // syntax for type uuid" error into the response.
    const res = await app.request("/api/workflow-templates/not-a-uuid");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("workflow template id");
  });

  test("DELETE /api/workflow-templates/:id returns 400 for non-UUID id (ISSUE-011)", async () => {
    const res = await app.request("/api/workflow-templates/zzz", {
      method: "DELETE",
      headers: { "X-Test-Principal": PRINCIPAL },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("POST /api/workflow-templates returns 400 for malformed JSON (ISSUE-011)", async () => {
    // Was returning 500 INTERNAL_ERROR before the HTTPException catch was added
    // to the registry error handler.
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: "{not-real-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Malformed JSON");
  });

  test("DELETE /api/workflow-templates/:id preserves published template history", async () => {
    const create = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "wfroute-test-del",
        version: "0.0.1",
        yamlContent: SAMPLE_YAML,
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/workflow-templates/${created.id}`, {
      method: "DELETE",
      headers: { "X-Test-Principal": PRINCIPAL },
    });
    expect(res.status).toBe(409);
    const get = await app.request(`/api/workflow-templates/${created.id}`);
    expect(get.status).toBe(200);
  });

  test("PUT /api/workflow-templates/:id publishes a new immutable version", async () => {
    const create = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "wfroute-test-update",
        version: "1.0.0",
        yamlContent: SAMPLE_YAML,
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/workflow-templates/${created.id}`, {
      method: "PUT",
      headers: W,
      body: JSON.stringify({
        name: "wfroute-test-update-renamed",
        version: "2.0.0",
        description: "updated",
        yamlContent:
          "name: updated\nparameters: []\nspec:\n  nodeDrafts: []\n  nodeRelations: []\n",
        tags: ["hpc", "updated"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      version: string;
      description: string | null;
      yamlContent: string;
      tags: string[];
    };
    expect(body.name).toBe("wfroute-test-update-renamed");
    expect(body.version).toBe("2.0.0");
    expect(body.description).toBe("updated");
    expect(body.yamlContent).toContain("name: updated");
    expect(body.tags).toContain("updated");
    expect(body.id).not.toBe(created.id);
    expect(res.headers.get("Location")).toBe(`./${body.id}`);
    const original = await app.request(`/api/workflow-templates/${created.id}`);
    const originalBody = (await original.json()) as { version: string; yamlContent: string };
    expect(originalBody.version).toBe("1.0.0");
    expect(originalBody.yamlContent).toBe(SAMPLE_YAML);

    const replay = await app.request(`/api/workflow-templates/${created.id}`, {
      method: "PUT",
      headers: W,
      body: JSON.stringify({
        name: "wfroute-test-update-renamed",
        version: "2.0.0",
        description: "updated",
        yamlContent:
          "name: updated\nparameters: []\nspec:\n  nodeDrafts: []\n  nodeRelations: []\n",
        tags: ["updated", "hpc"],
      }),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { id: string };
    expect(replayBody.id).toBe(body.id);
  });

  test("POST /api/workflow-templates returns 409 for a version collision", async () => {
    const payload = {
      name: "wfroute-test-version-conflict",
      version: "1.0.0",
      yamlContent: SAMPLE_YAML,
    };
    const first = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        ...payload,
        yamlContent: SAMPLE_YAML.replace("name: test-wf", "name: changed"),
      }),
    });
    expect(res.status).toBe(409);
  });

  // Security (tbd #17): writes require a principal; reads remain public.
  test("POST without a principal is rejected (401)", async () => {
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "wfroute-test-noauth",
        version: "1.0.0",
        yamlContent: SAMPLE_YAML,
      }),
    });
    expect(res.status).toBe(401);
  });

  test("POST rejects an org admin because workflow templates are platform publications", async () => {
    const orgAdminHeaders = {
      "Content-Type": "application/json",
      "X-Test-Principal": JSON.stringify({
        sub: "org-admin@test",
        role: "org_admin",
        orgIds: ["00000000-0000-0000-0000-000000000001"],
      }),
    };
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: orgAdminHeaders,
      body: JSON.stringify({
        name: "wfroute-test-org-admin-denied",
        version: "1.0.0",
        yamlContent: SAMPLE_YAML,
      }),
    });
    expect(res.status).toBe(403);
  });

  test("DELETE without a principal is rejected (401)", async () => {
    const res = await app.request("/api/workflow-templates/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
