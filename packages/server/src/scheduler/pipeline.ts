import { createLogger } from "@kuintessence/shared";
import type {
  AgentRow,
  FilterStage,
  PipelineResult,
  PlacementContext,
  RejectionTrace,
  ScoredAgent,
} from "./types";

const logger = createLogger("placement-pipeline");

export class PlacementPipeline {
  constructor(
    private stages: FilterStage[],
    /** Optional shared score map: stages may write into this map. */
    private scoreSink: Map<string, number> = new Map(),
  ) {}

  async run(candidates: AgentRow[], ctx: PlacementContext): Promise<PipelineResult> {
    const rejections: RejectionTrace[] = [];
    let surviving: AgentRow[] = [...candidates];

    for (const stage of this.stages) {
      const next: AgentRow[] = [];
      for (const agent of surviving) {
        const result = await stage.evaluate(agent, ctx);
        if (result.kind === "reject") {
          rejections.push({
            stage: stage.name,
            agentId: agent.agentId,
            reason: result.reason,
          });
          continue;
        }
        next.push(agent);
      }
      surviving = next;
      logger.debug({ stage: stage.name, surviving: surviving.length }, "Stage complete");
      if (surviving.length === 0) break;
    }

    const scored: ScoredAgent[] = surviving
      .map((agent) => ({ agent, score: this.scoreSink.get(agent.agentId) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0] ?? null;
    return { selected: scored, rejections, best };
  }
}
