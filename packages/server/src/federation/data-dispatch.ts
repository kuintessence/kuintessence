import { randomUUID } from "node:crypto";
import { clone, equals } from "@bufbuild/protobuf";
import {
  dataAccessPolicies,
  dataAssetFiles,
  dataAssetManifestEntries,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  dataLocations,
  dataReplicas,
  jobDataBindings,
  jobs,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  type DataDeliveryBinding,
  DataDeliveryBindingSchema,
  type DispatchJob,
  SandboxIoType,
  SandboxMountMode,
  type ServerMessage,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { DataDeliveryPolicySchema, WorkflowExecutionInterrupted } from "@kuintessence/shared";
import { and, eq, inArray } from "drizzle-orm";
import { dataDeliveryToProto } from "../grpc/dispatcher";
import {
  DataDeliveryResolver,
  type ResolvedDataDelivery,
  sandboxDataInputSource,
} from "../services/data-delivery";
import { PgDataPrerequisiteRepository } from "../services/data-prerequisite-repository-drizzle";
import { factsRequireRestrictedNoEgress } from "../services/restricted-no-egress";
import { datasetSourceAuthority, isFederationDataset } from "./dataset-authority";
import { assertNetdriveSnapshots } from "./netdrive-inputs";

export interface PreparedFederationDataDispatch {
  message: ServerMessage;
  authorize: (tx: PgTransaction) => Promise<void>;
}

/** Renew transport credentials without changing the committed data or execution intent. */
export class FederationDataDispatch {
  constructor(
    private readonly db: PgDb,
    private readonly minio: ConstructorParameters<typeof DataDeliveryResolver>[1] = {
      get dataMarketImmutableBucket(): string {
        throw new WorkflowExecutionInterrupted("Immutable object storage is unavailable");
      },
      presignImmutableDownload: async () => {
        throw new WorkflowExecutionInterrupted("Immutable object storage is unavailable");
      },
    },
    private readonly renewNetdriveUrl?: (
      storageKey: string,
      versionId?: string,
    ) => Promise<{ sourceUrl: string; expiresAt: number }>,
  ) {}

  async prepare(agentId: string, message: ServerMessage): Promise<PreparedFederationDataDispatch> {
    if (message.payload.case !== "dispatchJob") throw new Error("Expected a dispatch");
    const dispatch = message.payload.value;
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, dispatch.jobId));
    if (!job?.submittedBy || job.agentId !== agentId) rejectDataDispatch();
    const input = {
      jobId: dispatch.jobId,
      actorUserId: job.submittedBy,
      orgId: job.orgId,
      agentId,
    };
    const locations =
      dispatch.dataDeliveries.length > 0
        ? new Map(
            dispatch.dataDeliveries.map((delivery) => [delivery.bindingId, delivery.locationId]),
          )
        : undefined;
    const bindings = await this.bindings(this.db, input.jobId);
    const pinnedLocations = new Map(locations);
    for (const binding of bindings) {
      const inputs = dispatch.inputStaging.filter(
        (item) =>
          item.fileMetadataId.startsWith(`data-delivery-${binding.id}-`) && item.localDataSource,
      );
      for (const item of inputs) {
        const id = item.localDataSource?.locationId;
        if (!id || (pinnedLocations.has(binding.id) && pinnedLocations.get(binding.id) !== id))
          rejectDataDispatch();
        pinnedLocations.set(binding.id, id);
      }
    }
    const deliveries = await this.resolver(this.db).resolveForDispatch(input, {
      locations: pinnedLocations,
    });
    const refreshed = refreshDataCredentials(message, deliveries);
    if (refreshed.payload.case !== "dispatchJob") throw new Error("Expected dispatch");
    const netdrive = refreshed.payload.value.inputStaging.filter((input) => input.netdriveInput);
    const files = await assertNetdriveSnapshots(this.db, netdrive, input.actorUserId);
    for (const staged of netdrive) {
      const file = files.find((file) => file.id === staged.fileMetadataId);
      if (!file || !this.renewNetdriveUrl)
        throw new WorkflowExecutionInterrupted("NetDrive URL renewal is unavailable");
      const next = await this.renewNetdriveUrl(file.storageKey, file.storageVersionId ?? undefined);
      if (!Number.isSafeInteger(next.expiresAt) || next.expiresAt <= Date.now())
        throw new WorkflowExecutionInterrupted("NetDrive URL renewal has expired");
      staged.sourceUrl = next.sourceUrl;
      staged.deliveryLeaseId = randomUUID();
      staged.deliveryLeaseExpiresAtUnixMs = BigInt(next.expiresAt);
    }
    return {
      message: refreshed,
      authorize: async (tx) => {
        const [currentJob] = await tx
          .select()
          .from(jobs)
          .where(eq(jobs.id, input.jobId))
          .for("update");
        if (
          !currentJob ||
          currentJob.submittedBy !== input.actorUserId ||
          currentJob.orgId !== input.orgId ||
          currentJob.agentId !== agentId ||
          currentJob.status !== "queued" ||
          BigInt(currentJob.dispatchEpoch) !== dispatch.dispatchEpoch ||
          currentJob.revokedEpoch >= currentJob.dispatchEpoch
        )
          rejectDataDispatch();
        const currentFiles = await assertNetdriveSnapshots(tx, netdrive, input.actorUserId, true);
        if (
          currentFiles.some((file) => {
            const original = files.find((original) => original.id === file.id);
            return (
              original?.storageKey !== file.storageKey ||
              original.storageVersionId !== file.storageVersionId
            );
          })
        )
          throw new WorkflowExecutionInterrupted("NetDrive object moved during URL renewal");
        const currentBindings = await this.bindings(tx, input.jobId, true);
        if (JSON.stringify(currentBindings) !== JSON.stringify(bindings)) rejectDataDispatch();
        if (deliveries.length === 0) {
          assertFreshDataCredentials(refreshed);
          return;
        }
        const assetIds = [...new Set(deliveries.map((delivery) => delivery.assetId))].sort();
        const versionIds = [...new Set(deliveries.map((delivery) => delivery.versionId))].sort();
        const locationIds = [...new Set(deliveries.map((delivery) => delivery.locationId))].sort();
        // Parent UPDATE locks also fence new FK-backed grants/policies/manifest entries.
        // NOWAIT avoids inversion with grant revocation, which locks grants before Jobs.
        const assets = await tx
          .select()
          .from(dataAssets)
          .where(inArray(dataAssets.id, assetIds))
          .orderBy(dataAssets.id)
          .for("update", { noWait: true });
        const versions = await tx
          .select()
          .from(dataAssetVersions)
          .where(inArray(dataAssetVersions.id, versionIds))
          .orderBy(dataAssetVersions.id)
          .for("update", { noWait: true });
        await tx
          .select()
          .from(dataLocations)
          .where(inArray(dataLocations.id, locationIds))
          .orderBy(dataLocations.id)
          .for("update", { noWait: true });
        await tx
          .select()
          .from(dataGrants)
          .where(inArray(dataGrants.dataAssetId, assetIds))
          .orderBy(dataGrants.id)
          .for("update", { noWait: true });
        await tx
          .select()
          .from(dataAccessPolicies)
          .where(inArray(dataAccessPolicies.dataAssetId, assetIds))
          .orderBy(dataAccessPolicies.id)
          .for("update", { noWait: true });
        await tx
          .select()
          .from(dataReplicas)
          .where(inArray(dataReplicas.targetLocationId, locationIds))
          .orderBy(dataReplicas.id)
          .for("share", { noWait: true });
        await tx
          .select()
          .from(dataAssetFiles)
          .where(inArray(dataAssetFiles.dataAssetVersionId, versionIds))
          .orderBy(dataAssetFiles.id)
          .for("share", { noWait: true });
        await tx
          .select()
          .from(dataAssetManifestEntries)
          .where(inArray(dataAssetManifestEntries.dataAssetVersionId, versionIds))
          .orderBy(dataAssetManifestEntries.id)
          .for("share", { noWait: true });
        const repository = new PgDataPrerequisiteRepository(tx);
        for (const binding of currentBindings) {
          const asset = assets.find((row) => row.id === binding.assetId);
          const version = versions.find((row) => row.id === binding.versionId);
          if (
            !asset ||
            !version ||
            asset.lifecycle === "revoked" ||
            asset.kind !== binding.assetKind ||
            asset.sensitivity !== binding.sensitivity
          )
            rejectDataDispatch();
          const policy = DataDeliveryPolicySchema.parse(version.manifest.deliveryPolicy ?? {});
          if (
            JSON.stringify(policy) !==
            JSON.stringify(DataDeliveryPolicySchema.parse(binding.deliveryPolicy))
          )
            rejectDataDispatch();
        }
        for (const delivery of deliveries) {
          const version = await repository.resolveVersion(delivery);
          if (!version?.available || version.manifestDigest !== delivery.manifestDigest)
            rejectDataDispatch();
        }
        // This resolver performs only local reads and authorization; it never signs URLs under locks.
        const current = await this.resolver(tx).resolveForDispatch(input, {
          locations: pinnedLocations,
          issueCredentials: false,
        });
        if (!sameResolvedData(deliveries, current)) rejectDataDispatch();
        assertFreshDataCredentials(refreshed);
      },
    };
  }

  private resolver(db: PgDb | PgTransaction) {
    const repository = new PgDataPrerequisiteRepository(db);
    return new DataDeliveryResolver(db, this.minio, {
      verifyAccess: (input) => repository.verifyAccess(input),
    });
  }

  private async bindings(db: PgDb | PgTransaction, jobId: string, lock = false) {
    const query = db
      .select()
      .from(jobDataBindings)
      .where(and(eq(jobDataBindings.jobId, jobId), eq(jobDataBindings.source, "data-market")))
      .orderBy(jobDataBindings.id);
    return lock ? query.for("update", { noWait: true }) : query;
  }
}

export function refreshDataCredentials(
  message: ServerMessage,
  deliveries: readonly ResolvedDataDelivery[],
): ServerMessage {
  const refreshed = clone(ServerMessageSchema, message);
  if (refreshed.payload.case !== "dispatchJob") throw new Error("Expected a dispatch");
  const dispatch = refreshed.payload.value;
  const remaining = new Map(deliveries.map((delivery) => [delivery.bindingId, delivery]));
  if (remaining.size !== deliveries.length) rejectDataDispatch();
  dispatch.dataDeliveries = dispatch.dataDeliveries.map((original) => {
    const delivery = remaining.get(original.bindingId);
    if (!delivery) rejectDataDispatch();
    remaining.delete(original.bindingId);
    const next = dataDeliveryToProto(delivery);
    if (!equals(DataDeliveryBindingSchema, dataIntent(original), dataIntent(next)))
      rejectDataDispatch();
    const entries = new Map(next.selectedEntries.map((entry) => [entry.path, entry]));
    next.selectedEntries = original.selectedEntries.map((entry) => {
      const refreshedEntry = entries.get(entry.path);
      if (!refreshedEntry) rejectDataDispatch();
      return refreshedEntry;
    });
    return next;
  });
  const staged = new Set<number>();
  for (const delivery of remaining.values()) {
    const mount = dispatch.sandboxExecution?.artifactMounts.find(
      (item) => item.descriptor === delivery.inputDescriptor,
    );
    if (
      !mount ||
      !dispatch.restrictedNoEgress ||
      !dispatch.sandboxExecution?.networkDisabled ||
      mount.mode !== SandboxMountMode.READ_ONLY ||
      mount.ioType !== SandboxIoType.FILE_BATCH ||
      !["object-download", "readonly-mount"].includes(delivery.method) ||
      mount.relativePath !== `inputs/${delivery.inputDescriptor}` ||
      mount.containerPath !== `/kq/inputs/${delivery.inputDescriptor}` ||
      mount.batchEntries.length !== delivery.selectedEntries.length
    )
      rejectDataDispatch();
    for (const entry of delivery.selectedEntries) {
      if (
        !mount.batchEntries.some(
          (item) =>
            item.relativePath === entry.path &&
            item.sha256 === entry.sha256 &&
            item.sizeBytes === BigInt(entry.sizeBytes),
        )
      )
        rejectDataDispatch();
      const index = dispatch.inputStaging.findIndex(
        (item) =>
          item.stagePath === `${mount.relativePath}/${entry.path}` &&
          item.fileMetadataId.startsWith(`data-delivery-${delivery.bindingId}-`) &&
          item.deliveryLeaseId,
      );
      const input = dispatch.inputStaging[index];
      if (!input || staged.has(index)) rejectDataDispatch();
      const source = sandboxDataInputSource(delivery, entry);
      if (
        input.localDataSource?.locationId !== source.localDataSource?.locationId ||
        input.localDataSource?.managedRootId !== source.localDataSource?.managedRootId ||
        input.localDataSource?.relativePath !== source.localDataSource?.relativePath ||
        (source.localDataSource && input.sourceUrl)
      )
        rejectDataDispatch();
      staged.add(index);
      input.sourceUrl = source.sourceUrl;
      input.deliveryLeaseId = delivery.leaseId;
      input.deliveryLeaseExpiresAtUnixMs = BigInt(delivery.leaseExpiresAtUnixMs);
    }
  }
  if (
    dispatch.inputStaging.some(
      (input, index) =>
        !input.netdriveInput &&
        (input.deliveryLeaseId || input.deliveryLeaseExpiresAtUnixMs !== 0n) &&
        !staged.has(index),
    )
  )
    rejectDataDispatch();
  assertFreshDataCredentials(refreshed, true);
  return refreshed;
}

function dataIntent(delivery: DataDeliveryBinding): DataDeliveryBinding {
  return {
    ...delivery,
    leaseId: "",
    leaseExpiresAtUnixMs: 0n,
    selectedEntries: delivery.selectedEntries
      .map((entry) => ({ ...entry, objectDownloadUrl: "" }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function sameResolvedData(
  left: readonly ResolvedDataDelivery[],
  right: readonly ResolvedDataDelivery[],
): boolean {
  const stable = (items: readonly ResolvedDataDelivery[]) =>
    items
      .map(({ leaseId: _id, leaseExpiresAtUnixMs: _expiry, selectedEntries, ...item }) => ({
        ...item,
        selectedEntries: selectedEntries
          .map(({ objectDownloadUrl: _url, ...entry }) => entry)
          .sort((a, b) => a.path.localeCompare(b.path)),
      }))
      .sort((a, b) => a.bindingId.localeCompare(b.bindingId));
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function assertFreshDataCredentials(message: ServerMessage, pendingNetdrive = false): void {
  if (message.payload.case !== "dispatchJob") throw new Error("Expected a dispatch");
  const dispatch = message.payload.value;
  const now = BigInt(Date.now());
  if (
    dispatch.dataDeliveries.some((item) => !item.leaseId || item.leaseExpiresAtUnixMs <= now) ||
    dispatch.inputStaging.some(
      (item) =>
        !(pendingNetdrive && item.netdriveInput) &&
        item.deliveryLeaseId &&
        item.deliveryLeaseExpiresAtUnixMs <= now,
    )
  )
    throw new WorkflowExecutionInterrupted("Dispatch credentials need renewal");
}

function rejectDataDispatch(): never {
  throw new WorkflowExecutionInterrupted("Data dispatch no longer matches its authorized binding", {
    retryable: false,
  });
}

export async function assertRunningDataBindings(
  tx: PgTransaction,
  dispatch: DispatchJob,
): Promise<number> {
  let expiresAtUnixMs = Number.POSITIVE_INFINITY;
  function reject(): never {
    throw new WorkflowExecutionInterrupted("Running data binding changed", { retryable: false });
  }
  const bindings = await tx
    .select()
    .from(jobDataBindings)
    .where(
      and(eq(jobDataBindings.jobId, dispatch.jobId), eq(jobDataBindings.source, "data-market")),
    )
    .for("share");
  const deliveries = new Map(dispatch.dataDeliveries.map((item) => [item.bindingId, item]));
  if (deliveries.size !== dispatch.dataDeliveries.length) reject();
  const staged = new Set<number>();
  for (const binding of bindings) {
    const delivery = deliveries.get(binding.id);
    if (!delivery) {
      const manifest = dispatch.sandboxExecution;
      const mount = manifest?.artifactMounts.find(
        (mount) => mount.descriptor === binding.inputDescriptor,
      );
      if (
        !manifest?.networkDisabled ||
        !dispatch.restrictedNoEgress ||
        !mount ||
        mount.mode !== SandboxMountMode.READ_ONLY ||
        mount.ioType !== SandboxIoType.FILE_BATCH ||
        mount.relativePath !== `inputs/${binding.inputDescriptor}` ||
        mount.containerPath !== `/kq/inputs/${binding.inputDescriptor}` ||
        !binding.versionId
      )
        reject();
      const entries = await tx
        .select()
        .from(dataAssetManifestEntries)
        .where(eq(dataAssetManifestEntries.dataAssetVersionId, binding.versionId))
        .for("share", { noWait: true });
      const selected = binding.selectedEntries.length
        ? entries.filter((entry) => binding.selectedEntries.includes(entry.entryPath))
        : entries;
      if (
        !selected.length ||
        selected.length !== mount.batchEntries.length ||
        (binding.selectedEntries.length && selected.length !== binding.selectedEntries.length)
      )
        reject();
      const foreign = !!binding.assetId && (await isFederationDataset(tx, binding.assetId));
      for (const expected of mount.batchEntries) {
        if (
          !selected.some(
            (entry) =>
              entry.entryPath === expected.relativePath &&
              entry.digest.replace(/^sha256:/, "") === expected.sha256 &&
              Number.isSafeInteger(entry.sizeBytes) &&
              BigInt(entry.sizeBytes) === expected.sizeBytes,
          )
        )
          reject();
        const index = dispatch.inputStaging.findIndex(
          (input) =>
            input.stagePath === `${mount.relativePath}/${expected.relativePath}` &&
            input.fileMetadataId.startsWith(`data-delivery-${binding.id}-`) &&
            input.deliveryLeaseId &&
            input.deliveryLeaseExpiresAtUnixMs > 0n,
        );
        if (index < 0 || staged.has(index)) reject();
        staged.add(index);
        const input = dispatch.inputStaging[index];
        const local = input?.localDataSource;
        if (foreign && !local) reject();
        if (local) {
          const [job] = await tx.select().from(jobs).where(eq(jobs.id, dispatch.jobId));
          const [location] = await tx
            .select()
            .from(dataLocations)
            .where(eq(dataLocations.id, local.locationId))
            .for("share", { noWait: true });
          if (
            !job ||
            !binding.assetId ||
            !location ||
            input?.sourceUrl ||
            input?.netdriveInput ||
            !binding.allowedLocationIds.includes(location.id) ||
            location.kind !== "cp-local" ||
            location.status !== "available" ||
            location.dataAssetVersionId !== binding.versionId ||
            location.agentId !== job.agentId ||
            location.managedRootId !== local.managedRootId ||
            `${location.relativePath}/${expected.relativePath}` !== local.relativePath
          )
            reject();
          const source = await datasetSourceAuthority(
            tx,
            {
              assetId: binding.assetId,
              versionId: binding.versionId,
              locationId: location.id,
              orgIds: job.orgId ? [job.orgId] : [],
            },
            new Date(),
          );
          if (source && !source.allowed) reject();
          expiresAtUnixMs = Math.min(
            expiresAtUnixMs,
            source?.expiresAtUnixMs ?? Number.POSITIVE_INFINITY,
          );
        }
      }
      continue;
    }
    if (dispatch.sandboxExecution) reject();
    deliveries.delete(binding.id);
    if (
      !delivery ||
      delivery.assetId !== binding.assetId ||
      delivery.versionId !== binding.versionId ||
      delivery.manifestDigest !== binding.manifestDigest ||
      delivery.stagePath !== binding.stagePath
    )
      reject();
    const paths = delivery.selectedEntries.map((entry) => entry.path).sort();
    if (
      !paths.length ||
      new Set(paths).size !== paths.length ||
      (binding.selectedEntries.length &&
        JSON.stringify([...binding.selectedEntries].sort()) !== JSON.stringify(paths))
    )
      reject();
    const restricted = factsRequireRestrictedNoEgress({
      assetKind: binding.assetKind === "licensed-material" ? "licensed-material" : null,
      sensitivity:
        binding.sensitivity === "restricted" || binding.sensitivity === "regulated"
          ? binding.sensitivity
          : null,
      egressPolicy: binding.egressPolicy === "allow" ? "allow" : "deny",
    });
    if (delivery.restricted !== restricted || (restricted && !dispatch.restrictedNoEgress))
      reject();
  }
  if (
    deliveries.size ||
    dispatch.inputStaging.some(
      (input, index) =>
        !input.netdriveInput &&
        (input.deliveryLeaseId || input.deliveryLeaseExpiresAtUnixMs !== 0n) &&
        !staged.has(index),
    )
  )
    reject();
  return expiresAtUnixMs;
}
