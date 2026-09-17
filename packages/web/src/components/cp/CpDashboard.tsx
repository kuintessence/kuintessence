import { Activity, AlertTriangle, CheckCircle2, HardDrive, Layers, ServerOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCpDashboard } from "../../lib/use-cp-dashboard";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CpAttentionCards } from "./CpAttentionCards";
import { KpiTile } from "./KpiTile";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function CpDashboard() {
  const { t } = useTranslation();
  const q = useCpDashboard();

  if (q.error) {
    return (
      <div
        className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
        data-testid="cp-dashboard-error"
      >
        {toUserFacingError(q.error, t("cp.dashboard.loadFailed"))}
      </div>
    );
  }

  const k = q.data;
  const isLoading = q.isLoading || !k;
  const terminalJobs = (k?.jobsCompleted ?? 0) + (k?.jobsFailed ?? 0);
  const agentTotal = (k?.agentsHealthy ?? 0) + (k?.agentsSick ?? 0) + (k?.agentsOffline ?? 0);
  const successRate =
    terminalJobs > 0 ? Math.round(((k?.jobsCompleted ?? 0) / terminalJobs) * 100) : 0;
  const availableAgentRate =
    agentTotal > 0
      ? Math.round((((k?.agentsHealthy ?? 0) + (k?.agentsSick ?? 0)) / agentTotal) * 100)
      : 0;

  return (
    <div className="space-y-6" data-testid="cp-dashboard">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("cp.dashboard.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("cp.dashboard.subtitle")}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        <KpiTile
          title={t("cp.dashboard.kpi.jobsCompleted")}
          titleSuffix={t("cp.dashboard.kpi.period24Hours")}
          icon={CheckCircle2}
          tone="succeeded"
          value={isLoading ? "—" : k.jobsCompleted}
          testId="cp-kpi-jobsCompleted"
        />
        <KpiTile
          title={t("cp.dashboard.kpi.jobsFailed")}
          titleSuffix={t("cp.dashboard.kpi.period24Hours")}
          icon={AlertTriangle}
          tone="failed"
          value={isLoading ? "—" : k.jobsFailed}
          testId="cp-kpi-jobsFailed"
        />
        <KpiTile
          title={t("cp.dashboard.kpi.bytesTransferred")}
          titleSuffix={t("cp.dashboard.kpi.period24Hours")}
          icon={HardDrive}
          value={isLoading ? "—" : formatBytes(k.bytesTransferred)}
          testId="cp-kpi-bytesTransferred"
        />
        <KpiTile
          title={t("cp.dashboard.kpi.queueDepthPeak")}
          titleSuffix={t("cp.dashboard.kpi.period24Hours")}
          icon={Activity}
          value={isLoading ? "—" : k.queueDepthPeak}
          testId="cp-kpi-queueDepthPeak"
        />
        <KpiTile
          title={t("cp.dashboard.kpi.agentsHealthy")}
          icon={Layers}
          tone="succeeded"
          value={isLoading ? "—" : k.agentsHealthy}
          testId="cp-kpi-agentsHealthy"
        />
        <KpiTile
          title={t("cp.dashboard.kpi.agentsSick")}
          icon={AlertTriangle}
          tone="failed"
          value={isLoading ? "—" : k.agentsSick}
          testId="cp-kpi-agentsSick"
        />
        <KpiTile
          title={t("cp.dashboard.kpi.agentsOffline")}
          icon={ServerOff}
          value={isLoading ? "—" : k.agentsOffline}
          testId="cp-kpi-agentsOffline"
        />
      </div>

      <div className="grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-3">
        <OperationalSummary
          label={t("cp.dashboard.summary.successRate")}
          value={isLoading ? "—" : `${successRate}%`}
        />
        <OperationalSummary
          label={t("cp.dashboard.summary.agentAvailability")}
          value={isLoading ? "—" : `${availableAgentRate}%`}
        />
        <OperationalSummary
          label={t("cp.dashboard.summary.window")}
          value={t("cp.dashboard.summary.last24Hours")}
        />
      </div>

      <CpAttentionCards
        failedJobs={isLoading ? null : k.jobsFailed}
        sickAgents={isLoading ? null : k.agentsSick}
        offlineAgents={isLoading ? null : k.agentsOffline}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card data-testid="cp-top-users">
          <CardHeader className="p-4 pb-2">
            <CardTitle>{t("cp.dashboard.topUsers")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            {!isLoading && k.topUsers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("cp.dashboard.noTopUsers")}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {(k?.topUsers ?? []).map((u) => (
                  <li
                    key={u.userId}
                    className="flex items-center justify-between gap-3"
                    data-testid={`cp-top-user-${u.userId}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {u.displayName ?? u.email ?? u.userId}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[u.organizationName, u.email, u.userId].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="font-mono tabular-nums text-xs text-muted-foreground">
                      {u.jobs}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card data-testid="cp-top-apps">
          <CardHeader className="p-4 pb-2">
            <CardTitle>{t("cp.dashboard.topApps")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            {!isLoading && k.topApps.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("cp.dashboard.noTopApps")}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {(k?.topApps ?? []).map((a) => (
                  <li
                    key={a.appKey}
                    className="flex items-center justify-between gap-3"
                    data-testid={`cp-top-app-${a.appKey}`}
                  >
                    <span className="truncate font-mono text-xs text-foreground">{a.appKey}</span>
                    <span className="font-mono tabular-nums text-xs text-muted-foreground">
                      {a.jobs}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card data-testid="cp-agents-health">
          <CardHeader className="p-4 pb-2">
            <CardTitle>{t("cp.dashboard.agentsHealth")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <AgentsHealthBar
              healthy={k?.agentsHealthy ?? 0}
              sick={k?.agentsSick ?? 0}
              offline={k?.agentsOffline ?? 0}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function OperationalSummary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

interface AgentsHealthBarProps {
  healthy: number;
  sick: number;
  offline: number;
}

function AgentsHealthBar({ healthy, sick, offline }: AgentsHealthBarProps) {
  const { t } = useTranslation();
  const total = Math.max(healthy + sick + offline, 1);
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        <div
          data-testid="cp-agents-health-healthy"
          className="bg-[var(--status-succeeded)]"
          style={{ width: pct(healthy) }}
        />
        <div
          data-testid="cp-agents-health-sick"
          className="bg-[var(--status-failed)]"
          style={{ width: pct(sick) }}
        />
        <div
          data-testid="cp-agents-health-offline"
          className="bg-[var(--status-cancelled)]"
          style={{ width: pct(offline) }}
        />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
        <span data-testid="cp-agents-health-label-healthy">
          ● {t("cp.common.agentStatus.healthy")} <code className="text-[10px]">healthy</code>{" "}
          {healthy}
        </span>
        <span data-testid="cp-agents-health-label-sick">
          ● {t("cp.common.agentStatus.sick")} <code className="text-[10px]">sick</code> {sick}
        </span>
        <span data-testid="cp-agents-health-label-offline">
          ● {t("cp.common.agentStatus.offline")} <code className="text-[10px]">offline</code>{" "}
          {offline}
        </span>
      </div>
    </div>
  );
}
