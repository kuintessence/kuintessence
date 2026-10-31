import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
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
  owner: "所有者",
  admin: "管理员",
  operator: "运营人员",
  member: "成员",
  viewer: "观察者",
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
      toast.success(change.action === "save" ? "组织权限已保存" : "已移除组织成员");
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
        <CardTitle>组织成员权限</CardTitle>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="刷新组织成员"
            onClick={() => void list.refetch()}
            disabled={list.isFetching}
          >
            <RefreshCw />
          </Button>
          <Button size="sm" disabled={mobileReadOnly} onClick={() => startEdit(null)}>
            <Plus />
            添加成员
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {mobileReadOnly ? (
          <p className="text-sm text-muted-foreground">请在电脑上修改组织成员权限。</p>
        ) : null}
        <Input
          aria-label="搜索组织成员"
          placeholder="姓名、邮箱或组织名称"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          className="max-w-md"
        />
        {list.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {toUserFacingError(list.error, "无法读取组织成员，请重试。")}
          </p>
        ) : list.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取成员…
          </p>
        ) : list.data.data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {search ? "未找到匹配成员" : "暂无组织成员"}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
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
                <span className="text-sm">{ROLES[member.role] ?? member.role}</span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={mobileReadOnly}
                    aria-label={`编辑 ${member.displayName || member.email || member.userId} 的组织权限`}
                    onClick={() => startEdit(member)}
                  >
                    <Pencil />
                    <span>编辑</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={mobileReadOnly}
                    aria-label={`移除 ${member.displayName || member.email || member.userId} 的组织成员资格`}
                    onClick={() => {
                      mutation.reset();
                      setRemoving(member);
                    }}
                  >
                    <Trash2 />
                    <span>移除</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {page > 0 || list.data?.hasMore ? (
          <nav aria-label="组织成员分页" className="flex items-center justify-end gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0 || list.isFetching}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </Button>
            <span className="text-sm">第 {page + 1} 页</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!list.data?.hasMore || list.isFetching || list.isError}
              onClick={() => setPage(page + 1)}
            >
              下一页
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
            <DialogTitle>{editor?.existing ? "编辑组织权限" : "添加组织成员"}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {mobileReadOnly ? (
              <p className="text-sm text-muted-foreground">请在电脑上保存权限修改。</p>
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
                    用户
                  </label>
                  <Input
                    aria-label="查找用户"
                    disabled={mutation.isPending}
                    placeholder="姓名或邮箱"
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
                        ? "正在查找…"
                        : options.data?.data.users.length === 0
                          ? "未找到匹配用户"
                          : "选择用户"}
                    </option>
                    {!options.isError &&
                      options.data?.data.users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName ? `${user.displayName} · ${user.email}` : user.email}
                        </option>
                      ))}
                  </select>
                  {options.data?.data.moreUsers ? (
                    <p className="text-xs text-muted-foreground">
                      匹配超过 50 位用户，请缩小搜索范围。
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="membership-org" className="text-sm font-medium">
                    组织
                  </label>
                  <Input
                    aria-label="查找组织"
                    disabled={mutation.isPending}
                    placeholder="组织名称"
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
                        ? "正在查找…"
                        : options.data?.data.organizations.length === 0
                          ? "未找到匹配组织"
                          : "选择组织"}
                    </option>
                    {!options.isError &&
                      options.data?.data.organizations.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name}
                        </option>
                      ))}
                  </select>
                  {options.data?.data.moreOrganizations ? (
                    <p className="text-xs text-muted-foreground">
                      匹配超过 50 个组织，请缩小搜索范围。
                    </p>
                  ) : null}
                </div>
                {options.isError ? (
                  <div role="alert" className="text-sm text-destructive">
                    {toUserFacingError(options.error, "无法读取用户和组织。")}
                    <Button variant="outline" size="sm" onClick={() => void options.refetch()}>
                      重试
                    </Button>
                  </div>
                ) : null}
              </>
            )}
            <div className="space-y-2">
              <label htmlFor="membership-role" className="text-sm font-medium">
                组织角色
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
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {privileged ? (
              <p className="text-sm text-muted-foreground">
                该用户还拥有平台或算力管理权限；修改组织角色不会撤销这些权限。
              </p>
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {!editor?.existing &&
                mutation.error instanceof ApiError &&
                mutation.error.status === 409
                  ? "该用户已属于此组织，请从成员列表编辑权限。"
                  : toUserFacingError(mutation.error, "组织权限保存失败，请重试。")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setEditor(null)}>
              取消
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
              {mutation.isPending ? "保存中…" : "保存"}
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
            <DialogTitle>移除组织成员</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {mobileReadOnly ? (
              <p className="text-sm text-muted-foreground">请在电脑上移除组织成员。</p>
            ) : null}
            <p className="break-words">
              确认将 {removing?.displayName || removing?.email} 从 {removing?.orgName} 移除？
            </p>
            <p className="text-sm text-muted-foreground">
              仅撤销该组织成员资格，不删除用户账户或其他独立授权。
            </p>
            {mutation.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {toUserFacingError(mutation.error, "移除失败，请重试。")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setRemoving(null)}
            >
              取消
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
              {mutation.isPending ? "移除中…" : "确认移除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
