import { createFileRoute } from "@tanstack/react-router";
import { CpDashboard } from "../components/cp/CpDashboard";

export const Route = createFileRoute("/cp/")({
  component: CpDashboard,
});
