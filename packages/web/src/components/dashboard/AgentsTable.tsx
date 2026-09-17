import { useTranslation } from "react-i18next";
import type { AgentRow } from "../../lib/dashboard-data";
import { Badge } from "../ui/badge";

export interface AgentsTableProps {
  agents: AgentRow[];
}

function statusVariant(status: string): "running" | "cancelled" | "default" {
  const s = status.toUpperCase();
  if (s === "ONLINE") return "running";
  if (s === "OFFLINE" || s === "DRAINING") return "cancelled";
  return "default";
}

function statusLabel(status: string, translate: (key: string) => string): string {
  const normalized = status.toLowerCase();
  if (normalized === "online" || normalized === "offline" || normalized === "draining") {
    return translate(`dashboard.agentStatus.${normalized}`);
  }
  return status;
}

export function AgentsTable({ agents }: AgentsTableProps) {
  const { t } = useTranslation();
  if (agents.length === 0) {
    return (
      <div
        className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
        data-testid="agents-empty"
      >
        {t("dashboard.noAgents")}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-border" data-testid="agents-table">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{t("dashboard.site")}</th>
            <th className="px-3 py-2 font-medium">{t("dashboard.scheduler")}</th>
            <th className="px-3 py-2 font-medium">{t("dashboard.status")}</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agentId} className="border-t border-border last:border-b-0">
              <td className="px-3 py-2">
                <div className="font-medium">{a.siteName}</div>
                <div className="font-mono text-[11px] text-muted-foreground" title={a.agentId}>
                  {a.agentId.slice(0, 8)}
                </div>
              </td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                {a.schedulerType} {a.schedulerVersion}
              </td>
              <td className="px-3 py-2">
                <Badge variant={statusVariant(a.status)}>{statusLabel(a.status, t)}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
