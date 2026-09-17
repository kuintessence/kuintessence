import { useRouterState } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getAuthState } from "../../lib/auth";
import { isLocalMode } from "../../lib/local-mode";
import { toCapabilitySet, useMeCapabilities } from "../../lib/platform-capabilities";
import { MeteringPage } from "../cp/MeteringPage";
import { PageHeader, PageShell } from "../ui/page";
import { AuditCapabilityPanel } from "./AuditCapabilityPanel";
import { AuditLogPanel } from "./AuditLogPanel";
import { AuthzAdminPanel } from "./AuthzAdminPanel";
import { CloudStorageGovernancePanel } from "./CloudStorageGovernancePanel";
import { ClusterFileRootsPanel } from "./ClusterFileRootsPanel";
import { CostRatesForm } from "./CostRatesForm";
import { FileTransferAuditConfigPanel } from "./FileTransferAuditConfigPanel";
import { OperationsAttentionCards } from "./OperationsAttentionCards";
import type { OperationsArea } from "./operations-capabilities";
import { PlatformBrandingForm } from "./PlatformBrandingForm";
import { SandboxSecurityPanel } from "./SandboxSecurityPanel";
import { OperationsMap, OperationsSummary } from "./SettingsPage";
import { SSOConfigForm } from "./SSOConfigForm";

const OPERATIONS_AREAS = new Set<OperationsArea>([
  "security",
  "compute",
  "metering",
  "audit",
  "governance",
]);

export function resolveOperationsArea(hash: string): OperationsArea | null {
  const area = hash.replace(/^#/, "");
  return OPERATIONS_AREAS.has(area as OperationsArea) ? (area as OperationsArea) : null;
}

export function canAccessOperations(
  role: string | null,
  capabilities: ReadonlySet<string> = new Set(),
): boolean {
  return (
    role === "operator" ||
    role === "platform_admin" ||
    role === "super_admin" ||
    capabilities.has("workspace.audit.view")
  );
}

export function OperationsPage() {
  const auth = getAuthState();
  const { t } = useTranslation();
  const hash = useRouterState({ select: (state) => state.location.hash ?? "" });
  const local = isLocalMode();
  const capabilityState = useMeCapabilities(auth.isAuthenticated && !local);
  const capabilities = toCapabilitySet(capabilityState.data);
  const auditOnly =
    capabilities.has("workspace.audit.view") && !capabilities.has("workspace.platform.view");
  const activeArea = resolveOperationsArea(hash) ?? (auditOnly ? "audit" : null);

  if (!local && (capabilityState.status === "idle" || capabilityState.status === "loading")) {
    return null;
  }
  if (!canAccessOperations(auth.role, capabilities)) {
    return (
      <PageShell data-testid="operations-access-denied">
        <PageHeader
          title={t("settings.operations.accessDenied.title")}
          subtitle={t("settings.operations.accessDenied.description")}
        />
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/35 p-4 text-sm">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">{t("settings.operations.accessDenied.guidance")}</p>
        </div>
      </PageShell>
    );
  }
  return (
    <PageShell data-testid="operations-page">
      <PageHeader
        id="overview"
        className="scroll-mt-4"
        title={t("settings.operations.pageTitle")}
        subtitle={t("settings.operations.pageSubtitle")}
      />
      {activeArea ? null : (
        <>
          <OperationsSummary role={auth.role} capabilities={capabilities} />
          <OperationsAttentionCards />
        </>
      )}
      <OperationsConfiguration area={activeArea} role={auth.role} capabilities={capabilities} />
      {activeArea ? (
        <OperationsMap role={auth.role} areas={[activeArea]} capabilities={capabilities} />
      ) : null}
    </PageShell>
  );
}

function OperationsConfiguration({
  area,
  role,
  capabilities,
}: {
  area: OperationsArea | null;
  role: string | null;
  capabilities: ReadonlySet<string>;
}) {
  const platformAdmin = role === "platform_admin" || role === "super_admin";
  const orgAdmin = platformAdmin || role === "org_admin";
  if (!area) return null;
  if (area === "security" && platformAdmin) {
    return (
      <div className="space-y-4" data-testid="operations-security-configuration">
        <PlatformBrandingForm />
        <SandboxSecurityPanel />
        <AuthzAdminPanel showBreakGlass={role === "super_admin"} />
        <SSOConfigForm />
      </div>
    );
  }
  if (area === "compute" && orgAdmin) {
    return <ClusterFileRootsPanel />;
  }
  if (area === "metering" && platformAdmin) {
    return (
      <div className="space-y-4" data-testid="operations-metering-configuration">
        <CloudStorageGovernancePanel />
        {role === "super_admin" ? <CostRatesForm /> : null}
      </div>
    );
  }
  if (area === "metering" && role === "operator") {
    return <MeteringPage showWebhooks={false} />;
  }
  if (area === "metering" && capabilities.has("metering.report.view")) {
    return <MeteringPage showWebhooks={false} />;
  }
  if (area === "audit" && capabilities.has("audit.view")) {
    return (
      <div className="space-y-4" data-testid="operations-audit-configuration">
        <FileTransferAuditConfigPanel canManage={platformAdmin} />
        <AuditLogPanel />
      </div>
    );
  }
  if (area === "governance" && platformAdmin) {
    return <AuditCapabilityPanel />;
  }
  return null;
}
