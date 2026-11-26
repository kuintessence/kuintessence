import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PaginationControls } from "../ui/pagination-controls";

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
  const { t } = useTranslation();
  const mobileReadOnly = useMobileMutationBlocked("/admin/authz/audit-capabilities");
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
      toast.success(
        t(
          variables.grant
            ? "settings.operations.auditAccess.granted"
            : "settings.operations.auditAccess.revoked",
        ),
      );
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <section data-testid="audit-capability-panel" className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{t("settings.operations.auditAccess.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.operations.auditAccess.description")}
        </p>
      </header>
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
          aria-label={t("settings.operations.auditAccess.searchLabel")}
          placeholder={t("settings.operations.auditAccess.searchHint")}
          maxLength={200}
        />
        <Button type="submit" variant="outline">
          {t("settings.operations.auditAccess.search")}
        </Button>
      </form>
      {mobileReadOnly && (
        <p className="text-sm text-muted-foreground">
          {t("settings.operations.auditAccess.desktop")}
        </p>
      )}
      {query.isLoading ? (
        <div
          role="status"
          className="flex min-h-24 items-center justify-center text-muted-foreground"
        >
          <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
          {t("settings.operations.auditAccess.loading")}
        </div>
      ) : query.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-status-failed">
          <span>
            {toUserFacingError(query.error, t("settings.operations.auditAccess.loadFailed"))}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>
            <RefreshCw />
            {t("common.retry")}
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {query.data?.data.map((user) => {
            const pending = mutation.isPending && mutation.variables?.userId === user.id;
            return (
              <div
                key={user.id}
                className="grid min-w-0 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium [overflow-wrap:anywhere]">
                    {user.displayName || user.email}
                  </p>
                  {user.displayName && (
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {user.email}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t(`cp.users.roles.${user.role}`, { defaultValue: user.role })}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Badge variant={user.auditReadonly ? "succeeded" : "outline"}>
                    {user.auditReadonly ? (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    ) : (
                      <ShieldX className="h-3.5 w-3.5" />
                    )}
                    {t(
                      user.auditReadonly
                        ? "settings.operations.auditAccess.active"
                        : "settings.operations.auditAccess.inactive",
                    )}
                  </Badge>
                  {!mobileReadOnly && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={t(
                        user.auditReadonly
                          ? "settings.operations.auditAccess.revokeUser"
                          : "settings.operations.auditAccess.grantUser",
                        { email: user.email },
                      )}
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({ userId: user.id, grant: !user.auditReadonly })
                      }
                    >
                      {pending ? (
                        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                      ) : null}
                      {t(
                        pending
                          ? user.auditReadonly
                            ? "settings.operations.auditAccess.revoking"
                            : "settings.operations.auditAccess.granting"
                          : user.auditReadonly
                            ? "settings.operations.auditAccess.revoke"
                            : "settings.operations.auditAccess.grant",
                      )}
                    </Button>
                  )}
                </div>
                {mutation.isError && mutation.variables?.userId === user.id && (
                  <p
                    role="alert"
                    className="text-sm text-status-failed [overflow-wrap:anywhere] sm:col-span-2"
                  >
                    {toUserFacingError(
                      mutation.error,
                      t("settings.operations.auditAccess.updateFailed"),
                    )}
                  </p>
                )}
              </div>
            );
          })}
          {query.data?.data.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {t(
                search
                  ? "settings.operations.auditAccess.noMatches"
                  : "settings.operations.auditAccess.empty",
              )}
            </div>
          ) : null}
        </div>
      )}
      {query.isSuccess && (page > 0 || query.data.hasMore) && (
        <PaginationControls
          className="justify-end"
          previous={{ disabled: page === 0 || query.isFetching, onClick: () => setPage(page - 1) }}
          next={{
            disabled: !query.data.hasMore || query.isFetching,
            onClick: () => setPage(page + 1),
          }}
        >
          <span className="tabular-nums">
            {t("settings.operations.auditAccess.page", { page: page + 1 })}
          </span>
        </PaginationControls>
      )}
    </section>
  );
}
