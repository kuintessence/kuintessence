import { useQuery } from "@tanstack/react-query";
import { KeyRound, ServerCog, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { listSandboxExecutionAccounts } from "../../lib/sandbox-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { SandboxMappingReviewPanel } from "./SandboxMappingReviewPanel";

export function CpAccountsPage() {
  const { t } = useTranslation();
  const activeOrganizationId = useActiveOrganizationId();
  const accountsQuery = useQuery({
    queryKey: ["sandbox-execution-accounts", activeOrganizationId ?? "all"],
    queryFn: listSandboxExecutionAccounts,
    retry: false,
  });
  const accounts = accountsQuery.data ?? [];

  return (
    <div className="space-y-4" data-testid="cp-accounts-page">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{t("cp.accounts.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("cp.accounts.subtitle")}</p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <Summary
          icon={ServerCog}
          label={t("cp.accounts.summary.accounts")}
          value={accounts.length}
        />
        <Summary
          icon={UsersRound}
          label={t("cp.accounts.summary.shared")}
          value={accounts.filter((account) => account.sharedService).length}
        />
        <Summary
          icon={KeyRound}
          label={t("cp.accounts.summary.enabled")}
          value={accounts.filter((account) => account.enabled).length}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("cp.accounts.poolTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {accountsQuery.error instanceof Error ? (
            <div className="text-sm text-[var(--status-failed)]">
              {toUserFacingError(accountsQuery.error, t("cp.accounts.loadFailed"))}
            </div>
          ) : accountsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">{t("cp.common.loading")}</div>
          ) : accounts.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              {t("cp.accounts.empty")}
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {accounts.map((account) => (
                <div key={account.id} className="rounded-md border border-border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold" title={account.displayName}>
                        {account.displayName}
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={`${account.agentId} · ${account.id}`}
                      >
                        {account.agentId} · {account.id}
                      </div>
                    </div>
                    <Badge variant={account.enabled ? "running" : "cancelled"}>
                      {account.enabled ? t("cp.common.yes") : t("cp.common.no")}
                    </Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">{t("cp.accounts.backend")}</dt>
                    <dd>{account.backendType}</dd>
                    <dt className="text-muted-foreground">{t("cp.accounts.identity")}</dt>
                    <dd className="min-w-0 break-words font-mono">
                      {account.backendType === "unix"
                        ? `${account.username ?? "—"} (${account.uid ?? "—"}:${account.gid ?? "—"})`
                        : `${account.namespace ?? "—"}/${account.serviceAccount ?? "—"}`}
                    </dd>
                    <dt className="text-muted-foreground">{t("cp.accounts.queues")}</dt>
                    <dd className="min-w-0 break-words">
                      {account.allowedQueues.join(", ") || t("cp.accounts.allQueues")}
                    </dd>
                  </dl>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <SandboxMappingReviewPanel />
    </div>
  );
}

function Summary({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof ServerCog;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-card p-3">
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  );
}
