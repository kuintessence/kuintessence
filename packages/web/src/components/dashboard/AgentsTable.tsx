import { useTranslation } from "react-i18next";
import type { AgentRow } from "../../lib/dashboard-data";
import { Badge } from "../ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

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
        className="flex h-32 items-center justify-center border-border text-sm text-muted-foreground"
        data-testid="agents-empty"
      >
        {t("dashboard.noAgents")}
      </div>
    );
  }
  return (
    <div className="overflow-hidden border-border" data-testid="agents-table">
      <Table className="w-full text-sm">
        <TableHeader className=" text-left text-xs uppercase tracking-wide text-muted-foreground">
          <TableRow>
            <TableHead className="px-3 py-2 font-medium">{t("dashboard.site")}</TableHead>
            <TableHead className="px-3 py-2 font-medium">{t("dashboard.scheduler")}</TableHead>
            <TableHead className="px-3 py-2 font-medium">{t("dashboard.status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((a) => (
            <TableRow key={a.agentId} className=" border-border last:border-b-0">
              <TableCell className="px-3 py-2">
                <div className="font-medium">{a.siteName}</div>
                <div className="font-mono text-[11px] text-muted-foreground" title={a.agentId}>
                  {a.agentId.slice(0, 8)}
                </div>
              </TableCell>
              <TableCell className="px-3 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                {a.schedulerType} {a.schedulerVersion}
              </TableCell>
              <TableCell className="px-3 py-2">
                <Badge className="whitespace-nowrap" variant={statusVariant(a.status)}>
                  {statusLabel(a.status, t)}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
