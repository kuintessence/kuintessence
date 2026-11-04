import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
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

interface PlatformUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  suspended: boolean;
  canManage: boolean;
  organizations: Array<{ id: string; name: string }>;
}

export function PlatformUsersTable() {
  const { t } = useTranslation();
  const organizationId = useActiveOrganizationId();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [target, setTarget] = useState<PlatformUser | null>(null);
  const [reason, setReason] = useState("");
  const client = useQueryClient();
  const mobileReadOnly = useMobileMutationBlocked("/platform/users/example/status");
  const query = useQuery({
    queryKey: ["platform-users", organizationId ?? "all", search, page],
    queryFn: () =>
      api.get<{ items: PlatformUser[]; total: number }>(
        `/platform/users?${new URLSearchParams({ search, offset: String(page * 50), limit: "50" })}`,
      ),
  });
  const update = useMutation({
    mutationFn: (user: PlatformUser) =>
      api.patch(`/platform/users/${user.id}/status`, { suspended: !user.suspended, reason }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["platform-users"] });
      setTarget(null);
      setReason("");
    },
  });
  const items = query.error ? [] : (query.data?.items ?? []);
  return (
    <div className="space-y-4" data-testid="platform-users">
      <PageHeader title={t("operations.resources.users")} />
      {mobileReadOnly && (
        <p className="text-sm text-muted-foreground">{t("operations.users.desktopManage")}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          className="w-full sm:max-w-sm"
          aria-label={t("cp.users.searchLabel")}
          placeholder={t("cp.users.searchPlaceholder")}
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
        <p className="border-y border-border py-8 text-sm text-muted-foreground">
          {t(search ? "cp.users.noSearchResults" : "cp.users.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="block w-full text-sm lg:table">
            <thead className="sr-only bg-muted/40 text-left text-muted-foreground lg:not-sr-only lg:table-header-group">
              <tr>
                {[
                  "cp.users.col.email",
                  "operations.resources.provider",
                  "cp.users.col.role",
                  "operations.users.status",
                  "cp.agents.col.actions",
                ].map((label) => (
                  <th key={label} className="px-4 py-3 font-medium">
                    {t(label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="block divide-y divide-border lg:table-row-group">
              {items.map((user) => (
                <tr key={user.id} className="grid gap-2 p-4 lg:table-row lg:p-0">
                  <td className="min-w-0 break-all lg:px-4 lg:py-3">
                    <div className="font-medium">{user.displayName || user.email}</div>
                    {user.displayName && (
                      <div className="text-xs text-muted-foreground">{user.email}</div>
                    )}
                  </td>
                  <td className="break-words text-muted-foreground lg:max-w-64 lg:px-4 lg:py-3">
                    {user.organizations.map((org) => org.name).join(" · ") || "—"}
                  </td>
                  <td className="text-muted-foreground lg:px-4 lg:py-3">
                    {t(`cp.users.roles.${user.role}`, { defaultValue: user.role })}
                  </td>
                  <td className="lg:px-4 lg:py-3">
                    <Badge variant={user.suspended ? "cancelled" : "running"}>
                      {t(user.suspended ? "cp.common.disabled" : "cp.common.enabled")}
                    </Badge>
                  </td>
                  <td className="lg:px-4 lg:py-3">
                    {user.canManage && !mobileReadOnly && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11 lg:min-h-9"
                        onClick={() => {
                          setReason("");
                          update.reset();
                          setTarget(user);
                        }}
                      >
                        {t(user.suspended ? "operations.users.enable" : "operations.users.disable")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !update.isPending) setTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(target?.suspended ? "operations.users.enable" : "operations.users.disable")}
            </DialogTitle>
            <DialogDescription>
              {target?.email}
              {!target?.suspended && ` — ${t("operations.users.revokeSessions")}`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <label htmlFor="platform-user-status-reason" className="grid gap-2 text-sm">
              {t("operations.users.reason")}
              <Textarea
                id="platform-user-status-reason"
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {update.error && (
              <p role="alert" className="text-sm text-status-failed">
                {toUserFacingError(update.error, t("operations.users.updateFailed"))}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={update.isPending} onClick={() => setTarget(null)}>
              {t("cp.common.cancel")}
            </Button>
            <Button
              disabled={!reason.trim() || update.isPending || !target}
              onClick={() => {
                if (target) update.mutate(target);
              }}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
