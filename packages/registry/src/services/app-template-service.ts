import { appTemplates, type PgDb } from "@kuintessence/db";
import { AppError, type AppTemplateCreate, ErrorCode } from "@kuintessence/shared";
import { and, desc, eq, sql } from "drizzle-orm";

export class AppTemplateService {
  constructor(private db: PgDb) {}

  async create(data: AppTemplateCreate, createdBy?: string) {
    const [row] = await this.db
      .insert(appTemplates)
      .values({
        name: data.name,
        version: data.version,
        description: data.description ?? null,
        spec: data.spec,
        specKind: data.specKind,
        tags: data.tags ?? [],
        createdBy: createdBy ?? null,
      })
      .returning();
    if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR, "Insert returned no rows", 500);
    return row;
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(appTemplates).where(eq(appTemplates.id, id)).limit(1);
    return row && !isSpackCatalogRow(row) ? row : null;
  }

  async findByNameVersion(name: string, version: string) {
    const [row] = await this.db
      .select()
      .from(appTemplates)
      .where(and(eq(appTemplates.name, name), eq(appTemplates.version, version)))
      .limit(1);
    return row ?? null;
  }

  async list(limit = 100) {
    const rows = await this.db
      .select()
      .from(appTemplates)
      .orderBy(desc(appTemplates.createdAt))
      .limit(limit);
    return rows.filter((row) => !isSpackCatalogRow(row));
  }

  async listByTag(tag: string, limit = 100) {
    const all = await this.list(1000);
    return all.filter((row) => row.tags?.includes(tag)).slice(0, limit);
  }

  async updateById(id: string, data: AppTemplateCreate) {
    await this.assertNonCatalogRow(id);
    const [updated] = await this.db
      .update(appTemplates)
      .set({
        name: data.name,
        version: data.version,
        description: data.description ?? null,
        spec: data.spec,
        specKind: data.specKind,
        tags: data.tags ?? [],
        updatedAt: sql`now()`,
      })
      .where(eq(appTemplates.id, id))
      .returning();
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `Template ${id} not found`, 404);
    return updated;
  }

  async deleteById(id: string) {
    await this.assertNonCatalogRow(id);
    const [deleted] = await this.db.delete(appTemplates).where(eq(appTemplates.id, id)).returning();
    if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `Template ${id} not found`, 404);
    return deleted;
  }

  private async assertNonCatalogRow(id: string): Promise<void> {
    const [row] = await this.db
      .select({ id: appTemplates.id, tags: appTemplates.tags })
      .from(appTemplates)
      .where(eq(appTemplates.id, id))
      .limit(1);
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, `Template ${id} not found`, 404);
    if (isSpackCatalogRow(row)) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Spack catalog packages must be managed through the catalog API",
        403,
      );
    }
  }
}

function isSpackCatalogRow(row: { tags: string[] }): boolean {
  return row.tags.includes("spack-catalog");
}
