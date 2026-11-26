import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getStoredActiveOrganizationId, setActiveOrganization } from "../lib/active-organization";
import { getAuthState } from "../lib/auth";
import { toUserFacingError } from "../lib/user-facing-error";
import { Button } from "./ui/button";

/** Resolve directory links through the existing authorized organization switch. */
export function OrganizationQueryScope({ children }: { children: ReactNode }) {
  const location = useRouterState({ select: (state) => state.location });
  const requested = new URLSearchParams(location.searchStr).get("organizationId");
  if (!requested) return children;
  const entry = location.state.__TSR_key ?? location.state.key ?? location.href;
  return (
    <RequestedOrganizationScope
      key={entry}
      requested={requested}
      entry={entry}
      pathname={location.pathname}
    >
      {children}
    </RequestedOrganizationScope>
  );
}

function RequestedOrganizationScope({
  requested,
  entry,
  pathname,
  children,
}: {
  requested: string;
  entry: string;
  pathname: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const routeId = useMatch({
    strict: false,
    shouldThrow: false,
    select: (match) => match.routeId,
  });
  // The location can change before the outgoing route match unmounts.
  const matchesLocation =
    routeId !== undefined && router.getMatchedRoutes(pathname).foundRoute?.id === routeId;
  const { t } = useTranslation();
  const selectionKey = ["directory-organization-scope", requested, getAuthState().revision];
  const query = useQuery({
    queryKey: [...selectionKey, entry],
    enabled: matchesLocation,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      if (requested !== getStoredActiveOrganizationId()) {
        await queryClient.fetchQuery({
          queryKey: selectionKey,
          queryFn: async () => {
            await setActiveOrganization(requested);
            return requested;
          },
          staleTime: 0,
          retry: false,
        });
      }
      const current = router.history.location.state;
      // The organization change can remount this scope before a success effect runs.
      if ((current.__TSR_key ?? current.key ?? router.state.location.href) === entry) {
        await router.navigate({
          to: pathname,
          search: ({ organizationId: _organizationId, ...search }) => search,
          hash: true,
          state: true,
          replace: true,
          resetScroll: false,
        });
      }
      return requested;
    },
    retry: false,
  });
  if (!matchesLocation) return null;
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
