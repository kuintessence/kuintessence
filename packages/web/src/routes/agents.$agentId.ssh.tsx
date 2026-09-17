import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, RefreshCw, ShieldOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { SshTerminal } from "../components/ssh/SshTerminal";
import { Button } from "../components/ui/button";
import { PageHeader, PageShell } from "../components/ui/page";
import { usePlatformCapability } from "../lib/platform-capabilities";

/**
 * Web SSH route.
 *
 * The Server-side gateway enforces Agent operate permission authoritatively. The
 * route uses the matching capability so organization membership grants are
 * reflected before opening the socket.
 */
function Page() {
  const { agentId } = Route.useParams();
  return <SshRoutePage agentId={agentId} />;
}

export function SshRoutePage({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const access = usePlatformCapability("terminal.open");

  if (!access.ready) return null;

  if (access.error) {
    return (
      <PageShell>
        <PageHeader title={t("ssh.terminal.title")} subtitle={agentId} />
        <div className="space-y-3 rounded-md border border-status-failed/40 p-4" role="alert">
          <p className="text-sm text-status-failed">
            {t("workspace.capabilitiesFailedDescription")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={access.retry}>
            <RefreshCw />
            {t("workspace.retryCapabilities")}
          </Button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title={t("ssh.terminal.title", { defaultValue: "SSH terminal" })}
        subtitle={agentId}
        meta={
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link
              to="/agents"
              className="inline-flex items-center gap-1 hover:text-foreground"
              data-testid="ssh-back-link"
            >
              <ChevronLeft className="h-3 w-3" />
              {t("ssh.terminal.back")}
            </Link>
          </div>
        }
      />

      {access.allowed ? (
        <SshTerminal agentId={agentId} />
      ) : (
        <div
          className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground"
          data-testid="ssh-rbac-denied"
        >
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("ssh.terminal.unauthorized")}</span>
        </div>
      )}
    </PageShell>
  );
}

export const Route = createFileRoute("/agents/$agentId/ssh")({
  component: () => (
    <ProtectedRoute>
      <Page />
    </ProtectedRoute>
  ),
});
