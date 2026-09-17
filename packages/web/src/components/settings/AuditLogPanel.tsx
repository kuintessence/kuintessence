import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import type { AuditEntry } from "../../lib/dashboard-data";
import { toUserFacingError } from "../../lib/user-facing-error";
import { EventsList } from "../dashboard/EventsList";
import { Button } from "../ui/button";

interface AuditLogResponse {
  entries: AuditEntry[];
}

export function AuditLogPanel() {
  const { t } = useTranslation();
  const audit = useQuery({
    queryKey: ["operations", "audit-log"],
    queryFn: () => api.get<AuditLogResponse>("/audit-log?limit=100"),
  });
  const error = audit.error as Error | null;
  const entries = error ? [] : (audit.data?.entries ?? []);

  return (
    <section className="space-y-4" data-testid="platform-audit-log">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("settings.operations.auditLog.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.operations.auditLog.description")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => audit.refetch()}
          disabled={audit.isFetching}
          data-testid="platform-audit-refresh"
        >
          <RefreshCw className={audit.isFetching ? "animate-spin" : undefined} />
          {t("settings.operations.auditLog.refresh")}
        </Button>
      </div>
      {error ? (
        <div
          className="rounded-md border border-status-failed/40 p-3 text-sm text-status-failed"
          data-testid="platform-audit-error"
        >
          {toUserFacingError(error, t("settings.operations.auditLog.loadFailed"))}
        </div>
      ) : audit.isLoading ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : (
        <EventsList entries={entries} />
      )}
    </section>
  );
}
