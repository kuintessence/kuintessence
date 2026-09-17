import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { OperationsPage } from "../components/settings/OperationsPage";

export const Route = createFileRoute("/operations")({
  component: () => (
    <ProtectedRoute>
      <OperationsPage />
    </ProtectedRoute>
  ),
});
