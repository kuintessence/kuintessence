import type { agents } from "@kuintessence/db";
import type { JobSubmit, PreferenceSpec, RoleName } from "@kuintessence/shared";
import type { QueueSelection } from "../services/queue-registry";

export type AgentRow = typeof agents.$inferSelect;

export interface PlacementContext {
  job: JobSubmit;
  /** Resolved preferences (already merged global -> org -> user). */
  preferences: PreferenceSpec;
  /** Submitting user's role (RBAC). */
  userRole: RoleName;
  /** Submitting user's id. */
  userId: string;
  /** Org id, if any. */
  orgId: string | null;
  /** Resolved queue registry row requested by schedulingStrategy.queueId. */
  queueSelection?: QueueSelection | null;
  /** Resolved soft queue preferences from schedulingStrategy.preferredQueueIds. */
  preferredQueueSelections?: QueueSelection[];
  /** Soft workflow-plan ordering. Hard filters still take precedence. */
  preferredAgentIds?: string[];
}

export interface RejectionTrace {
  stage: string;
  agentId: string;
  reason: string;
}

export interface ScoredAgent {
  agent: AgentRow;
  score: number;
}

export type StageResult = { kind: "pass" } | { kind: "reject"; reason: string };

export interface FilterStage {
  readonly name: string;
  /**
   * Evaluate one agent for this stage. Return pass or reject.
   * The pipeline runs all candidates through each stage; rejected agents
   * drop out and contribute a RejectionTrace.
   */
  evaluate(agent: AgentRow, ctx: PlacementContext): Promise<StageResult> | StageResult;
}

export interface PipelineResult {
  /** Agents that passed all stages, with final auto-stage score. */
  selected: ScoredAgent[];
  /** All rejections across all stages, in order. */
  rejections: RejectionTrace[];
  /** The single best agent (highest score), or null if none passed. */
  best: ScoredAgent | null;
}
