import type {
  PlacementAgentSummary,
  PlacementStageResult,
  PlacementTrace,
} from "@kuintessence/shared";
import { PLACEMENT_STAGE_NAMES } from "@kuintessence/shared";
import type { AgentRow, FilterStage, PlacementContext } from "./types";

/**
 * collect-all-stages placement runner.
 *
 * The production `PlacementPipeline` short-circuits as soon as a stage
 * leaves zero survivors. That behaviour is correct for the dispatch path
 * (no point asking later stages anything), but it makes the trace useless
 * for UI explainability — the user sees "Permission rejected everyone" and
 * the rest of the pipeline is silent.
 *
 * `runPlacementWithTrace` walks every stage regardless of survivor count.
 * Each stage receives the agents that survived the previous stage; if zero
 * survivors enter a stage, the stage is recorded with `inputCount: 0` and
 * empty pass/reject lists. The auto-stage (last) is special: it never
 * rejects, only scores, so its survivors carry a final `score`.
 *
 * The shared map referenced by `AutoFilter` and the `scoreSink` constructor
 * argument lets the auto stage write per-agent scores back into the trace.
 */
export interface PlacementTraceInput {
  candidates: AgentRow[];
  context: PlacementContext;
  stages: FilterStage[];
  /**
   * The same shared score sink wired into the auto stage. After the run we
   * read it back to populate `finalDecision.score` and the survivor scores.
   */
  scoreSink: Map<string, number>;
  /** True when invoked from /preview-placement; false for post-decision audit. */
  preview: boolean;
}

function summarize(agent: AgentRow, score?: number): PlacementAgentSummary {
  const out: PlacementAgentSummary = {
    agentId: agent.agentId,
    siteName: agent.siteName,
    schedulerType: agent.schedulerType,
    schedulerVersion: agent.schedulerVersion,
  };
  if (score !== undefined) out.score = score;
  return out;
}

export async function runPlacementWithTrace(input: PlacementTraceInput): Promise<PlacementTrace> {
  const { candidates, context, stages, scoreSink, preview } = input;

  const stageResults: PlacementStageResult[] = [];
  let surviving: AgentRow[] = [...candidates];

  for (const stage of stages) {
    const inputCount = surviving.length;
    const passed: AgentRow[] = [];
    const rejected: { agent: AgentRow; reason: string }[] = [];

    for (const agent of surviving) {
      const result = await stage.evaluate(agent, context);
      if (result.kind === "reject") {
        rejected.push({ agent, reason: result.reason });
      } else {
        passed.push(agent);
      }
    }

    stageResults.push({
      name: stage.name,
      inputCount,
      passed: passed.map((a) =>
        // Auto stage attaches the freshly-written score; earlier stages don't.
        stage.name === "auto" ? summarize(a, scoreSink.get(a.agentId)) : summarize(a),
      ),
      rejected: rejected.map(({ agent, reason }) => ({
        agent: summarize(agent),
        reason,
      })),
    });

    surviving = passed;
  }

  // Final decision: highest score among auto-stage survivors.
  // We pull from the recorded auto stage so the decision is deterministically
  // tied to what the trace shows.
  const autoStage = stageResults.find((s) => s.name === "auto");
  const survivorList = autoStage?.passed ?? [];
  let finalDecision: PlacementAgentSummary | null = null;
  if (survivorList.length > 0) {
    finalDecision = [...survivorList].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
  }

  return {
    generatedAt: new Date().toISOString(),
    preview,
    candidateCount: candidates.length,
    stages: stageResults,
    finalDecision,
  };
}

/**
 * Defensive helper: ensure the trace contains every canonical stage in
 * pipeline order. Useful for callers that want to assert the contract
 * before persisting; the runner above already does the right thing when
 * fed a full placement pipeline, so this is effectively a sanity check.
 */
export function isFullPlacementTrace(trace: PlacementTrace): boolean {
  if (trace.stages.length !== PLACEMENT_STAGE_NAMES.length) return false;
  return trace.stages.every((stage, idx) => stage.name === PLACEMENT_STAGE_NAMES[idx]);
}

export const isFullEightStageTrace = isFullPlacementTrace;
