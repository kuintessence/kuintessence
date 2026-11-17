import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { InterconnectDashboard } from "../components/interconnect/InterconnectDashboard";
import { resolveInterconnectResource } from "../components/interconnect/model";
export const Route = createFileRoute("/cp/interconnect")({
  validateSearch: (search: Record<string, unknown>): { organizationId?: string } => ({
    organizationId: typeof search.organizationId === "string" ? search.organizationId : undefined,
  }),
  component: InterconnectRoute,
});
function InterconnectRoute() {
  const { organizationId } = Route.useSearch();
  const resource = useRouterState({
    select: (state) => resolveInterconnectResource(state.location.hash),
  });
  return (
    <InterconnectDashboard mode="provider" organizationId={organizationId} resource={resource} />
  );
}
