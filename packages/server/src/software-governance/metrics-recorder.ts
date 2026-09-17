import { agentMetrics, type PgDb } from "@kuintessence/db";
import type { AgentMetricsRecorder } from "../grpc/agent-handler";

/**
 * append-only metrics recorder. Single batch insert per
 * heartbeat so the ingest path stays bounded.
 *
 * Retention is not enforced by this recorder.
 * The schema is intentionally TimescaleDB-friendly (generic
 * agent_id / metric / value / ts shape) so the swap is one
 * `SELECT create_hypertable('agent_metrics', 'ts')` away.
 */
export class PgAgentMetricsRecorder implements AgentMetricsRecorder {
  constructor(private readonly db: PgDb) {}

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
