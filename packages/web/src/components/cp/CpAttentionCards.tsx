import { useQuery } from "@tanstack/react-query";
import { BellRing, ClipboardCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getSoftwareOverview } from "../../lib/cp-client";
import { usePlatformCapability } from "../../lib/platform-capabilities";
import { listSandboxMappingReviewQueue } from "../../lib/sandbox-client";
import {
  AttentionOverviewCard,
  type AttentionOverviewItem,
} from "../dashboard/AttentionOverviewCard";

interface CpAttentionCardsProps {
  failedJobs: number | null;
  sickAgents: number | null;
  offlineAgents: number | null;
}

interface CpApprovalSnapshot {
  accountMappings: number | null;
  preinstalledMappings: number | null;
  partialFailure: boolean;
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

async function getCpApprovalSnapshot(): Promise<CpApprovalSnapshot> {
  const results = await Promise.allSettled([
    listSandboxMappingReviewQueue(),
    getSoftwareOverview(),
  ]);
  const accountMappings = settledValue(results[0]);
  const softwareOverview = settledValue(results[1]);

  return {
    accountMappings: accountMappings?.length ?? null,
    preinstalledMappings:
      softwareOverview?.agents.reduce(
        (sum, agent) =>
          sum + agent.preinstalledMappings.filter((mapping) => mapping.auditedAt == null).length,
        0,
      ) ?? null,
    partialFailure: results.some((result) => result.status === "rejected"),
  };
}

export function CpAttentionCards({ failedJobs, sickAgents, offlineAgents }: CpAttentionCardsProps) {
  const { t } = useTranslation();
  const management = usePlatformCapability("workspace.provider.manage");
  const query = useQuery({
    queryKey: ["cp-operations-attention"],
    queryFn: getCpApprovalSnapshot,
    refetchInterval: 30_000,
    retry: false,
    enabled: management.allowed,
  });
  const snapshot = query.data;
  const approvals: AttentionOverviewItem[] = [
    {
      key: "accounts",
      label: t("cp.dashboard.attention.approvals.accounts"),
      count: snapshot?.accountMappings ?? null,
      href: "/cp/accounts",
    },
    {
      key: "software",
      label: t("cp.dashboard.attention.approvals.software"),
      count: snapshot?.preinstalledMappings ?? null,
      href: "/cp/software",
    },
  ];
  const alerts: AttentionOverviewItem[] = [
    {
      key: "failedJobs",
      label: t("cp.dashboard.attention.alerts.failedJobs"),
      count: failedJobs,
      href: "/jobs",
    },
    {
      key: "sickAgents",
      label: t("cp.dashboard.attention.alerts.sickAgents"),
      count: sickAgents,
      href: management.allowed ? "/cp/agents" : "/cp",
    },
    {
      key: "offlineAgents",
      label: t("cp.dashboard.attention.alerts.offlineAgents"),
      count: offlineAgents,
      href: management.allowed ? "/cp/agents" : "/cp",
    },
  ];
  const partialFailure = Boolean(query.error) || Boolean(snapshot?.partialFailure);

  return (
    <section className="grid gap-3 xl:grid-cols-2" aria-label={t("cp.dashboard.attention.label")}>
      {management.allowed ? (
        <AttentionOverviewCard
          title={t("cp.dashboard.attention.approvals.title")}
          description={t("cp.dashboard.attention.approvals.description")}
          icon={ClipboardCheck}
          items={approvals}
          emptyLabel={t("cp.dashboard.attention.approvals.empty")}
          partialFailureLabel={t("cp.dashboard.attention.partialFailure")}
          partialFailure={partialFailure}
          tone="pending"
          testId="cp-approval-attention"
        />
      ) : null}
      <AttentionOverviewCard
        title={t("cp.dashboard.attention.alerts.title")}
        description={t("cp.dashboard.attention.alerts.description")}
        icon={BellRing}
        items={alerts}
        emptyLabel={t("cp.dashboard.attention.alerts.empty")}
        partialFailureLabel={t("cp.dashboard.attention.partialFailure")}
        partialFailure={false}
        tone="failed"
        testId="cp-alert-attention"
      />
    </section>
  );
}
