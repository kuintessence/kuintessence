import type { QueryClient } from "@tanstack/react-query";

const ORGANIZATION_SENSITIVE_QUERY_ROOTS = new Set([
  "agent-software",
  "agents-list",
  "cp",
  "platform-users",
  "platform-operations-attention",
  "sandbox-execution-accounts",
  "sandbox-mapping-review",
  "interconnect",
  "compute-providers",
  "cp-data",
  "dashboard",
  "data-market",
  "files-cloud",
  "files-cluster",
  "files-transfers",
  "job-detail",
  "job-logs",
  "job-files-netdrive",
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

export async function refreshOrganizationScope(
  queryClient: QueryClient,
  organizationId: string | null,
) {
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
  await queryClient.resetQueries({ queryKey: ["me", "capabilities"] });
}

function isActiveOrganizationContext(value: unknown): value is {
  activeOrganizationId: string | null;
  organizations: unknown[];
} {
  return typeof value === "object" && value !== null && "activeOrganizationId" in value;
}
