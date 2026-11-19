import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { isLocalMode } from "../../lib/local-mode";
import { toCapabilitySet, useMeCapabilities } from "../../lib/platform-capabilities";
import { toUserFacingError } from "../../lib/user-facing-error";
import { CollectionView } from "../ui/collection-view";
import { PageHeader, PageShell } from "../ui/page";
import { AgentCard, type AgentRow } from "./AgentCard";

export function AgentsPage() {
  const { t } = useTranslation();
  const auth = getAuthState();
  const local = isLocalMode();
  const capabilityState = useMeCapabilities(auth.isAuthenticated && !local);
  const canOpenSsh = !local && toCapabilitySet(capabilityState.data).has("terminal.open");
  const agentsQ = useQuery({
    queryKey: ["agents-list"],
    queryFn: () => api.get<{ agents: AgentRow[] }>("/agents"),
    refetchInterval: 10_000,
  });

  const loadError = agentsQ.error;
  const agents = loadError ? [] : (agentsQ.data?.agents ?? []);
  const onlineCount = agents.filter((a) => a.status.toLowerCase() === "online").length;

  return (
    <PageShell data-testid="agents-page">
      <PageHeader
        title={t("agents.title")}
        actions={
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            data-testid="agents-count"
          >
            {t("agents.countHint", {
              online: agentsQ.isSuccess ? onlineCount : "—",
              total: agentsQ.isSuccess ? agents.length : "—",
            })}
          </span>
        }
      />

      <CollectionView
        errorTestId="agents-list-error"
        emptyTestId="agents-empty"
        data={agents}
        columns={[{ accessorKey: "siteName", header: t("ui.name") }]}
        table={{ pageSize: 10 }}
        getKey={(agent) => agent.agentId}
        matches={(agent, query) =>
          [agent.agentId, agent.siteName, agent.schedulerType, agent.status]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query)
        }
        renderItem={(agent) => <AgentCard agent={agent} canOpenSsh={canOpenSsh} />}
        loading={agentsQ.isLoading}
        error={loadError ? toUserFacingError(loadError, t("agents.loadFailed")) : undefined}
        onRetry={() => void agentsQ.refetch()}
        contentClassName="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] items-start gap-3"
        data-testid="agents-grid"
      />
    </PageShell>
  );
}
