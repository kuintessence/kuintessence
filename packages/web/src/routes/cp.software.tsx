import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CpCapabilityError } from "../components/cp/CpCapabilityError";
import { SoftwarePolicyTable } from "../components/cp/SoftwarePolicyTable";
import { RecipeRepositoriesPanel } from "../components/software/RecipeRepositoriesPanel";
import { SpackMaterialsPanel } from "../components/software/SpackMaterialsPanel";
import { usePlatformCapability } from "../lib/platform-capabilities";
import { useMobileMutationBlocked } from "../lib/use-mobile-mutation-blocked";

export function CpSoftwarePage() {
  const { t } = useTranslation();
  const mobileReadOnly = useMobileMutationBlocked("/cp/software");
  const management = usePlatformCapability("workspace.provider.manage");
  if (!management.ready) return null;
  if (management.error) return <CpCapabilityError retry={management.retry} />;
  return (
    <div className="space-y-4">
      <SoftwarePolicyTable canManage={management.allowed} />
      <details
        open={!mobileReadOnly}
        className="rounded-lg border border-border bg-card"
        data-testid="cp-software-material-details"
      >
        <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {t("software.materialManagement")}
        </summary>
        <div className="space-y-4 border-t border-border p-4">
          <RecipeRepositoriesPanel canManage={management.allowed} />
          <SpackMaterialsPanel canManage={management.allowed} />
        </div>
      </details>
    </div>
  );
}

export const Route = createFileRoute("/cp/software")({
  component: CpSoftwarePage,
});
