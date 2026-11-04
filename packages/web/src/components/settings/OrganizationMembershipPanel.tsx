import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { isMobileHighRiskMutationBlocked } from "../../lib/mobile-management-policy";
import { useMediaQuery } from "../../lib/use-media-query";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

const ROLES = {
  owner: "adminAccess.owner",
  admin: "adminAccess.admin",
  operator: "adminAccess.operator",
  member: "adminAccess.member",
  viewer: "adminAccess.viewer",
} as const;
type MemberRole = keyof typeof ROLES;
interface Membership {
  id: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  orgId: string;
  orgName: string | null;
  role: MemberRole;
  platformRole: string;
}
interface MemberOptions {
  users: Array<{ id: string; email: string; displayName: string | null; role: string }>;
  organizations: Array<{ id: string; name: string }>;
  moreUsers: boolean;
  moreOrganizations: boolean;
}
const key = ["admin", "authz", "memberships"] as const;
const PAGE_SIZE = 20;
const selectClass = "min-h-11 w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm";

export function OrganizationMembershipPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const compact = useMediaQuery("(max-width: 767px)");
  const mobileReadOnly = compact && isMobileHighRiskMutationBlocked("/admin/authz/memberships");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<{
    existing: Membership | null;
    userId: string;
    orgId: string;
    role: MemberRole;
  } | null>(null);
  const [removing, setRemoving] = useState<Membership | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [orgSearch, setOrgSearch] = useState("");
  const list = useQuery({
    queryKey: [...key, search, page],
    queryFn: () =>
      api.get<{ data: Membership[]; hasMore: boolean }>(
        `/admin/authz/memberships?${new URLSearchParams({ search, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })}`,
      ),
  });
  const options = useQuery({
    queryKey: ["admin", "authz", "membership-options", userSearch, orgSearch],
    queryFn: () =>
      api.get<{ data: MemberOptions }>(
        `/admin/authz/membership-options?${new URLSearchParams({ user: userSearch, organization: orgSearch })}`,
      ),
    enabled: editor !== null && editor.existing === null,
  });
  const mutation = useMutation({
    mutationFn: (
      change:
        | { action: "save"; userId: string; orgId: string; role: MemberRole; createOnly: boolean }
        | { action: "remove"; userId: string; orgId: string },
    ) =>
      change.action === "save"
        ? api.put("/admin/authz/memberships", {
            userId: change.userId,
            orgId: change.orgId,
            role: change.role,
            createOnly: change.createOnly,
          })
        : api.delete(`/admin/authz/memberships/${change.userId}/${change.orgId}`),
    onSuccess: async (_, change) => {
      setEditor(null);
      setRemoving(null);
      toast.success(change.action === "save" ? t("adminAccess.saved") : t("adminAccess.removed"));
      if (change.action === "remove" && list.data?.data.length === 1 && page > 0) setPage(page - 1);
      await client.invalidateQueries({ queryKey: key });
      await client.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const startEdit = (existing: Membership | null) => {
    mutation.reset();
    setUserSearch("");
    setOrgSearch("");
    setEditor({
      existing,
      userId: existing?.userId ?? "",
      orgId: existing?.orgId ?? "",
      role: existing?.role ?? "member",
    });
  };
  const selectedPlatformRole =
    editor?.existing?.platformRole ??
    options.data?.data.users.find((user) => user.id === editor?.userId)?.role;
  const privileged = ["org_admin", "platform_admin", "super_admin"].includes(
    selectedPlatformRole ?? "",
  );
  return (
    <Card data-testid="organization-membership-panel">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{t("adminAccess.members")}</CardTitle>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label={t("adminAccess.refreshMembers")}
            onClick={() => void list.refetch()}
            disabled={list.isFetching}
          >
            <RefreshCw />
          </Button>
          <Button size="sm" disabled={mobileReadOnly} onClick={() => startEdit(null)}>
            <Plus />

            {t("adminAccess.add")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {mobileReadOnly ? (
          <p className="text-sm text-muted-foreground">{t("adminAccess.desktopEdit")}</p>
        ) : null}
        <Input
          aria-label={t("adminAccess.search")}
          placeholder={t("adminAccess.searchHint")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          className="max-w-md"
        />
        {list.isError ? (
          <p role="alert" className="text-sm text-status-failed">
            {toUserFacingError(list.error, t("adminAccess.loadFailed"))}
          </p>
        ) : list.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("adminAccess.loading")}
          </p>
        ) : list.data.data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {search ? t("adminAccess.noMatches") : t("adminAccess.noMembers")}
          </p>
        ) : (
          <ul className="max-h-[36rem] divide-y overflow-y-auto rounded-md border">
            {list.data.data.map((member) => (
              <li
                key={member.id}
                className="flex min-w-0 flex-wrap items-center gap-3 p-3"
                data-testid={`membership-${member.id}`}
              >
                <div className="min-w-0 flex-1 basis-48">
                  <p className="break-words font-medium">
                    {member.displayName || member.email || member.userId}
                  </p>
                  {member.displayName && member.email ? (
                    <p className="break-all text-xs text-muted-foreground">{member.email}</p>
                  ) : null}
                </div>
                <p className="min-w-0 flex-1 basis-40 break-words text-sm">
                  {member.orgName ?? member.orgId}
                </p>
                <span className="text-sm">
                  {ROLES[member.role] ? t(ROLES[member.role]) : member.role}
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={mobileReadOnly}
                    aria-label={t("adminAccess.editMember", {
                      name: member.displayName || member.email || member.userId,
                    })}
                    onClick={() => startEdit(member)}
                  >
                    <Pencil />
                    <span>{t("adminAccess.edit")}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={mobileReadOnly}
                    aria-label={t("adminAccess.removeMember", {
                      name: member.displayName || member.email || member.userId,
                    })}
                    onClick={() => {
                      mutation.reset();
                      setRemoving(member);
                    }}
                  >
                    <Trash2 />
                    <span>{t("adminAccess.remove")}</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {page > 0 || list.data?.hasMore ? (
          <nav
            aria-label={t("adminAccess.pagination")}
            className="flex items-center justify-end gap-3"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0 || list.isFetching}
              onClick={() => setPage(page - 1)}
            >
              {t("adminAccess.previous")}
            </Button>
            <span className="text-sm">{t("adminAccess.page", { page: page + 1 })}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!list.data?.hasMore || list.isFetching || list.isError}
              onClick={() => setPage(page + 1)}
            >
              {t("adminAccess.next")}
            </Button>
          </nav>
        ) : null}
      </CardContent>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setEditor(null);
        }}
      >
        <DialogContent dismissible={!mutation.isPending} aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {editor?.existing ? t("adminAccess.editTitle") : t("adminAccess.addTitle")}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {mobileReadOnly ? (
              <p className="text-sm text-muted-foreground">{t("adminAccess.desktopSave")}</p>
            ) : null}
            {editor?.existing ? (
              <div className="space-y-1 break-words">
                <p className="font-medium">
                  {editor.existing.displayName || editor.existing.email}
                </p>
                <p className="text-sm text-muted-foreground">{editor.existing.orgName}</p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label htmlFor="membership-user" className="text-sm font-medium">
                    {t("adminAccess.user")}
                  </label>
                  <Input
                    aria-label={t("adminAccess.findUser")}
                    disabled={mutation.isPending}
                    placeholder={t("adminAccess.userHint")}
                    value={userSearch}
                    onChange={(event) => {
                      setUserSearch(event.target.value);
                      setEditor((current) => current && { ...current, userId: "" });
                    }}
                  />
                  <select
                    id="membership-user"
                    className={selectClass}
                    disabled={mutation.isPending || options.isFetching || options.isError}
                    value={editor?.userId ?? ""}
                    onChange={(event) =>
                      setEditor((current) => current && { ...current, userId: event.target.value })
                    }
                  >
                    <option value="">
                      {options.isFetching
                        ? t("adminAccess.searching")
                        : options.data?.data.users.length === 0
                          ? t("adminAccess.noUsers")
                          : t("adminAccess.chooseUser")}
                    </option>
                    {!options.isError &&
                      options.data?.data.users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName ? `${user.displayName} · ${user.email}` : user.email}
                        </option>
                      ))}
                  </select>
                  {options.data?.data.moreUsers ? (
                    <p className="text-xs text-muted-foreground">{t("adminAccess.moreUsers")}</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="membership-org" className="text-sm font-medium">
                    {t("adminAccess.organization")}
                  </label>
                  <Input
                    aria-label={t("adminAccess.findOrganization")}
                    disabled={mutation.isPending}
                    placeholder={t("adminAccess.orgHint")}
                    value={orgSearch}
                    onChange={(event) => {
                      setOrgSearch(event.target.value);
                      setEditor((current) => current && { ...current, orgId: "" });
                    }}
                  />
                  <select
                    id="membership-org"
                    className={selectClass}
                    disabled={mutation.isPending || options.isFetching || options.isError}
                    value={editor?.orgId ?? ""}
                    onChange={(event) =>
                      setEditor((current) => current && { ...current, orgId: event.target.value })
                    }
                  >
                    <option value="">
                      {options.isFetching
                        ? t("adminAccess.searching")
                        : options.data?.data.organizations.length === 0
                          ? t("adminAccess.noOrgs")
                          : t("adminAccess.chooseOrg")}
                    </option>
                    {!options.isError &&
                      options.data?.data.organizations.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name}
                        </option>
                      ))}
                  </select>
                  {options.data?.data.moreOrganizations ? (
                    <p className="text-xs text-muted-foreground">{t("adminAccess.moreOrgs")}</p>
                  ) : null}
                </div>
                {options.isError ? (
                  <div role="alert" className="text-sm text-status-failed">
                    {toUserFacingError(options.error, t("adminAccess.optionsFailed"))}
                    <Button variant="outline" size="sm" onClick={() => void options.refetch()}>
                      {t("adminAccess.retry")}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
            <div className="space-y-2">
              <label htmlFor="membership-role" className="text-sm font-medium">
                {t("adminAccess.orgRole")}
              </label>
              <select
                id="membership-role"
                disabled={mutation.isPending}
                className={selectClass}
                value={editor?.role ?? "member"}
                onChange={(event) =>
                  setEditor(
                    (current) => current && { ...current, role: event.target.value as MemberRole },
                  )
                }
              >
                {Object.entries(ROLES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
            </div>
            {privileged ? (
              <p className="text-sm text-muted-foreground">
                {t("adminAccess.independentPermissions")}
              </p>
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {!editor?.existing &&
                mutation.error instanceof ApiError &&
                mutation.error.status === 409
                  ? t("adminAccess.alreadyMember")
                  : toUserFacingError(mutation.error, t("adminAccess.saveFailed"))}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setEditor(null)}>
              {t("adminAccess.cancel")}
            </Button>
            <Button
              disabled={
                !editor?.userId ||
                !editor.orgId ||
                mutation.isPending ||
                mobileReadOnly ||
                (!editor.existing && (options.isFetching || options.isError))
              }
              onClick={() => {
                if (editor)
                  mutation.mutate({
                    action: "save",
                    userId: editor.userId,
                    orgId: editor.orgId,
                    role: editor.role,
                    createOnly: !editor.existing,
                  });
              }}
            >
              {mutation.isPending ? t("adminAccess.saving") : t("adminAccess.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setRemoving(null);
        }}
      >
        <DialogContent dismissible={!mutation.isPending} aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t("adminAccess.removeTitle")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {mobileReadOnly ? (
              <p className="text-sm text-muted-foreground">{t("adminAccess.desktopRemove")}</p>
            ) : null}
            <p className="break-words">
              {t("adminAccess.removeQuestion", {
                name: removing?.displayName || removing?.email,
                organization: removing?.orgName,
              })}
            </p>
            <p className="text-sm text-muted-foreground">{t("adminAccess.removeEffect")}</p>
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {toUserFacingError(mutation.error, t("adminAccess.removeFailed"))}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setRemoving(null)}
            >
              {t("adminAccess.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={mutation.isPending || mobileReadOnly}
              onClick={() => {
                if (removing)
                  mutation.mutate({
                    action: "remove",
                    userId: removing.userId,
                    orgId: removing.orgId,
                  });
              }}
            >
              {mutation.isPending ? t("adminAccess.removing") : t("adminAccess.confirmRemove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
