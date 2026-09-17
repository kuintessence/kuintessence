import { createFileRoute } from "@tanstack/react-router";
import { SoftwareSpackDetailPage } from "../components/software/SoftwareDetailPages";

function SoftwareSpackDetailRoute() {
  const { name, source } = Route.useParams();
  return <SoftwareSpackDetailPage name={name} source={source} />;
}

export const Route = createFileRoute("/software/spack/$source/$name")({
  component: SoftwareSpackDetailRoute,
});
