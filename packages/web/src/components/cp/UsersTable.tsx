import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { useCpUsers } from "../../lib/use-cp-users";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function UsersTable() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const activeOrganizationId = useActiveOrganizationId();
  const [isOffline, setIsOffline] = useState(
    () => typeof navigator !== "undefined" && !navigator.onLine,
  );
  const q = useCpUsers({ search: search || undefined, limit: 50, offset: 0 });

  const loadError = q.error as Error | null;
  const canShowMembers = activeOrganizationId !== null && !isOffline && !loadError;
  const items = canShowMembers ? (q.data?.items ?? []) : [];
  const total = canShowMembers ? (q.data?.total ?? 0) : 0;

  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return (
    <div className="space-y-4" data-testid="cp-users-table">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-semibold tracking-tight">{t("cp.users.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("cp.users.subtitle")}</p>
          <p
            className="mt-1 break-all font-mono text-xs text-muted-foreground"
            data-testid="cp-users-org"
          >
            {activeOrganizationId
              ? t("cp.users.currentOrganization", { organizationId: activeOrganizationId })
              : t("cp.users.organizationRequired")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            data-testid="cp-users-count"
          >
            {t("cp.users.countHint", { visible: items.length, total })}
          </span>
          <Button asChild variant="outline" size="sm" className="min-h-11 min-w-11">
            <a href="/cp/accounts">
              <KeyRound className="h-4 w-4" />
              {t("cp.users.manageAccounts")}
            </a>
          </Button>
        </div>
      </div>

      <div
        className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_8%,transparent)] p-3 text-sm"
        data-testid="cp-users-readonly-notice"
      >
        <p className="font-medium">{t("cp.users.readonly.title")}</p>
        <p className="mt-1 text-muted-foreground">{t("cp.users.readonly.description")}</p>
      </div>

      <label className="grid max-w-sm gap-1 text-sm font-medium" htmlFor="cp-users-search">
        {t("cp.users.searchLabel")}
        <Input
          id="cp-users-search"
          placeholder={t("cp.users.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-h-11"
          data-testid="cp-users-search"
        />
      </label>

      {activeOrganizationId === null ? (
        <div
          className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
          data-testid="cp-users-organization-required"
        >
          {t("cp.users.organizationRequired")}
        </div>
      ) : isOffline ? (
        <div
          className="rounded-md border border-status-failed/40 p-3 text-sm"
          data-testid="cp-users-offline"
          role="alert"
        >
          {t("cp.users.offline")}
        </div>
      ) : loadError ? (
        <div
          className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
          data-testid="cp-users-error"
          role="alert"
        >
          <p>{toUserFacingError(loadError, t("cp.users.loadFailed"))}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 min-h-11"
            onClick={() => void q.refetch()}
          >
            {t("cp.users.retryRead")}
          </Button>
        </div>
      ) : null}

      {activeOrganizationId === null || isOffline || loadError ? null : q.isLoading ? (
        <div
          className="text-sm text-muted-foreground"
          data-testid="cp-users-loading"
          aria-live="polite"
        >
          {t("cp.users.loading")}
        </div>
      ) : items.length === 0 ? (
        <div
          className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
          data-testid="cp-users-empty"
        >
          <div className="space-y-3 text-center">
            <p>{search ? t("cp.users.noSearchResults") : t("cp.users.empty")}</p>
            {search ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => {
                  setSearch("");
                  document.getElementById("cp-users-search")?.focus();
                }}
              >
                {t("cp.users.clearSearch")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          className="rounded-md border border-border sm:overflow-x-auto sm:overscroll-x-contain"
          data-testid="cp-users-table-scroll"
        >
          <table className="w-full text-sm xl:min-w-[48rem]">
            <thead className="sr-only bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground xl:not-sr-only xl:table-header-group">
              <tr>
                <th className="px-3 py-2 font-medium">{t("cp.users.col.email")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.users.col.role")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.users.col.suspended")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.users.col.quota")}</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border xl:table-row-group xl:divide-y-0">
              {items.map((u) => (
                <tr
                  key={u.id}
                  data-testid={`cp-users-row-${u.id}`}
                  className="grid grid-cols-2 gap-x-3 gap-y-3 p-4 xl:table-row xl:border-t xl:border-border xl:p-0"
                >
                  <td className="col-span-2 min-w-0 break-all font-medium xl:table-cell xl:px-3 xl:py-2 xl:font-normal">
                    {u.email}
                  </td>
                  <td className="xl:table-cell xl:px-3 xl:py-2 xl:font-mono xl:text-xs xl:text-muted-foreground">
                    <span className="mr-2 text-xs text-muted-foreground xl:hidden">
                      {t("cp.users.col.role")}
                    </span>
                    {u.role}
                  </td>
                  <td className="xl:table-cell xl:px-3 xl:py-2">
                    <span className="mr-2 text-xs text-muted-foreground xl:hidden">
                      {t("cp.users.col.suspended")}
                    </span>
                    <Badge
                      variant={
                        u.suspended === true
                          ? "failed"
                          : u.suspended === false
                            ? "outline"
                            : "default"
                      }
                      className="whitespace-normal"
                    >
                      {u.suspended === true
                        ? t("cp.users.historyMarked")
                        : u.suspended === false
                          ? t("cp.users.historyNotMarked")
                          : t("cp.users.historyUnknown")}
                    </Badge>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t("cp.users.historySuspendedHint")}
                    </span>
                  </td>
                  <td className="font-mono text-xs tabular-nums xl:table-cell xl:px-3 xl:py-2 xl:text-left">
                    <span className="mr-2 font-sans text-muted-foreground xl:hidden">
                      {t("cp.users.col.quota")}
                    </span>
                    {typeof u.quota === "number" ? (
                      <>
                        {u.quota === 0 ? (
                          <>
                            {t("cp.users.historyQuotaZero")}
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {t("cp.users.historyQuotaZeroAmbiguity")}
                            </span>
                          </>
                        ) : (
                          u.quota
                        )}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t("cp.users.historyQuotaHint")}
                        </span>
                      </>
                    ) : (
                      t("cp.users.notProvided")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
