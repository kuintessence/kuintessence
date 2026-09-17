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
import { relativeFromNow } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader } from "../ui/card";

export interface AgentRow {
  agentId: string;
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
  const { t } = useTranslation();
  const Icon = SCHEDULER_ICON[agent.schedulerType.toLowerCase()] ?? SCHEDULER_ICON.default;
  const healthStatus = agent.computeHealthStatus ?? "unknown";
  const healthNodes =
    agent.computeHealthOperationalNodeCount != null && agent.computeHealthNodeCount != null
      ? `${agent.computeHealthOperationalNodeCount}/${agent.computeHealthNodeCount}`
      : null;
  return (
    <Card data-testid={`agent-card-${agent.agentId}`} className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          {Icon ? <Icon className="h-4 w-4 text-muted-foreground" /> : null}
          <span className="text-sm font-semibold">{agent.siteName}</span>
        </div>
        <div className="flex items-center gap-1">
          <span
            data-testid={`agent-status-${agent.agentId}`}
            className={cn("h-2 w-2 rounded-full", statusDot(agent.status))}
          />
          <Badge variant="outline" className="text-[10px]">
            {agent.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 text-xs">
        <div
          className="font-mono text-[11px] text-muted-foreground tabular-nums"
          title={agent.agentId}
        >
          {agent.agentId.length > 12 ? agent.agentId.slice(0, 12) : agent.agentId}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Scheduler</span>
          <span className="font-mono">
            {agent.schedulerType} {agent.schedulerVersion}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
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
        <div className="grid grid-cols-2 gap-2 border-t border-border pt-2 text-[11px]">
          <div className="min-w-0" data-testid={`agent-health-${agent.agentId}`}>
            <div className="flex items-center gap-1 text-muted-foreground">
              <Activity className="h-3 w-3" />
              {t("agents.computeHealth")}
            </div>
            <div className="mt-0.5 truncate font-mono tabular-nums">
              {t(`agents.healthStatus.${healthStatus}`)}
              {healthNodes ? ` · ${healthNodes}` : ""}
            </div>
          </div>
          <div className="min-w-0" data-testid={`agent-queue-depth-${agent.agentId}`}>
            <div className="text-muted-foreground">{t("agents.queueDepth")}</div>
            <div className="mt-0.5 font-mono tabular-nums">{agent.queueDepth ?? "—"}</div>
          </div>
        </div>
        <div
          className="flex items-center gap-1.5 text-muted-foreground"
          title={agent.lastHeartbeat ?? undefined}
        >
          Heartbeat:{" "}
          <span className="font-mono tabular-nums">
            {agent.lastHeartbeat ? relativeFromNow(agent.lastHeartbeat) : "never"}
          </span>
        </div>
        <div className="mt-auto flex flex-wrap gap-3 pt-2">
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
      </CardContent>
    </Card>
  );
}
