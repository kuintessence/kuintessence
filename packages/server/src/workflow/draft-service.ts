import { type PgDb, workflowDrafts } from "@kuintessence/db";
import type { WorkflowPlacementConfig } from "@kuintessence/shared";
import { and, desc, eq } from "drizzle-orm";

export interface WorkflowDraftInput {
  name: string;
  placementConfig: WorkflowPlacementConfig;
  yaml: string;
}

export class WorkflowDraftService {
  constructor(private readonly db: PgDb) {}

  async create(ownerId: string, input: WorkflowDraftInput) {
    const [row] = await this.db
      .insert(workflowDrafts)
      .values({
        ownerId,
        name: input.name,
        yaml: input.yaml,
        placementConfig: input.placementConfig,
      })
      .returning();
    if (!row) throw new Error("Failed to create workflow draft");
    return row;
  }

  async getOwned(id: string, ownerId: string) {
    const [row] = await this.db
      .select()
      .from(workflowDrafts)
      .where(and(eq(workflowDrafts.id, id), eq(workflowDrafts.ownerId, ownerId)))
      .limit(1);
    return row ?? null;
  }

  async listOwned(ownerId: string) {
    return this.db
      .select()
      .from(workflowDrafts)
      .where(eq(workflowDrafts.ownerId, ownerId))
      .orderBy(desc(workflowDrafts.updatedAt));
  }

  async updateOwned(id: string, ownerId: string, input: WorkflowDraftInput) {
    const [row] = await this.db
      .update(workflowDrafts)
      .set({
        name: input.name,
        yaml: input.yaml,
        placementConfig: input.placementConfig,
        updatedAt: new Date(),
      })
      .where(and(eq(workflowDrafts.id, id), eq(workflowDrafts.ownerId, ownerId)))
      .returning();
    return row ?? null;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const rows = await this.db
      .delete(workflowDrafts)
      .where(and(eq(workflowDrafts.id, id), eq(workflowDrafts.ownerId, ownerId)))
      .returning({ id: workflowDrafts.id });
    return rows.length > 0;
  }
}
