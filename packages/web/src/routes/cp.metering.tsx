import { createFileRoute } from "@tanstack/react-router";
import { CpCapabilityError } from "../components/cp/CpCapabilityError";
import { MeteringPage } from "../components/cp/MeteringPage";
import { usePlatformCapability } from "../lib/platform-capabilities";

export function CpMeteringPage() {
  const management = usePlatformCapability("workspace.provider.manage");
  if (!management.ready) return null;
  if (management.error) return <CpCapabilityError retry={management.retry} />;
  return <MeteringPage scopeToActiveOrganization showWebhooks={management.allowed} />;
}

export const Route = createFileRoute("/cp/metering")({
  component: CpMeteringPage,
});
