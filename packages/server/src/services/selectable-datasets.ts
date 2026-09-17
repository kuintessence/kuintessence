import { dataAssets, dataAssetVersions, type PgDb, usecasePackages } from "@kuintessence/db";
import {
  AppError,
  DataAccessModeSchema,
  DataAssetKindSchema,
  DataAssetOwnerKindSchema,
  DataSensitivitySchema,
  type Dataset,
  ErrorCode,
  usecase,
} from "@kuintessence/shared";
import { and, desc, eq, ilike, isNotNull, or } from "drizzle-orm";
import { PgDataPrerequisiteRepository } from "./data-prerequisite-repository-drizzle";
import {
  createPgDataSelectionValidator,
  DataSelectionValidator,
  dataAssetMetadataElements,
  type SelectableDataAssetVersion,
} from "./data-selection-validation";
import {
  assertUsecasePackageExecutionAccess,
  type UsecaseExecutionRequester,
} from "./usecase-execution-authorizer";

export interface SelectableDatasetQuery {
  descriptor: string;
  limit: number;
  offset: number;
  q?: string;
}

export class SelectableDatasetService {
  constructor(private readonly db: PgDb) {}

  async list(
    usecasePackageId: string,
    actor: UsecaseExecutionRequester,
    query: SelectableDatasetQuery,
  ) {
    await assertUsecasePackageExecutionAccess(this.db, usecasePackageId, actor);
    const [stored] = await this.db
      .select({ spec: usecasePackages.spec })
      .from(usecasePackages)
      .where(eq(usecasePackages.id, usecasePackageId))
      .limit(1);
    if (!stored) throw new AppError(ErrorCode.NOT_FOUND, "Usecase package not found", 404);
    const pkg = usecase.UsecasePackageSchema.parse(stored.spec);
    if (!("softwareRef" in pkg)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Dataset inputs require a governed usecase package",
        409,
      );
    }
    const typed = pkg.inputs.find((input) => input.descriptor === query.descriptor);
    if (!typed || typed.type !== "Dataset") {
      throw new AppError(ErrorCode.NOT_FOUND, "Dataset input descriptor not found", 404);
    }

    const search = query.q
      ? or(
          ilike(dataAssets.name, `%${escapeLike(query.q)}%`),
          ilike(dataAssetVersions.version, `%${escapeLike(query.q)}%`),
        )
      : undefined;
    const rows = await this.db
      .select({
        assetId: dataAssets.id,
        assetName: dataAssets.name,
        assetKind: dataAssets.kind,
        ownerUserId: dataAssets.ownerUserId,
        ownerOrgId: dataAssets.ownerOrgId,
        providerOrgId: dataAssets.providerOrgId,
        ownerKind: dataAssets.ownerKind,
        visibility: dataAssets.visibility,
        lifecycle: dataAssets.lifecycle,
        accessMode: dataAssets.accessMode,
        sensitivity: dataAssets.sensitivity,
        assetTags: dataAssets.metadata,
        versionId: dataAssetVersions.id,
        version: dataAssetVersions.version,
        manifestDigest: dataAssetVersions.manifestDigest,
        format: dataAssetVersions.format,
        schemaUri: dataAssetVersions.schemaUri,
        sizeBytes: dataAssetVersions.sizeBytes,
        immutableAt: dataAssetVersions.immutableAt,
        manifest: dataAssetVersions.manifest,
        createdAt: dataAssetVersions.createdAt,
      })
      .from(dataAssetVersions)
      .innerJoin(dataAssets, eq(dataAssetVersions.dataAssetId, dataAssets.id))
      .where(
        and(
          eq(dataAssetVersions.status, "ready"),
          isNotNull(dataAssetVersions.immutableAt),
          isNotNull(dataAssetVersions.manifestDigest),
          search,
        ),
      )
      .orderBy(desc(dataAssetVersions.createdAt), desc(dataAssetVersions.id));
    const access = new PgDataPrerequisiteRepository(this.db);
    const snapshots = new Map(rows.map((row) => [row.versionId, candidateSnapshot(row)]));
    const validator = new DataSelectionValidator({
      getVersion: async ({ assetId, versionId }) => {
        const snapshot = snapshots.get(versionId);
        return snapshot?.asset.id === assetId ? snapshot : null;
      },
    });
    const [accessibleVersionIds, availableVersionIds] = await Promise.all([
      access.verifyAccessBatch({
        actorUserId: actor.userId,
        orgId: actor.orgId,
        candidates: rows.map((row) => ({
          assetId: row.assetId,
          versionId: row.versionId,
          kind: row.assetKind,
          accessMode: row.accessMode,
          ownerUserId: row.ownerUserId,
          ownerOrgId: row.ownerOrgId,
          providerOrgId: row.providerOrgId,
          visibility: row.visibility,
          lifecycle: row.lifecycle,
        })),
      }),
      access.listAvailableVersionIds(rows.map((row) => row.versionId)),
    ]);
    const selectable = (
      await Promise.all(
        rows.map(async (row) => {
          const manifestDigest = row.manifestDigest;
          if (!manifestDigest) return null;
          if (!accessibleVersionIds.has(row.versionId)) return null;
          if (!availableVersionIds.has(row.versionId)) return null;
          try {
            await validator.validateDatasetOption({
              pkg,
              descriptor: query.descriptor,
              dataInput: {
                source: "data-market",
                assetId: row.assetId,
                versionId: row.versionId,
                manifestDigest,
                selectedEntries: [],
              },
            });
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 409) return null;
            throw error;
          }
          const tags = row.assetTags.tags;
          return {
            assetId: row.assetId,
            assetName: row.assetName,
            assetKind: row.assetKind,
            tags: Array.isArray(tags)
              ? tags.filter((tag): tag is string => typeof tag === "string")
              : [],
            versionId: row.versionId,
            version: row.version,
            manifestDigest,
            format: row.format,
            schemaUri: row.schemaUri,
            sizeBytes: row.sizeBytes,
            input: {
              source: "data-market" as const,
              assetId: row.assetId,
              versionId: row.versionId,
              manifestDigest,
              selectedEntries: [],
            },
          };
        }),
      )
    ).filter((option): option is NonNullable<typeof option> => option !== null);
    return {
      options: selectable.slice(query.offset, query.offset + query.limit),
      total: selectable.length,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async validate(
    usecasePackageId: string,
    actor: UsecaseExecutionRequester,
    input: { descriptor: string; dataset: Dataset },
  ): Promise<void> {
    await assertUsecasePackageExecutionAccess(this.db, usecasePackageId, actor);
    const [stored] = await this.db
      .select({ spec: usecasePackages.spec })
      .from(usecasePackages)
      .where(eq(usecasePackages.id, usecasePackageId))
      .limit(1);
    if (!stored) throw new AppError(ErrorCode.NOT_FOUND, "Usecase package not found", 404);
    const pkg = usecase.UsecasePackageSchema.parse(stored.spec);
    if (!("softwareRef" in pkg)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Dataset inputs require a governed usecase package",
        409,
      );
    }
    const typed = pkg.inputs.find((candidate) => candidate.descriptor === input.descriptor);
    if (!typed || typed.type !== "Dataset") {
      throw new AppError(ErrorCode.NOT_FOUND, "Dataset input descriptor not found", 404);
    }

    const access = new PgDataPrerequisiteRepository(this.db);
    const canUse = await access.verifyAccess({
      actorUserId: actor.userId,
      orgId: actor.orgId,
      assetId: input.dataset.assetId,
      versionId: input.dataset.versionId,
    });
    if (!canUse) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Not authorized to use the selected Data Market version",
        403,
      );
    }
    const available = await access.listAvailableVersionIds([input.dataset.versionId]);
    if (!available.has(input.dataset.versionId)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Selected Data Market version is unavailable",
        409,
      );
    }
    await createPgDataSelectionValidator(this.db).validateDatasetOption({
      pkg,
      descriptor: input.descriptor,
      dataInput: input.dataset,
    });
  }
}

function candidateSnapshot(row: {
  assetId: string;
  assetName: string;
  assetKind: string;
  ownerKind: string;
  accessMode: string;
  sensitivity: string;
  assetTags: Record<string, unknown>;
  versionId: string;
  version: string;
  immutableAt: Date | null;
  manifestDigest: string | null;
  format: string | null;
  schemaUri: string | null;
  sizeBytes: number | null;
  manifest: Record<string, unknown>;
}): SelectableDataAssetVersion {
  return {
    asset: {
      id: row.assetId,
      name: row.assetName,
      kind: DataAssetKindSchema.parse(row.assetKind),
      ownerKind: DataAssetOwnerKindSchema.parse(row.ownerKind),
      accessMode: DataAccessModeSchema.parse(row.accessMode),
      sensitivity: DataSensitivitySchema.parse(row.sensitivity),
      tags: metadataTags(row.assetTags),
      elements: dataAssetMetadataElements(row.assetTags),
    },
    version: {
      id: row.versionId,
      version: row.version,
      status: "ready",
      immutableAt: row.immutableAt,
      manifestDigest: row.manifestDigest,
      format: row.format,
      schemaUri: row.schemaUri,
      sizeBytes: row.sizeBytes,
      elements: dataAssetMetadataElements(row.manifest),
    },
    files: [],
  };
}

function metadataTags(metadata: Record<string, unknown>): string[] {
  const tags = metadata.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
