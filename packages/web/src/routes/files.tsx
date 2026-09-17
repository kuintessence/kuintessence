import { createFileRoute } from "@tanstack/react-router";
import { FilesPage } from "../components/files/FilesPage";
import { ProtectedRoute } from "../components/ProtectedRoute";

export const Route = createFileRoute("/files")({
  component: () => (
    <ProtectedRoute>
      <FilesPage />
    </ProtectedRoute>
  ),
});
