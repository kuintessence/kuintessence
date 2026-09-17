import { createFileRoute } from "@tanstack/react-router";
import { CpInfrastructurePage } from "../components/cp/CpInfrastructurePage";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";

export const Route = createFileRoute("/cp/infrastructure")({
  component: () => (
    <CpManageBoundary>
      <CpInfrastructurePage />
    </CpManageBoundary>
  ),
});
