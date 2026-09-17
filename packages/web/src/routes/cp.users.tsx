import { createFileRoute } from "@tanstack/react-router";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";
import { UsersTable } from "../components/cp/UsersTable";

export const Route = createFileRoute("/cp/users")({
  component: () => (
    <CpManageBoundary>
      <UsersTable />
    </CpManageBoundary>
  ),
});
