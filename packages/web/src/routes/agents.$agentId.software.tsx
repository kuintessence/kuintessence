import { createFileRoute } from "@tanstack/react-router";
import { AgentSoftwarePage } from "../components/agents/AgentSoftwarePage";
import { ProtectedRoute } from "../components/ProtectedRoute";

function Page() {
  const { agentId } = Route.useParams();
  return <AgentSoftwarePage agentId={agentId} />;
}

export const Route = createFileRoute("/agents/$agentId/software")({
  component: () => (
    <ProtectedRoute>
      <Page />
    </ProtectedRoute>
  ),
});
