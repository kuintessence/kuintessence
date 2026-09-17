import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { SandboxScriptCatalog } from "../components/software/SandboxScriptCatalog";

function SandboxScriptsRouteComponent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <ProtectedRoute>
      {pathname === "/software/scripts" || pathname === "/software/scripts/" ? (
        <SandboxScriptCatalog />
      ) : (
        <Outlet />
      )}
    </ProtectedRoute>
  );
}

export const Route = createFileRoute("/software/scripts")({
  component: SandboxScriptsRouteComponent,
});
