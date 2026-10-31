import { createFileRoute } from "@tanstack/react-router";
import { InterconnectDashboard } from "../components/interconnect/InterconnectDashboard";
export const Route = createFileRoute("/cp/interconnect")({
  component: () => <InterconnectDashboard mode="provider" />,
});
