import { ShieldOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePlatformCapability } from "../../lib/platform-capabilities";
import { CpCapabilityError } from "./CpCapabilityError";

export function CpManageBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const access = usePlatformCapability("workspace.provider.manage");

  if (!access.ready) return null;
  if (access.error) {
    return <CpCapabilityError retry={access.retry} />;
  }
  if (!access.allowed) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground"
        data-testid="cp-manage-denied"
      >
        <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t("cp.access.manageRequired")}</span>
      </div>
    );
  }
  return children;
}
