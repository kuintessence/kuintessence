import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { getActiveOrganizationContext } from "./active-organization";

export function useOrganizationName(enabled = true) {
  const { data } = useQuery({
    queryKey: ["me", "active-organization"],
    queryFn: getActiveOrganizationContext,
    staleTime: 60_000,
    enabled,
  });
  return useCallback(
    (id: string) => data?.organizations?.find((org) => org.orgId === id)?.name ?? id,
    [data],
  );
}
