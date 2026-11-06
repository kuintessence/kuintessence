import type { PgTransaction } from "@kuintessence/db";
import type { JobSubmission } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import {
  LicenseRuntimeGovernanceService,
  PgGovernanceRepository,
} from "../services/license-runtime-governance";
import { availabilityRequestForRequirement } from "../services/placement-orchestrator";
import type { SoftwareAvailabilityService } from "../services/software-availability";
import type { FederationDeliveryTarget } from "./dispatch-authorization";

/** Reuse local software policy for the exact target, including every reconnect/retry. */
export async function prepareFederationSoftware(
  intent: JobSubmission,
  identity: { userId: string; orgId: string },
  delivery: FederationDeliveryTarget,
  availability?: Pick<SoftwareAvailabilityService, "resolve" | "assertExecutionAccess">,
  running = false,
): Promise<(tx: PgTransaction, providerOrgId: string) => Promise<number>> {
  const requirements = intent.softwareRequirements ?? [];
  const selected =
    delivery.kind === "install"
      ? requirements.filter(
          (requirement) =>
            requirement.installable &&
            availabilityRequestForRequirement(requirement, []).rawSpec === delivery.spec,
        )
      : requirements;
  if (delivery.kind === "install" && selected.length !== 1)
    throw new FederationError("OPERATION_CONFLICT");
  if (
    intent.spackExecution &&
    !requirements.some(
      (requirement) =>
        availabilityRequestForRequirement(requirement, []).rawSpec === intent.spackExecution?.spec,
    )
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (selected.length > 0 && !availability) throw new FederationError("POLICY_DENIED");
  for (const requirement of selected) {
    // A missing mapped asset must never fall back to raw-spec authorization.
    if (!requirement.assetId) throw new FederationError("OPERATION_CONFLICT");
    const request = availabilityRequestForRequirement(requirement, [delivery.agentId]);
    const principal = {
      ...identity,
      sub: identity.userId,
      role: "user" as const,
      email: "",
      orgIds: [identity.orgId],
      memberships: [{ orgId: identity.orgId, role: "member" as const }],
      capabilities: [],
    };
    if (running) {
      await availability?.assertExecutionAccess(request, principal, delivery.kind === "install");
      continue;
    }
    const response = await availability?.resolve(
      { ...request, installable: delivery.kind === "install" },
      principal,
      { requireInstallation: delivery.kind === "install" },
    );
    if (
      response?.asset?.id !== requirement.assetId ||
      response.asset.kind !== "spack-package" ||
      response.spec !== request.rawSpec
    )
      throw new FederationError("OPERATION_CONFLICT");
    const allowed = [
      ...response.installedAvailable,
      ...(delivery.kind === "install" ? response.installableAvailable : []),
    ];
    if (!allowed.some((node) => node.agentId === delivery.agentId))
      throw new FederationError("POLICY_DENIED");
  }
  return async (tx, providerOrgId) => {
    const governance = new LicenseRuntimeGovernanceService(new PgGovernanceRepository(tx, true));
    let expiresAtUnixMs = Number.POSITIVE_INFINITY;
    for (const requirement of selected) {
      if (!requirement.assetId) throw new FederationError("OPERATION_CONFLICT");
      const policy = await governance.getCanonicalLicensePolicy(requirement.assetId);
      const spec = availabilityRequestForRequirement(requirement, []).rawSpec;
      const authorization = await governance.evaluateLicenseAuthorization({
        assetKey: policy?.identifiers?.[0] ?? spec ?? requirement.name,
        assetId: requirement.assetId,
        policy: policy ?? undefined,
        providerEntitlementSubjectIds: [providerOrgId],
        consumerEntitlementSubjectIds: [identity.userId, identity.orgId],
        installRequested: delivery.kind === "install",
        now: new Date(Date.now()),
      });
      if (authorization.blocks.length > 0) throw new FederationError("POLICY_DENIED");
      expiresAtUnixMs = Math.min(expiresAtUnixMs, authorization.expiresAtUnixMs);
    }
    return expiresAtUnixMs;
  };
}
