import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { PageHeader } from "../ui/page";

interface InstalledRow {
  name: string;
  version: string;
  hash: string;
  compiler: string | null;
  spec: string;
  reportedAt: string;
}

interface InstalledResponse {
  success: boolean;
  data: InstalledRow[];
}

export interface AgentSoftwarePageProps {
  agentId: string;
}

/**
 * Read-only view of installed Spack specs for one agent.
 *
 * The org_admin REST endpoint at /api/software/agents/:id/installed
 * powers this view; policy editing is not exposed on this page.
 */
export function AgentSoftwarePage({ agentId }: AgentSoftwarePageProps) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["agent-software", agentId],
    queryFn: () => api.get<InstalledResponse>(`/software/agents/${agentId}/installed`),
    refetchInterval: 30_000,
  });

  if (q.isLoading) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }
  if (q.error) {
    return (
      <p className="text-sm text-status-failed" data-testid="agent-software-error">
        {toUserFacingError(q.error)}
      </p>
    );
  }
  const rows = q.data?.data ?? [];

  return (
    <div className="space-y-3" data-testid="agent-software-page">
      <PageHeader
        title={t("agentSoftware.title")}
        subtitle={agentId}
        actions={
          <span
            className="text-xs text-muted-foreground tabular-nums"
            data-testid="agent-software-count"
          >
            {t("agentSoftware.count", { count: rows.length })}
          </span>
        }
      />

      {rows.length === 0 ? (
        <div
          className="flex h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-sm text-muted-foreground"
          data-testid="agent-software-empty"
        >
          <Package className="h-5 w-5" />
          {t("agentSoftware.empty")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card px-4">
          <table
            className="w-full min-w-[40rem] border-collapse text-sm"
            data-testid="agent-software-table"
          >
            <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-2">{t("agentSoftware.name")}</th>
                <th className="py-2">{t("agentSoftware.version")}</th>
                <th className="py-2">{t("agentSoftware.compiler")}</th>
                <th className="py-2">Hash</th>
                <th className="py-2">Spec</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hash} className="border-b border-border last:border-0">
                  <td className="py-2 font-medium">{r.name}</td>
                  <td className="py-2 font-mono text-xs">{r.version}</td>
                  <td className="py-2 font-mono text-xs">{r.compiler ?? "-"}</td>
                  <td className="py-2 font-mono text-xs text-muted-foreground">
                    {r.hash.slice(0, 12)}
                  </td>
                  <td className="py-2 font-mono text-xs">{r.spec}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
