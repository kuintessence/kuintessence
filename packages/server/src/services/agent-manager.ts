import { agentMetrics, agents, auditLog, type PgDb } from "@kuintessence/db";
import {
  type AgentGpuSample,
  AgentGpuSampleSchema,
  type AgentHeartbeat,
  type AgentRegister,
  AppError,
  ErrorCode,
} from "@kuintessence/shared";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { agentPlatformTuple, agentProviderTuple } from "../authz/projection";
import type { AuthzService, AuthzTuple } from "../authz/service";

/** Latest live telemetry merged onto an agent row from `agent_metrics`. */
interface AgentTelemetry {
  diskUsedPercent?: number;
  gpus: AgentGpuSample[];
}

export type AgentWithTelemetry = typeof agents.$inferSelect & AgentTelemetry;

export type ComputeHealthStatus = "unknown" | "ready" | "unavailable";

export interface ComputeHealthReport {
  state: ComputeHealthStatus;
  observedAtUnixMs: bigint | number;
  nodeCount: number;
  operationalNodeCount: number;
  reason?: string;
}

export type AgentRegistrationInput = AgentRegister;

export type AgentHeartbeatInput = Omit<AgentHeartbeat, "computeHealth"> & {
  computeHealth?: ComputeHealthReport;
};

export interface AgentManagerOptions {
  computeHealthMaxAgeSec?: number;
  computeHealthMaxFutureSkewSec?: number;
  now?: () => Date;
}

const DEFAULT_COMPUTE_HEALTH_MAX_AGE_SEC = 120;
const DEFAULT_COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC = 5;
const COMPUTE_HEALTH_REASON_CODES = new Set([
  "unknown",
  "scheduler_unavailable",
  "scheduler_command_failed",
  "no_operational_nodes",
  "invalid_scheduler_state",
  "unsupported_scheduler",
  "probe_timeout",
  "invalid_observed_at",
  "invalid_health_report",
]);

export class AgentManager {
  constructor(
    private db: PgDb,
    private readonly authz?: AuthzService,
    private readonly options: AgentManagerOptions = {},
  ) {}

  /**
   * Register or re-register an agent. Idempotent via PG upsert.
   *
   * Caller MUST validate `data` against AgentRegisterSchema before calling.
   * Used by Task 9 connectRPC handler (proto enums validate at the wire).
   * If you ever expose this via REST, add zValidator at the route layer.
   */
  async register(data: AgentRegistrationInput) {
    const now = this.now();
    const hasProviderInput = Object.hasOwn(data, "providerOrgId");
    const computeHealth = registrationComputeHealth(data.computeHealthV1);
    const [existing] = await this.db
      .select({ providerOrgId: agents.providerOrgId })
      .from(agents)
      .where(eq(agents.agentId, data.agentId))
      .limit(1);
    const nextProviderOrgId = hasProviderInput
      ? (data.providerOrgId ?? null)
      : (existing?.providerOrgId ?? null);
    const [row] = await this.db
      .insert(agents)
      .values({
        agentId: data.agentId,
        siteName: data.siteName,
        providerOrgId: nextProviderOrgId,
        siteId: data.siteId ?? data.siteName,
        clusterId: data.clusterId ?? data.agentId,
        topology: data.topology ?? {},
        schedulerType: data.schedulerType,
        schedulerVersion: data.schedulerVersion,
        status: "online",
        lastHeartbeat: now,
        ...computeHealth,
        rootMode: data.rootMode ?? false,
        sandboxReadiness: data.sandboxReadiness ?? "critical",
        sandboxCapabilities: data.sandboxCapabilities ?? {},
        sandboxRuntimeCache: data.sandboxRuntimeCache ?? [],
        restrictedDataIsolation: data.restrictedDataIsolation ?? false,
      })
      .onConflictDoUpdate({
        target: agents.agentId,
        set: {
          siteName: data.siteName,
          providerOrgId: nextProviderOrgId,
          siteId: data.siteId ?? data.siteName,
          clusterId: data.clusterId ?? data.agentId,
          topology: data.topology ?? {},
          schedulerType: data.schedulerType,
          schedulerVersion: data.schedulerVersion,
          status: "online",
          lastHeartbeat: now,
          ...computeHealth,
          rootMode: data.rootMode ?? false,
          sandboxReadiness: data.sandboxReadiness ?? "critical",
          sandboxCapabilities: data.sandboxCapabilities ?? {},
          sandboxRuntimeCache: data.sandboxRuntimeCache ?? [],
          restrictedDataIsolation: data.restrictedDataIsolation ?? false,
        },
      })
      .returning();

    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Upsert returned no rows", 500);
    }
    await this.authz?.enqueueMany(
      agentTuples(data.agentId, row.providerOrgId, existing?.providerOrgId),
    );
    return row;
  }

  /**
   * Update agent metrics + lastHeartbeat. Throws NOT_FOUND if agent unregistered.
   *
   * Caller MUST validate `data` against AgentHeartbeatSchema.
   *
   * Migration 0013 — when the agent reports `queueDepth` /
   * `historicalP95WaitSec`, persist them. Older agents that don't yet
   * report these fields leave the columns at whatever the row already
   * holds (no-op on undefined), so a partial heartbeat doesn't reset
   * good telemetry to zero.
   */
  async heartbeat(data: AgentHeartbeatInput, now = this.now()) {
    const updates: Partial<typeof agents.$inferInsert> = {
      cpuUsagePercent: Math.round(data.cpuUsagePercent),
      memoryUsedMb: data.memoryUsedMb,
      memoryTotalMb: data.memoryTotalMb,
      lastHeartbeat: now,
      status: "online",
    };
    if (data.computeHealth !== undefined) {
      Object.assign(
        updates,
        heartbeatComputeHealth(
          data.computeHealth,
          now,
          this.options.computeHealthMaxAgeSec ?? DEFAULT_COMPUTE_HEALTH_MAX_AGE_SEC,
          this.options.computeHealthMaxFutureSkewSec ?? DEFAULT_COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC,
        ),
      );
    }
    if (data.queueDepth !== undefined) {
      updates.queueDepth = data.queueDepth;
    }
    if (data.historicalP95WaitSec !== undefined) {
      updates.historicalP95WaitSec = data.historicalP95WaitSec;
    }
    if (data.rootMode !== undefined) updates.rootMode = data.rootMode;
    if (data.sandboxReadiness !== undefined) updates.sandboxReadiness = data.sandboxReadiness;
    if (data.sandboxCapabilities !== undefined) {
      updates.sandboxCapabilities = data.sandboxCapabilities;
    }
    if (data.sandboxRuntimeCache !== undefined)
      updates.sandboxRuntimeCache = data.sandboxRuntimeCache;
    if (data.restrictedDataIsolation !== undefined) {
      updates.restrictedDataIsolation = data.restrictedDataIsolation;
    }

    const [updated] = await this.db
      .update(agents)
      .set(updates)
      .where(eq(agents.agentId, data.agentId))
      .returning();

    if (!updated) {
      throw new AppError(ErrorCode.NOT_FOUND, `Agent ${data.agentId} not found`, 404);
    }
    return updated;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Transitions online Agents with expired (or absent) heartbeats to offline.
   * The state change and its audit record share one transaction so a successful
   * sweep is always explainable without leaving stale scheduler candidates.
   */
  async sweepStaleHeartbeats(timeoutSec: number, now = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - timeoutSec * 1_000);
    return await this.db.transaction(async (tx) => {
      const expired = await tx
        .update(agents)
        .set({ status: "offline" })
        .where(
          and(
            eq(agents.status, "online"),
            or(isNull(agents.lastHeartbeat), lt(agents.lastHeartbeat, cutoff)),
          ),
        )
        .returning({ agentId: agents.agentId, lastHeartbeat: agents.lastHeartbeat });
      if (expired.length === 0) return [];

      await tx.insert(auditLog).values(
        expired.map((agent) => ({
          actor: "system",
          action: "agent.heartbeat.timeout",
          target: agent.agentId,
          diff: {
            before: {
              status: "online",
              lastHeartbeat: agent.lastHeartbeat?.toISOString() ?? null,
            },
            after: {
              status: "offline",
              cutoff: cutoff.toISOString(),
              timeoutSec,
            },
          },
        })),
      );
      return expired.map((agent) => agent.agentId);
    });
  }

  /**
   * Latest GPU + disk sample per agent from the append-only `agent_metrics`
   * table. The heartbeat path writes one `disk_used_percent` row and one `gpu`
   * row per physical GPU; we take the most-recent of each via DISTINCT ON so a
   * single index scan answers it (the `(agent_id, metric, ts)` index covers
   * the disk case; the gpu case adds a per-index key). Returns an empty map for
   * an empty id list to avoid an `IN ()` query.
   */
  private async latestTelemetry(ids: string[]): Promise<Map<string, AgentTelemetry>> {
    const out = new Map<string, AgentTelemetry>();
    if (ids.length === 0) return out;
    const ensure = (id: string): AgentTelemetry => {
      const existing = out.get(id);
      if (existing) return existing;
      const created: AgentTelemetry = { gpus: [] };
      out.set(id, created);
      return created;
    };

    const diskRows = await this.db.execute<{ agentId: string; value: number }>(sql`
      select ids.agent_id as "agentId", latest.value
      from unnest(${sqlAgentIdArray(ids)}) as ids(agent_id)
      join lateral (
        select ${agentMetrics.value} as value
        from ${agentMetrics}
        where ${agentMetrics.agentId} = ids.agent_id
          and ${agentMetrics.metric} = 'disk_used_percent'
        order by ${agentMetrics.ts} desc
        limit 1
      ) latest on true
    `);
    for (const r of diskRows) {
      ensure(r.agentId).diskUsedPercent = r.value;
    }

    const gpuIndex = sql`(${agentMetrics.payload} ->> 'index')`;
    const gpuRows = await this.db
      .selectDistinctOn([agentMetrics.agentId, gpuIndex], {
        agentId: agentMetrics.agentId,
        value: agentMetrics.value,
        payload: agentMetrics.payload,
      })
      .from(agentMetrics)
      .where(and(eq(agentMetrics.metric, "gpu"), inArray(agentMetrics.agentId, ids)))
      .orderBy(agentMetrics.agentId, gpuIndex, desc(agentMetrics.ts));
    for (const r of gpuRows) {
      const parsed = AgentGpuSampleSchema.safeParse({ utilPercent: r.value, ...r.payload });
      if (parsed.success) ensure(r.agentId).gpus.push(parsed.data);
    }
    for (const t of out.values()) {
      t.gpus.sort((a, b) => a.index - b.index);
    }
    return out;
  }

  private merge(row: typeof agents.$inferSelect, tel?: AgentTelemetry): AgentWithTelemetry {
    return { ...row, diskUsedPercent: tel?.diskUsedPercent, gpus: tel?.gpus ?? [] };
  }

  async getById(agentId: string): Promise<AgentWithTelemetry | null> {
    const [agent] = await this.db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
    if (!agent) return null;
    const tel = await this.latestTelemetry([agentId]);
    return this.merge(agent, tel.get(agentId));
  }

  async list(): Promise<AgentWithTelemetry[]> {
    const rows = await this.db.select().from(agents);
    const tel = await this.latestTelemetry(rows.map((r) => r.agentId));
    return rows.map((r) => this.merge(r, tel.get(r.agentId)));
  }

  async listByIds(agentIds: string[]): Promise<AgentWithTelemetry[]> {
    if (agentIds.length === 0) return [];
    const rows = await this.db.select().from(agents).where(inArray(agents.agentId, agentIds));
    const tel = await this.latestTelemetry(rows.map((r) => r.agentId));
    return rows.map((r) => this.merge(r, tel.get(r.agentId)));
  }

  async getOnlineAgent() {
    const [agent] = await this.db.select().from(agents).where(eq(agents.status, "online")).limit(1);
    return agent ?? null;
  }

  /**
   * Return all agents with status="online".
   * Used by the placement orchestrator to find eligible dispatch targets.
   */
  async listOnline() {
    return this.db.select().from(agents).where(eq(agents.status, "online"));
  }
}

function sqlAgentIdArray(ids: string[]) {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
}

function registrationComputeHealth(
  computeHealthCapable: boolean | undefined,
): Partial<typeof agents.$inferInsert> {
  return resetComputeHealth(computeHealthCapable === true, null);
}

function heartbeatComputeHealth(
  report: ComputeHealthReport,
  now: Date,
  maxAgeSec: number,
  maxFutureSkewSec: number,
): Partial<typeof agents.$inferInsert> {
  const observedAtUnixMs = toUnixMs(report.observedAtUnixMs);
  const maxAgeMs = Math.max(1, maxAgeSec) * 1_000;
  const maxFutureSkewMs = Math.max(0, maxFutureSkewSec) * 1_000;
  if (
    observedAtUnixMs === null ||
    observedAtUnixMs > now.getTime() + maxFutureSkewMs ||
    now.getTime() - observedAtUnixMs > maxAgeMs
  ) {
    return resetComputeHealth(true, "invalid_observed_at");
  }
  if (!isComputeHealthStatus(report.state)) {
    return resetComputeHealth(true, "invalid_health_report");
  }
  if (
    !isNodeCount(report.nodeCount) ||
    !isNodeCount(report.operationalNodeCount) ||
    report.operationalNodeCount > report.nodeCount ||
    (report.state === "ready" && report.operationalNodeCount === 0) ||
    (report.state === "unavailable" && report.operationalNodeCount !== 0)
  ) {
    return resetComputeHealth(true, "invalid_health_report");
  }
  return {
    computeHealthCapable: true,
    computeHealthStatus: report.state,
    computeHealthObservedAt: new Date(Math.min(observedAtUnixMs, now.getTime())),
    computeHealthReason: canonicalComputeHealthReason(report.state, report.reason),
    computeHealthNodeCount: report.nodeCount,
    computeHealthOperationalNodeCount: report.operationalNodeCount,
  };
}

function resetComputeHealth(
  computeHealthCapable: boolean,
  reason: "invalid_observed_at" | "invalid_health_report" | null,
): Partial<typeof agents.$inferInsert> {
  return {
    computeHealthCapable,
    computeHealthStatus: "unknown",
    computeHealthObservedAt: null,
    computeHealthReason: reason,
    computeHealthNodeCount: null,
    computeHealthOperationalNodeCount: null,
  };
}

function toUnixMs(value: bigint | number): number | null {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function isComputeHealthStatus(value: string): value is ComputeHealthStatus {
  return value === "unknown" || value === "ready" || value === "unavailable";
}

function isNodeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalComputeHealthReason(
  status: ComputeHealthStatus,
  reason: string | undefined,
): string | null {
  if (status === "ready") return null;
  const normalized = reason?.trim().toLowerCase() ?? "";
  return COMPUTE_HEALTH_REASON_CODES.has(normalized) ? normalized : "unknown";
}

function agentTuples(
  agentId: string,
  providerOrgId: string | null,
  previousProviderOrgId: string | null | undefined,
): AuthzTuple[] {
  const isNewAgent = previousProviderOrgId === undefined;
  const providerChanged = previousProviderOrgId !== providerOrgId;
  if (!isNewAgent && !providerChanged) return [];

  const tuples: AuthzTuple[] = [agentPlatformTuple(agentId)];
  if (previousProviderOrgId && providerChanged) {
    tuples.push({
      ...agentProviderTuple({ agentId, providerOrgId: previousProviderOrgId }),
      operation: "delete",
    });
  }
  if (providerOrgId) {
    tuples.push(agentProviderTuple({ agentId, providerOrgId }));
  }
  return tuples;
}
