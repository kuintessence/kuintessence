import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { isMobileHighRiskMutationBlocked } from "../../lib/mobile-management-policy";
import {
  listSandboxExecutionAccounts,
  type SandboxExecutionAccount,
} from "../../lib/sandbox-client";
import { useMediaQuery } from "../../lib/use-media-query";
import { useOrganizationName } from "../../lib/use-organization-name";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DataTable } from "../ui/data-table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { PageHeader } from "../ui/page";
import { RefreshButton } from "../ui/refresh-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { EditAccountQueues } from "./EditAccountQueues";
import { RegisterExecutionAccount } from "./RegisterExecutionAccount";
import { SandboxMappingReviewPanel } from "./SandboxMappingReviewPanel";

export function CpAccountsPage() {
  const { t } = useTranslation();
  const activeOrganizationId = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const organizationName = useOrganizationName();
  const [view, setView] = useState("accounts");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [backend, setBackend] = useState("");
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

  const columns: ColumnDef<SandboxExecutionAccount>[] = [
    {
      accessorKey: "displayName",
      header: t("cp.accounts.summary.accounts"),
      size: 205,
      cell: ({ row: { original } }) => (
        <div title={original.id}>
          <div className="font-medium">{original.displayName}</div>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-mono">{original.agentId}</span>
            {original.sharedService && <span>{t("cp.accounts.summary.shared")}</span>}
          </div>
        </div>
      ),
    },
    {
      id: "provider",
      accessorFn: (account) => organizationName(account.providerOrgId),
      header: t("operations.resources.provider"),
      size: 155,
    },
    { accessorKey: "backendType", header: t("cp.accounts.backend"), size: 135 },
    {
      id: "identity",
      accessorFn: (account) =>
        account.backendType === "unix"
          ? `${account.username ?? "—"} (${account.uid ?? "—"}:${account.gid ?? "—"})`
          : `${account.namespace ?? "—"}/${account.serviceAccount ?? "—"}`,
      header: t("cp.accounts.identity"),
      size: 170,
      cell: ({ getValue }) => <span className="font-mono">{String(getValue())}</span>,
    },
    {
      id: "queues",
      accessorFn: (account) =>
        account.backendType === "kubernetes"
          ? t("cp.accounts.queuesNotApplicable")
          : account.allowedQueues.join(", ") || t("cp.accounts.noQueues"),
      header: t("cp.accounts.queues"),
      size: 160,
    },
    {
      id: "status",
      accessorFn: (account) => Number(account.enabled),
      header: t("operations.users.status"),
      size: 105,
      cell: ({ row: { original } }) => (
        <Badge variant={original.enabled ? "running" : "cancelled"}>
          {t(original.enabled ? "cp.common.enabled" : "cp.common.disabled")}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: t("cp.queues.col.actions"),
      size: 205,
      enableResizing: false,
      cell: ({ row: { original: account } }) =>
        canManageAccount(account.providerOrgId) ? (
          <div className="flex flex-wrap gap-2">
            {account.backendType === "unix" && (
              <Button variant="outline" size="sm" onClick={() => setEditingId(account.id)}>
                {t("cp.accounts.editQueues")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                statusMutation.reset();
                setStatusTarget(account);
              }}
            >
              {t(account.enabled ? "operations.users.disable" : "operations.users.enable")}
            </Button>
          </div>
        ) : (
          "—"
        ),
    },
  ];
  const filteredAccounts = accounts.filter(
    (account) =>
      (!status || (status === "enabled") === account.enabled) &&
      (!backend || account.backendType === backend),
  );

  return (
    <div className="min-w-0 space-y-4" data-testid="cp-accounts-page">
      <PageHeader
        title={t("cp.accounts.title")}
        actions={
          view === "accounts" && (
            <>
              <RefreshButton
                variant="outline"
                onClick={() => void accountsQuery.refetch()}
                label={t("cp.common.refresh")}
                disabled={accountsQuery.isFetching}
              />
              {canRegister && (
                <Button className="sm:flex-none" onClick={() => setRegistering(true)}>
                  {t("cp.accounts.register")}
                </Button>
              )}
            </>
          )
        }
      />
      <Tabs value={view} onValueChange={setView}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="accounts">{t("cp.accounts.poolTitle")}</TabsTrigger>
          <TabsTrigger value="requests">{t("sandbox.accounts.reviewTitle")}</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts" className="min-w-0 space-y-3">
          {!activeOrganizationId && (
            <p className="text-sm text-muted-foreground">{t("cp.accounts.selectOrganization")}</p>
          )}
          {mobileReadOnly && (
            <p className="text-sm text-muted-foreground">{t("cp.accounts.desktopRegister")}</p>
          )}
          {accountsQuery.error ? (
            <p role="alert" className="text-sm text-status-failed">
              {toUserFacingError(accountsQuery.error, t("cp.accounts.loadFailed"))}
            </p>
          ) : accountsQuery.isLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("cp.common.loading")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  className="min-w-36 flex-[1_1_14rem]"
                  aria-label={t("cp.accounts.search")}
                  placeholder={t("cp.accounts.search")}
                />
                <NativeSelect
                  aria-label={t("cp.accounts.backend")}
                  value={backend}
                  onChange={(event) => setBackend(event.currentTarget.value)}
                  className="h-9"
                >
                  <option value="">{t("cp.accounts.allBackends")}</option>
                  <option value="unix">Unix</option>
                  <option value="kubernetes">Kubernetes</option>
                </NativeSelect>
                <NativeSelect
                  aria-label={t("operations.users.status")}
                  value={status}
                  onChange={(event) => setStatus(event.currentTarget.value)}
                  className="h-9"
                >
                  <option value="">{t("cp.accounts.allStatuses")}</option>
                  <option value="enabled">{t("cp.common.enabled")}</option>
                  <option value="disabled">{t("cp.common.disabled")}</option>
                </NativeSelect>
              </div>
              <DataTable
                columns={columns}
                data={filteredAccounts}
                globalFilter={search.trim()}
                pageSize={25}
                getRowId={(account) => account.id}
                rowDataTestId={(account) => `cp-execution-account-${account.id}`}
                pinnedEndColumn="actions"
                resizable
                caption={t("cp.accounts.poolTitle")}
                emptyState={accounts.length === 0 ? t("cp.accounts.empty") : t("common.empty")}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="requests">
          <SandboxMappingReviewPanel />
        </TabsContent>
      </Tabs>
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
