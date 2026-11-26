import { agentMetrics, type PgDb } from "@kuintessence/db";
import { lt } from "drizzle-orm";
import type { AgentMetricsRecorder } from "../grpc/agent-handler";

export class PgAgentMetricsRecorder implements AgentMetricsRecorder {
  constructor(private readonly db: PgDb) {}

  async prune(now = new Date()): Promise<void> {
    await this.db
      .delete(agentMetrics)
      .where(lt(agentMetrics.ts, new Date(now.getTime() - 7 * 86_400_000)));
  }

  async record(
    samples: Array<{
      agentId: string;
      metric: string;
      value: number;
      payload?: Record<string, unknown>;
      ts?: Date;
    }>,
  ): Promise<void> {
    if (samples.length === 0) return;
    await this.db.insert(agentMetrics).values(
      samples.map((s) => ({
        agentId: s.agentId,
        metric: s.metric,
        value: s.value,
        payload: s.payload ?? {},
        ts: s.ts ?? new Date(),
      })),
    );
  }
}
