import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ServerCog, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { isMobileHighRiskMutationBlocked } from "../../lib/mobile-management-policy";
import { listSandboxExecutionAccounts } from "../../lib/sandbox-client";
import { useMediaQuery } from "../../lib/use-media-query";
import { useOrganizationName } from "../../lib/use-organization-name";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { EditAccountQueues } from "./EditAccountQueues";
import { RegisterExecutionAccount } from "./RegisterExecutionAccount";
import { SandboxMappingReviewPanel } from "./SandboxMappingReviewPanel";

export function CpAccountsPage() {
  const { t } = useTranslation();
  const activeOrganizationId = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const organizationName = useOrganizationName();
  const [statusTarget, setStatusTarget] = useState<(typeof accounts)[number] | null>(null);
  const [registering, setRegistering] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const compact = useMediaQuery("(max-width: 767px)");
  const mobileReadOnly = compact && isMobileHighRiskMutationBlocked("/sandbox/accounts");
  const accountsQuery = useQuery({
    queryKey: [
      "sandbox-execution-accounts",
      activeOrganizationId ?? "all",
      getAuthState().revision,
    ],
    queryFn: listSandboxExecutionAccounts,
    retry: false,
    refetchInterval: 15_000,
  });
  const accounts = accountsQuery.data?.data ?? [];
  const canManageAccount = (orgId: string) =>
    !accountsQuery.error &&
    !mobileReadOnly &&
    accountsQuery.data?.manageableProviderOrgIds?.includes(orgId) === true;
  const statusMutation = useMutation({
    mutationFn: (account: (typeof accounts)[number]) =>
      api.patch(`/sandbox/accounts/${account.id}/status`, { enabled: !account.enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sandbox-execution-accounts"] });
      setStatusTarget(null);
    },
  });
  const canRegister =
    !!activeOrganizationId &&
    !accountsQuery.error &&
    accountsQuery.data?.manageableProviderOrgIds?.includes(activeOrganizationId) === true &&
    !mobileReadOnly;
  const editingAccount = accounts.find(
    (account) =>
      account.id === editingId &&
      canManageAccount(account.providerOrgId) &&
      account.backendType === "unix",
  );
  useEffect(() => {
    if (!editingAccount) setEditingId(null);
  }, [editingAccount]);
  useEffect(() => {
    if (!canRegister) setRegistering(false);
  }, [canRegister]);

  return (
    <div className="space-y-4" data-testid="cp-accounts-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("cp.accounts.title")}</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void accountsQuery.refetch()}>
            {t("cp.common.refresh")}
          </Button>
          {canRegister && (
            <Button onClick={() => setRegistering(true)}>{t("cp.accounts.register")}</Button>
          )}
        </div>
      </div>
      {!activeOrganizationId && (
        <p className="text-sm text-muted-foreground">{t("cp.accounts.selectOrganization")}</p>
      )}
      {mobileReadOnly && (
        <p className="text-sm text-muted-foreground">{t("cp.accounts.desktopRegister")}</p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <Summary
          icon={ServerCog}
          label={t("cp.accounts.summary.accounts")}
          value={accountsQuery.error || !accountsQuery.data ? "—" : accounts.length}
        />
        <Summary
          icon={UsersRound}
          label={t("cp.accounts.summary.shared")}
          value={
            accountsQuery.error || !accountsQuery.data
              ? "—"
              : accounts.filter((account) => account.sharedService).length
          }
        />
        <Summary
          icon={KeyRound}
          label={t("cp.accounts.summary.enabled")}
          value={
            accountsQuery.error || !accountsQuery.data
              ? "—"
              : accounts.filter((account) => account.enabled).length
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("cp.accounts.poolTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {accountsQuery.error instanceof Error ? (
            <div role="alert" className="text-sm text-[var(--status-failed)]">
              {toUserFacingError(accountsQuery.error, t("cp.accounts.loadFailed"))}
            </div>
          ) : accountsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">{t("cp.common.loading")}</div>
          ) : accounts.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              {t("cp.accounts.empty")}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  data-testid={`cp-execution-account-${account.id}`}
                  className="rounded-md border border-border bg-background p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div
                        className="break-words text-sm font-semibold"
                        title={account.displayName}
                      >
                        {account.displayName}
                      </div>
                      <div
                        className="break-all font-mono text-[11px] text-muted-foreground"
                        title={`${account.agentId} · ${account.id}`}
                      >
                        {account.agentId}
                      </div>
                    </div>
                    <Badge
                      variant={account.enabled ? "running" : "cancelled"}
                      className="shrink-0 whitespace-nowrap"
                    >
                      {account.enabled ? t("cp.common.enabled") : t("cp.common.disabled")}
                    </Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">{t("operations.resources.provider")}</dt>
                    <dd className="min-w-0 break-words">
                      {organizationName(account.providerOrgId)}
                    </dd>
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
                      {account.backendType === "kubernetes"
                        ? t("cp.accounts.queuesNotApplicable")
                        : account.allowedQueues.join(", ") || t("cp.accounts.noQueues")}
                    </dd>
                  </dl>
                  {canManageAccount(account.providerOrgId) && account.backendType === "unix" && (
                    <Button
                      className="mt-3"
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingId(account.id)}
                    >
                      {t("cp.accounts.editQueues")}
                    </Button>
                  )}
                  {canManageAccount(account.providerOrgId) && (
                    <Button
                      className="mt-3 ml-2"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        statusMutation.reset();
                        setStatusTarget(account);
                      }}
                    >
                      {t(account.enabled ? "operations.users.disable" : "operations.users.enable")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <SandboxMappingReviewPanel />
      <Dialog
        open={statusTarget !== null}
        onOpenChange={(open) => {
          if (!open && !statusMutation.isPending) setStatusTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(statusTarget?.enabled ? "operations.users.disable" : "operations.users.enable")}
            </DialogTitle>
            <DialogDescription>
              {statusTarget?.enabled
                ? t("operations.accounts.disableConfirm", { name: statusTarget.displayName })
                : statusTarget?.displayName}
            </DialogDescription>
          </DialogHeader>
          {statusMutation.error && (
            <DialogBody>
              <p role="alert" className="text-sm text-status-failed">
                {toUserFacingError(statusMutation.error, t("operations.users.updateFailed"))}
              </p>
            </DialogBody>
          )}
          <DialogFooter className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={statusMutation.isPending}
              onClick={() => setStatusTarget(null)}
            >
              {t("cp.common.cancel")}
            </Button>
            <Button
              disabled={statusMutation.isPending || !statusTarget}
              onClick={() => {
                if (statusTarget) statusMutation.mutate(statusTarget);
              }}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editingAccount && (
        <EditAccountQueues
          key={`${editingAccount.id}:${getAuthState().revision}`}
          account={editingAccount}
          onClose={() => setEditingId(null)}
          onSaved={async () => {
            await queryClient.invalidateQueries({ queryKey: ["sandbox-execution-accounts"] });
            setEditingId(null);
          }}
        />
      )}
      {registering && canRegister && activeOrganizationId && (
        <RegisterExecutionAccount
          key={`${activeOrganizationId}:${getAuthState().revision}`}
          providerOrgId={activeOrganizationId}
          onClose={() => setRegistering(false)}
          onSaved={async () => {
            await queryClient.invalidateQueries({ queryKey: ["sandbox-execution-accounts"] });
            setRegistering(false);
          }}
        />
      )}
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
  value: number | string;
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
