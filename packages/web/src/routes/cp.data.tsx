import { createFileRoute } from "@tanstack/react-router";
import { CpDataPage } from "../components/cp/CpDataPage";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";

export const Route = createFileRoute("/cp/data")({
  component: () => (
    <CpManageBoundary>
      <CpDataPage />
    </CpManageBoundary>
  ),
});
