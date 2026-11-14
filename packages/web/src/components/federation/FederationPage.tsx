import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BriefcaseBusiness,
  ClipboardList,
  FileCheck2,
  FolderSync,
  Handshake,
  Package,
  Scale,
  Truck,
} from "lucide-react";
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
import { refreshOrganizationScope } from "../../lib/organization-query-scope";
import { useMediaQuery } from "../../lib/use-media-query";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AgreementPanel } from "./AgreementPanel";
import { CommercialPanel } from "./CommercialPanel";
import { FederationAssetsPanel } from "./FederationAssetsPanel";
import { FederationEvidencePanel } from "./FederationEvidencePanel";
import { FederationEmpty } from "./FederationLayout";
import { FederationMarketPanel } from "./FederationMarketPanel";
import { FederationTasksPanel } from "./FederationTasksPanel";
import { MediaDeliveryPanel, type MediaWorkflowExport } from "./MediaDeliveryPanel";
import { MediaLogisticsPanel } from "./MediaLogisticsPanel";

const sections = [
  { value: "tasks", label: "federation.tasks.title", icon: ClipboardList },
  { value: "market", label: "federation.market.title", icon: BriefcaseBusiness },
  { value: "execution", label: "federation.agreements.agreements", icon: Handshake },
  { value: "assets", label: "federation.assets.title", icon: FolderSync },
  { value: "commercial", label: "federation.commercial.title", icon: Scale },
  { value: "delivery", label: "federation.delivery.title", icon: Package },
  { value: "evidence", label: "federation.evidence.title", icon: FileCheck2 },
  { value: "media", label: "federation.logistics.title", icon: Truck },
] as const;

export function FederationPage({ mediaExport }: { mediaExport?: MediaWorkflowExport } = {}) {
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
      />
    </PageShell>
  );
}

function OrganizationAgreements({
  revision,
  mediaExport,
}: {
  revision: string | null;
  mediaExport?: MediaWorkflowExport;
}) {
  const { t } = useTranslation();
  const desktopNavigation = useMediaQuery("(min-width: 1280px)");
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
  if (context.isPending)
    return (
      <>
        <PageHeader title={t("federation.agreements.title")} />
        <p role="status">{t("federation.loading")}</p>
      </>
    );
  if (context.isError)
    return (
      <div role="alert">
        <PageHeader title={t("federation.agreements.title")} />
        <p>{t("federation.loadFailed")}</p>
        <Button variant="outline" onClick={() => void context.refetch()}>
          {t("federation.refresh")}
        </Button>
      </div>
    );
  return (
    <>
      <PageHeader
        title={t("federation.agreements.title")}
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
      {organizationId && context.data.organizations.some((org) => org.orgId === organizationId) ? (
        <Tabs
          key={`${organizationId}:${revision}`}
          defaultValue={mediaExport ? "delivery" : "execution"}
          orientation={desktopNavigation ? "vertical" : "horizontal"}
          className="federation-layout"
        >
          <TabsList aria-label={t("federation.agreements.title")} className="federation-nav">
            {sections.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} className="federation-nav-item">
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {t(label)}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="federation-content">
            <TabsContent value="tasks">
              <FederationTasksPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            </TabsContent>
            <TabsContent value="market">
              <FederationMarketPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            </TabsContent>
            <TabsContent value="execution">
              <AgreementPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            </TabsContent>
            <TabsContent value="commercial">
              <CommercialPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            </TabsContent>
            <TabsContent value="assets">
              <FederationAssetsPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            </TabsContent>
            <TabsContent value="delivery">
              <MediaDeliveryPanel
                exportFrom={mediaExport}
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            </TabsContent>
            <TabsContent value="evidence">
              <FederationEvidencePanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            </TabsContent>
            <TabsContent value="media">
              <MediaLogisticsPanel
                scope={{ organizationId, authRevision: revision }}
                switching={change.isPending || context.isFetching}
              />
            </TabsContent>
          </div>
        </Tabs>
      ) : (
        <FederationEmpty>{t("federation.agreements.chooseOrganization")}</FederationEmpty>
      )}
    </>
  );
}
