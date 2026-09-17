import { createFileRoute } from "@tanstack/react-router";
import { CpAccountsPage } from "../components/cp/CpAccountsPage";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";

export const Route = createFileRoute("/cp/accounts")({
  component: () => (
    <CpManageBoundary>
      <CpAccountsPage />
    </CpManageBoundary>
  ),
});
