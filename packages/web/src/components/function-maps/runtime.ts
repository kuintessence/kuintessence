import type { CpAgent, CpSoftwareOverview } from "../../lib/cp-client";
import type { Acquisition, MapNode, MapObservation, MapRuntime, MapText } from "./model";

const text = (zh: string, en: string): MapText => ({ zh, en });
export function acquisitionState(query: {
  isPending: boolean;
  error: unknown;
  data: unknown;
}): Acquisition {
  if (query.error) {
    const status =
      typeof query.error === "object" && "status" in query.error ? query.error.status : null;
    return status === 401 || status === 403 ? "forbidden" : "error";
  }
  if (query.isPending) return "loading";
  return query.data === undefined || query.data === null ? "no-data" : "ready";
}
export function infrastructureRuntime(input: {
  agents?: CpAgent[];
  overview?: CpSoftwareOverview;
  state: Acquisition;
  overviewState: Acquisition;
  fetchedAt: number;
  overviewFetchedAt: number;
}): MapRuntime {
  // Never retain private rows after a failed authorization or scope check.
  const agents = input.state === "ready" ? (input.agents ?? []) : [];
  const shown = agents.slice(0, 24);
  const nodes: MapNode[] = shown.map((agent) => ({
    id: `agent:${agent.id}`,
    name: text(agent.hostname, agent.hostname),
    purpose: text(
      `Agent ${agent.id}；站点 ${agent.siteId}`,
      `Agent ${agent.id}; site ${agent.siteId}`,
    ),
    kind: "instance",
    icon: "server",
    route: `/cp/agents#function-map-agent-${encodeURIComponent(agent.id)}`,
    section: text(`Agent ${agent.id}`, `Agent ${agent.id}`),
  }));
  const observations: MapObservation[] = shown.map((agent) => {
    const detail =
      input.overviewState === "ready"
        ? input.overview?.agents.find(
            (row) =>
              row.agentId === agent.id && row.providerOrgId === (agent.providerOrgId ?? null),
          )
        : undefined;
    return {
      nodeId: `agent:${agent.id}`,
      acquisition: input.state,
      lifecycle: agent.status,
      health: "unknown",
      source:
        "GET /cp/agents: status; GET /cp/software/overview: lastHeartbeat, controlChannelOnline, runtimeStatus",
      observedAt: detail?.lastHeartbeat ?? null,
      fetchedAt: input.fetchedAt ? new Date(input.fetchedAt).toISOString() : null,
      facts: text(
        `服务端状态=${agent.status}；${detail ? `控制通道=${detail.controlChannelOnline ? "在线" : "离线"}（概览获取时间 ${new Date(input.overviewFetchedAt).toISOString()}）` : "心跳与控制通道数据未获取"}。心跳时间只用于说明最近心跳，不证明业务健康；状态字段未提供独立观测时间。`,
        `Server status=${agent.status}; ${detail ? `control channel=${detail.controlChannelOnline ? "online" : "offline"} (overview fetched ${new Date(input.overviewFetchedAt).toISOString()})` : "heartbeat and control channel unavailable"}. Heartbeat time is not proof of business health; status has no separate observation timestamp.`,
      ),
    };
  });
  if (!nodes.length) {
    nodes.push({
      id: "g05.collection",
      name: text("Agent 查询", "Agent query"),
      purpose: text("当前范围的真实 Agent 清单", "Actual Agents in the current scope"),
      kind: "service",
      icon: "search",
      route: "/cp/agents",
      section: text("", ""),
    });
    observations.push({
      nodeId: "g05.collection",
      acquisition: input.state === "ready" ? "no-data" : input.state,
      facts: text(
        "未取得可显示实例；不推断集群健康或连接故障。",
        "No displayable instances; no cluster health or connection fault is inferred.",
      ),
      source: "GET /cp/agents",
      observedAt: null,
      fetchedAt: input.fetchedAt ? new Date(input.fetchedAt).toISOString() : null,
    });
  }
  return {
    nodes,
    edges: [],
    observations,
    notice: text(
      `仅显示当前获准范围内前 ${shown.length} / ${agents.length} 个 Agent。沿用清单 30 秒、概览 15 秒刷新；健康与任务进度未接入。`,
      `Showing the first ${shown.length} of ${agents.length} authorized Agents. List refresh: 30s; overview: 15s. Health and task progress are not connected.`,
    ),
  };
}
export interface AuthzHealthSnapshot {
  mode: "off" | "shadow" | "enforce";
  configured: boolean;
  healthy: boolean;
  schemaWritten: boolean;
  schemaMatches: boolean;
  outbox: { pending: number; processing: number; dead: number };
}
export interface AuthzReadinessSnapshot {
  shadowDiffs: number;
  enforceReady: boolean;
  externalSmokeRequired: boolean;
  blockers: string[];
  outbox: { pending: number; processing: number; dead: number };
}
export function authorizationRuntime(input: {
  health: AuthzHealthSnapshot | null;
  readiness: AuthzReadinessSnapshot | null;
  state: Acquisition;
  fetchedAt: string | null;
}): MapRuntime {
  const available = input.state === "ready";
  const health = available ? input.health : null;
  const readiness = available ? input.readiness : null;
  const snapshot = (
    nodeId: string,
    facts: MapText,
    source: string,
    status?: MapObservation["health"],
  ): MapObservation => ({
    nodeId,
    acquisition: nodeId === "t01.n1" || nodeId === "t01.n5" ? "unknown" : input.state,
    facts,
    source,
    health: status ?? "unknown",
    observedAt: null,
    fetchedAt: input.fetchedAt,
  });
  return {
    observations: [
      snapshot(
        "t01.n1",
        text(
          "成员变更事件未在此接入，不能判断投递是否完成。",
          "Membership events are not connected here; projection completion is unknown.",
        ),
        "OrganizationMembershipPanel",
        "unknown",
      ),
      snapshot(
        "t01.n2",
        readiness
          ? text(
              `待同步 ${readiness.outbox.pending}；处理中 ${readiness.outbox.processing}；死信 ${readiness.outbox.dead}`,
              `Pending ${readiness.outbox.pending}; processing ${readiness.outbox.processing}; dead ${readiness.outbox.dead}`,
            )
          : text("同步数量未知", "Outbox counts unknown"),
        "GET /admin/authz/readiness: outbox",
        readiness && readiness.outbox.dead > 0 ? "confirmed-fault" : "unknown",
      ),
      snapshot(
        "t01.n3",
        health
          ? text(
              `模式 ${health.mode}；已配置 ${health.configured}；schema 写入 ${health.schemaWritten}；schema 匹配 ${health.schemaMatches}；健康探测 ${health.healthy}`,
              `Mode ${health.mode}; configured ${health.configured}; schema written ${health.schemaWritten}; schema matches ${health.schemaMatches}; health probe ${health.healthy}`,
            )
          : text("授权服务探测未知", "Authorization service probe unknown"),
        "GET /admin/authz/health",
        health?.mode !== "off" && health?.configured
          ? health.healthy
            ? "reported-ok"
            : "confirmed-fault"
          : "unknown",
      ),
      snapshot(
        "t01.n4",
        readiness
          ? text(
              `观察差异 ${readiness.shadowDiffs}；enforceReady=${readiness.enforceReady}；仍需外部 smoke=${readiness.externalSmokeRequired}。${readiness.blockers.join("；")}`,
              `Shadow differences ${readiness.shadowDiffs}; enforceReady=${readiness.enforceReady}; external smoke required=${readiness.externalSmokeRequired}. ${readiness.blockers.join("; ")}`,
            )
          : text("差异与就绪条件未知", "Differences and readiness unknown"),
        "GET /admin/authz/readiness: shadowDiffs, enforceReady, blockers, externalSmokeRequired",
      ),
      snapshot(
        "t01.n5",
        text(
          "仅进入已有恢复入口；本图不会重建、重试或清空记录。",
          "Opens the existing recovery entrance; this map never rebuilds, retries or clears records.",
        ),
        "AuthzAdminPanel.refresh / existing recovery forms",
      ),
    ],
    notice: text(
      "复用授权页手动刷新。接口未返回观测时间，下面只记录页面获取时间；无自动过期判定，不据此宣称完整数字孪生。",
      "Uses the authorization page's manual refresh. APIs do not return observation time; only fetch time is recorded. No automatic expiry rule or complete digital-twin claim.",
    ),
  };
}
