import { Link } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw, ShieldOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getAuthState } from "../../lib/auth";
import { type SoftwareSection, softwareCatalogDestination } from "../../lib/software-navigation";
import { useSoftwarePublishingAccess } from "../../lib/software-publishing-access";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";

export function SoftwarePublisherRoute({
  children,
  platformOnly = false,
  returnSection = "templates",
}: {
  children: ReactNode;
  platformOnly?: boolean;
  returnSection?: SoftwareSection;
}) {
  const { t } = useTranslation();
  const access = useSoftwarePublishingAccess();
  if (!access.ready) return null;
  if (access.error) {
    return (
      <PageShell data-testid="software-publisher-capability-error">
        <PageHeader title={t("software.manage.publishAccessTitle")} />
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
  const role = getAuthState().role;
  const hasPlatformScope = role === "platform_admin" || role === "super_admin";
  if (!access.canPublish || (platformOnly && !hasPlatformScope)) {
    return (
      <PageShell data-testid="software-publisher-denied">
        <PageHeader
          title={t("software.manage.publishAccessTitle")}
          subtitle={t("software.manage.publishAccessDenied")}
        />
        <div className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-3">
            <p>{t("software.manage.publishAccessGuidance")}</p>
            <Button asChild type="button" variant="outline" size="sm">
              <Link {...softwareCatalogDestination(returnSection)}>
                <ArrowLeft />
                {t("software.manage.backToSoftware")}
              </Link>
            </Button>
          </div>
        </div>
      </PageShell>
    );
  }
  return <>{children}</>;
}
