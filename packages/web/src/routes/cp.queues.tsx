import { createFileRoute } from "@tanstack/react-router";
import { CpManageBoundary } from "../components/cp/CpManageBoundary";
import { CpQueuesPage } from "../components/cp/CpQueuesPage";

export const Route = createFileRoute("/cp/queues")({
  component: () => (
    <CpManageBoundary>
      <CpQueuesPage />
    </CpManageBoundary>
  ),
});
