import { createHash, randomUUID } from "node:crypto";
import {
  agents,
  dataAssetFiles,
  dataAssetManifestEntries,
  dataAssetVersions,
  dataDeliveryRevocations,
  dataLocations,
  dataReplicas,
  jobDataBindings,
  jobs,
  type PgDb,
} from "@kuintessence/db";
import {
  AppError,
  DataAssetEntryPathSchema,
  ErrorCode,
  type SandboxSignedManifest,
} from "@kuintessence/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { MinioBackend } from "../storage/minio-client";
import { isReplicaEligible } from "./data-prerequisite-repository-drizzle";
import { factsRequireRestrictedNoEgress } from "./restricted-no-egress";
import type { SandboxManifestSigner } from "./sandbox-manifest-signer";

const DEFAULT_PRESIGN_TTL_SEC = 5 * 60;
const DEFAULT_LEASE_TTL_SEC = 60;
const DEFAULT_REPLICA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type DataDeliveryMethod = "object-download" | "stage-copy" | "readonly-mount";

export interface ResolvedDataDeliveryEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
  objectDownloadUrl?: string;
  objectKey?: string;
  objectVersionId?: string;
}

export interface ResolvedDataDelivery {
  bindingId: string;
  inputDescriptor: string;
  locationId: string;
  assetId: string;
  versionId: string;
  manifestDigest: string;
  selectedEntries: ResolvedDataDeliveryEntry[];
  stagePath: string;
  method: DataDeliveryMethod;
  managedRootId?: string;
  relativePath?: string;
  restricted: boolean;
  leaseId: string;
  leaseExpiresAtUnixMs: number;
}

interface BindingRow {
  id: string;
  inputDescriptor: string;
  assetId: string;
  versionId: string;
  manifestDigest: string;
  selectedEntries: string[];
  allowedLocationIds: string[];
  stagePath: string;
  sensitivity: string | null;
  assetKind: string | null;
  egressPolicy: "allow" | "deny";
}

interface LocationRow {
  id: string;
  versionId: string;
  kind: string;
  status: string;
  agentId: string | null;
  managedRootId: string | null;
  relativePath: string | null;
  uri: string | null;
  replicaStatus: string | null;
  replicaManifestDigest: string | null;
  replicaVerifiedAt: Date | null;
}

export interface DataDeliveryResolverOptions {
  presignTtlSec?: number;
  leaseTtlSec?: number;
  replicaMaxAgeMs?: number;
  now?: () => Date;
  verifyAccess: (input: {
    actorUserId: string;
    orgId: string | null;
    assetId: string;
    versionId: string;
  }) => Promise<boolean>;
}

/** Resolves a selected Agent's immutable bindings immediately before dispatch. */
export class DataDeliveryResolver {
  private readonly presignTtlSec: number;
  private readonly leaseTtlSec: number;
  private readonly replicaMaxAgeMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: PgDb,
    private readonly minio: Pick<
      MinioBackend,
      "dataMarketImmutableBucket" | "presignImmutableDownload"
    >,
    private readonly options: DataDeliveryResolverOptions,
  ) {
    this.presignTtlSec = options.presignTtlSec ?? DEFAULT_PRESIGN_TTL_SEC;
    this.leaseTtlSec = options.leaseTtlSec ?? DEFAULT_LEASE_TTL_SEC;
    this.replicaMaxAgeMs = options.replicaMaxAgeMs ?? DEFAULT_REPLICA_MAX_AGE_MS;
    this.now = options.now ?? (() => new Date());
  }

  async resolveForDispatch(input: {
    jobId: string;
    actorUserId: string;
    orgId: string | null;
    agentId: string;
  }): Promise<ResolvedDataDelivery[]> {
    const bindings = await this.loadBindings(input.jobId);
    const resolved: ResolvedDataDelivery[] = [];
    for (const binding of bindings) {
      const allowed = await this.options.verifyAccess({
        actorUserId: input.actorUserId,
        orgId: input.orgId,
        assetId: binding.assetId,
        versionId: binding.versionId,
      });
      if (!allowed) throw new AppError(ErrorCode.FORBIDDEN, "DATA_ACCESS_REVOKED", 403);
      const locations = await this.loadValidLocations(binding.versionId, binding.manifestDigest);
      const candidates = locations.filter((location) =>
        location.kind === "cp-local" ? location.agentId === input.agentId : true,
      );
      if (binding.allowedLocationIds.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_LOCATION_UNAVAILABLE", 409);
      }
      const permitted = candidates.filter((location) =>
        binding.allowedLocationIds.includes(location.id),
      );
      const restricted = factsRequireRestrictedNoEgress({
        assetKind: binding.assetKind as "licensed-material" | null,
        sensitivity: binding.sensitivity as "restricted" | "regulated" | null,
        egressPolicy: binding.egressPolicy,
      });
      const location = selectLocation(
        permitted,
        restricted,
        restricted ? await this.hasTrustedRestrictedProfile(input.agentId) : false,
      );
      if (!location) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_LOCATION_CONFLICT", 409);
      }
      const entries = await this.loadEntries(binding, location);
      if (entries.length === 0)
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_MANIFEST_EMPTY", 409);
      assertExactSelectedEntries(binding.selectedEntries, entries);
      if (location.kind === "cp-local") {
        if (!location.managedRootId || !location.relativePath) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_LOCATION_INVALID", 409);
        }
        resolved.push({
          bindingId: binding.id,
          inputDescriptor: binding.inputDescriptor,
          locationId: location.id,
          assetId: binding.assetId,
          versionId: binding.versionId,
          manifestDigest: binding.manifestDigest,
          selectedEntries: entries,
          stagePath: binding.stagePath,
          method: restricted ? "readonly-mount" : "stage-copy",
          managedRootId: location.managedRootId,
          relativePath: location.relativePath,
          restricted,
          ...this.createLease(),
        });
        continue;
      }
      const locationKey = objectKey(location.uri, this.minio.dataMarketImmutableBucket);
      assertImmutableObjectKey(locationKey);
      const fallbackKey = entries.length === 1 ? locationKey : null;
      resolved.push({
        bindingId: binding.id,
        inputDescriptor: binding.inputDescriptor,
        locationId: location.id,
        assetId: binding.assetId,
        versionId: binding.versionId,
        manifestDigest: binding.manifestDigest,
        selectedEntries: await Promise.all(
          entries.map(async (entry) => ({
            ...entry,
            objectDownloadUrl: await this.minio.presignImmutableDownload(
              immutableObjectKey(entry.objectKey ?? fallbackKey ?? missingObjectKey()),
              this.presignTtlSec,
              requiredObjectVersionId(entry.objectVersionId),
            ),
          })),
        ),
        stagePath: binding.stagePath,
        method: "object-download",
        restricted,
        ...this.createLease(),
      });
    }
    assertDistinctDeliveryTargets(resolved);
    return resolved;
  }

  private createLease(): { leaseId: string; leaseExpiresAtUnixMs: number } {
    return {
      leaseId: randomUUID(),
      leaseExpiresAtUnixMs: this.now().getTime() + this.leaseTtlSec * 1000,
    };
  }

  private async loadBindings(jobId: string): Promise<BindingRow[]> {
    const rows = await this.db
      .select({
        id: jobDataBindings.id,
        inputDescriptor: jobDataBindings.inputDescriptor,
        assetId: jobDataBindings.assetId,
        versionId: jobDataBindings.versionId,
        manifestDigest: jobDataBindings.manifestDigest,
        selectedEntries: jobDataBindings.selectedEntries,
        allowedLocationIds: jobDataBindings.allowedLocationIds,
        stagePath: jobDataBindings.stagePath,
        sensitivity: jobDataBindings.sensitivity,
        assetKind: jobDataBindings.assetKind,
        egressPolicy: jobDataBindings.egressPolicy,
      })
      .from(jobDataBindings)
      .where(and(eq(jobDataBindings.jobId, jobId), eq(jobDataBindings.source, "data-market")));
    return rows.map((row) => {
      if (!row.assetId || !row.versionId || !row.manifestDigest || !row.stagePath) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_BINDING_INVALID", 409);
      }
      return {
        ...row,
        assetId: row.assetId,
        versionId: row.versionId,
        manifestDigest: row.manifestDigest,
        selectedEntries: normalizeRequestedEntries(row.selectedEntries),
        stagePath: safeEntryPath(row.stagePath),
        assetKind: row.assetKind,
        egressPolicy: row.egressPolicy === "allow" ? "allow" : "deny",
      };
    });
  }

  private async hasTrustedRestrictedProfile(agentId: string): Promise<boolean> {
    const [agent] = await this.db
      .select({ restrictedDataIsolation: agents.restrictedDataIsolation })
      .from(agents)
      .where(eq(agents.agentId, agentId))
      .limit(1);
    return agent?.restrictedDataIsolation === true;
  }

  private async loadValidLocations(
    versionId: string,
    manifestDigest: string,
  ): Promise<LocationRow[]> {
    const rows = await this.db
      .select({
        id: dataLocations.id,
        versionId: dataLocations.dataAssetVersionId,
        kind: dataLocations.kind,
        status: dataLocations.status,
        agentId: dataLocations.agentId,
        managedRootId: dataLocations.managedRootId,
        relativePath: dataLocations.relativePath,
        uri: dataLocations.uri,
        versionManifestDigest: dataAssetVersions.manifestDigest,
        replicaStatus: dataReplicas.status,
        replicaManifestDigest: dataReplicas.manifestDigest,
        replicaVerifiedAt: dataReplicas.verifiedAt,
      })
      .from(dataLocations)
      .innerJoin(dataAssetVersions, eq(dataLocations.dataAssetVersionId, dataAssetVersions.id))
      .leftJoin(dataReplicas, eq(dataReplicas.targetLocationId, dataLocations.id))
      .where(
        and(eq(dataLocations.dataAssetVersionId, versionId), eq(dataLocations.status, "available")),
      );
    return rows.flatMap((row) => {
      if (row.versionManifestDigest !== manifestDigest) return [];
      const replica = row.replicaStatus !== null;
      if (
        replica &&
        !isReplicaEligible(
          {
            status: row.replicaStatus,
            manifestDigest: row.replicaManifestDigest,
            verifiedAt: row.replicaVerifiedAt,
          },
          manifestDigest,
          this.now(),
          this.replicaMaxAgeMs,
        )
      ) {
        return [];
      }
      return [{ ...row, versionId: row.versionId }];
    });
  }

  private async loadEntries(
    binding: BindingRow,
    location: LocationRow,
  ): Promise<ResolvedDataDeliveryEntry[]> {
    const rows = await this.db
      .select({
        path: dataAssetManifestEntries.entryPath,
        sha256: dataAssetManifestEntries.digest,
        sizeBytes: dataAssetManifestEntries.sizeBytes,
        locationId: dataAssetFiles.locationId,
        fileMetadata: dataAssetFiles.metadata,
      })
      .from(dataAssetManifestEntries)
      .leftJoin(dataAssetFiles, eq(dataAssetManifestEntries.dataAssetFileId, dataAssetFiles.id))
      .where(eq(dataAssetManifestEntries.dataAssetVersionId, binding.versionId));
    const paths = binding.selectedEntries.length > 0 ? new Set(binding.selectedEntries) : null;
    return rows.flatMap((row) => {
      if (paths && !paths.has(row.path)) return [];
      if (location.kind !== "cp-local" && row.locationId && row.locationId !== location.id)
        return [];
      const objectKey = objectKeyFromMetadata(row.fileMetadata ?? {});
      const objectVersionId = objectVersionIdFromMetadata(row.fileMetadata ?? {});
      if (location.kind !== "cp-local" && objectKey && !objectVersionId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_OBJECT_VERSION_MISSING", 409);
      }
      return [
        {
          path: safeEntryPath(row.path),
          sha256: normalizeDigest(row.sha256),
          sizeBytes: row.sizeBytes,
          objectKey,
          objectVersionId,
        },
      ];
    });
  }
}

export interface RestrictedSandboxDeliveryBinding {
  manifest: SandboxSignedManifest;
  inputStaging: Array<{
    fileMetadataId: string;
    stagePath: string;
    sourceUrl: string;
    deliveryLeaseId: string;
    deliveryLeaseExpiresAtUnixMs: number;
  }>;
}

/** Binds restricted object entries into the signed Sandbox input contract. */
export class RestrictedSandboxDeliveryBinder {
  constructor(private readonly signer: Pick<SandboxManifestSigner, "sign">) {}

  bind(
    manifest: SandboxSignedManifest,
    deliveries: readonly ResolvedDataDelivery[],
  ): RestrictedSandboxDeliveryBinding {
    if (deliveries.length === 0) return { manifest, inputStaging: [] };
    if (deliveries.some((delivery) => delivery.method !== "object-download")) {
      throw new Error("Restricted Sandbox delivery requires immutable object entries");
    }
    const existing = new Set(manifest.mounts.map((mount) => mount.descriptor));
    const mounts = deliveries.map((delivery) => {
      const descriptor = sandboxDescriptor(delivery);
      if (existing.has(descriptor)) {
        throw new Error("Restricted Sandbox delivery conflicts with a signed input descriptor");
      }
      existing.add(descriptor);
      const batchEntries = delivery.selectedEntries.map((entry) => ({
        relativePath: entry.path,
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
      }));
      return {
        descriptor,
        ioType: "FileBatch" as const,
        mode: "ReadOnly" as const,
        relativePath: `inputs/${descriptor}`,
        containerPath: `/kq/inputs/${descriptor}`,
        expectedSha256: batchDigest(batchEntries),
        inlineContentBase64: null,
        batchEntries,
        sizeLimitBytes: Math.max(
          1,
          batchEntries.reduce((total, entry) => total + entry.sizeBytes, 0),
        ),
        required: true,
      };
    });
    const signed = this.signer.sign({
      jobId: manifest.jobId,
      script: manifest.script,
      runtime: manifest.runtime,
      executionMode: manifest.executionMode,
      ...(manifest.runtimeAttestationId
        ? { runtimeAttestationId: manifest.runtimeAttestationId }
        : {}),
      ...(manifest.executionProfile ? { executionProfile: manifest.executionProfile } : {}),
      identity: manifest.identity,
      mounts: [...manifest.mounts, ...mounts],
      limits: manifest.limits,
      networkDisabled: manifest.networkDisabled,
    });
    return {
      manifest: signed,
      inputStaging: deliveries.flatMap((delivery, deliveryIndex) =>
        delivery.selectedEntries.map((entry, entryIndex) => ({
          fileMetadataId: `data-delivery-${delivery.bindingId}-${entryIndex}`,
          stagePath: `inputs/${mounts[deliveryIndex]?.descriptor ?? ""}/${entry.path}`,
          sourceUrl: requireObjectDownloadUrl(entry.objectDownloadUrl),
          deliveryLeaseId: delivery.leaseId,
          deliveryLeaseExpiresAtUnixMs: delivery.leaseExpiresAtUnixMs,
        })),
      ),
    };
  }
}

function sandboxDescriptor(delivery: ResolvedDataDelivery): string {
  if (
    delivery.inputDescriptor === "." ||
    delivery.inputDescriptor === ".." ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(delivery.inputDescriptor)
  ) {
    throw new Error("Restricted Sandbox delivery input descriptor is invalid");
  }
  return delivery.inputDescriptor;
}

function batchDigest(
  entries: Array<{ relativePath: string; sha256: string; sizeBytes: number }>,
): string {
  const hash = createHash("sha256");
  for (const entry of entries.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(`${entry.relativePath}\0${entry.sizeBytes}\0${entry.sha256}\n`);
  }
  return hash.digest("hex");
}

function requireObjectDownloadUrl(value: string | undefined): string {
  if (!value) throw new Error("Restricted Sandbox object entry lacks a transient download URL");
  return value;
}

export async function revokeDataDeliveryJobs(input: {
  db: PgDb;
  dispatcher: Pick<AgentDispatcher, "pushDataDeliveryRevoke">;
  assetId: string;
  versionId?: string | null;
  reasonCode: string;
}): Promise<number> {
  const bindings = await input.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        jobId: jobs.id,
        agentId: jobs.agentId,
        restrictedNoEgress: jobs.restrictedNoEgress,
        dispatchEpoch: jobs.dispatchEpoch,
        revokedEpoch: jobs.revokedEpoch,
      })
      .from(jobDataBindings)
      .innerJoin(jobs, eq(jobDataBindings.jobId, jobs.id))
      .where(
        and(
          eq(jobDataBindings.source, "data-market"),
          eq(jobDataBindings.assetId, input.assetId),
          input.versionId ? eq(jobDataBindings.versionId, input.versionId) : undefined,
          inArray(jobs.status, ["pending", "queued", "running"]),
        ),
      )
      .for("update");
    if (rows.length === 0) return rows;
    const now = new Date();
    await tx
      .update(jobs)
      .set({
        status: "cancelled",
        completedAt: now,
        errorMessage: `DATA_DELIVERY_REVOKED:${input.reasonCode}`,
        revokedEpoch: sql`greatest(${jobs.revokedEpoch}, ${jobs.dispatchEpoch} + 1)`,
      })
      .where(
        inArray(
          jobs.id,
          rows.map((row) => row.jobId),
        ),
      );
    const remote = rows.filter((row) => row.agentId !== null);
    if (remote.length > 0) {
      await tx
        .insert(dataDeliveryRevocations)
        .values(
          remote.map((row) => ({
            jobId: row.jobId,
            agentId: row.agentId ?? "",
            reasonCode: input.reasonCode,
            destroyRestrictedWorkRoot: row.restrictedNoEgress,
            revokedEpoch: Math.max(row.revokedEpoch, row.dispatchEpoch + 1),
          })),
        )
        .onConflictDoNothing();
    }
    return rows;
  });
  for (const binding of bindings) {
    if (!binding.agentId) continue;
    input.dispatcher.pushDataDeliveryRevoke(
      binding.agentId,
      binding.jobId,
      input.reasonCode,
      binding.restrictedNoEgress,
      Math.max(binding.revokedEpoch, binding.dispatchEpoch + 1),
    );
  }
  return bindings.length;
}

export function selectLocation(
  locations: LocationRow[],
  restricted: boolean,
  trustedRestrictedProfile = false,
): LocationRow | undefined {
  if (restricted) {
    return (
      locations.find((location) => location.kind === "cp-local") ??
      (trustedRestrictedProfile
        ? locations.find((location) => location.kind !== "cp-local")
        : undefined)
    );
  }
  return locations[0];
}

function objectKey(uri: string | null, bucket: string): string {
  if (!uri?.startsWith(`s3://${bucket}/`)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_OBJECT_LOCATION_INVALID", 409);
  }
  const key = uri.slice(`s3://${bucket}/`.length);
  const parsed = DataAssetEntryPathSchema.safeParse(key);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_OBJECT_LOCATION_INVALID", 409);
  }
  return parsed.data;
}

function immutableObjectKey(key: string): string {
  assertImmutableObjectKey(key);
  return key;
}

function assertImmutableObjectKey(key: string): void {
  if (!key.startsWith("data-market/immutable/")) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_OBJECT_LOCATION_INVALID", 409);
  }
}

function safeEntryPath(path: string): string {
  const parsed = DataAssetEntryPathSchema.safeParse(path);
  if (!parsed.success)
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_MANIFEST_PATH_INVALID", 409);
  return parsed.data;
}

function normalizeDigest(digest: string): string {
  const normalized = digest.startsWith("sha256:") ? digest.slice(7) : digest;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_MANIFEST_DIGEST_INVALID", 409);
  }
  return normalized.toLowerCase();
}

function objectKeyFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const key = metadata.objectKey;
  if (typeof key !== "string") return undefined;
  return DataAssetEntryPathSchema.safeParse(key).data;
}

function objectVersionIdFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const versionId = metadata.objectVersionId;
  if (versionId === null || versionId === undefined) return undefined;
  if (typeof versionId !== "string" || versionId.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_OBJECT_VERSION_INVALID", 409);
  }
  return versionId;
}

function missingObjectKey(): never {
  throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_OBJECT_KEY_MISSING", 409);
}

function requiredObjectVersionId(value: string | undefined): string {
  if (!value) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_OBJECT_VERSION_MISSING", 409);
  }
  return value;
}

export function assertExactSelectedEntries(
  requestedEntries: readonly string[],
  returnedEntries: readonly Pick<ResolvedDataDeliveryEntry, "path">[],
): void {
  const requested = normalizeRequestedEntries(requestedEntries);
  const returned = returnedEntries.map((entry) => safeEntryPath(entry.path));
  const returnedSet = new Set(returned);
  if (returnedSet.size !== returned.length) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_DELIVERY_RETURNED_PATH_DUPLICATE", 409);
  }
  if (requested.length === 0) return;
  const requestedSet = new Set(requested);
  if (
    requestedSet.size !== returnedSet.size ||
    [...requestedSet].some((path) => !returnedSet.has(path))
  ) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_DELIVERY_PATH_SET_MISMATCH", 409);
  }
}

export function assertDistinctDeliveryTargets(deliveries: readonly ResolvedDataDelivery[]): void {
  const targets = deliveries.flatMap((delivery) =>
    delivery.selectedEntries.map((entry) => ({
      bindingId: delivery.bindingId,
      path: deliveryTargetPath(delivery.stagePath, entry.path),
    })),
  );
  const ordered = [...targets].sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    if (current.path === previous.path || current.path.startsWith(`${previous.path}/`)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_DELIVERY_TARGET_CONFLICT", 409, {
        firstBindingId: previous.bindingId,
        secondBindingId: current.bindingId,
        firstPath: previous.path,
        secondPath: current.path,
      });
    }
  }
}

function normalizeRequestedEntries(entries: readonly string[]): string[] {
  const normalized = entries.map(safeEntryPath);
  if (new Set(normalized).size !== normalized.length) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_DELIVERY_REQUESTED_PATH_DUPLICATE", 409);
  }
  return normalized;
}

function deliveryTargetPath(stagePath: string, entryPath: string): string {
  return safeEntryPath(`${safeEntryPath(stagePath)}/${safeEntryPath(entryPath)}`);
}
