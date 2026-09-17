// Daily metering usage-summary emitter.
//
// Once per UTC day the Server publishes a `usage.daily` summary for every org
// that subscribes to it: the previous day's raw usage (grouped by org) is
// signed and POSTed via the {@link WebhookDispatcher}. This is distinct from
// the retention rollup tiers — those are compaction, not summaries, so they
// must not fire webhooks. The emitter is the sole producer of webhook events.

import { createLogger } from "@kuintessence/shared";
import type { Logger } from "pino";
import type { QueryRequest, QueryResult, QueryResultRow, TenantScope } from "./metering";
import type { WebhookConfig, WebhookDispatcher, WebhookEvent } from "./metering-webhook";

const USAGE_DAILY = "usage.daily";
const USAGE_MONTHLY = "usage.monthly";

/**
 * Tiers the rollup splits a long window across. A given timestamp lives in
 * exactly one tier (the rollup deletes the source after promoting it), so
 * summing the same window across every tier double-counts nothing.
 */
const ALL_TIERS = ["raw", "hourly", "daily", "monthly"] as const;

export interface MeteringQueryPort {
  query(scope: TenantScope, req: QueryRequest): Promise<QueryResult>;
}

export interface WebhookEmitterRepository {
  listEnabledForEvent(event: string): Promise<WebhookConfig[]>;
  recordResult(id: string, ok: boolean): Promise<void>;
}

export interface MeteringWebhookEmitterDeps {
  query: MeteringQueryPort;
  repo: WebhookEmitterRepository;
  dispatcher: WebhookDispatcher;
  logger?: Logger;
  now?: () => Date;
}

export interface EmitReport {
  orgs: number;
  sent: number;
  failed: number;
}

export class MeteringWebhookEmitter {
  private readonly query: MeteringQueryPort;
  private readonly repo: WebhookEmitterRepository;
  private readonly dispatcher: WebhookDispatcher;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(deps: MeteringWebhookEmitterDeps) {
    this.query = deps.query;
    this.repo = deps.repo;
    this.dispatcher = deps.dispatcher;
    this.logger = deps.logger ?? createLogger("metering-webhook-emitter");
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Emit a `usage.daily` summary for the window `[dayStart, dayEnd)` to each
   * subscribed org. Yesterday is always still in the `raw` tier, so a single
   * raw query is both correct and the cheapest option.
   */
  async emitDailySummary(dayStart: Date, dayEnd: Date): Promise<EmitReport> {
    return this.emit(USAGE_DAILY, (orgId) =>
      this.query.query(
        { kind: "orgs", orgIds: [orgId] },
        {
          from: dayStart.toISOString(),
          to: dayEnd.toISOString(),
          period: "raw",
          grouping: "org",
          limit: 1000,
          offset: 0,
        },
      ),
    );
  }

  /**
   * Emit a `usage.monthly` summary for the window `[monthStart, monthEnd)`.
   * Because the rollup prunes tiers by age, a whole past month is split —
   * the final days remain in `raw` while the rest has rolled to `hourly` /
   * `daily`. The per-org query therefore unions every tier (see
   * {@link queryAllTiers}).
   */
  async emitMonthlySummary(monthStart: Date, monthEnd: Date): Promise<EmitReport> {
    return this.emit(USAGE_MONTHLY, (orgId) => this.queryAllTiers(orgId, monthStart, monthEnd));
  }

  /**
   * Shared fanout core: list subscribed webhooks for `event`, group by org,
   * run `queryOrg` once per org, dispatch, and record results. One org
   * failing (query or dispatch) never aborts the rest — failures are logged
   * and reflected in the returned tally.
   */
  private async emit(
    event: string,
    queryOrg: (orgId: string) => Promise<QueryResult>,
  ): Promise<EmitReport> {
    const webhooks = await this.repo.listEnabledForEvent(event);
    if (webhooks.length === 0) {
      return { orgs: 0, sent: 0, failed: 0 };
    }

    const byOrg = new Map<string, WebhookConfig[]>();
    for (const w of webhooks) {
      const list = byOrg.get(w.orgId) ?? [];
      list.push(w);
      byOrg.set(w.orgId, list);
    }

    let sent = 0;
    let failed = 0;
    for (const [orgId, orgWebhooks] of byOrg) {
      try {
        const result = await queryOrg(orgId);
        const evt: WebhookEvent = {
          event,
          orgId,
          payload: result,
          occurredAt: this.now(),
        };
        const results = await this.dispatcher.fanout(evt, orgWebhooks);
        for (const { webhookId, result: r } of results) {
          await this.repo.recordResult(webhookId, r.ok);
          if (r.ok) sent += 1;
          else failed += 1;
        }
      } catch (err) {
        this.logger.warn({ err, orgId }, "metering-webhook-emitter: org summary failed");
      }
    }

    return { orgs: byOrg.size, sent, failed };
  }

  /**
   * Union an org's usage across all four retention tiers for `[from, to)`,
   * summing per groupKey. A given timestamp lives in exactly one tier (the
   * rollup deletes the source on promotion), so the sum is double-count-free.
   */
  private async queryAllTiers(orgId: string, from: Date, to: Date): Promise<QueryResult> {
    const merged = new Map<string, QueryResultRow>();
    for (const period of ALL_TIERS) {
      const r = await this.query.query(
        { kind: "orgs", orgIds: [orgId] },
        {
          from: from.toISOString(),
          to: to.toISOString(),
          period,
          grouping: "org",
          limit: 1000,
          offset: 0,
        },
      );
      for (const row of r.rows) {
        const cur = merged.get(row.groupKey);
        if (cur) {
          cur.cpuCoreSeconds += row.cpuCoreSeconds;
          cur.gpuSeconds += row.gpuSeconds;
          cur.memoryMbSeconds += row.memoryMbSeconds;
          cur.storageMbSeconds += row.storageMbSeconds;
          cur.networkEgressMb += row.networkEgressMb;
          cur.jobCount += row.jobCount;
        } else {
          merged.set(row.groupKey, { ...row });
        }
      }
    }
    const rows = [...merged.values()];
    return { rows, total: rows.length };
  }
}
