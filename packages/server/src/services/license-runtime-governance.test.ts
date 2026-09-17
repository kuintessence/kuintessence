import { describe, expect, test } from "bun:test";
import {
  type GovernanceRepository,
  type LicensePolicySnapshot,
  LicenseRuntimeGovernanceService,
} from "./license-runtime-governance";

function repository(overrides: Partial<GovernanceRepository> = {}): GovernanceRepository {
  return {
    getCanonicalLicensePolicy: async () => null,
    listEntitlements: async () => [],
    getRuntimeContract: async () => null,
    listRuntimeBindings: async () => [],
    getLicensedMaterial: async () => null,
    ...overrides,
  };
}

describe("LicenseRuntimeGovernanceService", () => {
  test("fails closed for unknown automatic installation and missing entitlements", async () => {
    const service = new LicenseRuntimeGovernanceService(repository());
    const blocks = await service.evaluateLicense({
      assetKey: "spack:vasp@6.5.1",
      policy: {
        classification: "unknown",
        provenance: "https://example.test/licenses/vasp",
        acceptanceRequired: true,
        providerSourceInstallEntitlementRequired: true,
        consumerUseEntitlementRequired: true,
      },
      providerEntitlementSubjectIds: ["provider-org"],
      consumerEntitlementSubjectIds: ["consumer-org"],
      installRequested: true,
    });
    expect(blocks.map((block) => block.code)).toEqual([
      "LICENSE_UNKNOWN_AUTO_INSTALL_DENIED",
      "LICENSE_ACCEPTANCE_REQUIRED",
      "LICENSE_PROVIDER_ENTITLEMENT_REQUIRED",
      "LICENSE_CONSUMER_ENTITLEMENT_REQUIRED",
    ]);
  });

  test("accepts an unexpired approved consumer entitlement", async () => {
    const service = new LicenseRuntimeGovernanceService(
      repository({
        listEntitlements: async () => [
          { subjectId: "consumer", scope: "consumer-use", status: "approved" },
        ],
      }),
    );
    expect(
      await service.evaluateLicense({
        assetKey: "spack:restricted@1",
        policy: {
          classification: "proprietary",
          provenance: "https://example.test/licenses/vasp",
          consumerUseEntitlementRequired: true,
        },
        providerEntitlementSubjectIds: [],
        consumerEntitlementSubjectIds: ["consumer"],
        installRequested: false,
      }),
    ).toEqual([]);
  });

  test("VASP-style material placement requires both provider and consumer entitlements", async () => {
    const service = new LicenseRuntimeGovernanceService(
      repository({
        getLicensedMaterial: async () => ({
          id: "vasp-potcar-pbe",
          providerOrgId: "provider",
          agentId: "agent-a",
          assetId: "asset-1",
          licenseSubject: "VASP-license",
          version: "PBE.64",
          elementSet: ["Si"],
          fingerprint: "sha256:verified",
          status: "active",
        }),
        getCanonicalLicensePolicy: async () => ({
          classification: "proprietary",
          provenance: "https://www.vasp.at/info/eula/",
          acceptanceRequired: true,
          providerSourceInstallEntitlementRequired: true,
          consumerUseEntitlementRequired: true,
          autoInstallAllowed: false,
        }),
      }),
    );
    await expect(
      service.resolveLicensedMaterialMounts({
        requests: [
          {
            selector: "vasp-potcar-pbe",
            licenseSubject: "VASP",
            targetPath: "POTCAR",
            requiredElements: ["Si"],
          },
        ],
        providerOrgId: "provider",
        agentId: "agent-a",
        consumerEntitlementSubjectIds: ["consumer"],
      }),
    ).rejects.toThrow("LICENSE_PROVIDER_ENTITLEMENT_REQUIRED");
  });

  test("allows VASP placement after approved provider and consumer-use entitlements", async () => {
    const service = new LicenseRuntimeGovernanceService(
      repository({
        listEntitlements: async ({ scope }) => [
          {
            subjectId: scope === "provider-source-install" ? "provider" : "consumer",
            scope,
            status: "approved",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          },
        ],
        getLicensedMaterial: async () => ({
          id: "vasp-potcar-pbe",
          providerOrgId: "provider",
          agentId: "agent-a",
          assetId: "asset-1",
          licenseSubject: "VASP-license",
          version: "PBE.64",
          elementSet: ["Si"],
          fingerprint: "sha256:verified",
          status: "active",
        }),
        getCanonicalLicensePolicy: async () => ({
          classification: "proprietary",
          provenance: "https://www.vasp.at/info/eula/",
          acceptanceRequired: true,
          providerSourceInstallEntitlementRequired: true,
          providerEntitlementRequiredForUse: true,
          consumerUseEntitlementRequired: true,
          autoInstallAllowed: false,
        }),
      }),
    );
    await expect(
      service.resolveLicensedMaterialMounts({
        requests: [
          {
            selector: "vasp-potcar-pbe",
            licenseSubject: "VASP-license",
            targetPath: "POTCAR",
            requiredElements: ["Si"],
          },
        ],
        providerOrgId: "provider",
        agentId: "agent-a",
        consumerEntitlementSubjectIds: ["consumer"],
      }),
    ).resolves.toEqual([
      {
        selector: "vasp-potcar-pbe",
        licenseSubject: "VASP-license",
        targetPath: "POTCAR",
        requiredElements: ["Si"],
        expectedFingerprint: "sha256:verified",
      },
    ]);
  });

  test("requires a policy for preinstalled use and rejects malformed policy snapshots", async () => {
    const service = new LicenseRuntimeGovernanceService(repository());
    expect(
      (
        await service.evaluateLicense({
          assetKey: "spack:unreviewed@1",
          providerEntitlementSubjectIds: [],
          consumerEntitlementSubjectIds: [],
          installRequested: false,
        })
      )[0]?.code,
    ).toBe("LICENSE_POLICY_REQUIRED");
    expect(
      (
        await service.evaluateLicense({
          assetKey: "spack:unreviewed@1",
          policy: { classification: "not-a-license" } as unknown as LicensePolicySnapshot,
          providerEntitlementSubjectIds: [],
          consumerEntitlementSubjectIds: [],
          installRequested: false,
        })
      )[0]?.code,
    ).toBe("LICENSE_POLICY_REQUIRED");
  });

  test("requires the provider entitlement for proprietary preinstalled use", async () => {
    const service = new LicenseRuntimeGovernanceService(repository());
    expect(
      (
        await service.evaluateLicense({
          assetKey: "VASP-license",
          policy: {
            classification: "proprietary",
            provenance: "https://example.test/licenses/vasp",
            providerSourceInstallEntitlementRequired: true,
          },
          providerEntitlementSubjectIds: ["provider"],
          consumerEntitlementSubjectIds: [],
          installRequested: false,
        })
      ).map((block) => block.code),
    ).toContain("LICENSE_PROVIDER_ENTITLEMENT_REQUIRED");
  });

  test("requires a signed runtime binding scoped to the selected Agent", async () => {
    const service = new LicenseRuntimeGovernanceService(
      repository({
        getRuntimeContract: async () => ({ id: "python-3.12-stdlib-v1", status: "active" }),
        listRuntimeBindings: async () => [
          {
            contractId: "python-3.12-stdlib-v1",
            runtimeProfileId: "runtime-1",
            providerOrgId: "provider",
            agentId: "different-agent",
            status: "active",
            signatureVerified: true,
          },
        ],
      }),
    );
    expect(
      (
        await service.evaluateRuntime({
          contractId: "python-3.12-stdlib-v1",
          providerOrgId: "provider",
          agentId: "agent-a",
        })
      )[0]?.code,
    ).toBe("RUNTIME_CONTRACT_UNBOUND");
  });

  test("does not treat a digest-shaped value as a runtime attestation", async () => {
    const service = new LicenseRuntimeGovernanceService(
      repository({
        getRuntimeContract: async () => ({ id: "python-3.12-stdlib-v1", status: "active" }),
        listRuntimeBindings: async () => [
          {
            contractId: "python-3.12-stdlib-v1",
            runtimeProfileId: "runtime-1",
            providerOrgId: "provider",
            agentId: "agent-a",
            status: "active",
            signatureVerified: false,
          },
        ],
      }),
    );
    expect(
      (
        await service.evaluateRuntime({
          contractId: "python-3.12-stdlib-v1",
          providerOrgId: "provider",
          agentId: "agent-a",
        })
      )[0]?.code,
    ).toBe("RUNTIME_CONTRACT_UNBOUND");
  });

  test("requires the selected Agent material mapping and every requested element", async () => {
    const service = new LicenseRuntimeGovernanceService(
      repository({
        getLicensedMaterial: async () => ({
          id: "potcar-pbe",
          providerOrgId: "provider",
          agentId: "agent-a",
          assetId: "asset-1",
          licenseSubject: "VASP-license",
          version: "PBE.64",
          elementSet: ["Si", "O"],
          fingerprint: "sha256:abc",
          status: "active",
        }),
      }),
    );
    expect(
      (
        await service.evaluateLicensedMaterial({
          selectorId: "potcar-pbe",
          providerOrgId: "provider",
          agentId: "agent-a",
          requiredElements: ["Si", "Fe"],
        })
      )[0]?.code,
    ).toBe("LICENSED_MATERIAL_ELEMENTS_MISMATCH");
  });
});
