import { createFileRoute } from "@tanstack/react-router";
import { AuditSearchPanel } from "../components/cp/AuditSearchPanel";

export const Route = createFileRoute("/cp/audit")({
  component: AuditSearchPanel,
});
