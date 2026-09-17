/**
 * placement trace types shared by Server, Web, and CLI.
 *
 * The placement pipeline (compute health → permissions → queue → software →
 * billing → load → urgency → install rights → manual → auto) emits one of
 * these whenever it
 * runs, either as a pre-submit preview (POST /api/scheduler/preview-placement)
 * or as a post-decision audit record persisted on the job (GET
 * /api/jobs/:id/placement).
 *
 * The shape is intentionally small and JSON-serializable so it can be stored
 * verbatim in a JSONB column and rendered by the React stepper without
 * additional decoding.
 */
import { z } from "zod";

/**
 * Canonical names of the placement stages, in pipeline order. Both the
 * runtime trace builder and the Web stepper consult this list so a missing
 * stage in the trace surfaces as an obviously-missing column in the UI.
 */
export const PLACEMENT_STAGE_NAMES = [
  "compute-health",
  "permission",
  "queue",
  "software",
  "billing",
  "load",
  "urgency",
  "install-rights",
  "manual",
  "auto",
] as const;

export type PlacementStageName = (typeof PLACEMENT_STAGE_NAMES)[number];

/** A single agent's identity inside a trace — kept lean to fit in JSONB. */
export const PlacementAgentSummarySchema = z.object({
  agentId: z.string(),
  siteName: z.string().optional(),
  schedulerType: z.string().optional(),
  schedulerVersion: z.string().optional(),
  /** Final auto-stage score; only present on the survivor list. */
  score: z.number().optional(),
});
export type PlacementAgentSummary = z.infer<typeof PlacementAgentSummarySchema>;

/** One agent's rejection at a specific stage. */
export const PlacementRejectionSchema = z.object({
  agent: PlacementAgentSummarySchema,
  reason: z.string(),
});
export type PlacementRejection = z.infer<typeof PlacementRejectionSchema>;

export const PlacementPreferenceRejectionSchema = z.object({
  queueId: z.string().min(1),
  code: z.string().min(1),
  reason: z.string().min(1),
});
export type PlacementPreferenceRejection = z.infer<typeof PlacementPreferenceRejectionSchema>;

/** Aggregate result for one stage of the pipeline. */
export const PlacementStageResultSchema = z.object({
  /** Canonical stage name; matches PLACEMENT_STAGE_NAMES. */
  name: z.string(),
  /** Number of agents that entered this stage (passed all earlier stages). */
  inputCount: z.number().int().nonnegative(),
  /** Agents that survived this stage. */
  passed: z.array(PlacementAgentSummarySchema),
  /** Agents this stage rejected, with reasons. */
  rejected: z.array(PlacementRejectionSchema),
});
export type PlacementStageResult = z.infer<typeof PlacementStageResultSchema>;

/**
 * Full placement trace covering all stages.
 *
 * `finalDecision` is the agent the auto-stage scored highest. It is null when
 * the pipeline rejected every candidate.
 *
 * The trace MUST contain one entry per stage in pipeline order, even when the
 * stage was a no-op (zero rejections). This invariant is what lets the Web
 * stepper render a column for every stage without inventing placeholders.
 */
export const PlacementTraceSchema = z.object({
  generatedAt: z.string(),
  /** True when this trace came from /preview-placement (no DB persistence). */
  preview: z.boolean(),
  candidateCount: z.number().int().nonnegative(),
  stages: z.array(PlacementStageResultSchema),
  softPreferenceRejections: z.array(PlacementPreferenceRejectionSchema).optional(),
  finalDecision: PlacementAgentSummarySchema.nullable(),
});
export type PlacementTrace = z.infer<typeof PlacementTraceSchema>;
