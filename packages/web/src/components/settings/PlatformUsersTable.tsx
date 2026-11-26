import { ApiError } from "@kuintessence/shared/browser";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, PaginationState, SortingState } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
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
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { PageHeader } from "../ui/page";

interface PlatformUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  suspended: boolean;
  canManage: boolean;
  canEdit: boolean;
  organizations: Array<{ id: string; name: string }>;
}

type UserAction = { type: "create" } | { type: "edit" | "status" | "delete"; user: PlatformUser };

export function PlatformUsersTable() {
  const { t } = useTranslation();
  const organizationId = useActiveOrganizationId();
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [sorting, setSorting] = useState<SortingState>([]);
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const sort = sorting[0];
  const resetPage = () => setPagination((current) => ({ ...current, pageIndex: 0 }));
  const organizationName = useOrganizationName(!!organizationId);
  const [action, setAction] = useState<UserAction | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [reason, setReason] = useState("");
  const client = useQueryClient();
  const mobileReadOnly = useMobileMutationBlocked("/platform/users/example/status");
  const query = useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      "platform-users",
      organizationId ?? "all",
      getAuthState().revision,
      search,
      pagination,
      sorting,
      role,
      status,
    ],
    queryFn: () =>
      api.get<{ items: PlatformUser[]; total: number; canCreate: boolean }>(
        `/platform/users?${new URLSearchParams({
          search,
          offset: String(pagination.pageIndex * pagination.pageSize),
          limit: String(pagination.pageSize),
          ...(sort ? { sort: sort.id, direction: sort.desc ? "desc" : "asc" } : {}),
          ...(role ? { role } : {}),
          ...(status ? { status } : {}),
        })}`,
      ),
  });
  const items = query.error || query.isPlaceholderData ? [] : (query.data?.items ?? []);
  useEffect(() => {
    if (!query.data || query.isPlaceholderData) return;
    const last = Math.max(0, Math.ceil(query.data.total / pagination.pageSize) - 1);
    if (pagination.pageIndex > last) setPagination((current) => ({ ...current, pageIndex: last }));
  }, [pagination, query.data, query.isPlaceholderData]);
  const update = useMutation({
    mutationFn: async (intent: UserAction) => {
      if (intent.type === "create") {
        await api.post("/platform/users", { email: email.trim(), displayName });
        return;
      }
      const path = `/platform/users/${intent.user.id}`;
      if (intent.type === "edit") await api.patch(path, { displayName });
      if (intent.type === "delete") await api.delete(path);
      if (intent.type === "status")
        await api.patch(`${path}/status`, { suspended: !intent.user.suspended, reason });
    },
    onSuccess: async (_result, intent) => {
      if (intent.type === "delete" && items.length === 1 && pagination.pageIndex > 0) {
        setPagination((current) => ({ ...current, pageIndex: Math.max(0, current.pageIndex - 1) }));
      }
      await client.invalidateQueries({ queryKey: ["platform-users"] });
      setAction(null);
    },
  });
  function open(intent: UserAction) {
    update.reset();
    setEmail(intent.type === "create" ? "" : intent.user.email);
    setDisplayName(intent.type === "edit" ? (intent.user.displayName ?? "") : "");
    setReason("");
    setAction(intent);
  }
  const editingProfile = action?.type === "create" || action?.type === "edit";
  const title =
    action?.type === "status"
      ? t(action.user.suspended ? "operations.users.enable" : "operations.users.disable")
      : t(`operations.users.${action?.type ?? "edit"}`);
  const errorDetails = update.error instanceof ApiError ? update.error.details : null;
  const errorReason =
    typeof errorDetails === "object" && errorDetails && "reason" in errorDetails
      ? errorDetails.reason
      : null;
  const columns: ColumnDef<PlatformUser>[] = [
    {
      id: "member",
      accessorFn: (user) => user.displayName || user.email,
      header: t("cp.users.col.email"),
      size: 225,
      cell: ({ row: { original: user } }) => (
        <>
          <div className="font-medium">{user.displayName || user.email}</div>
          {user.displayName && <div className="text-xs text-muted-foreground">{user.email}</div>}
        </>
      ),
    },
    {
      id: "organization",
      accessorFn: (user) => user.organizations.map((org) => org.name).join(" · ") || "—",
      header: t("operations.resources.provider"),
      size: 155,
    },
    {
      accessorKey: "role",
      header: t("cp.users.col.role"),
      size: 126,
      cell: ({ row }) =>
        t(`cp.users.roles.${row.original.role}`, { defaultValue: row.original.role }),
    },
    {
      id: "status",
      accessorFn: (user) => user.suspended,
      header: t("operations.users.status"),
      size: 108,
      cell: ({ row }) => (
        <Badge variant={row.original.suspended ? "cancelled" : "running"}>
          {t(row.original.suspended ? "cp.common.disabled" : "cp.common.enabled")}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: t("cp.agents.col.actions"),
      size: 182,
      enableResizing: false,
      cell: ({ row: { original: user } }) =>
        !mobileReadOnly && (user.canManage || user.canEdit) ? (
          <div className="flex items-center gap-1">
            {user.canEdit && (
              <Button
                variant="outline"
                size="sm"
                className="px-2"
                onClick={() => open({ type: "edit", user })}
              >
                {t("operations.users.editAction")}
              </Button>
            )}
            {user.canManage && (
              <Button
                variant="outline"
                size="sm"
                className="px-2"
                onClick={() => open({ type: "status", user })}
              >
                {t(
                  user.suspended
                    ? "operations.users.enableAction"
                    : "operations.users.disableAction",
                )}
              </Button>
            )}
            {user.canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="px-2 text-status-failed"
                onClick={() => open({ type: "delete", user })}
              >
                {t("operations.users.deleteAction")}
              </Button>
            )}
          </div>
        ) : (
          "—"
        ),
    },
  ];
  return (
    <div className="space-y-4" data-testid="platform-users">
      <PageHeader
        title={t("operations.resources.users")}
        actions={
          query.data?.canCreate &&
          !query.error &&
          !mobileReadOnly && (
            <Button className="sm:flex-none" onClick={() => open({ type: "create" })}>
              <Plus aria-hidden="true" />
              {t("operations.users.create")}
            </Button>
          )
        }
      />
      {mobileReadOnly && (
        <p className="text-sm text-muted-foreground">{t("operations.users.desktopManage")}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          className="w-full sm:max-w-sm"
          aria-label={t("cp.users.searchLabel")}
          placeholder={t("cp.users.searchPlaceholder")}
          maxLength={200}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            resetPage();
          }}
        />
        <NativeSelect
          aria-label={t("cp.users.col.role")}
          value={role}
          onChange={(event) => {
            setRole(event.target.value);
            resetPage();
          }}
        >
          <option value="">{t("operations.users.allRoles")}</option>
          {["guest", "user", "org_admin", "operator", "platform_admin", "super_admin"].map(
            (value) => (
              <option key={value} value={value}>
                {t(`cp.users.roles.${value}`, { defaultValue: value })}
              </option>
            ),
          )}
        </NativeSelect>
        <NativeSelect
          aria-label={t("operations.users.status")}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            resetPage();
          }}
        >
          <option value="">{t("operations.users.allStatuses")}</option>
          <option value="enabled">{t("cp.common.enabled")}</option>
          <option value="suspended">{t("cp.common.disabled")}</option>
        </NativeSelect>
      </div>
      {query.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-status-failed">
          <span>{toUserFacingError(query.error, t("cp.users.loadFailed"))}</span>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t("cp.users.retryRead")}
          </Button>
        </div>
      ) : (
        <DataTable<PlatformUser, unknown>
          columns={columns}
          data={items}
          getRowId={(user) => user.id}
          caption={t("operations.resources.users")}
          resizable
          pinnedEndColumn="actions"
          pagination={pagination}
          onPaginationChange={setPagination}
          sorting={sorting}
          onSortingChange={(next) => {
            setSorting(next);
            resetPage();
          }}
          rowCount={query.data?.total ?? 0}
          manualPagination
          manualSorting
          manualFiltering
          emptyState={t(
            query.isPending || query.isPlaceholderData
              ? "cp.common.loading"
              : search || role || status
                ? "cp.users.noSearchResults"
                : "cp.users.empty",
          )}
        />
      )}
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !update.isPending) setAction(null);
        }}
      >
        <DialogContent dismissible={!update.isPending}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {action?.type === "create" ? (
                t("operations.users.createHint", {
                  scope: organizationId
                    ? organizationName(organizationId)
                    : t("operations.users.platformScope"),
                })
              ) : action?.type === "delete" ? (
                t("operations.users.deleteHint", { email })
              ) : action?.type === "status" && !action.user.suspended ? (
                <>
                  {email} · {t("operations.users.revokeSessions")}
                </>
              ) : (
                email
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form
              id="platform-user-form"
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (action && !update.isPending) update.mutate(action);
              }}
            >
              {action?.type === "create" && (
                <label className="grid gap-2 text-sm">
                  {t("operations.users.email")}
                  <Input
                    type="email"
                    required
                    maxLength={255}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              )}
              {editingProfile && (
                <label className="grid gap-2 text-sm">
                  {t("operations.users.displayName")}
                  <Input
                    maxLength={255}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
              )}
              {action?.type === "status" && (
                <label htmlFor="platform-user-status-reason" className="grid gap-2 text-sm">
                  {t("operations.users.reason")}
                  <Textarea
                    id="platform-user-status-reason"
                    value={reason}
                    maxLength={500}
                    onChange={(event) => setReason(event.target.value)}
                    required
                  />
                </label>
              )}
              {update.error && (
                <p role="alert" className="text-sm text-status-failed">
                  {errorReason === "EMAIL_IN_USE"
                    ? t("operations.users.emailInUse")
                    : errorReason === "USER_HAS_HISTORY"
                      ? t("operations.users.hasHistory")
                      : toUserFacingError(update.error, t("operations.users.updateFailed"))}
                </p>
              )}
            </form>
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={update.isPending} onClick={() => setAction(null)}>
              {t("cp.common.cancel")}
            </Button>
            <Button
              type="submit"
              form="platform-user-form"
              variant={action?.type === "delete" ? "destructive" : "default"}
              disabled={!action || update.isPending || (action.type === "status" && !reason.trim())}
            >
              {action?.type === "delete"
                ? t("operations.users.deleteAction")
                : editingProfile
                  ? t("cp.common.save")
                  : t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
