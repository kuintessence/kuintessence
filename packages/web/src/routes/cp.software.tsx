import { createFileRoute } from "@tanstack/react-router";
import { CpCapabilityError } from "../components/cp/CpCapabilityError";
import { SoftwarePolicyTable } from "../components/cp/SoftwarePolicyTable";
import { RecipeRepositoriesPanel } from "../components/software/RecipeRepositoriesPanel";
import { SpackMaterialsPanel } from "../components/software/SpackMaterialsPanel";
import { usePlatformCapability } from "../lib/platform-capabilities";

export function CpSoftwarePage() {
  const management = usePlatformCapability("workspace.provider.manage");
  if (!management.ready) return null;
  if (management.error) return <CpCapabilityError retry={management.retry} />;
  return (
    <div className="space-y-4">
      <RecipeRepositoriesPanel canManage={management.allowed} />
      <SpackMaterialsPanel canManage={management.allowed} />
      <SoftwarePolicyTable canManage={management.allowed} />
    </div>
  );
}

export const Route = createFileRoute("/cp/software")({
  component: CpSoftwarePage,
});
