import {
  agents,
  dataAssetFiles,
  dataAssetImports,
  dataAssetManifestEntries,
  dataAssetVersions,
  dataLocations,
  dataScanRequests,
  type PgDb,
} from "@kuintessence/db";
import { AppError, DataAssetEntryPathSchema, ErrorCode } from "@kuintessence/shared";
import { and, eq, sql } from "drizzle-orm";
import type {
  DataImportCoordinator,
  DataImportScanAttestation,
  DataImportScanRequest,
  PersistedDataScanRequest,
} from "./data-import-coordinator";

type DataScanRequestRow = typeof dataScanRequests.$inferSelect;

export class PgDataImportCoordinator implements DataImportCoordinator {
  constructor(private readonly db: PgDb) {}

  async requestCpLocalScan(
    input: DataImportScanRequest & { requestId: string; deadlineAt: Date },
  ): Promise<{ request: PersistedDataScanRequest; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(dataScanRequests)
        .where(eq(dataScanRequests.requestId, input.requestId))
        .limit(1);
      if (existing) {
        assertStoredRequestMatches(existing, input);
        return { request: toPersistedRequest(existing), created: false };
      }
      const [dataImport] = await tx
        .select()
        .from(dataAssetImports)
        .where(eq(dataAssetImports.id, input.importId))
        .for("update")
        .limit(1);
      if (
        !dataImport ||
        dataImport.sourceKind !== "cp-local" ||
        dataImport.targetAssetId !== input.assetId ||
        dataImport.sourceManagedRootId !== input.managedRootId ||
        dataImport.sourceRelativePath !== input.relativePath
      ) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "CP-local import binding is invalid", 400);
      }
      const [existingForImport] = await tx
        .select()
        .from(dataScanRequests)
        .where(eq(dataScanRequests.importId, input.importId))
        .limit(1);
      if (existingForImport) {
        assertStoredRequestMatches(existingForImport, input);
        return { request: toPersistedRequest(existingForImport), created: false };
      }
      const [version] = await tx
        .select({ id: dataAssetVersions.id })
        .from(dataAssetVersions)
        .where(
          and(
            eq(dataAssetVersions.id, input.versionId),
            eq(dataAssetVersions.dataAssetId, input.assetId),
            eq(dataAssetVersions.version, dataImport.targetVersion),
          ),
        )
        .limit(1);
      if (!version) {
        throw new AppError(ErrorCode.NOT_FOUND, "Target data version not found", 404);
      }
      const [agent] = await tx
        .select({ providerOrgId: agents.providerOrgId })
        .from(agents)
        .where(eq(agents.agentId, input.agentId))
        .limit(1);
      if (!agent || agent.providerOrgId !== input.providerOrgId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Data scan Agent binding is invalid", 400);
      }
      const [created] = await tx
        .insert(dataScanRequests)
        .values({
          requestId: input.requestId,
          importId: input.importId,
          assetId: input.assetId,
          versionId: input.versionId,
          agentId: input.agentId,
          providerOrgId: input.providerOrgId,
          managedRootId: input.managedRootId,
          relativePath: input.relativePath,
          deadlineAt: input.deadlineAt,
        })
        .returning();
      if (!created) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data scan request insert failed", 500);
      }
      return { request: toPersistedRequest(created), created: true };
    });
  }

  async listPendingCpLocalScans(): Promise<PersistedDataScanRequest[]> {
    const rows = await this.db
      .select()
      .from(dataScanRequests)
      .where(eq(dataScanRequests.status, "pending"));
    return rows.map(toPersistedRequest);
  }

  async getCpLocalScan(requestId: string): Promise<PersistedDataScanRequest | null> {
    const [row] = await this.db
      .select()
      .from(dataScanRequests)
      .where(eq(dataScanRequests.requestId, requestId))
      .limit(1);
    return row ? toPersistedRequest(row) : null;
  }

  async markCpLocalScanAttempt(requestId: string, dispatched: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [scan] = await tx
        .update(dataScanRequests)
        .set({
          attempt: sql`${dataScanRequests.attempt} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(dataScanRequests.requestId, requestId), eq(dataScanRequests.status, "pending")),
        )
        .returning({ importId: dataScanRequests.importId });
      if (scan && dispatched) {
        await tx
          .update(dataAssetImports)
          .set({ status: "running", errorMessage: null })
          .where(eq(dataAssetImports.id, scan.importId));
      }
    });
  }

  async acceptCpLocalScanAttestation(input: DataImportScanAttestation): Promise<void> {
    for (const entry of input.entries) {
      if (!DataAssetEntryPathSchema.safeParse(entry.path).success) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "CP-local scan manifest contains an invalid entry path",
          400,
          { blocker: "DATA_MANIFEST_PATH_INVALID", path: entry.path },
        );
      }
    }
    await this.db.transaction(async (tx) => {
      const [scan] = await tx
        .select()
        .from(dataScanRequests)
        .where(eq(dataScanRequests.requestId, input.requestId))
        .for("update")
        .limit(1);
      if (!scan) {
        throw new AppError(ErrorCode.NOT_FOUND, "Data scan request not found", 404);
      }
      if (scan.status === "completed") return;
      if (scan.status !== "pending") {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Data scan request is no longer pending",
          409,
        );
      }
      if (
        scan.importId !== input.importId ||
        scan.agentId !== input.agentId ||
        scan.providerOrgId !== input.providerOrgId ||
        scan.managedRootId !== input.managedRootId ||
        scan.relativePath !== input.relativePath
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Data scan attestation binding is invalid",
          400,
        );
      }
      const [dataImport] = await tx
        .select()
        .from(dataAssetImports)
        .where(eq(dataAssetImports.id, scan.importId))
        .limit(1);
      if (
        !dataImport ||
        dataImport.sourceKind !== "cp-local" ||
        dataImport.targetAssetId !== scan.assetId ||
        dataImport.sourceManagedRootId !== scan.managedRootId ||
        dataImport.sourceRelativePath !== scan.relativePath
      ) {
        throw new AppError(ErrorCode.NOT_FOUND, "CP-local data import session not found", 404);
      }
      const [agent] = await tx
        .select()
        .from(agents)
        .where(eq(agents.agentId, input.agentId))
        .limit(1);
      if (!agent || agent.providerOrgId !== input.providerOrgId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Attesting Agent binding is invalid", 400);
      }
      const [version] = await tx
        .select()
        .from(dataAssetVersions)
        .where(
          and(
            eq(dataAssetVersions.id, scan.versionId),
            eq(dataAssetVersions.dataAssetId, scan.assetId),
            eq(dataAssetVersions.version, dataImport.targetVersion),
          ),
        )
        .limit(1);
      if (!version) {
        throw new AppError(ErrorCode.NOT_FOUND, "Target data version not found", 404);
      }
      if (input.entries.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Empty scan attestation", 400);
      }
      const [location] = await tx
        .insert(dataLocations)
        .values({
          dataAssetVersionId: version.id,
          providerOrgId: input.providerOrgId,
          siteId: agent.siteName,
          agentId: agent.agentId,
          managedRootId: input.managedRootId,
          relativePath: input.relativePath,
          kind: "cp-local",
          uri: null,
          status: "available",
        })
        .returning();
      if (!location) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data location insert failed", 500);
      }
      const files = await tx
        .insert(dataAssetFiles)
        .values(
          input.entries.map((entry) => ({
            dataAssetVersionId: version.id,
            locationId: location.id,
            path: entry.path,
            digest: entry.digest,
            sizeBytes: entry.sizeBytes,
            mediaType: entry.mediaType ?? null,
          })),
        )
        .returning();
      await tx.insert(dataAssetManifestEntries).values(
        input.entries.map((entry, index) => ({
          dataAssetVersionId: version.id,
          dataAssetFileId: files[index]?.id ?? null,
          entryPath: entry.path,
          digest: entry.digest,
          sizeBytes: entry.sizeBytes,
          mediaType: entry.mediaType ?? null,
        })),
      );
      await tx
        .update(dataAssetVersions)
        .set({
          status: "ready",
          manifestDigest: input.manifestDigest,
          contentHash: input.contentHash,
          sizeBytes: input.sizeBytes,
          format: input.format,
          immutableAt: input.scannedAt,
          manifest: {
            attestedBy: input.agentId,
            scannedAt: input.scannedAt.toISOString(),
            scanRequestId: input.requestId,
          },
        })
        .where(eq(dataAssetVersions.id, version.id));
      await tx
        .update(dataAssetImports)
        .set({ status: "completed", completedAt: input.scannedAt })
        .where(eq(dataAssetImports.id, dataImport.id));
      await tx
        .update(dataScanRequests)
        .set({
          status: "completed",
          attestationPayload: input.attestationPayload,
          attestationSignature: input.attestationSignature,
          errorMessage: null,
          completedAt: input.scannedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dataScanRequests.requestId, input.requestId),
            eq(dataScanRequests.status, "pending"),
          ),
        );
    });
  }

  async failCpLocalScan(input: {
    requestId: string;
    importId: string;
    error: string;
    completedAt: Date;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [scan] = await tx
        .update(dataScanRequests)
        .set({
          status: "failed",
          errorMessage: input.error,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        })
        .where(
          and(
            eq(dataScanRequests.requestId, input.requestId),
            eq(dataScanRequests.importId, input.importId),
            eq(dataScanRequests.status, "pending"),
          ),
        )
        .returning({ requestId: dataScanRequests.requestId });
      if (!scan) return;
      await tx
        .update(dataAssetImports)
        .set({ status: "failed", errorMessage: input.error, completedAt: input.completedAt })
        .where(eq(dataAssetImports.id, input.importId));
    });
  }
}

function toPersistedRequest(row: DataScanRequestRow): PersistedDataScanRequest {
  if (row.status !== "pending" && row.status !== "completed" && row.status !== "failed") {
    throw new Error(`Unsupported data scan request status: ${row.status}`);
  }
  return {
    requestId: row.requestId,
    importId: row.importId,
    assetId: row.assetId,
    versionId: row.versionId,
    agentId: row.agentId,
    providerOrgId: row.providerOrgId,
    managedRootId: row.managedRootId,
    relativePath: row.relativePath,
    deadlineAt: row.deadlineAt,
    attempt: row.attempt,
    status: row.status,
  };
}

function assertStoredRequestMatches(
  row: DataScanRequestRow,
  input: DataImportScanRequest & { requestId: string },
): void {
  if (
    row.requestId !== input.requestId ||
    row.importId !== input.importId ||
    row.assetId !== input.assetId ||
    row.versionId !== input.versionId ||
    row.agentId !== input.agentId ||
    row.providerOrgId !== input.providerOrgId ||
    row.managedRootId !== input.managedRootId ||
    row.relativePath !== input.relativePath
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Data scan requestId cannot be reused for another import",
      409,
    );
  }
}
