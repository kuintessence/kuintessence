import { createFileRoute } from "@tanstack/react-router";
import { AgentRegistrationPage } from "../components/cp/AgentRegistrationPage";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";

export const Route = createFileRoute("/cp/agent-registration")({
  component: () => (
    <CpManageBoundary>
      <AgentRegistrationPage />
    </CpManageBoundary>
  ),
});
