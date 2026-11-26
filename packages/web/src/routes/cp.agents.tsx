import { createFileRoute } from "@tanstack/react-router";
import { CpAgentsTable } from "../components/cp/CpAgentsTable";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";
import { OrganizationQueryScope } from "../components/OrganizationQueryScope";

export const Route = createFileRoute("/cp/agents")({
  component: () => (
    <CpManageBoundary>
      <OrganizationQueryScope>
        <CpAgentsTable />
      </OrganizationQueryScope>
    </CpManageBoundary>
  ),
});
