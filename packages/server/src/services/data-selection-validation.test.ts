import { describe, expect, test } from "bun:test";
import { usecase } from "@kuintessence/shared";
import {
  DataSelectionValidator,
  dataAssetMetadataElements,
  type SelectableDataAssetVersion,
} from "./data-selection-validation";

const assetId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000102";

function selected(overrides: Partial<SelectableDataAssetVersion> = {}): SelectableDataAssetVersion {
  return {
    asset: {
      id: assetId,
      name: "vasp-potcar-pbe",
      kind: "licensed-material",
      ownerKind: "user",
      accessMode: "entitlement",
      sensitivity: "restricted",
      tags: ["vasp", "pbe"],
      elements: ["Si"],
    },
    version: {
      id: versionId,
      version: "2025.1",
      status: "ready",
      immutableAt: new Date("2026-07-01T00:00:00.000Z"),
      manifestDigest: "sha256:potcar-manifest",
      format: "potcar",
      schemaUri: "https://example.test/potcar-schema",
      sizeBytes: 1024,
      elements: ["O"],
    },
    files: [{ path: "POTCAR" }],
    ...overrides,
  };
}

function pkg() {
  return usecase.GovernedUsecasePackageSchema.parse({
    usecase: { commandFile: "vasp_std", inputSlots: [] },
    software: { kind: "Spack", name: "vasp", version: "6.5.1", argumentList: [] },
    arguments: [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
    description: "VASP static calculation",
    domain: "materials",
    tags: ["VASP"],
    citations: [],
    softwareRef: { source: "official-upstream", name: "vasp", version: "6.5.1" },
    inputs: [
      {
        descriptor: "potcar",
        type: "Dataset",
        dataRequirements: {
          dataAssets: [
            { kind: "licensed-material", selector: "vasp-potcar-pbe", version: "2025.1" },
          ],
          acceptedFormats: ["potcar"],
          requiredSchema: "https://example.test/potcar-schema",
          requiredTags: ["vasp"],
          minBytes: 512,
          maxBytes: 2048,
          accessModes: ["entitlement"],
          maxSensitivity: "restricted",
          allowUserPrivate: true,
        },
      },
    ],
    outputs: [],
    resources: {},
    materialMappings: [],
    dataRequirements: [
      {
        asset: { kind: "licensed-material", selector: "vasp-potcar-pbe", version: "2025.1" },
        targetPath: "POTCAR",
        accessMode: "entitlement",
        maxSensitivity: "restricted",
        deliveryPolicy: {},
        entitlementRequired: true,
        allowUserPrivate: true,
      },
    ],
    licensedMaterials: [
      {
        selector: "vasp-potcar-pbe",
        licenseSubject: "VASP",
        targetPath: "POTCAR",
        requiredElements: ["si", "O"],
      },
    ],
    licenseRequirements: [],
  });
}

function validator(value = selected()) {
  return new DataSelectionValidator({ getVersion: async () => value });
}

function potcarInput(targetPath?: string) {
  return {
    source: "data-market" as const,
    assetId,
    versionId,
    manifestDigest: "sha256:potcar-manifest",
    selectedEntries: ["POTCAR"],
    ...(targetPath ? { targetPath } : {}),
  };
}

describe("DataSelectionValidator", () => {
  test("normalizes the asset metadata element set used by VASP validation", () => {
    expect(dataAssetMetadataElements({ elements: ["si", "O", "SI", 42] })).toEqual(["Si", "O"]);
  });

  test("freezes a matching immutable VASP DataAsset and suppresses the legacy selector", async () => {
    const result = await validator().validateUsecase({
      pkg: pkg(),
      dataInputs: { potcar: potcarInput() },
    });
    expect(result).toEqual([
      {
        descriptor: "potcar",
        stagePath: "POTCAR",
        satisfiedLicensedMaterialSelectors: ["vasp-potcar-pbe"],
      },
    ]);
  });

  test("rejects a POTCAR whose immutable metadata omits a required element", async () => {
    await expect(
      validator(selected({ version: { ...selected().version, elements: [] } })).validateUsecase({
        pkg: pkg(),
        dataInputs: { potcar: potcarInput() },
      }),
    ).rejects.toMatchObject({ details: { blocker: "LICENSED_MATERIAL_ELEMENTS_MISMATCH" } });
  });

  test("rejects a selected entry outside the immutable manifest", async () => {
    await expect(
      validator().validateUsecase({
        pkg: pkg(),
        dataInputs: { potcar: { ...potcarInput(), selectedEntries: ["secret/POTCAR"] } },
      }),
    ).rejects.toMatchObject({ details: { blocker: "DATA_SELECTED_ENTRY_NOT_FOUND" } });
  });

  test("rejects a private DataAsset when the declared Dataset input forbids it", async () => {
    const privatePkg = pkg();
    const input = privatePkg.inputs[0];
    if (!input || input.type !== "Dataset" || !input.dataRequirements) {
      throw new Error("expected Dataset input requirements");
    }
    privatePkg.inputs[0] = {
      ...input,
      dataRequirements: {
        ...input.dataRequirements,
        allowUserPrivate: false,
      },
    };
    await expect(
      validator().validateUsecase({
        pkg: privatePkg,
        dataInputs: { potcar: potcarInput() },
      }),
    ).rejects.toMatchObject({ details: { blocker: "DATA_USER_PRIVATE_DISALLOWED" } });
  });

  test("does not silently reuse one selected DataAsset for two distinct target paths", async () => {
    const reused = pkg();
    const requirement = reused.dataRequirements[0];
    if (!requirement) throw new Error("expected licensed material requirement");
    reused.dataRequirements.push({ ...requirement, targetPath: "POTCAR.secondary" });
    await expect(
      validator().validateUsecase({
        pkg: reused,
        dataInputs: { potcar: potcarInput() },
      }),
    ).rejects.toMatchObject({ details: { blocker: "DATA_ASSET_REQUIREMENT_REUSED" } });
  });
});
