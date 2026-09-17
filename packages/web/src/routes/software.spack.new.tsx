import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { SoftwareSpackCatalogCreatePage } from "../components/software/SoftwareCreatePages";
import { SoftwarePublisherRoute } from "../components/software/SoftwarePublisherRoute";

export const Route = createFileRoute("/software/spack/new")({
  component: () => (
    <ProtectedRoute>
      <SoftwarePublisherRoute returnSection="spack">
        <SoftwareSpackCatalogCreatePage />
      </SoftwarePublisherRoute>
    </ProtectedRoute>
  ),
});
