import { createFileRoute } from "@tanstack/react-router";
import { DataMarketPage } from "../components/data-market/DataMarketPage";
import { ProtectedRoute } from "../components/ProtectedRoute";

export const Route = createFileRoute("/data-market")({
  component: () => (
    <ProtectedRoute>
      <DataMarketPage />
    </ProtectedRoute>
  ),
});
