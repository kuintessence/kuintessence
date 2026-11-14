import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  ACTIVE_ORGANIZATION_STORAGE_KEY,
  getActiveOrganizationContext,
  getStoredActiveOrganizationId,
  setActiveOrganization,
  useActiveOrganizationId,
} from "../../lib/active-organization";
import { getAuthState, subscribeAuthState } from "../../lib/auth";
import { FEDERATION_SECTIONS, type FederationSection } from "../../lib/federation-navigation";
import { federationReadFailed } from "../../lib/federation-query-state";
import { refreshOrganizationScope } from "../../lib/organization-query-scope";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";
import { AgreementPanel } from "./AgreementPanel";
import { CommercialPanel } from "./CommercialPanel";
import { FederationAssetsPanel } from "./FederationAssetsPanel";
import { FederationEvidencePanel } from "./FederationEvidencePanel";
import { FederationEmpty, FederationPageTitle, FederationRefreshNotice } from "./FederationLayout";
import { FederationMarketPanel } from "./FederationMarketPanel";
import { FederationTasksPanel } from "./FederationTasksPanel";
import { MediaDeliveryPanel, type MediaWorkflowExport } from "./MediaDeliveryPanel";
import { MediaLogisticsPanel } from "./MediaLogisticsPanel";

export function FederationPage({
  mediaExport,
  section = mediaExport ? "delivery" : "agreements",
}: {
  mediaExport?: MediaWorkflowExport;
  section?: FederationSection;
} = {}) {
  const revision = useSyncExternalStore(
    subscribeAuthState,
    () => getAuthState().revision,
    () => null,
  );
  return (
    <PageShell className="federation-workspace">
      <OrganizationAgreements
        key={`${revision}:${mediaExport?.workflowRunId ?? ""}:${mediaExport?.taskKind ?? ""}`}
        revision={revision}
        mediaExport={mediaExport}
        section={section}
      />
    </PageShell>
  );
}

function OrganizationAgreements({
  revision,
  mediaExport,
  section,
}: {
  revision: string | null;
  mediaExport?: MediaWorkflowExport;
  section: FederationSection;
}) {
  const { t } = useTranslation();
  const pageTitle = t(
    FEDERATION_SECTIONS.find((item) => item.id === section)?.labelKey ??
      "federation.agreements.agreements",
  );
  const client = useQueryClient();
  const organizationId = useActiveOrganizationId();
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === ACTIVE_ORGANIZATION_STORAGE_KEY || event.key === null)
      )
        void refreshOrganizationScope(client, getStoredActiveOrganizationId());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [client]);
  const context = useQuery({
    queryKey: ["federation", "organization-context", revision],
    queryFn: getActiveOrganizationContext,
  });
  const change = useMutation({
    mutationFn: setActiveOrganization,
    onSuccess: async (_, selectedId) => {
      await refreshOrganizationScope(client, selectedId);
      await client.invalidateQueries({ queryKey: ["federation"] });
    },
  });
  if (context.isPending || (!context.isError && !context.data))
    return (
      <>
        <PageHeader title={pageTitle} />
        <p role="status">{t("federation.loading")}</p>
      </>
    );
  if (federationReadFailed(context) || !context.data)
    return (
      <div role="alert">
        <PageHeader title={pageTitle} />
        <p>{t("federation.loadFailed")}</p>
        <Button variant="outline" onClick={() => void context.refetch()}>
          {t("federation.refresh")}
        </Button>
      </div>
    );
  return (
    <>
      <PageHeader
        title={pageTitle}
        actions={
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <label htmlFor="federation-organization" className="text-sm font-medium">
              {t("federation.agreements.organization")}
            </label>
            <select
              id="federation-organization"
              className="h-10 min-w-0 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-72"
              disabled={change.isPending || context.isFetching}
              value={organizationId ?? ""}
              onChange={(event) => change.mutate(event.target.value)}
            >
              <option value="" disabled>
                {t("federation.agreements.chooseOrganization")}
              </option>
              {context.data.organizations.map((org) => (
                <option key={org.orgId} value={org.orgId}>
                  {org.name}
                  {context.data.organizations.some(
                    (other) => other.orgId !== org.orgId && other.name === org.name,
                  )
                    ? ` · ${org.orgId}`
                    : ""}
                </option>
              ))}
            </select>
            {change.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.saveFailed")}
              </p>
            ) : null}
          </div>
        }
      />
      <FederationRefreshNotice query={context} onRetry={() => void context.refetch()} />
      {organizationId && context.data.organizations.some((org) => org.orgId === organizationId) ? (
        <FederationPageTitle value={pageTitle}>
          <div key={`${organizationId}:${revision}:${section}`} className="federation-content">
            {section === "tasks" ? (
              <FederationTasksPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            ) : null}
            {section === "market" ? (
              <FederationMarketPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            ) : null}
            {section === "agreements" ? (
              <AgreementPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            ) : null}
            {section === "commercial" ? (
              <CommercialPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            ) : null}
            {section === "assets" ? (
              <FederationAssetsPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            ) : null}
            {section === "delivery" ? (
              <MediaDeliveryPanel
                exportFrom={mediaExport}
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            ) : null}
            {section === "cases" ? (
              <FederationEvidencePanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            ) : null}
            {section === "logistics" ? (
              <MediaLogisticsPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            ) : null}
          </div>
        </FederationPageTitle>
      ) : (
        <FederationEmpty>{t("federation.agreements.chooseOrganization")}</FederationEmpty>
      )}
    </>
  );
}
