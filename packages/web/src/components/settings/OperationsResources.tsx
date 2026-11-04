import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { useCpDashboard } from "../../lib/use-cp-dashboard";
import { toUserFacingError } from "../../lib/user-facing-error";
import { AgentRegistrationPage } from "../cp/AgentRegistrationPage";
import { CpAccountsPage } from "../cp/CpAccountsPage";
import { CpAgentsTable } from "../cp/CpAgentsTable";
import { CpQueuesPage } from "../cp/CpQueuesPage";
import { ProviderOrganizationSelector } from "../cp/ProviderOrganizationSelector";
import { SoftwarePolicyTable } from "../cp/SoftwarePolicyTable";
import { Button } from "../ui/button";
import { PageHeader } from "../ui/page";
import { OperationsAttentionCards } from "./OperationsAttentionCards";
import { PlatformUsersTable } from "./PlatformUsersTable";

const resourceAreas = [
  "overview",
  "clusters",
  "queues",
  "accounts",
  "software",
  "users",
  "registration",
] as const;
type ResourceArea = (typeof resourceAreas)[number];
export function isOperationsResourceArea(area: string): area is ResourceArea {
  return resourceAreas.some((candidate) => candidate === area);
}

export function OperationsResources({ area }: { area: ResourceArea }) {
  const { t } = useTranslation();
  const organizationId = useActiveOrganizationId();
  return (
    <div className="space-y-5" data-testid="operations-resources">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <ProviderOrganizationSelector />
        {area === "clusters" && (
          <Button asChild>
            <a href="/operations#registration">{t("cp.nav.agentRegistration")}</a>
          </Button>
        )}
      </div>
      <Fragment key={`${area}:${organizationId ?? "all"}`}>
        {area === "overview" && <OperationsOverview />}
        {area === "clusters" && <CpAgentsTable />}
        {area === "registration" && <AgentRegistrationPage />}
        {area === "queues" && <CpQueuesPage />}
        {area === "accounts" && <CpAccountsPage />}
        {area === "software" && <SoftwarePolicyTable canManage />}
        {area === "users" && <PlatformUsersTable />}
      </Fragment>
    </div>
  );
}

function OperationsOverview() {
  const { t } = useTranslation();
  const query = useCpDashboard();
  const k = query.data;
  const counts = [
    {
      label: "cp.nav.agents",
      value: k ? k.agentsHealthy + k.agentsSick + k.agentsOffline : null,
      href: "#clusters",
    },
    { label: "cp.dashboard.kpi.agentsHealthy", value: k?.agentsHealthy, href: "#clusters" },
    { label: "cp.dashboard.kpi.agentsOffline", value: k?.agentsOffline, href: "#clusters" },
    { label: "cp.dashboard.kpi.agentsSick", value: k?.agentsSick, href: "#clusters" },
  ];
  return (
    <div className="space-y-6">
      <PageHeader title={t("settings.operations.pageTitle")} />
      {query.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-status-failed">
          <span>{toUserFacingError(query.error, t("cp.dashboard.loadFailed"))}</span>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t("cp.common.refresh")}
          </Button>
        </div>
      ) : null}
      <dl className="grid grid-cols-2 gap-5 border-y border-border py-5 md:grid-cols-4">
        {counts.map((item) => (
          <div key={item.label}>
            <dt className="text-sm text-muted-foreground">{t(item.label)}</dt>
            <dd className="mt-2 text-3xl font-semibold tabular-nums">
              <a
                className="rounded-sm hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                href={item.href}
              >
                {query.error ? "—" : (item.value ?? "—")}
              </a>
            </dd>
          </div>
        ))}
      </dl>
      <CpAgentsTable />
      <OperationsAttentionCards />
    </div>
  );
}
