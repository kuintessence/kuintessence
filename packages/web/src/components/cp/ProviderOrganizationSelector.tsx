import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getActiveOrganizationContext, setActiveOrganization } from "../../lib/active-organization";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";

const CP_ROLES = new Set(["owner", "admin", "operator", "platform_admin", "super_admin"]);
const ORGANIZATION_SENSITIVE_QUERY_ROOTS = new Set([
  "agent-software",
  "agents-list",
  "cp",
  "cp-data",
  "dashboard",
  "data-market",
  "files-cloud",
  "files-cluster",
  "files-transfers",
  "job-detail",
  "job-placement",
  "jobs-list",
  "metering",
  "queues-visible",
  "software-access-requests",
  "software-mirror-cache-status",
  "software-review-queue",
  "software-spack-availability",
  "software-spack-catalog",
  "software-spack-catalog-detail",
  "software-templates",
  "software-usecases",
  "software-workflow-templates",
  "storage-quota-requests",
  "storage-summary",
  "terminal-sessions",
  "workflow-detail",
  "workflow-drafts",
  "workflow-jobs",
  "workflows-list",
]);

function isOrganizationSensitiveQuery(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root === "string" && ORGANIZATION_SENSITIVE_QUERY_ROOTS.has(root);
}

export function ProviderOrganizationSelector() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const context = useQuery({
    queryKey: ["me", "active-organization"],
    queryFn: getActiveOrganizationContext,
    staleTime: 60_000,
  });
  const update = useMutation({
    mutationFn: setActiveOrganization,
    onSuccess: async (_data, organizationId) => {
      const queryFilter = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          isOrganizationSensitiveQuery(query.queryKey),
      };
      await queryClient.cancelQueries(queryFilter);
      queryClient.removeQueries(queryFilter);
      queryClient.setQueryData(["me", "active-organization"], (current: unknown) => {
        if (!isActiveOrganizationContext(current)) return current;
        return { ...current, activeOrganizationId: organizationId };
      });
      queryClient.removeQueries({ queryKey: ["me", "capabilities"] });
    },
  });
  const organizations = (context.data?.organizations ?? []).filter((item) =>
    CP_ROLES.has(item.role),
  );

  if (context.isLoading || (!context.error && organizations.length === 0)) return null;

  if (context.error) {
    return (
      <div
        className="flex max-w-full flex-wrap items-start gap-2 text-xs text-status-failed"
        data-testid="cp-organization-selector-error"
      >
        <Building2 className="h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">
          {toUserFacingError(context.error, t("cp.organizationSelector.loadFailed"))}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="cp-organization-selector-retry"
          onClick={() => context.refetch()}
        >
          {t("cp.organizationSelector.retry")}
        </Button>
      </div>
    );
  }

  return (
    <label
      className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm"
      data-testid="cp-organization-selector"
    >
      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{t("cp.organizationSelector.label")}</span>
      <select
        aria-label={t("cp.organizationSelector.ariaLabel")}
        className="h-9 min-w-48 max-w-full rounded-md border border-input bg-background px-3 text-sm"
        disabled={update.isPending}
        value={context.data?.activeOrganizationId ?? ""}
        onChange={(event) => update.mutate(event.target.value || null)}
      >
        <option value="">{t("cp.organizationSelector.allOrganizations")}</option>
        {organizations.map((organization) => (
          <option key={organization.orgId} value={organization.orgId}>
            {organization.name}
          </option>
        ))}
      </select>
      {update.error ? (
        <span
          className="min-w-0 break-words text-xs text-status-failed"
          data-testid="cp-organization-selector-update-error"
        >
          {toUserFacingError(update.error, t("cp.organizationSelector.updateFailed"))}
        </span>
      ) : null}
    </label>
  );
}

function isActiveOrganizationContext(value: unknown): value is {
  activeOrganizationId: string | null;
  organizations: unknown[];
} {
  return typeof value === "object" && value !== null && "activeOrganizationId" in value;
}
