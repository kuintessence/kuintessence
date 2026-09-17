import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { isLocalMode } from "../../lib/local-mode";
import { toCapabilitySet, useMeCapabilities } from "../../lib/platform-capabilities";
import { toUserFacingError } from "../../lib/user-facing-error";
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
        subtitle={t("agents.subtitle")}
        actions={
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            data-testid="agents-count"
          >
            {t("agents.countHint", { online: onlineCount, total: agents.length })}
          </span>
        }
      />

      {loadError ? (
        <div
          className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
          data-testid="agents-list-error"
        >
          {toUserFacingError(loadError, t("agents.loadFailed"))}
        </div>
      ) : null}

      {loadError ? null : agentsQ.isLoading ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : agents.length === 0 ? (
        <div
          className="flex h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-sm text-muted-foreground"
          data-testid="agents-empty"
        >
          <Server className="h-5 w-5" />
          {t("agents.empty")}
          <code className="font-mono text-[12px]">
            SERVER_GRPC_URL=… AGENT_ID=… AGENT_SITE_NAME=… bun packages/agent/src/index.ts
          </code>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="agents-grid"
        >
          {agents.map((a) => (
            <AgentCard key={a.agentId} agent={a} canOpenSsh={canOpenSsh} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
