import { type PgDb, placementPlans, workflowRuns } from "@kuintessence/db";
import {
  canonicalJson,
  type ExecutionIdentity,
  type PlacementConstraint,
  type PlacementObjective,
  type PlannerMode,
  type Workflow,
  type WorkflowPlacementConfig,
  WorkflowPlacementConfigSchema,
} from "@kuintessence/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  planSandboxPlacement,
  type SandboxPlannerRequest,
  type SandboxPlannerResult,
} from "../scheduler/sandbox-planner";

export interface PlacementPlanNodeRecord {
  nodeId: string;
  executionIdentity: ExecutionIdentity;
  preferredAgentId: string;
  fallbackAgentIds: string[];
  constraint: PlacementConstraint | null;
  objective: PlacementObjective;
  estimatedInputBytes: number;
  estimatedOutputBytes: number;
}

export interface PlacementPlanRecord {
  id: string;
  workflowRunId: string;
  version: number;
  plannerMode: PlannerMode;
  trigger: string;
  nodes: PlacementPlanNodeRecord[];
  objective: PlacementObjective;
  budgetCap: number | null;
  budgetStatus: "within-cap" | "awaiting-approval" | "approved";
  supersedesPlanId: string | null;
  createdAt: Date;
}

export interface PlacementPlanDraft {
  workflowRunId: string;
  plannerMode: PlannerMode;
  trigger: string;
  nodes: PlacementPlanNodeRecord[];
  objective: PlacementObjective;
  budgetCap: number | null;
  budgetStatus: "within-cap" | "awaiting-approval";
}

export interface PlacementPlanStore {
  saveIfChanged(draft: PlacementPlanDraft): Promise<PlacementPlanRecord>;
  list(workflowRunId: string): Promise<PlacementPlanRecord[]>;
  approve(workflowRunId: string, planId: string): Promise<PlacementPlanRecord | null>;
}

export interface PlacementPlanBuildInput {
  config: WorkflowPlacementConfig;
  request: Omit<SandboxPlannerRequest, "mode" | "budgetCap">;
  executionIdentities?: Readonly<Record<string, ExecutionIdentity>>;
}

class PlacementApprovalConflict extends Error {}

export type PlacementPlanBuilder = (
  workflowRunId: string,
  trigger: string,
  context?: { workflow: Workflow; config: WorkflowPlacementConfig },
) => Promise<PlacementPlanBuildInput>;

function planSignature(
  plan: Pick<PlacementPlanDraft, "nodes" | "objective" | "budgetCap">,
): string {
  return canonicalJson({ nodes: plan.nodes, objective: plan.objective, budgetCap: plan.budgetCap });
}

function dbRecord(row: typeof placementPlans.$inferSelect): PlacementPlanRecord {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    version: row.version,
    plannerMode: row.plannerMode as PlannerMode,
    trigger: row.trigger,
    nodes: row.nodes as unknown as PlacementPlanNodeRecord[],
    objective: row.objective as PlacementObjective,
    budgetCap: row.budgetCap,
    budgetStatus: row.budgetStatus as PlacementPlanRecord["budgetStatus"],
    supersedesPlanId: row.supersedesPlanId,
    createdAt: row.createdAt,
  };
}

export class PgPlacementPlanStore implements PlacementPlanStore {
  constructor(private readonly db: PgDb) {}

  async saveIfChanged(draft: PlacementPlanDraft): Promise<PlacementPlanRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${draft.workflowRunId}))`);
      const [latest] = await tx
        .select()
        .from(placementPlans)
        .where(eq(placementPlans.workflowRunId, draft.workflowRunId))
        .orderBy(desc(placementPlans.version))
        .limit(1);
      if (latest && planSignature(draft) === planSignature(dbRecord(latest))) {
        return dbRecord(latest);
      }
      const [saved] = await tx
        .insert(placementPlans)
        .values({
          workflowRunId: draft.workflowRunId,
          version: (latest?.version ?? 0) + 1,
          plannerMode: draft.plannerMode,
          trigger: draft.trigger,
          nodes: draft.nodes as unknown as Array<Record<string, unknown>>,
          objective: draft.objective,
          budgetCap: draft.budgetCap,
          budgetStatus: draft.budgetStatus,
          supersedesPlanId: latest?.id ?? null,
        })
        .returning();
      if (!saved) throw new Error("placement plan was not persisted");
      if (draft.budgetStatus === "awaiting-approval") {
        await tx
          .update(workflowRuns)
          .set({ status: "awaiting_approval", updatedAt: new Date() })
          .where(
            and(eq(workflowRuns.id, draft.workflowRunId), eq(workflowRuns.status, "submitted")),
          );
      }
      return dbRecord(saved);
    });
  }

  async list(workflowRunId: string): Promise<PlacementPlanRecord[]> {
    const rows = await this.db
      .select()
      .from(placementPlans)
      .where(eq(placementPlans.workflowRunId, workflowRunId))
      .orderBy(desc(placementPlans.version));
    return rows.map(dbRecord);
  }

  async approve(workflowRunId: string, planId: string): Promise<PlacementPlanRecord | null> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workflowRunId}))`);
        const [updated] = await tx
          .update(placementPlans)
          .set({ budgetStatus: "approved" })
          .where(
            and(
              eq(placementPlans.id, planId),
              eq(placementPlans.workflowRunId, workflowRunId),
              eq(placementPlans.budgetStatus, "awaiting-approval"),
            ),
          )
          .returning();
        if (!updated) return null;
        const queued = await tx
          .update(workflowRuns)
          .set({ status: "queued", queuedAt: new Date(), updatedAt: new Date() })
          .where(
            and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, "awaiting_approval")),
          )
          .returning({ id: workflowRuns.id });
        if (queued.length !== 1) throw new PlacementApprovalConflict();
        return dbRecord(updated);
      });
    } catch (error) {
      if (error instanceof PlacementApprovalConflict) return null;
      throw error;
    }
  }
}

function sumBytes(values: readonly { bytes: number }[] | undefined): number {
  return values?.reduce((total, value) => total + value.bytes, 0) ?? 0;
}

function planNodes(
  input: PlacementPlanBuildInput,
  result: SandboxPlannerResult,
): PlacementPlanNodeRecord[] {
  return result.assignments.map((assignment) => {
    const source = input.request.nodes.find((node) => node.id === assignment.nodeId);
    return {
      nodeId: assignment.nodeId,
      executionIdentity:
        input.executionIdentities?.[assignment.nodeId] ?? input.config.defaultExecutionIdentity,
      preferredAgentId: assignment.agentId,
      fallbackAgentIds: assignment.fallbackAgentIds,
      constraint: source?.constraint ?? null,
      objective: assignment.objective,
      estimatedInputBytes: sumBytes(source?.inputs),
      estimatedOutputBytes: sumBytes(source?.outputs),
    };
  });
}

export class PlacementPlanService {
  constructor(
    private readonly store: PlacementPlanStore,
    private readonly builder: PlacementPlanBuilder,
  ) {}

  async prepare(
    workflowRunId: string,
    workflow: Workflow,
    rawConfig: WorkflowPlacementConfig,
  ): Promise<"within-cap" | "awaiting-approval"> {
    const config = WorkflowPlacementConfigSchema.parse(rawConfig);
    const input = await this.builder(workflowRunId, "workflow-submit", { workflow, config });
    const plan = await this.persist(workflowRunId, "workflow-submit", input);
    return plan.budgetStatus === "awaiting-approval" ? "awaiting-approval" : "within-cap";
  }

  async replan(workflowRunId: string, trigger: string): Promise<PlacementPlanRecord> {
    return this.persist(workflowRunId, trigger, await this.builder(workflowRunId, trigger));
  }

  list(workflowRunId: string): Promise<PlacementPlanRecord[]> {
    return this.store.list(workflowRunId);
  }

  approve(workflowRunId: string, planId: string): Promise<PlacementPlanRecord | null> {
    return this.store.approve(workflowRunId, planId);
  }

  private async persist(
    workflowRunId: string,
    trigger: string,
    input: PlacementPlanBuildInput,
  ): Promise<PlacementPlanRecord> {
    const result = planSandboxPlacement({
      ...input.request,
      mode: input.config.plannerMode,
      budgetCap: input.config.budgetCap,
    });
    return this.store.saveIfChanged({
      workflowRunId,
      plannerMode: result.mode,
      trigger,
      nodes: planNodes(input, result),
      objective: result.objective,
      budgetCap: input.config.budgetCap,
      budgetStatus: result.budgetStatus,
    });
  }
}
