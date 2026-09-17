import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../../components/ProtectedRoute";
import { WorkflowsPage } from "../../components/workflows/WorkflowsPage";

export const Route = createFileRoute("/workflows/")({
  component: () => (
    <ProtectedRoute>
      <WorkflowsPage />
    </ProtectedRoute>
  ),
});
