import { useQuery } from "@tanstack/react-query";
import { useActiveOrganizationId } from "./active-organization";
import { type DashboardKpis, getDashboardKpis } from "./cp-client";

const REFETCH_MS = 30_000;

export function useCpDashboard() {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<DashboardKpis>({
    queryKey: ["cp", "dashboard", activeOrganizationId ?? "all"],
    queryFn: () => getDashboardKpis(),
    refetchInterval: REFETCH_MS,
  });
}
