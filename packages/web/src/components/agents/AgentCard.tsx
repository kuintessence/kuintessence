import { Link } from "@tanstack/react-router";
import {
  Activity,
  Bell,
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
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { AgentSiteOperations } from "./AgentSiteOperations";
import { AgentUpdates, useAgentUpdates } from "./AgentUpdates";

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
  const updates = useAgentUpdates(agent.agentId);
  const hasNotice =
    !updates.isError && updates.data?.requests.some((entry) => entry.kind === "notice");
  const language = i18n?.resolvedLanguage ?? i18n?.language;
  const Icon = SCHEDULER_ICON[agent.schedulerType.toLowerCase()] ?? SCHEDULER_ICON.default;
  const healthStatus = agent.computeHealthStatus ?? "unknown";
  const healthNodes =
    agent.computeHealthOperationalNodeCount != null && agent.computeHealthNodeCount != null
      ? `${agent.computeHealthOperationalNodeCount}/${agent.computeHealthNodeCount}`
      : null;
  const scheduler = [agent.schedulerType, agent.schedulerVersion].filter(Boolean).join(" ");
  const memory = memUsed(agent.memoryUsedMb, agent.memoryTotalMb);
  const actionClass = "inline-flex min-h-8 items-center gap-1 text-xs text-brand hover:underline";
  return (
    <article
      data-testid={`agent-card-${agent.agentId}`}
      className="flex h-full min-w-0 flex-col gap-2 rounded-md border border-border bg-card px-3 pt-3 pb-2"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {Icon ? <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : null}
          <h2 className="kq-name-fade text-sm font-semibold" title={agent.siteName}>
            {agent.siteName}
          </h2>
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
        <div className="space-y-0.5 text-muted-foreground">
          <span className="kq-name-fade w-fit max-w-full font-mono" title={agent.agentId}>
            {agent.agentId}
          </span>
          <span className="kq-name-fade w-fit max-w-full" title={scheduler}>
            {t("agents.scheduler")} <span className="font-mono">{scheduler}</span>
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
            <span className="tabular-nums">{memory}</span>
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
      </div>
      <footer className="mt-auto flex flex-wrap items-center gap-x-3 border-t border-border pt-1">
        <Dialog>
          <DialogTrigger
            type="button"
            className={cn(actionClass, "cursor-pointer")}
            aria-label={t("agents.openDetails", { name: agent.siteName })}
            title={hasNotice ? t("agents.updater.notice") : undefined}
            aria-description={hasNotice ? t("agents.updater.notice") : undefined}
          >
            {hasNotice ? <Bell aria-hidden="true" className="h-3 w-3" /> : null}
            {t("agents.details")}
          </DialogTrigger>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{t("agents.clusterDetails")}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4 text-sm">
              <div className="space-y-1 [overflow-wrap:anywhere]">
                <h3 className="font-semibold">{agent.siteName}</h3>
                <p className="font-mono text-xs text-muted-foreground">{agent.agentId}</p>
                <p className="text-xs text-muted-foreground">
                  {t("agents.scheduler")} <span className="font-mono">{scheduler}</span>
                </p>
              </div>
              <div className="space-y-1 border-t border-border pt-2">
                <AgentSiteOperations
                  value={agent.siteOperations}
                  online={agent.status === "online"}
                />
                <AgentUpdates agentId={agent.agentId} />
              </div>
            </DialogBody>
          </DialogContent>
        </Dialog>
        <Link
          to="/jobs"
          search={{ agentId: agent.agentId }}
          className={actionClass}
          aria-label={t("agents.viewJobs")}
          data-testid={`agent-view-jobs-${agent.agentId}`}
        >
          <Workflow className="h-3 w-3" />
          {t("jobs.title")}
        </Link>
        {canOpenSsh ? (
          <Link
            to="/agents/$agentId/ssh"
            params={{ agentId: agent.agentId }}
            className={actionClass}
            data-testid={`agent-open-ssh-${agent.agentId}`}
          >
            <SquareTerminal className="h-3 w-3" />
            {t("agents.openSsh")}
          </Link>
        ) : null}
      </footer>
    </article>
  );
}
