import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../../components/ProtectedRoute";
import { WorkflowDagView } from "../../components/workflows/WorkflowDagView";

function WorkflowRunRoute() {
  const { runId } = Route.useParams();
  return (
    <ProtectedRoute>
      <WorkflowDagView runId={runId} />
    </ProtectedRoute>
  );
}

export const Route = createFileRoute("/workflows/$runId")({
  component: WorkflowRunRoute,
});
