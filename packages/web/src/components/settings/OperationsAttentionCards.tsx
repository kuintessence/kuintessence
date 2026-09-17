import { Role } from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { BellRing, ClipboardCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, listSoftwareAccessRequests } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import {
  listSandboxAgentSecurityViews,
  listSandboxMappingReviewQueue,
} from "../../lib/sandbox-client";
import {
  AttentionOverviewCard,
  type AttentionOverviewItem,
} from "../dashboard/AttentionOverviewCard";

interface PlatformAttentionSnapshot {
  pendingSoftwareRequests: number | null;
  pendingStorageRequests: number | null;
  pendingAccountMappings: number | null;
  criticalSandboxAgents: number | null;
  degradedSandboxAgents: number | null;
  authorizationDeadLetters: number | null;
  authorizationDiffs: number | null;
  approvalsPartialFailure: boolean;
  alertsPartialFailure: boolean;
}

interface StorageQuotaRequestsResponse {
  requests: Array<{ status: string }>;
}

interface AuthzReadinessResponse {
  success: true;
  data: {
    outbox: { dead: number };
    shadowDiffs: number;
  };
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function canManagePlatformAttention(role: string | null): boolean {
  return role === Role.PLATFORM_ADMIN || role === Role.SUPER_ADMIN;
}

async function getPlatformAttentionSnapshot(
  canManagePlatform: boolean,
): Promise<PlatformAttentionSnapshot> {
  if (!canManagePlatform) {
    const sandboxAgents = await listSandboxAgentSecurityViews();
    return {
      pendingSoftwareRequests: null,
      pendingStorageRequests: null,
      pendingAccountMappings: null,
      criticalSandboxAgents:
        sandboxAgents.filter((agent) => agent.sandboxReadiness === "critical").length ?? null,
      degradedSandboxAgents:
        sandboxAgents.filter((agent) => agent.sandboxReadiness === "degraded").length ?? null,
      authorizationDeadLetters: null,
      authorizationDiffs: null,
      approvalsPartialFailure: false,
      alertsPartialFailure: false,
    };
  }
  const results = await Promise.allSettled([
    listSoftwareAccessRequests({ status: "pending" }),
    api.get<StorageQuotaRequestsResponse>(
      "/admin/storage/quota-requests?scope=cloud&scopeId=global",
    ),
    listSandboxMappingReviewQueue(),
    listSandboxAgentSecurityViews(),
    api.get<AuthzReadinessResponse>("/admin/authz/readiness"),
  ]);
  const softwareRequests = settledValue(results[0]);
  const storageRequests = settledValue(results[1]);
  const accountMappings = settledValue(results[2]);
  const sandboxAgents = settledValue(results[3]);
  const authz = settledValue(results[4]);

  return {
    pendingSoftwareRequests: softwareRequests?.length ?? null,
    pendingStorageRequests:
      storageRequests?.requests.filter((request) => request.status === "pending").length ?? null,
    pendingAccountMappings: accountMappings?.length ?? null,
    criticalSandboxAgents:
      sandboxAgents?.filter((agent) => agent.sandboxReadiness === "critical").length ?? null,
    degradedSandboxAgents:
      sandboxAgents?.filter((agent) => agent.sandboxReadiness === "degraded").length ?? null,
    authorizationDeadLetters: authz?.data.outbox.dead ?? null,
    authorizationDiffs: authz?.data.shadowDiffs ?? null,
    approvalsPartialFailure: results.slice(0, 3).some((result) => result.status === "rejected"),
    alertsPartialFailure: results.slice(3).some((result) => result.status === "rejected"),
  };
}

export function OperationsAttentionCards() {
  const { t } = useTranslation();
  const canManagePlatform = canManagePlatformAttention(getAuthState().role);
  const query = useQuery({
    queryKey: ["platform-operations-attention", canManagePlatform ? "manage" : "observe"],
    queryFn: () => getPlatformAttentionSnapshot(canManagePlatform),
    refetchInterval: 30_000,
    retry: false,
  });
  const snapshot = query.data;
  const approvals: AttentionOverviewItem[] = [
    {
      key: "software",
      label: t("settings.operations.attention.approvals.software"),
      count: snapshot?.pendingSoftwareRequests ?? null,
      href: "/software",
      external: true,
    },
    {
      key: "storage",
      label: t("settings.operations.attention.approvals.storage"),
      count: snapshot?.pendingStorageRequests ?? null,
      href: "/operations#metering",
    },
    {
      key: "accounts",
      label: t("settings.operations.attention.approvals.accounts"),
      count: snapshot?.pendingAccountMappings ?? null,
      href: "/cp/accounts",
      external: true,
    },
  ];
  const alerts: AttentionOverviewItem[] = [
    {
      key: "sandboxCritical",
      label: t("settings.operations.attention.alerts.sandboxCritical"),
      count: snapshot?.criticalSandboxAgents ?? null,
      href: "/operations#security",
    },
    {
      key: "sandboxDegraded",
      label: t("settings.operations.attention.alerts.sandboxDegraded"),
      count: snapshot?.degradedSandboxAgents ?? null,
      href: "/operations#security",
    },
    ...(canManagePlatform
      ? [
          {
            key: "authzDeadLetters",
            label: t("settings.operations.attention.alerts.authzDeadLetters"),
            count: snapshot?.authorizationDeadLetters ?? null,
            href: "/operations#security",
          },
          {
            key: "authzDiffs",
            label: t("settings.operations.attention.alerts.authzDiffs"),
            count: snapshot?.authorizationDiffs ?? null,
            href: "/operations#security",
          },
        ]
      : []),
  ];
  const queryFailed = Boolean(query.error);

  return (
    <section
      className="grid gap-3 xl:grid-cols-2"
      aria-label={t("settings.operations.attention.label")}
    >
      {canManagePlatform ? (
        <AttentionOverviewCard
          title={t("settings.operations.attention.approvals.title")}
          description={t("settings.operations.attention.approvals.description")}
          icon={ClipboardCheck}
          items={approvals}
          emptyLabel={t("settings.operations.attention.approvals.empty")}
          partialFailureLabel={t("settings.operations.attention.partialFailure")}
          partialFailure={queryFailed || Boolean(snapshot?.approvalsPartialFailure)}
          tone="pending"
          testId="operations-approval-attention"
        />
      ) : null}
      <AttentionOverviewCard
        title={t("settings.operations.attention.alerts.title")}
        description={t("settings.operations.attention.alerts.description")}
        icon={BellRing}
        items={alerts}
        emptyLabel={t("settings.operations.attention.alerts.empty")}
        partialFailureLabel={t("settings.operations.attention.partialFailure")}
        partialFailure={queryFailed || Boolean(snapshot?.alertsPartialFailure)}
        tone="failed"
        testId="operations-alert-attention"
      />
    </section>
  );
}
