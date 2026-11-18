import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CpCapabilityError } from "../components/cp/CpCapabilityError";
import { MeteringPage } from "../components/cp/MeteringPage";
import { CostRatesForm } from "../components/settings/CostRatesForm";
import { PageHeader, PageShell } from "../components/ui/page";
import { useActiveOrganizationId } from "../lib/active-organization";
import { usePlatformCapability } from "../lib/platform-capabilities";

export function CpMeteringPage() {
  const { t } = useTranslation();
  const organizationId = useActiveOrganizationId();
  const isRates = useRouterState({
    select: (s) => s.location.hash.replace(/^#/, "") === "cost-rates",
  });
  const management = usePlatformCapability("workspace.provider.manage");
  if (!management.ready) return null;
  if (management.error) return <CpCapabilityError retry={management.retry} />;
  if (isRates) {
    return (
      <PageShell>
        <PageHeader title={t("settings.costRates.title")} />
        {management.allowed && organizationId ? (
          <CostRatesForm key={organizationId} organizationId={organizationId} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("settings.costRates.selectOrganization")}
          </p>
        )}
      </PageShell>
    );
  }
  return <MeteringPage scopeToActiveOrganization showWebhooks={management.allowed} />;
}

export const Route = createFileRoute("/cp/metering")({
  component: CpMeteringPage,
});
