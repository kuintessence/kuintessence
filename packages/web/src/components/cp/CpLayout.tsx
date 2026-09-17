import { ShieldOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePlatformCapability } from "../../lib/platform-capabilities";
import { CpCapabilityError } from "./CpCapabilityError";
import { ProviderOrganizationSelector } from "./ProviderOrganizationSelector";

export interface CpLayoutProps {
  children: ReactNode;
}

export function CpLayout({ children }: CpLayoutProps) {
  const { t } = useTranslation();
  const access = usePlatformCapability("workspace.provider.view");

  if (!access.ready) return null;

  if (access.error) {
    return <CpCapabilityError retry={access.retry} />;
  }

  if (!access.allowed) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground"
        data-testid="cp-rbac-denied"
      >
        <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t("cp.access.viewRequired")}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="cp-layout">
      <div className="flex justify-start sm:justify-end">
        <ProviderOrganizationSelector />
      </div>
      {children}
    </div>
  );
}
