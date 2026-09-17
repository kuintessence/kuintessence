import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { TerminalPage } from "../components/terminal/TerminalPage";

export const Route = createFileRoute("/terminal")({
  component: () => (
    <ProtectedRoute>
      <TerminalPage />
    </ProtectedRoute>
  ),
});
