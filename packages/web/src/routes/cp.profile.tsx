import { createFileRoute } from "@tanstack/react-router";
import { ComputeProvidersPage } from "../components/providers/ComputeProvidersPage";
export const Route = createFileRoute("/cp/profile")({
  component: () => <ComputeProvidersPage mode="provider" />,
});
