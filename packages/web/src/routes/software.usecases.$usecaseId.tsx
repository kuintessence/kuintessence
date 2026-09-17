import { createFileRoute } from "@tanstack/react-router";
import { SoftwareUsecaseDetailPage } from "../components/software/SoftwareDetailPages";

function SoftwareUsecaseDetailRoute() {
  const { usecaseId } = Route.useParams();
  return <SoftwareUsecaseDetailPage usecaseId={usecaseId} />;
}

export const Route = createFileRoute("/software/usecases/$usecaseId")({
  component: SoftwareUsecaseDetailRoute,
});
