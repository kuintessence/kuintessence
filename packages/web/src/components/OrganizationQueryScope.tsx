import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { setActiveOrganization, useActiveOrganizationId } from "../lib/active-organization";
import { getAuthState } from "../lib/auth";
import { toUserFacingError } from "../lib/user-facing-error";
import { Button } from "./ui/button";

/** Resolve directory links through the existing authorized organization switch. */
export function OrganizationQueryScope({ children }: { children: ReactNode }) {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const requested = new URLSearchParams(search).get("organizationId");
  if (!requested) return children;
  return (
    <RequestedOrganizationScope key={requested} requested={requested}>
      {children}
    </RequestedOrganizationScope>
  );
}

function RequestedOrganizationScope({
  requested,
  children,
}: {
  requested: string;
  children: ReactNode;
}) {
  const active = useActiveOrganizationId();
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["directory-organization-scope", requested, getAuthState().revision],
    enabled: Boolean(requested),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      if (requested !== active) await setActiveOrganization(requested);
      return requested;
    },
    retry: false,
  });
  if (!query.isSuccess || !query.isFetchedAfterMount) {
    if (query.error)
      return (
        <div role="alert" className="space-y-2">
          <p>{toUserFacingError(query.error)}</p>
          <Button onClick={() => void query.refetch()}>{t("common.retry")}</Button>
        </div>
      );
    return <p role="status">{t("common.loading")}</p>;
  }
  return children;
}
