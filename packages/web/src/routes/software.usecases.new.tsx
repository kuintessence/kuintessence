import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { SoftwareUsecaseCreatePage } from "../components/software/SoftwareCreatePages";
import { SoftwarePublisherRoute } from "../components/software/SoftwarePublisherRoute";

export const Route = createFileRoute("/software/usecases/new")({
  component: () => (
    <ProtectedRoute>
      <SoftwarePublisherRoute returnSection="usecases">
        <SoftwareUsecaseCreatePage />
      </SoftwarePublisherRoute>
    </ProtectedRoute>
  ),
});
