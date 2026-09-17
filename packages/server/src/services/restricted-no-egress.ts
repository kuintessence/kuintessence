import type { DataAssetKind, DataSensitivity } from "@kuintessence/shared";
import { AppError, ErrorCode } from "@kuintessence/shared";

export interface FrozenDataEgressFacts {
  assetKind: DataAssetKind | null;
  sensitivity: DataSensitivity | null;
  egressPolicy: "allow" | "deny";
}

export function factsRequireRestrictedNoEgress(facts: FrozenDataEgressFacts): boolean {
  return (
    facts.assetKind === "licensed-material" ||
    (facts.egressPolicy === "deny" &&
      (facts.sensitivity === "restricted" || facts.sensitivity === "regulated"))
  );
}

export function assertRestrictedNoEgressSubmission(input: {
  facts: FrozenDataEgressFacts[];
  hasLicensedMaterialMounts: boolean;
  trustedExecutable: boolean;
  expectedOutputCount: number;
  fileOutputDescriptorCount: number;
}): boolean {
  const restrictedNoEgress =
    input.hasLicensedMaterialMounts || input.facts.some(factsRequireRestrictedNoEgress);
  if (!restrictedNoEgress) return false;
  if (!input.trustedExecutable) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Restricted no-egress inputs require a trusted executable from an active signed ecosystem release",
      403,
    );
  }
  if (input.expectedOutputCount > 0 || input.fileOutputDescriptorCount > 0) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Restricted no-egress jobs cannot declare outputs",
      403,
    );
  }
  return true;
}
