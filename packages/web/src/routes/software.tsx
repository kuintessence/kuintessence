import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { SoftwarePage } from "../components/software/SoftwarePage";

function SoftwareRouteComponent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <ProtectedRoute>{pathname === "/software" ? <SoftwarePage /> : <Outlet />}</ProtectedRoute>
  );
}

export const Route = createFileRoute("/software")({
  component: SoftwareRouteComponent,
});
