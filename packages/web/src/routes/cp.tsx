import { createFileRoute, Outlet } from "@tanstack/react-router";
import { CpLayout } from "../components/cp/CpLayout";
import { ProtectedRoute } from "../components/ProtectedRoute";

export const Route = createFileRoute("/cp")({
  component: () => (
    <ProtectedRoute>
      <CpLayout>
        <Outlet />
      </CpLayout>
    </ProtectedRoute>
  ),
});
