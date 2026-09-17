import {
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  workflowTemplates,
} from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  type SoftwareAssetRef,
  type WorkflowTemplateCreate,
  workflowDsl,
} from "@kuintessence/shared";
import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import { parse } from "yaml";
import { platformPublicGrants, type SoftwareAssetService } from "./software-asset-service";

export interface WorkflowTemplateListQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  tag?: string;
}

export interface WorkflowTemplatePage {
  templates: Array<typeof workflowTemplates.$inferSelect>;
  tags: string[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

export class WorkflowTemplateService {
  constructor(
    private db: PgDb,
    private readonly assets?: SoftwareAssetService,
  ) {}

  async create(data: WorkflowTemplateCreate, createdBy?: string) {
    return (await this.createWithStatus(data, createdBy)).template;
  }

  async createWithStatus(data: WorkflowTemplateCreate, createdBy?: string) {
    const normalized = normalizeTemplateInput(data);
    const workflow = parseWorkflowTemplate(normalized.yamlContent);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-template:${normalized.name}:${normalized.version}`}, 0))`,
      );
      const existing = await tx
        .select()
        .from(workflowTemplates)
        .where(
          and(
            eq(workflowTemplates.name, normalized.name),
            eq(workflowTemplates.version, normalized.version),
          ),
        )
        .orderBy(desc(workflowTemplates.createdAt));
      if (existing.length > 0) {
        const identical = existing.find((candidate) => matchesTemplate(candidate, normalized));
        if (identical) return { template: identical, created: false };
        throw versionConflict(normalized.name, normalized.version);
      }
      const [inserted] = await tx
        .insert(workflowTemplates)
        .values({
          name: normalized.name,
          version: normalized.version,
          description: normalized.description ?? null,
          yamlContent: normalized.yamlContent,
          tags: normalized.tags ?? [],
          createdBy: createdBy ?? null,
        })
        .returning();
      if (!inserted) throw new AppError(ErrorCode.INTERNAL_ERROR, "Insert returned no rows", 500);
      await this.syncAsset(inserted, createdBy ?? null, workflow, tx);
      return { template: inserted, created: true };
    });
  }

  async getById(id: string) {
    const [row] = await this.db
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByNameVersion(name: string, version: string) {
    const [row] = await this.db
      .select()
      .from(workflowTemplates)
      .where(
        and(
          eq(workflowTemplates.name, name),
          eq(workflowTemplates.version, version),
          workflowCatalogVisibility(),
        ),
      )
      .orderBy(desc(workflowTemplates.createdAt), desc(workflowTemplates.id))
      .limit(1);
    return row ?? null;
  }

  private async listByNameVersion(name: string, version: string) {
    return this.db
      .select()
      .from(workflowTemplates)
      .where(and(eq(workflowTemplates.name, name), eq(workflowTemplates.version, version)))
      .orderBy(desc(workflowTemplates.createdAt));
  }

  async list(limit = 100) {
    return (await this.listPage({ pageSize: limit })).templates;
  }

  async listByTag(tag: string, limit = 100) {
    return (await this.listPage({ tag, pageSize: limit })).templates;
  }

  async listPage(input: WorkflowTemplateListQuery = {}): Promise<WorkflowTemplatePage> {
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 24, 100));
    const requestedPage = Math.max(1, input.page ?? 1);
    const query = input.q?.trim() ?? "";
    const tag = input.tag?.trim() ?? "";
    const filter = and(
      workflowCatalogVisibility(),
      query.length > 0
        ? sql`(
            ${ilike(workflowTemplates.name, `%${escapeLike(query)}%`)} OR
            ${ilike(workflowTemplates.version, `%${escapeLike(query)}%`)} OR
            ${ilike(workflowTemplates.description, `%${escapeLike(query)}%`)} OR
            EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(${workflowTemplates.tags}) AS workflow_tag(value)
              WHERE workflow_tag.value ILIKE ${`%${escapeLike(query)}%`}
            )
          )`
        : undefined,
      tag.length > 0
        ? sql`(
            CASE
              WHEN jsonb_typeof(${workflowTemplates.tags}) = 'array'
                THEN ${workflowTemplates.tags}
              ELSE '[]'::jsonb
            END
          ) @> ${JSON.stringify([tag])}::jsonb`
        : undefined,
    );
    const [totalRows, tagRows] = await Promise.all([
      this.db.select({ total: count() }).from(workflowTemplates).where(filter),
      this.db.execute<{ tag: string }>(sql`
        SELECT DISTINCT workflow_tag.value AS tag
        FROM ${workflowTemplates}
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(${workflowTemplates.tags}) = 'array'
              THEN ${workflowTemplates.tags}
            ELSE '[]'::jsonb
          END
        ) AS workflow_tag(value)
        WHERE ${workflowCatalogVisibility()}
        ORDER BY workflow_tag.value
      `),
    ]);
    const total = totalRows[0]?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const templates = await this.db
      .select()
      .from(workflowTemplates)
      .where(filter)
      .orderBy(desc(workflowTemplates.createdAt), desc(workflowTemplates.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      templates,
      tags: tagRows.map((row) => row.tag),
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
    };
  }

  async updateById(id: string, data: WorkflowTemplateCreate, createdBy?: string) {
    return (await this.updateByIdWithStatus(id, data, createdBy)).template;
  }

  async updateByIdWithStatus(id: string, data: WorkflowTemplateCreate, createdBy?: string) {
    const normalized = normalizeTemplateInput(data);
    const source = await this.getById(id);
    if (!source) throw new AppError(ErrorCode.NOT_FOUND, `Template ${id} not found`, 404);
    if (matchesTemplate(source, normalized)) return { template: source, created: false };

    const existing = await this.listByNameVersion(normalized.name, normalized.version);
    if (existing.length > 0) {
      const identical = existing.find((row) => matchesTemplate(row, normalized));
      if (identical) return { template: identical, created: false };
      throw versionConflict(normalized.name, normalized.version);
    }
    return this.createWithStatus(normalized, createdBy);
  }

  async deleteById(id: string) {
    const template = await this.getById(id);
    if (!template) throw new AppError(ErrorCode.NOT_FOUND, `Template ${id} not found`, 404);
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Published workflow templates are immutable and cannot be deleted. Publish a replacement version instead.",
      409,
    );
  }

  private async syncAsset(
    row: typeof workflowTemplates.$inferSelect,
    createdBy: string | null,
    workflow: WorkflowDocument,
    tx: Parameters<Parameters<PgDb["transaction"]>[0]>[0],
  ) {
    if (!this.assets) return;
    const refs = collectWorkflowRefs(workflow);
    await this.assets.inTransaction(tx).upsertAsset({
      kind: "workflow-template",
      name: row.name,
      version: row.version,
      source: "platform-fork",
      lifecycle: "published",
      visibility: "platform-public",
      trustedForGlobalUse: true,
      createdBy,
      legacyRef: { field: "workflowTemplateId", value: row.id },
      payload: {
        kind: "workflow-template",
        workflowTemplateId: row.id,
        usecaseRefs: refs.usecaseRefs,
        packageRefs: refs.packageRefs,
        yamlContent: row.yamlContent,
      },
      provenance: { source: "platform-fork", legacyTable: "workflow_templates" },
      grants: platformPublicGrants(),
    });
  }
}

function matchesTemplate(
  row: typeof workflowTemplates.$inferSelect,
  data: WorkflowTemplateCreate,
): boolean {
  return (
    row.name === data.name &&
    row.version === data.version &&
    row.description === (data.description ?? null) &&
    row.yamlContent === data.yamlContent &&
    sameTags(row.tags, data.tags ?? [])
  );
}

function sameTags(left: string[], right: string[]): boolean {
  const normalizedLeft = normalizeTags(left);
  const normalizedRight = normalizeTags(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((tag, index) => tag === normalizedRight[index])
  );
}

function normalizeTemplateInput(data: WorkflowTemplateCreate): WorkflowTemplateCreate {
  return { ...data, tags: normalizeTags(data.tags ?? []) };
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags)].sort((left, right) => left.localeCompare(right));
}

function workflowCatalogVisibility() {
  const binding = sql`${ecosystemReleaseAssets.kind} = 'workflow-template' AND ${ecosystemReleaseAssets.workflowTemplateId} = ${workflowTemplates.id}`;
  const anyBinding = sql`EXISTS (SELECT 1 FROM ${ecosystemReleaseAssets} WHERE ${binding})`;
  const activeBinding = sql`EXISTS (
    SELECT 1
    FROM ${ecosystemReleaseAssets}
    INNER JOIN ${ecosystemReleases} ON ${ecosystemReleaseAssets.releaseId} = ${ecosystemReleases.id}
    WHERE ${binding} AND ${ecosystemReleases.status} = 'active'
  )`;
  return sql`(${anyBinding} = false OR ${activeBinding})`;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function versionConflict(name: string, version: string): AppError {
  return new AppError(
    ErrorCode.VALIDATION_ERROR,
    `Workflow template ${name}@${version} already exists with different content. Choose a new version.`,
    409,
  );
}

type WorkflowDocument = ReturnType<typeof parseWorkflowTemplate>;

function parseWorkflowTemplate(yamlContent: string) {
  let parsed: unknown;
  try {
    parsed = parse(yamlContent);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Workflow template YAML is invalid", 422);
  }
  const schemaResult = workflowDsl.WorkflowSchema.safeParse(parsed);
  if (!schemaResult.success) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Workflow template failed schema validation: ${formatIssues(schemaResult.error.issues)}`,
      422,
    );
  }
  if (schemaResult.data.advanced?.skipStaticValidation === true) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Published workflow templates cannot skip static validation",
      422,
    );
  }
  const staticErrors = workflowDsl.validateWorkflow(schemaResult.data);
  if (staticErrors.length > 0) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Workflow template failed static validation: ${staticErrors.slice(0, 5).join("; ")}`,
      422,
    );
  }
  return schemaResult.data;
}

function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function collectWorkflowRefs(workflow: WorkflowDocument): {
  usecaseRefs: SoftwareAssetRef[];
  packageRefs: SoftwareAssetRef[];
} {
  const usecaseRefs: SoftwareAssetRef[] = [];
  const packageRefs: SoftwareAssetRef[] = [];
  for (const node of workflow.spec.nodeDrafts) {
    if (node.type !== "SoftwareUsecaseComputing") continue;
    if (node.usecaseVersionId && node.softwareVersionId) {
      usecaseRefs.push({ kind: "usecase", id: node.usecaseVersionId });
      packageRefs.push({ kind: "spack-package", id: node.softwareVersionId });
    } else if (node.usecaseRef && node.softwareRef) {
      usecaseRefs.push({ kind: "usecase", ...node.usecaseRef });
      packageRefs.push({ kind: "spack-package", ...node.softwareRef });
    }
  }
  return { usecaseRefs: uniqueRefs(usecaseRefs), packageRefs: uniqueRefs(packageRefs) };
}

function uniqueRefs(refs: SoftwareAssetRef[]): SoftwareAssetRef[] {
  return [
    ...new Map(
      refs.map((ref) => [
        JSON.stringify([
          ref.kind,
          ref.id ?? "",
          ref.source ?? "",
          ref.name ?? "",
          ref.version ?? "",
          ref.providerOrgId ?? "",
        ]),
        ref,
      ]),
    ).values(),
  ];
}
