import { dataAssetFiles, dataAssets, dataAssetVersions, type PgDb } from "@kuintessence/db";
import type {
  DataAssetKind,
  DataInputRef,
  DataRequirements,
  DataSensitivity,
  usecase,
} from "@kuintessence/shared";
import {
  AppError,
  DataAccessModeSchema,
  DataAssetKindSchema,
  DataAssetOwnerKindSchema,
  DataDeliveryTargetPathSchema,
  DataSensitivitySchema,
  ErrorCode,
} from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";

export interface SelectableDataAssetVersion {
  asset: {
    id: string;
    name: string;
    kind: DataAssetKind;
    ownerKind: "user" | "org" | "provider" | "platform";
    accessMode: "open" | "request" | "entitlement";
    sensitivity: DataSensitivity;
    tags: string[];
    elements: string[];
  };
  version: {
    id: string;
    version: string;
    status: string;
    immutableAt: Date | null;
    manifestDigest: string | null;
    format: string | null;
    schemaUri: string | null;
    sizeBytes: number | null;
    elements: string[];
  };
  files: Array<{ path: string }>;
}

export interface DataSelectionRepository {
  getVersion(input: {
    assetId: string;
    versionId: string;
  }): Promise<SelectableDataAssetVersion | null>;
}

export interface ValidatedDataSelection {
  descriptor: string;
  stagePath: string;
  satisfiedLicensedMaterialSelectors: string[];
}

export class DataSelectionValidator {
  constructor(private readonly repository: DataSelectionRepository) {}

  async validateUsecase(input: {
    pkg: usecase.GovernedUsecasePackage;
    dataInputs: Record<string, DataInputRef>;
    dataRequirements?: Record<string, DataRequirements>;
  }): Promise<ValidatedDataSelection[]> {
    const typedInputs = new Map(input.pkg.inputs.map((item) => [item.descriptor, item]));
    const selected = await Promise.all(
      Object.entries(input.dataInputs).map(async ([descriptor, dataInput]) => {
        const typed = typedInputs.get(descriptor);
        if (!typed) {
          throw blocked("DATA_INPUT_DESCRIPTOR_UNKNOWN", descriptor, {
            descriptor,
            reason: "The selected Data Market input is not declared by this usecase",
          });
        }
        if (typed.type === "Dataset" && dataInput.source !== "data-market") {
          throw blocked("DATASET_INPUT_REQUIRES_DATA_MARKET", descriptor, { descriptor });
        }
        if (dataInput.source !== "data-market") {
          return { descriptor, dataInput, selected: null, typed };
        }
        const selected = await this.load(dataInput, descriptor);
        this.assertSelectionMatches(
          selected,
          descriptor,
          typed.type === "Dataset" ? typed.dataRequirements : undefined,
        );
        this.assertSelectionMatches(selected, descriptor, input.dataRequirements?.[descriptor]);
        return { descriptor, dataInput, selected, typed };
      }),
    );

    for (const typed of input.pkg.inputs) {
      if (typed.type === "Dataset" && typed.required && !input.dataInputs[typed.descriptor]) {
        throw blocked("DATASET_INPUT_REQUIRED", typed.descriptor, {
          descriptor: typed.descriptor,
        });
      }
    }

    const topLevelMatches = new Map<usecase.DataAssetRequirement, string>();
    const assignedDescriptors = new Set<string>();
    for (const requirement of input.pkg.dataRequirements) {
      const matches = selected.filter(
        (entry) =>
          entry.selected !== null &&
          this.matchesAssetRequirement(entry.selected, requirement, entry.descriptor),
      );
      const available = matches.filter((entry) => !assignedDescriptors.has(entry.descriptor));
      if (available.length === 0) {
        throw blocked(
          matches.length > 0
            ? "DATA_ASSET_REQUIREMENT_REUSED"
            : "DATA_ASSET_REQUIREMENT_UNSATISFIED",
          requirement.asset.selector,
          {
            selector: requirement.asset,
            targetPath: requirement.targetPath,
          },
        );
      }
      if (available.length > 1) {
        throw blocked("DATA_ASSET_REQUIREMENT_AMBIGUOUS", requirement.asset.selector, {
          selector: requirement.asset,
          targetPath: requirement.targetPath,
          descriptors: available.map((entry) => entry.descriptor),
        });
      }
      const match = available[0];
      if (!match) throw new Error("Data requirement assignment unexpectedly has no candidate");
      topLevelMatches.set(requirement, match.descriptor);
      assignedDescriptors.add(match.descriptor);
    }

    const materialMatches = new Map<string, string[]>();
    for (const material of input.pkg.licensedMaterials) {
      const match = selected.find(
        (entry) =>
          entry.selected !== null &&
          matchesSelector(entry.selected, {
            kind: "licensed-material",
            selector: material.selector,
          }),
      );
      if (!match?.selected) continue;
      const requiredElements = normalizedElements(material.requiredElements);
      const available = new Set(
        match.selected.asset.elements.concat(match.selected.version.elements),
      );
      const missingElements = requiredElements.filter((element) => !available.has(element));
      if (missingElements.length > 0) {
        throw blocked("LICENSED_MATERIAL_ELEMENTS_MISMATCH", match.descriptor, {
          selector: material.selector,
          missingElements,
          availableElements: [...available].sort(),
        });
      }
      materialMatches.set(match.descriptor, [
        ...(materialMatches.get(match.descriptor) ?? []),
        material.selector,
      ]);
    }

    return selected.map((entry) => {
      const requirement = input.pkg.dataRequirements.find(
        (candidate) => topLevelMatches.get(candidate) === entry.descriptor,
      );
      return {
        descriptor: entry.descriptor,
        stagePath: stagePath(entry.dataInput, requirement?.targetPath, entry.descriptor),
        satisfiedLicensedMaterialSelectors: materialMatches.get(entry.descriptor) ?? [],
      };
    });
  }

  async validateDatasetOption(input: {
    pkg: usecase.GovernedUsecasePackage;
    descriptor: string;
    dataInput: Extract<DataInputRef, { source: "data-market" }>;
  }): Promise<void> {
    const typed = input.pkg.inputs.find((item) => item.descriptor === input.descriptor);
    if (!typed || typed.type !== "Dataset") {
      throw blocked("DATASET_INPUT_DESCRIPTOR_UNKNOWN", input.descriptor, {
        descriptor: input.descriptor,
      });
    }
    const selected = await this.load(input.dataInput, input.descriptor);
    this.assertSelectionMatches(selected, input.descriptor, typed.dataRequirements);
  }

  private async load(
    input: Extract<DataInputRef, { source: "data-market" }>,
    descriptor: string,
  ): Promise<SelectableDataAssetVersion> {
    const selected = await this.repository.getVersion({
      assetId: input.assetId,
      versionId: input.versionId,
    });
    if (
      !selected ||
      selected.version.status !== "ready" ||
      selected.version.immutableAt === null ||
      selected.version.manifestDigest !== input.manifestDigest
    ) {
      throw blocked("DATA_VERSION_NOT_IMMUTABLE_READY", descriptor, {
        assetId: input.assetId,
        versionId: input.versionId,
      });
    }
    const paths = new Set(selected.files.map((file) => file.path));
    const missing = input.selectedEntries.filter((path) => !paths.has(path));
    if (missing.length > 0) {
      throw blocked("DATA_SELECTED_ENTRY_NOT_FOUND", descriptor, { missing });
    }
    return selected;
  }

  private assertSelectionMatches(
    selected: SelectableDataAssetVersion,
    descriptor: string,
    requirements: usecase.DatasetDataRequirements | DataRequirements | undefined,
  ): void {
    if (!requirements) return;
    const selectors = "dataAssets" in requirements ? requirements.dataAssets : [];
    if (
      selectors.length > 0 &&
      !selectors.some((selector) => matchesSelector(selected, selector))
    ) {
      throw blocked("DATA_ASSET_SELECTOR_MISMATCH", descriptor, { selectors });
    }
    if (
      requirements.acceptedFormats.length > 0 &&
      (!selected.version.format || !requirements.acceptedFormats.includes(selected.version.format))
    ) {
      throw blocked("DATA_FORMAT_MISMATCH", descriptor, {
        expected: requirements.acceptedFormats,
        actual: selected.version.format,
      });
    }
    if (requirements.requiredSchema && selected.version.schemaUri !== requirements.requiredSchema) {
      throw blocked("DATA_SCHEMA_MISMATCH", descriptor, {
        expected: requirements.requiredSchema,
        actual: selected.version.schemaUri,
      });
    }
    if (!requirements.requiredTags.every((tag) => selected.asset.tags.includes(tag))) {
      throw blocked("DATA_TAG_MISMATCH", descriptor, { expected: requirements.requiredTags });
    }
    if (
      (requirements.minBytes !== undefined &&
        (selected.version.sizeBytes === null ||
          selected.version.sizeBytes < requirements.minBytes)) ||
      (requirements.maxBytes !== undefined &&
        (selected.version.sizeBytes === null || selected.version.sizeBytes > requirements.maxBytes))
    ) {
      throw blocked("DATA_SIZE_MISMATCH", descriptor, {
        minimum: requirements.minBytes,
        maximum: requirements.maxBytes,
        actual: selected.version.sizeBytes,
      });
    }
    if (
      requirements.accessModes.length > 0 &&
      !requirements.accessModes.includes(selected.asset.accessMode)
    ) {
      throw blocked("DATA_ACCESS_MODE_MISMATCH", descriptor, {
        expected: requirements.accessModes,
        actual: selected.asset.accessMode,
      });
    }
    if (
      requirements.maxSensitivity !== undefined &&
      sensitivityRank(selected.asset.sensitivity) > sensitivityRank(requirements.maxSensitivity)
    ) {
      throw blocked("DATA_SENSITIVITY_MISMATCH", descriptor, {
        maximum: requirements.maxSensitivity,
        actual: selected.asset.sensitivity,
      });
    }
    if (
      "allowUserPrivate" in requirements &&
      !requirements.allowUserPrivate &&
      selected.asset.ownerKind === "user"
    ) {
      throw blocked("DATA_USER_PRIVATE_DISALLOWED", descriptor, { descriptor });
    }
  }

  private matchesAssetRequirement(
    selected: SelectableDataAssetVersion,
    requirement: usecase.DataAssetRequirement,
    descriptor: string,
  ): boolean {
    try {
      if (!matchesSelector(selected, requirement.asset)) return false;
      if (selected.asset.accessMode !== requirement.accessMode) return false;
      if (
        requirement.maxSensitivity !== undefined &&
        sensitivityRank(selected.asset.sensitivity) > sensitivityRank(requirement.maxSensitivity)
      ) {
        return false;
      }
      if (!requirement.allowUserPrivate && selected.asset.ownerKind === "user") return false;
      if (requirement.entitlementRequired && selected.asset.accessMode !== "entitlement")
        return false;
      return true;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw blocked("DATA_ASSET_REQUIREMENT_MISMATCH", descriptor, {
        selector: requirement.asset,
      });
    }
  }
}

export function createPgDataSelectionValidator(db: PgDb): DataSelectionValidator {
  return new DataSelectionValidator({
    async getVersion(input) {
      const [row] = await db
        .select({
          assetId: dataAssets.id,
          assetName: dataAssets.name,
          assetKind: dataAssets.kind,
          ownerKind: dataAssets.ownerKind,
          accessMode: dataAssets.accessMode,
          sensitivity: dataAssets.sensitivity,
          metadata: dataAssets.metadata,
          versionId: dataAssetVersions.id,
          version: dataAssetVersions.version,
          status: dataAssetVersions.status,
          immutableAt: dataAssetVersions.immutableAt,
          manifestDigest: dataAssetVersions.manifestDigest,
          format: dataAssetVersions.format,
          schemaUri: dataAssetVersions.schemaUri,
          sizeBytes: dataAssetVersions.sizeBytes,
          manifest: dataAssetVersions.manifest,
        })
        .from(dataAssetVersions)
        .innerJoin(dataAssets, eq(dataAssetVersions.dataAssetId, dataAssets.id))
        .where(and(eq(dataAssetVersions.id, input.versionId), eq(dataAssets.id, input.assetId)))
        .limit(1);
      if (!row) return null;
      const files = await db
        .select({ path: dataAssetFiles.path })
        .from(dataAssetFiles)
        .where(eq(dataAssetFiles.dataAssetVersionId, row.versionId));
      return {
        asset: {
          id: row.assetId,
          name: row.assetName,
          kind: DataAssetKindSchema.parse(row.assetKind),
          ownerKind: DataAssetOwnerKindSchema.parse(row.ownerKind),
          accessMode: DataAccessModeSchema.parse(row.accessMode),
          sensitivity: DataSensitivitySchema.parse(row.sensitivity),
          tags: metadataTags(row.metadata),
          elements: dataAssetMetadataElements(row.metadata),
        },
        version: {
          id: row.versionId,
          version: row.version,
          status: row.status,
          immutableAt: row.immutableAt,
          manifestDigest: row.manifestDigest,
          format: row.format,
          schemaUri: row.schemaUri,
          sizeBytes: row.sizeBytes,
          elements: dataAssetMetadataElements(row.manifest),
        },
        files,
      };
    },
  });
}

function matchesSelector(
  selected: SelectableDataAssetVersion,
  selector: { kind: DataAssetKind; selector: string; version?: string },
): boolean {
  return (
    selected.asset.kind === selector.kind &&
    selected.asset.name === selector.selector &&
    (selector.version === undefined || selected.version.version === selector.version)
  );
}

function stagePath(
  input: DataInputRef,
  requirementTargetPath: string | undefined,
  descriptor: string,
): string {
  const path = input.targetPath ?? requirementTargetPath ?? `inputs/${descriptor}`;
  const parsed = DataDeliveryTargetPathSchema.safeParse(path);
  if (!parsed.success) {
    throw blocked("DATA_STAGE_PATH_INVALID", descriptor, { path });
  }
  return parsed.data;
}

function sensitivityRank(value: DataSensitivity): number {
  return ["open", "internal", "restricted", "regulated"].indexOf(value);
}

function blocked(code: string, descriptor: string, details: Record<string, unknown>): AppError {
  return new AppError(ErrorCode.VALIDATION_ERROR, `Data Market selection blocked: ${code}`, 409, {
    blocker: code,
    descriptor,
    ...details,
  });
}

function metadataTags(metadata: Record<string, unknown>): string[] {
  const tags = metadata.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

export function dataAssetMetadataElements(metadata: Record<string, unknown>): string[] {
  const elements = metadata.elements;
  return Array.isArray(elements)
    ? normalizedElements(
        elements.filter((element): element is string => typeof element === "string"),
      )
    : [];
}

function normalizedElements(elements: readonly string[]): string[] {
  return [
    ...new Set(
      elements.map((element) => {
        const value = element.trim();
        if (!/^[A-Za-z]{1,2}$/.test(value)) return value;
        return `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
      }),
    ),
  ];
}
