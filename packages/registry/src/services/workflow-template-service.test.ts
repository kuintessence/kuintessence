import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPgDb,
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
  workflowTemplates,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { SoftwareAssetService } from "./software-asset-service";
import { WorkflowTemplateService } from "./workflow-template-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

function workflowYaml(name: string): string {
  return `name: ${name}
parameters: []
spec:
  nodeDrafts: []
  nodeRelations: []`;
}

const SAMPLE_YAML = workflowYaml("sample-wf");

describe("WorkflowTemplateService", () => {
  let db: PgDb;
  let service: WorkflowTemplateService;
  const ids: string[] = [];
  const releaseIds: string[] = [];

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    service = new WorkflowTemplateService(db, new SoftwareAssetService(db));
  });

  afterAll(async () => {
    for (const id of releaseIds) {
      await db.delete(ecosystemReleases).where(eq(ecosystemReleases.id, id));
    }
    for (const id of ids) {
      await db.delete(workflowTemplates).where(eq(workflowTemplates.id, id));
    }
    await db.delete(softwareAssets).where(like(softwareAssets.name, "wfsvc-test-%"));
    await db.delete(workflowTemplates).where(like(workflowTemplates.name, "wfsvc-test-%"));
  });

  test("create + getById", async () => {
    const t = await service.create({
      name: "wfsvc-test-wrf-pipeline",
      version: "1.0.0",
      yamlContent: SAMPLE_YAML,
      tags: ["climate", "hpc"],
    });
    ids.push(t.id);
    const got = await service.getById(t.id);
    expect(got?.name).toBe("wfsvc-test-wrf-pipeline");
    expect(got?.tags).toEqual(["climate", "hpc"]);
    expect(got?.yamlContent).toBe(SAMPLE_YAML);
    const assets = await db
      .select()
      .from(softwareAssets)
      .where(like(softwareAssets.name, "wfsvc-test-wrf-pipeline"));
    expect(assets[0]?.kind).toBe("workflow-template");
    expect(assets[0]?.payload).toMatchObject({
      kind: "workflow-template",
      workflowTemplateId: t.id,
    });
    const assetId = assets[0]?.id;
    expect(assetId).toBeDefined();
    const [revisions, grants] = await Promise.all([
      db
        .select()
        .from(softwareAssetRevisions)
        .where(eq(softwareAssetRevisions.assetId, assetId ?? "")),
      db
        .select()
        .from(softwareAssetGrants)
        .where(eq(softwareAssetGrants.assetId, assetId ?? "")),
    ]);
    expect(revisions).toHaveLength(1);
    expect(grants).toHaveLength(1);
  });

  test("findByNameVersion", async () => {
    const t = await service.create({
      name: "wfsvc-test-gromacs",
      version: "2.0.0",
      yamlContent: workflowYaml("gromacs-wf"),
      tags: ["molecular-dynamics"],
    });
    ids.push(t.id);
    const got = await service.findByNameVersion("wfsvc-test-gromacs", "2.0.0");
    expect(got?.id).toBe(t.id);
  });

  test("findByNameVersion returns null for unknown", async () => {
    const got = await service.findByNameVersion("no-such-wf", "0.0.0");
    expect(got).toBeNull();
  });

  test("list returns recent templates", async () => {
    const list = await service.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  test("listByTag filters by tag", async () => {
    const list = await service.listByTag("climate");
    expect(list.some((r) => r.name === "wfsvc-test-wrf-pipeline")).toBe(true);
  });

  test("listPage reaches the 101st template with stable pagination and search", async () => {
    const prefix = "wfsvc-test-pagination-";
    const inserted = await db
      .insert(workflowTemplates)
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          name: `${prefix}${String(index + 1).padStart(3, "0")}`,
          version: "1.0.0",
          yamlContent: SAMPLE_YAML,
          tags: index === 100 ? ["pagination"] : ["bulk"],
        })),
      )
      .returning();
    ids.push(...inserted.map((row) => row.id));

    const first = await service.listPage({ q: prefix, page: 1, pageSize: 100 });
    const second = await service.listPage({ q: prefix, page: 2, pageSize: 100 });
    const tagged = await service.listPage({ tag: "pagination", pageSize: 10 });

    expect(first.total).toBe(101);
    expect(first.templates).toHaveLength(100);
    expect(first.hasNext).toBe(true);
    expect(second.total).toBe(101);
    expect(second.templates).toHaveLength(1);
    expect(second.hasNext).toBe(false);
    const repeat = await service.listPage({ q: prefix, page: 2, pageSize: 100 });
    expect(repeat.templates.map((row) => row.id)).toEqual(second.templates.map((row) => row.id));
    expect(new Set([...first.templates, ...second.templates].map((row) => row.id)).size).toBe(101);
    expect(tagged.templates).toHaveLength(1);
    expect(tagged.templates[0]?.name).toBe(`${prefix}101`);
    expect(tagged.tags).toContain("pagination");
  });

  test("hides inactive-only release bindings from discovery but keeps getById", async () => {
    const ordinary = await service.create({
      name: "wfsvc-test-visibility-ordinary",
      version: "1.0.0",
      yamlContent: workflowYaml("visibility-ordinary"),
      tags: ["ordinary"],
    });
    const catalog = await service.create({
      name: "wfsvc-test-visibility-catalog",
      version: "1.0.0",
      yamlContent: workflowYaml("visibility-catalog"),
      tags: ["catalog-only"],
    });
    ids.push(ordinary.id, catalog.id);

    const [release] = await db
      .insert(ecosystemReleases)
      .values({
        releaseKey: "wfsvc-test-visibility-release",
        version: "1.0.0",
        artifactDigest: `sha256:${"1".repeat(64)}`,
        manifest: {},
        signature: "test-signature",
        signingKeyId: "test-key",
        status: "inactive",
        importedBy: "test",
      })
      .returning();
    if (!release) throw new Error("failed to create visibility release");
    releaseIds.push(release.id);
    await db.insert(ecosystemReleaseAssets).values({
      releaseId: release.id,
      ecosystemKey: "workflow/wfsvc-test-visibility-catalog",
      kind: "workflow-template",
      name: catalog.name,
      version: catalog.version,
      payload: {},
      provenance: {},
      licensePolicy: {},
      manifestEntryDigest: `sha256:${"2".repeat(64)}`,
      workflowTemplateId: catalog.id,
    });

    const hidden = await service.listPage({ q: "wfsvc-test-visibility", pageSize: 10 });
    expect(hidden.templates.map((row) => row.id)).toEqual([ordinary.id]);
    expect(hidden.total).toBe(1);
    expect(hidden.tags).toContain("ordinary");
    expect(hidden.tags).not.toContain("catalog-only");
    expect(await service.findByNameVersion(catalog.name, catalog.version)).toBeNull();
    expect((await service.getById(catalog.id))?.id).toBe(catalog.id);

    await db
      .update(ecosystemReleases)
      .set({ status: "active" })
      .where(eq(ecosystemReleases.id, release.id));
    const active = await service.listPage({ q: "wfsvc-test-visibility", pageSize: 10 });
    expect(active.templates.map((row) => row.id)).toEqual(
      expect.arrayContaining([ordinary.id, catalog.id]),
    );
    expect(active.total).toBe(2);
    expect(active.tags).toContain("catalog-only");
    expect(active.tags).toContain("ordinary");
    expect((await service.findByNameVersion(catalog.name, catalog.version))?.id).toBe(catalog.id);
  });

  test("updateById creates a new immutable template row", async () => {
    const t = await service.create({
      name: "wfsvc-test-immutable",
      version: "1.0.0",
      yamlContent: workflowYaml("original-template"),
    });
    ids.push(t.id);
    const next = await service.updateById(t.id, {
      name: "wfsvc-test-immutable",
      version: "1.1.0",
      yamlContent: workflowYaml("updated-template"),
    });
    ids.push(next.id);
    expect(next.id).not.toBe(t.id);
    expect((await service.getById(t.id))?.yamlContent).toContain("name: original-template");
    expect(next.yamlContent).toContain("name: updated-template");
  });

  test("create is idempotent for identical name, version, and content", async () => {
    const input = {
      name: "wfsvc-test-idempotent",
      version: "1.0.0",
      description: "same template",
      yamlContent: workflowYaml("same"),
      tags: ["demo"],
    };
    const first = await service.create(input);
    ids.push(first.id);
    const second = await service.create(input);
    expect(second.id).toBe(first.id);
  });

  test("create treats tags as an unordered set for idempotency", async () => {
    const first = await service.create({
      name: "wfsvc-test-idempotent-tags",
      version: "1.0.0",
      yamlContent: workflowYaml("tags"),
      tags: ["hpc", "demo"],
    });
    ids.push(first.id);
    const second = await service.create({
      name: "wfsvc-test-idempotent-tags",
      version: "1.0.0",
      yamlContent: workflowYaml("tags"),
      tags: ["demo", "hpc", "demo"],
    });
    expect(second.id).toBe(first.id);
    expect(second.tags).toEqual(["demo", "hpc"]);
  });

  test("rejects a name and version collision with different content", async () => {
    const name = "wfsvc-test-version-conflict";
    const first = await service.create({
      name,
      version: "1.0.0",
      yamlContent: workflowYaml("first"),
    });
    ids.push(first.id);
    await expect(
      service.create({ name, version: "1.0.0", yamlContent: workflowYaml("second") }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 409,
    });
  });

  test("deleteById preserves published templates", async () => {
    const t = await service.create({
      name: "wfsvc-test-no-delete",
      version: "1.0.0",
      yamlContent: workflowYaml("no-delete"),
    });
    ids.push(t.id);
    await expect(service.deleteById(t.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 409,
    });
    expect((await service.getById(t.id))?.id).toBe(t.id);
  });

  test("rejects invalid workflow YAML before inserting a template", async () => {
    const name = "wfsvc-test-invalid-yaml";
    await expect(
      service.create({
        name,
        version: "1.0.0",
        yamlContent: "name: missing-schema-version\nsteps: []",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 422 });
    expect(await service.findByNameVersion(name, "1.0.0")).toBeNull();
  });

  test("rejects a workflow with failed cross-field validation before inserting", async () => {
    const name = "wfsvc-test-invalid-workflow";
    await expect(
      service.create({
        name,
        version: "1.0.0",
        yamlContent: `name: invalid-workflow
parameters: []
spec:
  nodeDrafts: []
  nodeRelations:
    - fromId: missing
      toId: missing
      fromSlot: output
      toSlot: input`,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 422 });
    expect(await service.findByNameVersion(name, "1.0.0")).toBeNull();
  });

  test("rejects published templates that bypass static validation", async () => {
    const name = "wfsvc-test-skip-static-validation";
    await expect(
      service.create({
        name,
        version: "1.0.0",
        yamlContent: `name: skip-static-validation
parameters: []
advanced:
  skipStaticValidation: true
spec:
  nodeDrafts: []
  nodeRelations: []`,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 422 });
    expect(await service.findByNameVersion(name, "1.0.0")).toBeNull();
  });

  test("rolls back the template when asset synchronization fails", async () => {
    const name = "wfsvc-test-asset-rollback";
    const failingAssets = {
      inTransaction: () => failingAssets,
      upsertAsset: async () => {
        throw new Error("asset write failed");
      },
    } as unknown as SoftwareAssetService;
    const failingService = new WorkflowTemplateService(db, failingAssets);
    await expect(
      failingService.create({
        name,
        version: "1.0.0",
        yamlContent: workflowYaml("asset-rollback"),
      }),
    ).rejects.toThrow("asset write failed");
    expect(await failingService.findByNameVersion(name, "1.0.0")).toBeNull();
    const assets = await db.select().from(softwareAssets).where(like(softwareAssets.name, name));
    expect(assets).toEqual([]);
  });
});
