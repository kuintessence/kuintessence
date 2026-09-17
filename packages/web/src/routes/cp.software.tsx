import { createFileRoute } from "@tanstack/react-router";
import { CpCapabilityError } from "../components/cp/CpCapabilityError";
import { SoftwarePolicyTable } from "../components/cp/SoftwarePolicyTable";
import { usePlatformCapability } from "../lib/platform-capabilities";

export function CpSoftwarePage() {
  const management = usePlatformCapability("workspace.provider.manage");
  if (!management.ready) return null;
  if (management.error) return <CpCapabilityError retry={management.retry} />;
  return <SoftwarePolicyTable canManage={management.allowed} />;
}

export const Route = createFileRoute("/cp/software")({
  component: CpSoftwarePage,
});
