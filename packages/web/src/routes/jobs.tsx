import { createFileRoute } from "@tanstack/react-router";
import { JobsPage } from "../components/jobs/JobsPage";
import { ProtectedRoute } from "../components/ProtectedRoute";

export interface JobsSearch {
  agentId?: string;
}

function parseJobsSearch(search: Record<string, unknown>): JobsSearch {
  const agentId = typeof search.agentId === "string" ? search.agentId.trim() : "";
  return agentId.length > 0 && agentId.length <= 255 ? { agentId } : {};
}

function JobsRoutePage() {
  const { agentId } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProtectedRoute>
      <JobsPage
        key={agentId ?? "all-agents"}
        agentId={agentId}
        onClearAgentFilter={() => navigate({ search: {}, replace: true })}
      />
    </ProtectedRoute>
  );
}

export const Route = createFileRoute("/jobs")({
  validateSearch: parseJobsSearch,
  component: JobsRoutePage,
});
