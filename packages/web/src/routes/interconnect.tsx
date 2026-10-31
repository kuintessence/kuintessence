import { createFileRoute } from "@tanstack/react-router";
import { InterconnectDashboard } from "../components/interconnect/InterconnectDashboard";
import { ProtectedRoute } from "../components/ProtectedRoute";
export const Route = createFileRoute("/interconnect")({
  component: () => (
    <ProtectedRoute>
      <InterconnectDashboard mode="operator" />
    </ProtectedRoute>
  ),
});
