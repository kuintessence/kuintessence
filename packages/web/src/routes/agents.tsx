import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AgentsPage } from "../components/agents/AgentsPage";
import { ProtectedRoute } from "../components/ProtectedRoute";

function AgentsRouteComponent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <ProtectedRoute>{pathname === "/agents" ? <AgentsPage /> : <Outlet />}</ProtectedRoute>;
}

export const Route = createFileRoute("/agents")({
  component: AgentsRouteComponent,
});
