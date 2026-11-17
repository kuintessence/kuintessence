import { createFileRoute } from "@tanstack/react-router";
import { InterconnectDashboard } from "../components/interconnect/InterconnectDashboard";
export const Route = createFileRoute("/cp/interconnect")({
  validateSearch: (search: Record<string, unknown>): { organizationId?: string } => ({
    organizationId: typeof search.organizationId === "string" ? search.organizationId : undefined,
  }),
  component: InterconnectRoute,
});
function InterconnectRoute() {
  const { organizationId } = Route.useSearch();
  return <InterconnectDashboard mode="provider" organizationId={organizationId} />;
}
