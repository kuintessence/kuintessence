import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

export function CpCapabilityError({ retry }: { retry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="space-y-3 rounded-md border border-status-failed/40 p-4"
      data-testid="cp-capability-error"
      role="alert"
    >
      <p className="text-sm text-status-failed">{t("workspace.capabilitiesFailedDescription")}</p>
      <Button type="button" variant="outline" size="sm" onClick={retry}>
        <RefreshCw />
        {t("workspace.retryCapabilities")}
      </Button>
    </div>
  );
}
