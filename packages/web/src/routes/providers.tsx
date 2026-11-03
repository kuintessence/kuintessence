import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { ComputeProvidersPage } from "../components/providers/ComputeProvidersPage";
export const Route = createFileRoute("/providers")({
  component: () => (
    <ProtectedRoute>
      <ComputeProvidersPage mode="operator" />
    </ProtectedRoute>
  ),
});
