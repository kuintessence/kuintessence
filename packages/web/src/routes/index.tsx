import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "../components/dashboard/Dashboard";
import { ProtectedRoute } from "../components/ProtectedRoute";

export const Route = createFileRoute("/")({
  component: () => (
    <ProtectedRoute>
      <Dashboard />
    </ProtectedRoute>
  ),
});
