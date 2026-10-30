import { useQuery } from "@tanstack/react-query";
import { getActiveOrganizationContext } from "./active-organization";

export function useOrganizationName(enabled = true) {
  const { data } = useQuery({
    queryKey: ["me", "active-organization"],
    queryFn: getActiveOrganizationContext,
    staleTime: 60_000,
    enabled,
  });
  return (id: string) => data?.organizations?.find((org) => org.orgId === id)?.name ?? id;
}
