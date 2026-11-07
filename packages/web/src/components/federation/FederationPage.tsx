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
import { refreshOrganizationScope } from "../../lib/organization-query-scope";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AgreementPanel } from "./AgreementPanel";
import { CommercialPanel } from "./CommercialPanel";

export function FederationPage() {
  const { t } = useTranslation();
  const revision = useSyncExternalStore(
    subscribeAuthState,
    () => getAuthState().revision,
    () => null,
  );
  return (
    <PageShell>
      <PageHeader title={t("federation.agreements.title")} />
      <OrganizationAgreements key={revision} revision={revision} />
    </PageShell>
  );
}

function OrganizationAgreements({ revision }: { revision: string | null }) {
  const { t } = useTranslation();
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
  if (context.isPending) return <p role="status">{t("federation.loading")}</p>;
  if (context.isError)
    return (
      <div role="alert">
        <p>{t("federation.loadFailed")}</p>
        <Button variant="outline" onClick={() => void context.refetch()}>
          {t("federation.refresh")}
        </Button>
      </div>
    );
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="federation-organization" className="text-sm font-medium">
          {t("federation.agreements.organization")}
        </label>
        <select
          id="federation-organization"
          className="h-10 max-w-full rounded-md border border-input bg-background px-3 text-sm"
          disabled={change.isPending || context.isFetching}
          value={organizationId ?? ""}
          onChange={(event) => change.mutate(event.target.value)}
        >
          <option value="" disabled>
            {t("federation.agreements.chooseOrganization")}
          </option>
          {context.data.organizations.map((org) => (
            <option key={org.orgId} value={org.orgId}>
              {org.name} · {org.orgId}
            </option>
          ))}
        </select>
        {change.isError ? (
          <p role="alert" className="text-sm text-status-failed">
            {t("federation.saveFailed")}
          </p>
        ) : null}
      </div>
      {organizationId && context.data.organizations.some((org) => org.orgId === organizationId) ? (
        <Tabs key={`${organizationId}:${revision}`} defaultValue="execution">
          <TabsList aria-label={t("federation.agreements.title")}>
            <TabsTrigger value="execution">{t("federation.agreements.agreements")}</TabsTrigger>
            <TabsTrigger value="commercial">{t("federation.commercial.title")}</TabsTrigger>
          </TabsList>
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
        </Tabs>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("federation.agreements.chooseOrganization")}
        </p>
      )}
    </>
  );
}
