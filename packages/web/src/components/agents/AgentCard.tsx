import { Link } from "@tanstack/react-router";
import {
  Activity,
  Container,
  Cpu,
  MemoryStick,
  Server,
  Settings as SettingsIcon,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { relativeFromNow, statusLabel } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { AgentSiteOperations } from "./AgentSiteOperations";
import { AgentUpdates } from "./AgentUpdates";

export interface AgentRow {
  agentId: string;
  siteOperations?: unknown;
  clusterId?: string | null;
  siteName: string;
  schedulerType: string;
  schedulerVersion: string;
  status: string;
  lastHeartbeat: string | null;
  cpuUsagePercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  maxConcurrentJobs?: number | null;
  queueDepth?: number | null;
  computeHealthStatus?: string | null;
  computeHealthNodeCount?: number | null;
  computeHealthOperationalNodeCount?: number | null;
}

const SCHEDULER_ICON: Record<string, typeof Server> = {
  slurm: Server,
  pbs: Server,
  pbs_pro: Server,
  torque: Server,
  k8s: Container,
  kubernetes: Container,
  docker: Container,
  default: SettingsIcon,
};

function statusDot(status: string): string {
  const s = status.toLowerCase();
  if (s === "online") return "bg-[var(--status-running)]";
  if (s === "unhealthy") return "bg-[var(--status-failed)]";
  return "bg-[var(--status-cancelled)]";
}

function memUsed(used: number | null, total: number | null): string {
  if (used == null || total == null || total === 0) return "—";
  const pct = Math.round((used / total) * 100);
  return `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GiB · ${pct}%`;
}

export function AgentCard({ agent, canOpenSsh }: { agent: AgentRow; canOpenSsh: boolean }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.resolvedLanguage ?? i18n?.language;
  const Icon = SCHEDULER_ICON[agent.schedulerType.toLowerCase()] ?? SCHEDULER_ICON.default;
  const healthStatus = agent.computeHealthStatus ?? "unknown";
  const healthNodes =
    agent.computeHealthOperationalNodeCount != null && agent.computeHealthNodeCount != null
      ? `${agent.computeHealthOperationalNodeCount}/${agent.computeHealthNodeCount}`
      : null;
  return (
    <article
      data-testid={`agent-card-${agent.agentId}`}
      className="min-w-0 space-y-2 rounded-md border border-border bg-card p-3"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {Icon ? <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : null}
          <h2 className="text-sm font-semibold [overflow-wrap:anywhere]">{agent.siteName}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span
            data-testid={`agent-status-${agent.agentId}`}
            className={cn("h-2 w-2 rounded-full", statusDot(agent.status))}
          />
          <Badge variant="outline" className="text-xs">
            {statusLabel(agent.status, language)}
          </Badge>
        </div>
      </header>
      <div className="space-y-2 text-xs">
        <div className="flex flex-wrap gap-x-2 gap-y-1 text-muted-foreground">
          <span className="max-w-full truncate font-mono" title={agent.agentId}>
            {agent.agentId}
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {t("agents.scheduler")}{" "}
            <span className="font-mono">
              {agent.schedulerType} {agent.schedulerVersion}
            </span>
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex items-center gap-1.5">
            <Cpu className="h-3 w-3 text-muted-foreground" />
            <span className="tabular-nums">
              {agent.cpuUsagePercent != null ? `${agent.cpuUsagePercent}%` : "—"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <MemoryStick className="h-3 w-3 text-muted-foreground" />
            <span className="tabular-nums" title={memUsed(agent.memoryUsedMb, agent.memoryTotalMb)}>
              {memUsed(agent.memoryUsedMb, agent.memoryTotalMb)}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="min-w-0" data-testid={`agent-health-${agent.agentId}`}>
            <div className="flex items-center gap-1 text-muted-foreground">
              <Activity className="h-3 w-3" />
              {t("agents.computeHealth")}
            </div>
            <div className="break-words font-mono tabular-nums">
              {t(`agents.healthStatus.${healthStatus}`)}
              {healthNodes ? ` · ${healthNodes}` : ""}
            </div>
          </div>
          <div className="min-w-0" data-testid={`agent-queue-depth-${agent.agentId}`}>
            <div className="text-muted-foreground">{t("agents.queueDepth")}</div>
            <div className="font-mono tabular-nums">{agent.queueDepth ?? "—"}</div>
          </div>
        </div>
        <div
          className="flex items-center gap-1.5 text-muted-foreground"
          title={agent.lastHeartbeat ?? undefined}
        >
          {t("agents.heartbeat")}:
          <span className="font-mono tabular-nums">
            {agent.lastHeartbeat
              ? relativeFromNow(agent.lastHeartbeat, undefined, language)
              : t("agents.never")}
          </span>
        </div>
        <div className="[&>details]:pt-1 [&>details>summary]:text-xs">
          <AgentSiteOperations value={agent.siteOperations} online={agent.status === "online"} />
          <AgentUpdates agentId={agent.agentId} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2">
          <Link
            to="/jobs"
            search={{ agentId: agent.agentId }}
            className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
            data-testid={`agent-view-jobs-${agent.agentId}`}
          >
            <Workflow className="h-3 w-3" />
            {t("agents.viewJobs")}
          </Link>
          {canOpenSsh ? (
            <Link
              to="/agents/$agentId/ssh"
              params={{ agentId: agent.agentId }}
              className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
              data-testid={`agent-open-ssh-${agent.agentId}`}
            >
              <SquareTerminal className="h-3 w-3" />
              {t("agents.openSsh")}
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}
