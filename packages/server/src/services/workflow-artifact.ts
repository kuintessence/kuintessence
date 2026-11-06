import {
  artifactReplicas,
  netdriveFiles,
  type PgDb,
  workflowArtifactFiles,
  workflowArtifacts,
  workflowRuns,
} from "@kuintessence/db";
import {
  type ArtifactDurability,
  canonicalJson,
  createLogger,
  type SandboxArtifactMember,
  type ScriptIoType,
  WorkflowExecutionInterrupted,
} from "@kuintessence/shared";
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";

import { validateArtifactMembers } from "./artifact-members";

export interface ArtifactRecord {
  id: string;
  workflowRunId: string;
  producerNodeId: string;
  producerJobId?: string | null;
  descriptor: string;
  ioType: ScriptIoType;
  contentHash: string;
  sizeBytes: number;
  durability: ArtifactDurability;
  netdriveFileId: string | null;
  fileMembers?: SandboxArtifactMember[] | null;
  createdAt: Date;
  persistentAt: Date | null;
}

export interface ArtifactReplicaRecord {
  id: string;
  artifactId: string;
  agentId: string;
  siteId: string;
  clusterId: string;
  storageKind: "agent-local" | "netdrive";
  storageRef: string;
  status: "pending" | "available" | "persisting" | "failed" | "expired";
  verifiedAt: Date | null;
  expiresAt: Date | null;
  failureReason: string | null;
}

export interface LocalArtifactRegistration {
  workflowRunId: string;
  producerNodeId: string;
  producerJobId?: string | null;
  descriptor: string;
  ioType: ScriptIoType;
  contentHash: string;
  sizeBytes: number;
  durability: ArtifactDurability;
  ownerId: string;
  fileMembers?: SandboxArtifactMember[] | null;
  agentId: string;
  siteId: string;
  clusterId: string;
  storageRef: string;
}

export interface PendingArtifactPersistence {
  artifact: ArtifactRecord;
  replica: ArtifactReplicaRecord | null;
  ownerId: string | null;
}

export interface ArtifactStore {
  pendingPersistence(workflowRunId: string): Promise<PendingArtifactPersistence[]>;
  registerLocal(
    input: LocalArtifactRegistration,
  ): Promise<{ artifact: ArtifactRecord; replica: ArtifactReplicaRecord }>;
  beginPersistence(
    artifact: ArtifactRecord,
    localReplica: ArtifactReplicaRecord,
  ): Promise<ArtifactReplicaRecord>;
  completePersistence(
    artifactId: string,
    replicaId: string,
    result: { netdriveFileId: string | null; storageRef: string },
  ): Promise<void>;
  failPersistence(replicaId: string, reason: string): Promise<void>;
  expireEphemeral(workflowRunId: string, expiresAt: Date): Promise<void>;
  availableReplicas(artifactIds: readonly string[]): Promise<ArtifactReplicaRecord[]>;
  collectExpired(now: Date): Promise<ArtifactReplicaRecord[]>;
  markExpired(replicaIds: readonly string[]): Promise<void>;
}

export interface ArtifactPersister {
  persist(input: {
    artifact: ArtifactRecord;
    localReplica: ArtifactReplicaRecord;
    ownerId: string;
  }): Promise<{ netdriveFileId: string | null; storageRef: string }>;
}

function artifactRecord(row: typeof workflowArtifacts.$inferSelect): ArtifactRecord {
  return {
    ...row,
    ioType: row.ioType as ScriptIoType,
    durability: row.durability as ArtifactDurability,
  };
}

function replicaRecord(row: typeof artifactReplicas.$inferSelect): ArtifactReplicaRecord {
  return {
    id: row.id,
    artifactId: row.artifactId,
    agentId: row.agentId,
    siteId: row.siteId,
    clusterId: row.clusterId,
    storageKind: row.storageKind as ArtifactReplicaRecord["storageKind"],
    storageRef: row.storageRef,
    status: row.status as ArtifactReplicaRecord["status"],
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
    failureReason: row.failureReason,
  };
}

export class PgArtifactStore implements ArtifactStore {
  constructor(private readonly db: PgDb) {}

  async registerLocal(
    input: LocalArtifactRegistration,
  ): Promise<{ artifact: ArtifactRecord; replica: ArtifactReplicaRecord }> {
    const fileMembers = validateArtifactMembers(input);
    return this.db.transaction(async (tx) => {
      const values = {
        fileMembers,
        workflowRunId: input.workflowRunId,
        producerNodeId: input.producerNodeId,
        producerJobId: input.producerJobId ?? null,
        descriptor: input.descriptor,
        ioType: input.ioType,
        contentHash: input.contentHash,
        sizeBytes: input.sizeBytes,
        durability: input.durability,
      };
      const [inserted] = input.producerJobId
        ? await tx
            .insert(workflowArtifacts)
            .values(values)
            .onConflictDoNothing({
              target: [workflowArtifacts.producerJobId, workflowArtifacts.descriptor],
              where: isNotNull(workflowArtifacts.producerJobId),
            })
            .returning()
        : await tx
            .insert(workflowArtifacts)
            .values(values)
            .onConflictDoUpdate({
              target: [
                workflowArtifacts.workflowRunId,
                workflowArtifacts.producerNodeId,
                workflowArtifacts.descriptor,
              ],
              targetWhere: isNull(workflowArtifacts.producerJobId),
              set: {
                ioType: input.ioType,
                fileMembers,
                contentHash: input.contentHash,
                sizeBytes: input.sizeBytes,
                durability: input.durability,
                netdriveFileId: null,
                persistentAt: null,
              },
            })
            .returning();
      const artifact =
        inserted ??
        (input.producerJobId
          ? (
              await tx
                .select()
                .from(workflowArtifacts)
                .where(
                  and(
                    eq(workflowArtifacts.producerJobId, input.producerJobId),
                    eq(workflowArtifacts.descriptor, input.descriptor),
                  ),
                )
                .for("update")
            )[0]
          : undefined);
      if (!artifact) throw new Error("workflow artifact was not persisted");
      if (
        input.producerJobId &&
        (artifact.workflowRunId !== input.workflowRunId ||
          artifact.producerNodeId !== input.producerNodeId ||
          artifact.ioType !== input.ioType ||
          artifact.contentHash !== input.contentHash ||
          artifact.sizeBytes !== input.sizeBytes ||
          artifact.durability !== input.durability ||
          canonicalJson(artifact.fileMembers) !== canonicalJson(fileMembers))
      )
        throw new Error("A completed job's artifact is immutable");
      if (!input.producerJobId)
        await tx
          .delete(workflowArtifactFiles)
          .where(eq(workflowArtifactFiles.artifactId, artifact.id));
      const [replica] = await tx
        .insert(artifactReplicas)
        .values({
          artifactId: artifact.id,
          agentId: input.agentId,
          siteId: input.siteId,
          clusterId: input.clusterId,
          storageKind: "agent-local",
          storageRef: input.storageRef,
          status: "available",
          verifiedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            artifactReplicas.artifactId,
            artifactReplicas.agentId,
            artifactReplicas.storageKind,
          ],
          set: {
            siteId: input.siteId,
            clusterId: input.clusterId,
            storageRef: input.storageRef,
            status: "available",
            verifiedAt: new Date(),
            expiresAt: null,
            failureReason: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!replica) throw new Error("artifact replica was not persisted");
      return { artifact: artifactRecord(artifact), replica: replicaRecord(replica) };
    });
  }

  async pendingPersistence(workflowRunId: string): Promise<PendingArtifactPersistence[]> {
    const rows = await this.db
      .select({ artifact: workflowArtifacts, ownerId: workflowRuns.submittedBy })
      .from(workflowArtifacts)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowArtifacts.workflowRunId))
      .where(
        and(
          eq(workflowArtifacts.workflowRunId, workflowRunId),
          inArray(workflowArtifacts.durability, ["Checkpoint", "Persistent"]),
          or(
            isNull(workflowArtifacts.persistentAt),
            and(
              ne(workflowArtifacts.ioType, "FileBatch"),
              isNull(workflowArtifacts.netdriveFileId),
            ),
            and(
              eq(workflowArtifacts.ioType, "FileBatch"),
              or(
                isNull(workflowArtifacts.fileMembers),
                sql`(SELECT count(*) FROM ${workflowArtifactFiles}
                JOIN ${netdriveFiles} ON ${netdriveFiles.id} = ${workflowArtifactFiles.netdriveFileId}
                WHERE ${workflowArtifactFiles.artifactId} = ${workflowArtifacts.id}
                  AND ${netdriveFiles.deletedAt} IS NULL) < jsonb_array_length(${workflowArtifacts.fileMembers})`,
              ),
            ),
          ),
        ),
      );
    const replicas = await this.availableReplicas(rows.map(({ artifact }) => artifact.id));
    const now = Date.now();
    return rows.map(({ artifact, ownerId }) => ({
      artifact: artifactRecord(artifact),
      ownerId,
      replica:
        replicas.find(
          (replica) =>
            replica.artifactId === artifact.id &&
            replica.storageKind === "agent-local" &&
            replica.verifiedAt !== null &&
            (replica.expiresAt === null || replica.expiresAt.getTime() > now),
        ) ?? null,
    }));
  }

  async beginPersistence(
    artifact: ArtifactRecord,
    localReplica: ArtifactReplicaRecord,
  ): Promise<ArtifactReplicaRecord> {
    const [replica] = await this.db
      .insert(artifactReplicas)
      .values({
        artifactId: artifact.id,
        agentId: localReplica.agentId,
        siteId: localReplica.siteId,
        clusterId: localReplica.clusterId,
        storageKind: "netdrive",
        storageRef: "pending",
        status: "persisting",
      })
      .onConflictDoUpdate({
        target: [
          artifactReplicas.artifactId,
          artifactReplicas.agentId,
          artifactReplicas.storageKind,
        ],
        set: { status: "persisting", failureReason: null, updatedAt: new Date() },
      })
      .returning();
    if (!replica) throw new Error("NetDrive replica was not initialized");
    return replicaRecord(replica);
  }

  async completePersistence(
    artifactId: string,
    replicaId: string,
    result: { netdriveFileId: string | null; storageRef: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [artifact] = await tx
        .select()
        .from(workflowArtifacts)
        .where(eq(workflowArtifacts.id, artifactId))
        .for("update");
      if (!artifact) throw new Error("Artifact disappeared during publication");
      const [run] = await tx
        .select({ ownerId: workflowRuns.submittedBy })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, artifact.workflowRunId));
      if (!run?.ownerId) throw new Error("Artifact has no workflow owner");
      if (artifact.ioType === "FileBatch") {
        const members = validateArtifactMembers(artifact);
        if (!members || result.netdriveFileId !== null)
          throw new Error("Invalid batch publication");
        const files = await tx
          .select({ path: workflowArtifactFiles.relativePath, file: netdriveFiles })
          .from(workflowArtifactFiles)
          .innerJoin(netdriveFiles, eq(netdriveFiles.id, workflowArtifactFiles.netdriveFileId))
          .where(
            and(eq(workflowArtifactFiles.artifactId, artifactId), isNull(netdriveFiles.deletedAt)),
          );
        if (
          members.some(
            (member) =>
              !files.some(
                ({ path, file }) =>
                  path === member.relativePath &&
                  file.ownerId === run.ownerId &&
                  file.sha256 === member.sha256 &&
                  file.size === member.sizeBytes,
              ),
          )
        )
          throw new Error("Artifact batch publication is incomplete");
      } else {
        const [file] = result.netdriveFileId
          ? await tx
              .select()
              .from(netdriveFiles)
              .where(
                and(eq(netdriveFiles.id, result.netdriveFileId), isNull(netdriveFiles.deletedAt)),
              )
          : [];
        if (
          !file ||
          file.ownerId !== run.ownerId ||
          file.sha256 !== artifact.contentHash ||
          file.size !== artifact.sizeBytes
        )
          throw new WorkflowExecutionInterrupted(
            "Artifact publication failed ownership/size/hash verification",
            { retryable: false },
          );
      }
      let published = result;
      if (artifact.netdriveFileId) {
        const [existing] = await tx
          .select()
          .from(netdriveFiles)
          .where(
            and(eq(netdriveFiles.id, artifact.netdriveFileId), isNull(netdriveFiles.deletedAt)),
          );
        if (existing) {
          if (existing.sha256 !== artifact.contentHash || existing.size !== artifact.sizeBytes)
            throw new Error("Published artifact content is inconsistent");
          published = { netdriveFileId: existing.id, storageRef: existing.path };
        }
      }
      const now = new Date();
      await tx
        .update(workflowArtifacts)
        .set({ netdriveFileId: published.netdriveFileId, persistentAt: now })
        .where(eq(workflowArtifacts.id, artifactId));
      await tx
        .update(artifactReplicas)
        .set({
          storageRef: published.storageRef,
          status: "available",
          verifiedAt: now,
          failureReason: null,
          updatedAt: now,
        })
        .where(eq(artifactReplicas.id, replicaId));
    });
  }

  async failPersistence(replicaId: string, reason: string): Promise<void> {
    await this.db
      .update(artifactReplicas)
      .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
      .where(eq(artifactReplicas.id, replicaId));
  }

  async expireEphemeral(workflowRunId: string, expiresAt: Date): Promise<void> {
    const artifacts = await this.db
      .select({ id: workflowArtifacts.id })
      .from(workflowArtifacts)
      .where(
        and(
          eq(workflowArtifacts.workflowRunId, workflowRunId),
          eq(workflowArtifacts.durability, "Ephemeral"),
        ),
      );
    if (artifacts.length === 0) return;
    await this.db
      .update(artifactReplicas)
      .set({ expiresAt, updatedAt: new Date() })
      .where(
        inArray(
          artifactReplicas.artifactId,
          artifacts.map((artifact) => artifact.id),
        ),
      );
  }

  async availableReplicas(artifactIds: readonly string[]): Promise<ArtifactReplicaRecord[]> {
    if (artifactIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(artifactReplicas)
      .where(
        and(
          inArray(artifactReplicas.artifactId, [...artifactIds]),
          eq(artifactReplicas.status, "available"),
        ),
      );
    return rows.map(replicaRecord);
  }

  async collectExpired(now: Date): Promise<ArtifactReplicaRecord[]> {
    const rows = await this.db
      .select()
      .from(artifactReplicas)
      .where(
        and(
          inArray(artifactReplicas.status, ["available", "failed"]),
          lte(artifactReplicas.expiresAt, now),
        ),
      );
    return rows.map(replicaRecord);
  }

  async markExpired(replicaIds: readonly string[]): Promise<void> {
    if (replicaIds.length === 0) return;
    await this.db
      .update(artifactReplicas)
      .set({ status: "expired", updatedAt: new Date() })
      .where(inArray(artifactReplicas.id, [...replicaIds]));
  }
}

export class WorkflowArtifactService {
  private readonly logger = createLogger("workflow-artifact");

  private readonly checkpointTasks = new Map<string, Set<Promise<void>>>();
  private readonly publications = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ArtifactStore,
    private readonly persister?: ArtifactPersister,
    private readonly removeLocal?: (replica: ArtifactReplicaRecord) => Promise<void>,
  ) {}

  async registerLocal(input: LocalArtifactRegistration): Promise<ArtifactRecord> {
    if (!/^[0-9a-f]{64}$/.test(input.contentHash)) {
      throw new Error("artifact content hash must be lowercase SHA-256");
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error("artifact size must be a non-negative safe integer");
    }
    const registered = await this.store.registerLocal(input);
    if (
      input.durability === "Ephemeral" ||
      ((registered.artifact.ioType === "FileBatch" || registered.artifact.netdriveFileId) &&
        registered.artifact.persistentAt)
    )
      return registered.artifact;
    if (!this.persister) throw new Error("durable artifacts require a NetDrive persister");
    const task = this.persist(registered, input.ownerId);
    if (input.durability === "Persistent") {
      await task;
    } else {
      this.trackCheckpoint(input.workflowRunId, task);
    }
    return registered.artifact;
  }

  async awaitCheckpointPersistence(workflowRunId: string): Promise<void> {
    const tasks = [...(this.checkpointTasks.get(workflowRunId) ?? [])];
    // Wait for all local transfers before retrying their persisted records.
    const results = await Promise.allSettled(tasks);
    this.checkpointTasks.delete(workflowRunId);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    for (const pending of await this.store.pendingPersistence(workflowRunId)) {
      if (!pending.ownerId) throw new Error("Durable artifact has no workflow owner");
      if (!pending.replica) throw new Error("Durable artifact has no verified local replica");
      await this.persist({ artifact: pending.artifact, replica: pending.replica }, pending.ownerId);
    }
  }

  async markWorkflowTerminal(
    workflowRunId: string,
    terminalAt = new Date(),
    ttlMs = 24 * 60 * 60 * 1000,
  ): Promise<void> {
    await this.store.expireEphemeral(workflowRunId, new Date(terminalAt.getTime() + ttlMs));
  }

  async collectGarbage(now = new Date()): Promise<number> {
    const expired = await this.store.collectExpired(now);
    const removed: string[] = [];
    for (const replica of expired) {
      try {
        if (replica.storageKind === "agent-local") {
          if (!this.removeLocal) continue;
          await this.removeLocal(replica);
        }
        removed.push(replica.id);
      } catch (err) {
        this.logger.warn({ err, replicaId: replica.id }, "Artifact replica GC failed");
      }
    }
    await this.store.markExpired(removed);
    return removed.length;
  }

  persist(
    registered: { artifact: ArtifactRecord; replica: ArtifactReplicaRecord },
    ownerId: string,
  ): Promise<void> {
    const key = `${ownerId}:${registered.artifact.id}`;
    const pending = this.publications.get(key);
    if (pending) return pending;
    const task = this.publish(registered, ownerId)
      .catch((cause) => {
        if (cause instanceof WorkflowExecutionInterrupted) throw cause;
        throw new WorkflowExecutionInterrupted("Artifact publication is pending", { cause });
      })
      .finally(() => this.publications.delete(key));
    this.publications.set(key, task);
    return task;
  }

  private async publish(
    registered: { artifact: ArtifactRecord; replica: ArtifactReplicaRecord },
    ownerId: string,
  ): Promise<void> {
    if (!this.persister) throw new Error("artifact persister is unavailable");
    const persistentReplica = await this.store.beginPersistence(
      registered.artifact,
      registered.replica,
    );
    try {
      const result = await this.persister.persist({
        artifact: registered.artifact,
        localReplica: registered.replica,
        ownerId,
      });
      await this.store.completePersistence(registered.artifact.id, persistentReplica.id, result);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.store.failPersistence(persistentReplica.id, reason);
      throw err;
    }
  }

  private trackCheckpoint(workflowRunId: string, task: Promise<void>): void {
    const tasks = this.checkpointTasks.get(workflowRunId) ?? new Set<Promise<void>>();
    tasks.add(task);
    this.checkpointTasks.set(workflowRunId, tasks);
    task.catch((err) => {
      this.logger.error({ err, workflowRunId }, "Checkpoint artifact persistence failed");
    });
  }
}
