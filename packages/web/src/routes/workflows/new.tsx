import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw, ShieldOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProtectedRoute } from "../../components/ProtectedRoute";
import { Button } from "../../components/ui/button";
import { PageHeader, PageShell } from "../../components/ui/page";
import { NewWorkflowPage } from "../../components/workflows/NewWorkflowPage";
import { getAuthState } from "../../lib/auth";
import { isLocalMode } from "../../lib/local-mode";
import { toCapabilitySet, useMeCapabilities } from "../../lib/platform-capabilities";
import { canCreateWorkflow } from "../../lib/workflow-access";

export const Route = createFileRoute("/workflows/new")({
  component: () => (
    <ProtectedRoute>
      <WorkflowCreationRoute />
    </ProtectedRoute>
  ),
});

function WorkflowCreationRoute() {
  const { t } = useTranslation();
  const auth = getAuthState();
  const local = isLocalMode();
  const capabilityState = useMeCapabilities(auth.isAuthenticated && !local);
  if (!local && capabilityState.status === "error") {
    return (
      <PageShell data-testid="workflow-create-capability-error">
        <PageHeader title={t("workflows.newWorkflowTitle")} />
        <div className="space-y-3 rounded-md border border-status-failed/40 p-4" role="alert">
          <p className="text-sm text-status-failed">
            {t("workspace.capabilitiesFailedDescription")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={capabilityState.retry}>
            <RefreshCw />
            {t("workspace.retryCapabilities")}
          </Button>
        </div>
      </PageShell>
    );
  }
  if (!local && capabilityState.status !== "ready") {
    return null;
  }
  if (!canCreateWorkflow(local, toCapabilitySet(capabilityState.data))) {
    return (
      <PageShell data-testid="workflow-create-denied">
        <PageHeader
          title={t("workflows.newWorkflowTitle")}
          subtitle={t("workflows.creation.accessDenied")}
        />
        <div className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-3">
            <p>{t("workflows.creation.accessGuidance")}</p>
            <Button asChild type="button" variant="outline" size="sm">
              <Link to="/workflows">
                <ArrowLeft />
                {t("workflows.title")}
              </Link>
            </Button>
          </div>
        </div>
      </PageShell>
    );
  }
  return <NewWorkflowPage />;
}
