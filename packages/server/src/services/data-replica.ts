import { createHash, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  agentCerts,
  agentControlSessions,
  agents,
  clusterFileRoots,
  dataAssetFiles,
  dataAssetImports,
  dataAssetManifestEntries,
  dataAssetVersions,
  dataLocations,
  dataReplicas,
  netdriveFiles,
  netdriveTransferLog,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  DataReplicaCommandSchema,
  type DataReplicaReceipt,
  REPLICA_RANGE_BYTES,
  type ReplicaRange,
  ReplicaRangeReadSchema,
  type ReplicaRangeResult,
  ReplicaRangeResultSchema,
} from "@kuintessence/proto";
import {
  AppError,
  DataAssetEntryPathSchema,
  ErrorCode,
  ManagedDatasetRootIdsSchema,
} from "@kuintessence/shared";
import { and, asc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { disclosureExpiry } from "../federation/media-export-data";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { MinioBackend } from "../storage/minio-client";
import type { DataAssetReplica, DataReplicaInput } from "./data-market";
import { readDataVersionCustody } from "./data-version-custody";

type Task = typeof dataReplicas.$inferSelect;
type Location = typeof dataLocations.$inferSelect;
type SourceStore = Pick<MinioBackend, "presignImmutableDownload" | "dataMarketImmutableBucket">;
type Target = {
  agentId: string;
  managedRootId: string;
  providerOrgId: string;
  siteId?: string;
  clusterId?: string;
};
export const REPLICA_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const conflict = (message: string) => new AppError(ErrorCode.VALIDATION_ERROR, message, 409);
const forbidden = () => new AppError(ErrorCode.FORBIDDEN, "DATA_REPLICA_AUTHORITY_CHANGED", 403);
const active = ["pending", "syncing", "available"];

async function resolveTarget(tx: PgTransaction, target: Target) {
  const [row] = await tx
    .select({ agent: agents, root: clusterFileRoots })
    .from(clusterFileRoots)
    .innerJoin(agents, eq(agents.agentId, clusterFileRoots.agentId))
    .where(and(eq(clusterFileRoots.id, target.managedRootId), eq(agents.agentId, target.agentId)))
    .for("share");
  if (
    !row?.root.enabled ||
    row.root.providerOrgId !== target.providerOrgId ||
    row.agent.providerOrgId !== target.providerOrgId ||
    !row.agent.siteId ||
    !row.agent.clusterId ||
    (target.siteId && target.siteId !== row.agent.siteId) ||
    (target.clusterId && target.clusterId !== row.agent.clusterId) ||
    !ManagedDatasetRootIdsSchema.safeParse(row.agent.topology.managedDatasetRootIds).data?.includes(
      row.root.id,
    )
  )
    throw forbidden();
  return { siteId: row.agent.siteId, clusterId: row.agent.clusterId, rootPath: row.root.path };
}

async function source(
  tx: PgTransaction,
  actor: { userId: string; orgId: string },
  versionId: string,
  digest: string,
  bucket: string,
  now: Date,
) {
  const { asset, version } = await readDataVersionCustody(tx, actor, versionId, false);
  if (
    asset.providerOrgId !== actor.orgId ||
    asset.lifecycle !== "published" ||
    asset.visibility === "private" ||
    version.status !== "ready" ||
    !version.immutableAt ||
    version.manifestDigest !== digest
  )
    throw forbidden();
  const expiry = await disclosureExpiry(tx, actor, asset.id, versionId, now);
  if (expiry === null) throw forbidden();
  const manifest = await tx
    .select()
    .from(dataAssetManifestEntries)
    .where(eq(dataAssetManifestEntries.dataAssetVersionId, versionId))
    .orderBy(asc(dataAssetManifestEntries.entryPath))
    .for("share");
  const files = await tx
    .select({ file: dataAssetFiles, location: dataLocations })
    .from(dataAssetFiles)
    .innerJoin(dataLocations, eq(dataLocations.id, dataAssetFiles.locationId))
    .where(eq(dataAssetFiles.dataAssetVersionId, versionId))
    .for("share");
  const byId = new Map(files.map((row) => [row.file.id, row]));
  const rows = manifest.map((entry) => ({ entry, ...byId.get(entry.dataAssetFileId ?? "") }));
  const locationId = rows[0]?.location?.id;
  if (!locationId) throw conflict("DATA_REPLICA_IMMUTABLE_SOURCE_REQUIRED");
  const origin = rows[0]?.location;
  let managed:
    | {
        agentId: string;
        rootId: string;
        datasetPath: string;
        siteId: string;
        clusterId: string;
        rootPath: string;
      }
    | undefined;
  if (origin?.kind === "cp-local") {
    if (
      origin.providerOrgId !== actor.orgId ||
      !origin.agentId ||
      !origin.managedRootId ||
      !origin.relativePath ||
      !(
        origin.relativePath === "." ||
        DataAssetEntryPathSchema.safeParse(origin.relativePath).success
      ) ||
      origin.relativePath
        .split("/")
        .some((part) => part === ".kq-replicas" || part === ".federation-media") ||
      version.manifest?.attestedBy !== origin.agentId
    )
      throw forbidden();
    const root = await resolveTarget(tx, {
      agentId: origin.agentId,
      managedRootId: origin.managedRootId,
      providerOrgId: actor.orgId,
    });
    managed = {
      ...root,
      agentId: origin.agentId,
      rootId: origin.managedRootId,
      datasetPath: origin.relativePath,
    };
  }
  const entries = rows.map(({ entry, file, location }) => {
    const key = file?.metadata.objectKey;
    const objectVersion = file?.metadata.objectVersionId;
    const sha256 = entry.digest.replace(/^sha256:/, "").toLowerCase();
    if (
      location?.id !== locationId ||
      location.dataAssetVersionId !== versionId ||
      (!managed && location.kind !== "platform-object") ||
      location.status !== "available" ||
      (!managed &&
        (!bucket || !location.uri?.startsWith(`s3://${bucket}/data-market/immutable/`))) ||
      !file ||
      file.dataAssetVersionId !== versionId ||
      file.path !== entry.entryPath ||
      file.digest !== entry.digest ||
      file.sizeBytes !== entry.sizeBytes ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !DataAssetEntryPathSchema.safeParse(entry.entryPath).success ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0
    )
      throw conflict("DATA_REPLICA_IMMUTABLE_SOURCE_REQUIRED");
    if (managed)
      return {
        path: entry.entryPath,
        sizeBytes: entry.sizeBytes,
        sha256,
        key: "",
        objectVersion: "",
      };
    if (
      typeof key !== "string" ||
      !key.startsWith("data-market/immutable/") ||
      !DataAssetEntryPathSchema.safeParse(key).success ||
      typeof objectVersion !== "string" ||
      !objectVersion.trim() ||
      objectVersion === "null"
    )
      throw conflict("DATA_REPLICA_IMMUTABLE_SOURCE_REQUIRED");
    return { path: entry.entryPath, sizeBytes: entry.sizeBytes, sha256, key, objectVersion };
  });
  if (entries.reduce((sum, e) => sum + e.sizeBytes, 0) !== version.sizeBytes)
    throw conflict("DATA_REPLICA_MANIFEST_CHANGED");
  return {
    locationId,
    entries,
    expiry,
    managed,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(managed ? [managed, entries] : entries))
      .digest("hex"),
  };
}

function view(task: Task, location: Location): DataAssetReplica {
  return {
    id: task.id,
    versionId: task.dataAssetVersionId,
    providerOrgId: location.providerOrgId ?? "",
    agentId: location.agentId ?? "",
    siteId: task.targetSiteId,
    clusterId: task.targetClusterId ?? "",
    status: task.status as DataAssetReplica["status"],
    locationKind: "cp-local",
    verifiedAt: task.verifiedAt,
  };
}

async function taskRow(tx: PgTransaction, id: string) {
  const [row] = await tx
    .select({ task: dataReplicas, location: dataLocations })
    .from(dataReplicas)
    .innerJoin(dataLocations, eq(dataLocations.id, dataReplicas.targetLocationId))
    .where(eq(dataReplicas.id, id))
    .for("update");
  return row;
}

async function finish(
  tx: PgTransaction,
  task: Task,
  location: Location,
  status: string,
  now: Date,
) {
  await tx
    .update(dataReplicas)
    .set({
      status,
      completedAt: now,
      updatedAt: now,
      attemptId: null,
      leaseUntil: null,
      verifiedAt: null,
      cleanupPending: true,
    })
    .where(eq(dataReplicas.id, task.id));
  await tx
    .update(dataLocations)
    .set({ status: "unavailable", updatedAt: now })
    .where(eq(dataLocations.id, location.id));
}

async function validatedSource(
  tx: PgTransaction,
  task: Task,
  location: Location,
  now: Date,
  bucket: string,
) {
  if (
    !task.requestedBy ||
    !task.manifestDigest ||
    !task.targetClusterId ||
    !location.agentId ||
    !location.managedRootId ||
    !location.providerOrgId ||
    location.relativePath !== `.kq-replicas/${task.id}` ||
    location.siteId !== task.targetSiteId
  )
    throw forbidden();
  const target = await resolveTarget(tx, {
    managedRootId: location.managedRootId,
    agentId: location.agentId,
    providerOrgId: location.providerOrgId,
    siteId: task.targetSiteId,
    clusterId: task.targetClusterId,
  });
  const pinned = await source(
    tx,
    { userId: task.requestedBy, orgId: location.providerOrgId },
    task.dataAssetVersionId,
    task.manifestDigest,
    bucket,
    now,
  );
  if (
    target.rootPath !== location.metadata.rootPath ||
    pinned.fingerprint !== location.metadata.sourceFingerprint ||
    task.sourceLocationId !== pinned.locationId
  )
    throw forbidden();
  return pinned;
}

/** NetDrive imports produce one immutable object version with the file's digest and size. */
export function importedNetdriveReplicas(db: PgDb | PgTransaction, ...filters: SQL[]) {
  return db
    .selectDistinct({
      replicaId: dataReplicas.id,
      siteId: dataReplicas.targetSiteId,
      fileId: netdriveFiles.id,
      bytes: netdriveFiles.size,
    })
    .from(dataAssetImports)
    .innerJoin(
      netdriveFiles,
      and(
        eq(netdriveFiles.id, dataAssetImports.sourceNetdriveFileId),
        eq(netdriveFiles.ownerId, dataAssetImports.requesterUserId),
      ),
    )
    .innerJoin(
      dataAssetVersions,
      and(
        eq(dataAssetVersions.dataAssetId, dataAssetImports.targetAssetId),
        eq(dataAssetVersions.version, dataAssetImports.targetVersion),
        eq(dataAssetVersions.createdBy, dataAssetImports.requesterUserId),
        eq(dataAssetVersions.contentHash, netdriveFiles.sha256),
        eq(dataAssetVersions.manifestDigest, netdriveFiles.sha256),
        eq(dataAssetVersions.sizeBytes, netdriveFiles.size),
      ),
    )
    .innerJoin(dataReplicas, eq(dataReplicas.dataAssetVersionId, dataAssetVersions.id))
    .innerJoin(dataLocations, eq(dataLocations.id, dataReplicas.targetLocationId))
    .where(
      and(
        eq(dataAssetImports.sourceKind, "netdrive"),
        eq(dataAssetImports.status, "completed"),
        ...filters,
      ),
    );
}

export async function eligibleReplicaIds(
  db: PgDb | PgTransaction,
  ids: (string | null)[],
  now: Date,
) {
  const candidates = [...new Set(ids.filter((id): id is string => !!id))];
  if (!candidates.length) return new Set<string>();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ task: dataReplicas, location: dataLocations })
      .from(dataReplicas)
      .innerJoin(dataLocations, eq(dataLocations.id, dataReplicas.targetLocationId))
      .where(
        and(
          inArray(dataReplicas.id, candidates),
          eq(dataReplicas.status, "available"),
          eq(dataLocations.status, "available"),
        ),
      )
      .for("share");
    const allowed = new Set<string>();
    for (const { task, location } of rows) {
      if (
        !task.verifiedAt ||
        now.getTime() - task.verifiedAt.getTime() >= REPLICA_VERIFICATION_TTL_MS ||
        task.verifiedAt > now
      )
        continue;
      const bucket = location.metadata.sourceBucket;
      if (typeof bucket !== "string") continue;
      try {
        await validatedSource(tx, task, location, now, bucket);
        allowed.add(task.id);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    return allowed;
  });
}

export class DataReplicaCoordinator {
  constructor(
    private readonly db: PgDb,
    private readonly storage: SourceStore | undefined,
    private readonly dispatcher: Pick<
      AgentDispatcher,
      "replicaChannel" | "pushReplica" | "pushReplicaRange" | "replicaRangePeer"
    >,
    private readonly clock = () => new Date(),
  ) {}

  async create(
    input: DataReplicaInput,
    userId: string,
    orgId: string,
    digest: string,
    key: string,
  ) {
    if (input.locationKind !== "cp-local" || !input.managedRootId)
      throw conflict("Choose a managed replica root; the Agent assigns the directory");
    const target = { ...input, managedRootId: input.managedRootId, providerOrgId: orgId };
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, key])},0))`,
      );
      const [previous] = await tx
        .select()
        .from(dataReplicas)
        .where(and(eq(dataReplicas.requestedBy, userId), eq(dataReplicas.idempotencyKey, key)));
      if (previous) {
        const row = await taskRow(tx, previous.id);
        if (
          !row ||
          previous.dataAssetVersionId !== input.versionId ||
          row.location.managedRootId !== target.managedRootId ||
          row.location.agentId !== input.agentId ||
          row.location.providerOrgId !== orgId ||
          (input.siteId && previous.targetSiteId !== input.siteId) ||
          (input.clusterId && previous.targetClusterId !== input.clusterId)
        )
          throw conflict("Idempotency-Key was used for a different replica");
        return view(row.task, row.location);
      }
      const binding = await resolveTarget(tx, target);
      const pinned = await source(
        tx,
        { userId, orgId },
        input.versionId,
        digest,
        this.storage?.dataMarketImmutableBucket ?? "",
        this.clock(),
      );
      const id = randomUUID();
      const [location] = await tx
        .insert(dataLocations)
        .values({
          dataAssetVersionId: input.versionId,
          providerOrgId: orgId,
          agentId: input.agentId,
          siteId: binding.siteId,
          managedRootId: target.managedRootId,
          relativePath: `.kq-replicas/${id}`,
          kind: "cp-local",
          status: "unavailable",
          metadata: {
            rootPath: binding.rootPath,
            sourceFingerprint: pinned.fingerprint,
            sourceBucket: this.storage?.dataMarketImmutableBucket ?? "",
          },
        })
        .returning();
      if (!location) throw new Error("Replica target insert failed");
      const [task] = await tx
        .insert(dataReplicas)
        .values({
          id,
          dataAssetVersionId: input.versionId,
          sourceLocationId: pinned.locationId,
          targetLocationId: location.id,
          targetSiteId: binding.siteId,
          targetClusterId: binding.clusterId,
          requestedBy: userId,
          idempotencyKey: key,
          manifestDigest: digest,
        })
        .onConflictDoNothing()
        .returning();
      if (!task) throw conflict("An active replica already exists at this site");
      return view(task, location);
    });
  }

  async cancel(versionId: string, id: string, orgId: string) {
    return this.db.transaction(async (tx) => {
      const row = await taskRow(tx, id);
      if (!row || row.task.dataAssetVersionId !== versionId || row.location.providerOrgId !== orgId)
        throw new AppError(ErrorCode.NOT_FOUND, "Replica not found", 404);
      if (row.task.status === "deleted") return;
      if (!["pending", "syncing"].includes(row.task.status))
        throw conflict("Only queued or copying replicas can be canceled");
      await finish(tx, row.task, row.location, "deleted", this.clock());
    });
  }

  async tick(serverId?: string) {
    const now = this.clock();
    const rows = await this.db
      .select({ id: dataReplicas.id })
      .from(dataReplicas)
      .innerJoin(dataLocations, eq(dataLocations.id, dataReplicas.targetLocationId))
      .where(
        and(
          serverId
            ? sql`not exists (select 1 from ${agentControlSessions}
            where ${agentControlSessions.agentId} = ${dataLocations.agentId}
              and ${agentControlSessions.serverId} <> ${serverId}
              and ${agentControlSessions.expiresAt} > clock_timestamp())`
            : undefined,
          or(inArray(dataReplicas.status, active), eq(dataReplicas.cleanupPending, true)),
          or(isNull(dataReplicas.leaseUntil), lt(dataReplicas.leaseUntil, now)),
        ),
      )
      .orderBy(asc(dataReplicas.updatedAt))
      .limit(64);
    const errors: unknown[] = [];
    for (const row of rows) {
      try {
        await this.dispatch(row.id);
      } catch (err) {
        errors.push(err);
        await this.db
          .update(dataReplicas)
          .set({ updatedAt: this.clock() })
          .where(eq(dataReplicas.id, row.id));
      }
    }
    if (errors.length) throw new AggregateError(errors, "Replica dispatch failed");
  }

  private async dispatch(id: string) {
    await this.db.transaction(async (tx) => {
      const row = await taskRow(tx, id);
      const now = this.clock();
      if (!row) return;
      const { task, location } = row;
      if (task.leaseUntil && task.leaseUntil > now) return;
      const release = task.cleanupPending && !active.includes(task.status);
      if (!release && !active.includes(task.status)) return;
      if (
        !release &&
        !task.verifiedAt &&
        task.requestedAt.getTime() + 86_400_000 <= now.getTime()
      ) {
        await finish(tx, task, location, "expired", now);
        return;
      }
      let pinned: Awaited<ReturnType<typeof source>> | undefined;
      if (!release) {
        try {
          pinned = await validatedSource(
            tx,
            task,
            location,
            now,
            this.storage?.dataMarketImmutableBucket ?? "",
          );
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          await finish(tx, task, location, "failed", now);
          return;
        }
      }
      const renew =
        task.status === "available" &&
        (!task.verifiedAt ||
          task.verifiedAt.getTime() + REPLICA_VERIFICATION_TTL_MS <= now.getTime() ||
          task.verifiedAt > now);
      if (renew) {
        await tx
          .update(dataLocations)
          .set({ status: "unavailable", updatedAt: now })
          .where(eq(dataLocations.id, location.id));
      }
      const agent = location.agentId;
      const cert = agent && this.dispatcher.replicaChannel(agent, !!pinned?.managed);
      if (
        (task.status === "available" && !renew) ||
        !agent ||
        !cert ||
        !location.managedRootId ||
        !(await validCertificate(tx, agent, cert, now))
      ) {
        await tx
          .update(dataReplicas)
          .set({
            ...(renew ? { status: "pending" } : {}),
            updatedAt: now,
            leaseUntil: new Date(Math.min(now.getTime() + 30_000, pinned?.expiry ?? Infinity)),
          })
          .where(eq(dataReplicas.id, id));
        return;
      }
      const expires = Math.min(now.getTime() + 300_000, pinned?.expiry ?? Infinity);
      const ttl = Math.floor((expires - this.clock().getTime()) / 1000);
      if (ttl < 1) return;
      const attemptId = randomUUID();
      const entries = await Promise.all(
        (pinned?.entries ?? []).map(async (entry) => ({
          path: entry.path,
          sha256: entry.sha256,
          sizeBytes: BigInt(entry.sizeBytes),
          downloadUrl: pinned?.managed
            ? ""
            : await this.storage?.presignImmutableDownload(entry.key, ttl, entry.objectVersion),
        })),
      );
      const command = create(DataReplicaCommandSchema, {
        replicaId: id,
        attemptId,
        managedRootId: location.managedRootId,
        managedSource: !!pinned?.managed,
        expiresAtUnixMs: BigInt(expires),
        release,
        entries,
      });
      await tx
        .update(dataReplicas)
        .set({
          attemptId,
          leaseUntil: new Date(expires),
          updatedAt: now,
          status: release ? task.status : "syncing",
        })
        .where(eq(dataReplicas.id, id));
      this.dispatcher.pushReplica(agent, cert, command);
    });
  }

  async relay(
    agentId: string,
    fingerprint: string,
    range: ReplicaRange,
    response?: ReplicaRangeResult,
  ) {
    if (
      !/^[a-f0-9-]{36}$/i.test(range.replicaId) ||
      !/^[a-f0-9-]{36}$/i.test(range.requestId) ||
      !DataAssetEntryPathSchema.safeParse(range.path).success ||
      range.offset < 0n ||
      (response && response.data.length > REPLICA_RANGE_BYTES)
    )
      return;
    await this.db.transaction(async (tx) => {
      const row = await taskRow(tx, range.replicaId);
      const now = this.clock();
      if (
        !row ||
        row.task.status !== "syncing" ||
        row.task.attemptId !== range.attemptId ||
        !row.task.leaseUntil ||
        row.task.leaseUntil <= now ||
        !row.location.agentId ||
        (!response && row.location.agentId !== agentId) ||
        this.dispatcher.replicaChannel(agentId, true) !== fingerprint ||
        !(await validCertificate(tx, agentId, fingerprint, now))
      )
        return;
      const pinned = await validatedSource(
        tx,
        row.task,
        row.location,
        now,
        this.storage?.dataMarketImmutableBucket ?? "",
      );
      const origin = pinned.managed;
      const entry = pinned.entries.find((e) => e.path === range.path);
      if (
        !origin ||
        !entry ||
        (entry.sizeBytes === 0 ? range.offset !== 0n : range.offset >= BigInt(entry.sizeBytes)) ||
        (response && origin.agentId !== agentId)
      )
        return;
      const peer = response ? row.location.agentId : origin.agentId;
      const cert = this.dispatcher.replicaRangePeer(peer);
      if (!cert || !(await validCertificate(tx, peer, cert, now))) {
        if (!response)
          this.dispatcher.pushReplicaRange(agentId, fingerprint, {
            case: "replicaRangeResult",
            value: create(ReplicaRangeResultSchema, { range, outcome: "retry" }),
          });
        return;
      }
      const deadline = Math.min(row.task.leaseUntil.getTime(), pinned.expiry);
      if (this.clock().getTime() >= deadline) return;
      if (response) {
        if (
          response.outcome === "read"
            ? (!response.data.length && entry.sizeBytes !== 0) ||
              range.offset + BigInt(response.data.length) > BigInt(entry.sizeBytes)
            : response.data.length || !["mismatch", "retry"].includes(response.outcome)
        )
          return;
        this.dispatcher.pushReplicaRange(peer, cert, {
          case: "replicaRangeResult",
          value: response,
        });
      } else
        this.dispatcher.pushReplicaRange(peer, cert, {
          case: "replicaRangeRead",
          value: create(ReplicaRangeReadSchema, {
            range,
            managedRootId: origin.rootId,
            datasetPath: origin.datasetPath,
            sha256: entry.sha256,
            sizeBytes: BigInt(entry.sizeBytes),
            expiresAtUnixMs: BigInt(deadline),
          }),
        });
    });
  }

  async accept(agentId: string, fingerprint: string, receipt: DataReplicaReceipt) {
    await this.db.transaction(async (tx) => {
      const row = await taskRow(tx, receipt.replicaId);
      if (!row || row.location.agentId !== agentId || row.task.attemptId !== receipt.attemptId)
        return;
      const { task, location } = row;
      const now = this.clock();
      if (
        !task.leaseUntil ||
        task.leaseUntil <= now ||
        !(await validCertificate(tx, agentId, fingerprint, now))
      )
        return;
      if (task.cleanupPending && receipt.outcome === "released") {
        await tx
          .update(dataReplicas)
          .set({ cleanupPending: false, attemptId: null, leaseUntil: null, updatedAt: now })
          .where(eq(dataReplicas.id, task.id));
        return;
      }
      if (task.status !== "syncing") return;
      if (receipt.outcome === "retry") {
        await tx
          .update(dataReplicas)
          .set({
            status: "pending",
            attemptId: null,
            leaseUntil: new Date(now.getTime() + 10_000),
            updatedAt: now,
          })
          .where(eq(dataReplicas.id, task.id));
        return;
      }
      if (receipt.outcome !== "copied") {
        await finish(
          tx,
          task,
          location,
          receipt.outcome === "mismatch" ? "mismatch" : "failed",
          now,
        );
        return;
      }
      let pinned: Awaited<ReturnType<typeof source>>;
      try {
        pinned = await validatedSource(
          tx,
          task,
          location,
          now,
          this.storage?.dataMarketImmutableBucket ?? "",
        );
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await finish(tx, task, location, "failed", now);
        return;
      }
      const files = new Map(receipt.files.map((f) => [f.relativePath, f]));
      if (
        files.size !== receipt.files.length ||
        files.size !== pinned.entries.length ||
        pinned.entries.some((e) => {
          const f = files.get(e.path);
          return !f || f.sha256 !== e.sha256 || f.sizeBytes !== BigInt(e.sizeBytes);
        })
      ) {
        await finish(tx, task, location, "mismatch", now);
        return;
      }
      if (Math.min(task.leaseUntil.getTime(), pinned.expiry) <= this.clock().getTime()) return;
      if (!pinned.managed && !task.verifiedAt) {
        const [sourceFile] = await importedNetdriveReplicas(tx, eq(dataReplicas.id, task.id));
        if (sourceFile) {
          await tx.insert(netdriveTransferLog).values({
            fileId: sourceFile.fileId,
            netdriveFileIds: [sourceFile.fileId],
            actorId: task.requestedBy,
            orgId: location.providerOrgId,
            direction: "mirror",
            siteId: task.targetSiteId,
            bytes: sourceFile.bytes,
            occurredAt: now,
          });
        }
      }
      await tx
        .update(dataReplicas)
        .set({
          status: "available",
          bytesCopied: pinned.entries.reduce((n, e) => n + e.sizeBytes, 0),
          verifiedAt: now,
          completedAt: now,
          updatedAt: now,
          leaseUntil: null,
          attemptId: null,
        })
        .where(eq(dataReplicas.id, task.id));
      await tx
        .update(dataLocations)
        .set({ status: "available", updatedAt: now })
        .where(eq(dataLocations.id, location.id));
    });
  }
}

async function validCertificate(
  tx: PgTransaction,
  agentId: string,
  fingerprint: string,
  now: Date,
) {
  const [cert] = await tx
    .select()
    .from(agentCerts)
    .where(and(eq(agentCerts.agentId, agentId), eq(agentCerts.fingerprintSha256, fingerprint)))
    .for("share");
  return (
    cert &&
    !cert.revokedAt &&
    cert.subjectCn === agentId &&
    cert.issuedAt <= now &&
    cert.expiresAt > now
  );
}
