import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

interface AuditCapabilityUser {
  id: string;
  email: string;
  displayName?: string | null;
  role: string;
  auditReadonly: boolean;
  grantedBy: string | null;
  grantedAt: string | null;
}

interface AuditCapabilityResponse {
  success: true;
  data: AuditCapabilityUser[];
  hasMore: boolean;
}

const queryKey = ["admin", "authz", "audit-capabilities"] as const;

export function AuditCapabilityPanel() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: [...queryKey, search, page],
    queryFn: () =>
      api.get<AuditCapabilityResponse>(
        `/admin/authz/audit-capabilities?${new URLSearchParams({ search, limit: "50", offset: String(page * 50) })}`,
      ),
  });
  const mutation = useMutation({
    mutationFn: ({ userId, grant }: { userId: string; grant: boolean }) =>
      grant
        ? api.put(`/admin/authz/audit-capabilities/${userId}`)
        : api.delete(`/admin/authz/audit-capabilities/${userId}`),
    onSuccess: async (_data, variables) => {
      toast.success(variables.grant ? "已授予审计只读权限" : "已撤销审计只读权限");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      toast.error(toUserFacingError(error, "更新审计权限失败，请稍后重试。"));
    },
  });

  return (
    <Card data-testid="audit-capability-panel">
      <CardHeader>
        <CardTitle className="text-base text-foreground">审计只读权限</CardTitle>
        <p className="text-sm text-muted-foreground">
          授权用户查看审计记录、SSH 录屏和计量报告；该权限不包含任何配置或执行操作。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(String(new FormData(event.currentTarget).get("search") ?? "").trim());
            setPage(0);
          }}
        >
          <Input
            name="search"
            type="search"
            aria-label="搜索审计授权用户"
            placeholder="姓名或邮箱"
            maxLength={200}
          />
          <Button type="submit" variant="outline">
            搜索
          </Button>
        </form>
        {query.isLoading ? (
          <div className="flex min-h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在载入用户
          </div>
        ) : query.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <span>{toUserFacingError(query.error, "无法载入审计权限列表，请稍后重试。")}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>
              <RefreshCw />
              重试
            </Button>
          </div>
        ) : (
          <div className="divide-y rounded-md border">
            {query.data?.data.map((user) => {
              const pending = mutation.isPending && mutation.variables?.userId === user.id;
              return (
                <div
                  key={user.id}
                  className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={user.email}>
                      {user.displayName || user.email}
                    </p>
                    {user.displayName && (
                      <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">{user.role}</p>
                  </div>
                  <Badge variant={user.auditReadonly ? "succeeded" : "outline"}>
                    {user.auditReadonly ? (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    ) : (
                      <ShieldX className="h-3.5 w-3.5" />
                    )}
                    {user.auditReadonly ? "审计只读" : "未授予"}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant={user.auditReadonly ? "outline" : "default"}
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate({ userId: user.id, grant: !user.auditReadonly })}
                  >
                    {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {user.auditReadonly ? "撤销" : "授予"}
                  </Button>
                </div>
              );
            })}
            {query.data?.data.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">暂无用户</div>
            ) : null}
          </div>
        )}
        {!query.isLoading && !query.isError && (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>第 {page + 1} 页</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={page === 0 || query.isFetching}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!query.data?.hasMore || query.isFetching}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
