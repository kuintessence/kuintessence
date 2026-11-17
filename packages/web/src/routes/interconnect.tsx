import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { InterconnectDashboard } from "../components/interconnect/InterconnectDashboard";
import { resolveInterconnectResource } from "../components/interconnect/model";
import { ProtectedRoute } from "../components/ProtectedRoute";
export const Route = createFileRoute("/interconnect")({
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
    <ProtectedRoute>
      <InterconnectDashboard mode="operator" organizationId={organizationId} resource={resource} />
    </ProtectedRoute>
  );
}
