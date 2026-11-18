import { ApiError } from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { useOrganizationName } from "../../lib/use-organization-name";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
import { PageHeader } from "../ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

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
  const [page, setPage] = useState(0);
  const organizationName = useOrganizationName(!!organizationId);
  const [action, setAction] = useState<UserAction | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [reason, setReason] = useState("");
  const client = useQueryClient();
  const mobileReadOnly = useMobileMutationBlocked("/platform/users/example/status");
  const query = useQuery({
    queryKey: ["platform-users", organizationId ?? "all", getAuthState().revision, search, page],
    queryFn: () =>
      api.get<{ items: PlatformUser[]; total: number; canCreate: boolean }>(
        `/platform/users?${new URLSearchParams({ search, offset: String(page * 50), limit: "50" })}`,
      ),
  });
  const items = query.error ? [] : (query.data?.items ?? []);
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
      if (intent.type === "delete" && items.length === 1 && page > 0) {
        setPage((current) => Math.max(0, current - 1));
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
            setPage(0);
          }}
        />
        <span className="text-sm tabular-nums text-muted-foreground">
          {query.error || !query.data
            ? "—"
            : t("cp.users.countHint", { visible: items.length, total: query.data.total })}
        </span>
      </div>
      {query.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-status-failed">
          <span>{toUserFacingError(query.error, t("cp.users.loadFailed"))}</span>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t("cp.users.retryRead")}
          </Button>
        </div>
      ) : query.isPending ? (
        <p role="status">{t("cp.common.loading")}</p>
      ) : items.length === 0 ? (
        <p className=" border-border py-8 text-sm text-muted-foreground">
          {t(search ? "cp.users.noSearchResults" : "cp.users.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto border-border">
          <Table className="block w-full text-sm lg:table">
            <TableHeader className="sr-only text-left text-muted-foreground lg:not-sr-only lg:table-header-group">
              <TableRow>
                {[
                  "cp.users.col.email",
                  "operations.resources.provider",
                  "cp.users.col.role",
                  "operations.users.status",
                  "cp.agents.col.actions",
                ].map((label) => (
                  <TableHead key={label} className="px-4 py-3 font-medium">
                    {t(label)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody className="block divide-y divide-border lg:table-row-group">
              {items.map((user) => (
                <TableRow key={user.id} className="grid gap-2 p-4 lg:table-row lg:p-0">
                  <TableCell className="min-w-0 break-all lg:px-4 lg:py-3">
                    <div className="font-medium">{user.displayName || user.email}</div>
                    {user.displayName && (
                      <div className="text-xs text-muted-foreground">{user.email}</div>
                    )}
                  </TableCell>
                  <TableCell className="break-words text-muted-foreground lg:max-w-64 lg:px-4 lg:py-3">
                    {user.organizations.map((org) => org.name).join(" · ") || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground lg:px-4 lg:py-3">
                    {t(`cp.users.roles.${user.role}`, { defaultValue: user.role })}
                  </TableCell>
                  <TableCell className="lg:px-4 lg:py-3">
                    <Badge variant={user.suspended ? "cancelled" : "running"}>
                      {t(user.suspended ? "cp.common.disabled" : "cp.common.enabled")}
                    </Badge>
                  </TableCell>
                  <TableCell className="lg:px-4 lg:py-3">
                    {(user.canManage || user.canEdit) && !mobileReadOnly ? (
                      <div className="flex flex-wrap gap-2">
                        {user.canEdit && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => open({ type: "edit", user })}
                          >
                            {t("operations.users.edit")}
                          </Button>
                        )}
                        {user.canManage && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => open({ type: "status", user })}
                          >
                            {t(
                              user.suspended
                                ? "operations.users.enable"
                                : "operations.users.disable",
                            )}
                          </Button>
                        )}
                        {user.canEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-status-failed"
                            onClick={() => open({ type: "delete", user })}
                          >
                            {t("operations.users.delete")}
                          </Button>
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {query.data && query.data.total > 50 && (
        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
            {t("operations.users.previous")}
          </Button>
          <span className="tabular-nums">
            {page + 1} / {Math.ceil(query.data.total / 50)}
          </span>
          <Button
            variant="outline"
            disabled={(page + 1) * 50 >= query.data.total}
            onClick={() => setPage(page + 1)}
          >
            {t("operations.users.next")}
          </Button>
        </div>
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
                ? t("operations.users.delete")
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
