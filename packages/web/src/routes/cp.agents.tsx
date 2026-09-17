import { createFileRoute } from "@tanstack/react-router";
import { CpAgentsTable } from "../components/cp/CpAgentsTable";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";

export const Route = createFileRoute("/cp/agents")({
  component: () => (
    <CpManageBoundary>
      <CpAgentsTable />
    </CpManageBoundary>
  ),
});
