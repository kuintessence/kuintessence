import { createFileRoute } from "@tanstack/react-router";
import { SoftwareWorkflowTemplateDetailPage } from "../components/software/SoftwareDetailPages";

function SoftwareWorkflowTemplateDetailRoute() {
  const { templateId } = Route.useParams();
  return <SoftwareWorkflowTemplateDetailPage templateId={templateId} />;
}

export const Route = createFileRoute("/software/workflow-templates/$templateId")({
  component: SoftwareWorkflowTemplateDetailRoute,
});
