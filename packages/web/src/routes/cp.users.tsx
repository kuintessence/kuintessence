import { createFileRoute } from "@tanstack/react-router";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";
import { UsersTable } from "../components/cp/UsersTable";
import { OrganizationQueryScope } from "../components/OrganizationQueryScope";

export const Route = createFileRoute("/cp/users")({
  component: () => (
    <CpManageBoundary>
      <OrganizationQueryScope>
        <UsersTable />
      </OrganizationQueryScope>
    </CpManageBoundary>
  ),
});
