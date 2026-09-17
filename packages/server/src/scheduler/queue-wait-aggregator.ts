import { agents, jobs, type PgDb } from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import type { Logger } from "pino";
import { percentile } from "./percentile";

interface WaitRow {
  agentId: string;
  waitSec: number;
}

/** Pure: group wait seconds by agent, take p95 per agent (rounded to int). */
export function aggregateP95ByAgent(rows: WaitRow[]): Map<string, number> {
  const byAgent = new Map<string, number[]>();
  for (const r of rows) {
    const list = byAgent.get(r.agentId);
    if (list) list.push(r.waitSec);
    else byAgent.set(r.agentId, [r.waitSec]);
  }
  const out = new Map<string, number>();
  for (const [agentId, waits] of byAgent) {
    out.set(agentId, Math.round(percentile(waits, 0.95)));
  }
  return out;
}

export interface QueueWaitAggregatorOptions {
  /** Only consider jobs submitted within this many seconds. Default 7 days. */
  lookbackSec?: number;
  now?: () => number;
  logger?: Logger;
}

const DEFAULT_LOOKBACK_SEC = 7 * 24 * 3600;

/**
 * Recompute each agent's historical P95 queue-wait from `jobs` history
 * (wait = started_at - submitted_at) and write it to
 * `agents.historical_p95_wait_sec`. The queue-wait scorer reads that column.
 * Best-effort: a failed write is logged, not thrown.
 */
export class QueueWaitAggregator {
  private readonly db: PgDb;
  private readonly lookbackSec: number;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(db: PgDb, opts: QueueWaitAggregatorOptions = {}) {
    this.db = db;
    this.lookbackSec = opts.lookbackSec ?? DEFAULT_LOOKBACK_SEC;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? createLogger("queue-wait-aggregator");
  }

  async recomputeAll(): Promise<number> {
    const since = new Date(this.now() - this.lookbackSec * 1000);
    const rows = await this.db
      .select({
        agentId: jobs.agentId,
        submittedAt: jobs.submittedAt,
        startedAt: jobs.startedAt,
      })
      .from(jobs)
      .where(and(isNotNull(jobs.agentId), isNotNull(jobs.startedAt), gte(jobs.submittedAt, since)));

    const waits: WaitRow[] = [];
    for (const r of rows) {
      if (!r.agentId || !r.startedAt) continue;
      const waitSec = Math.max(0, (r.startedAt.getTime() - r.submittedAt.getTime()) / 1000);
      waits.push({ agentId: r.agentId, waitSec });
    }

    const p95 = aggregateP95ByAgent(waits);
    let updated = 0;
    for (const [agentId, value] of p95) {
      try {
        await this.db
          .update(agents)
          .set({ historicalP95WaitSec: value })
          .where(eq(agents.agentId, agentId));
        updated++;
      } catch (err) {
        this.logger.warn({ err, agentId, value }, "failed to write historical_p95_wait_sec");
      }
    }
    return updated;
  }
}
