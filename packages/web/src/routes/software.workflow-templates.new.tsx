import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { SoftwareWorkflowTemplateCreatePage } from "../components/software/SoftwareCreatePages";
import { SoftwarePublisherRoute } from "../components/software/SoftwarePublisherRoute";

export const Route = createFileRoute("/software/workflow-templates/new")({
  component: () => (
    <ProtectedRoute>
      <SoftwarePublisherRoute platformOnly returnSection="templates">
        <SoftwareWorkflowTemplateCreatePage />
      </SoftwarePublisherRoute>
    </ProtectedRoute>
  ),
});
