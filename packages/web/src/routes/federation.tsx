import { createFileRoute } from "@tanstack/react-router";
import { FederationPage } from "../components/federation/FederationPage";
import { ProtectedRoute } from "../components/ProtectedRoute";

export const Route = createFileRoute("/federation")({
  component: () => (
    <ProtectedRoute>
      <FederationPage />
    </ProtectedRoute>
  ),
});
