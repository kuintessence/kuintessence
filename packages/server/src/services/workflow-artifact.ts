import { artifactReplicas, type PgDb, workflowArtifacts } from "@kuintessence/db";
import { type ArtifactDurability, createLogger, type ScriptIoType } from "@kuintessence/shared";
import { and, eq, inArray, lte } from "drizzle-orm";

export interface ArtifactRecord {
  id: string;
  workflowRunId: string;
  producerNodeId: string;
  descriptor: string;
  ioType: ScriptIoType;
  contentHash: string;
  sizeBytes: number;
  durability: ArtifactDurability;
  netdriveFileId: string | null;
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
  descriptor: string;
  ioType: ScriptIoType;
  contentHash: string;
  sizeBytes: number;
  durability: ArtifactDurability;
  ownerId: string;
  agentId: string;
  siteId: string;
  clusterId: string;
  storageRef: string;
}

export interface ArtifactStore {
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
    result: { netdriveFileId: string; storageRef: string },
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
  }): Promise<{ netdriveFileId: string; storageRef: string }>;
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
    return this.db.transaction(async (tx) => {
      const [artifact] = await tx
        .insert(workflowArtifacts)
        .values({
          workflowRunId: input.workflowRunId,
          producerNodeId: input.producerNodeId,
          descriptor: input.descriptor,
          ioType: input.ioType,
          contentHash: input.contentHash,
          sizeBytes: input.sizeBytes,
          durability: input.durability,
        })
        .onConflictDoUpdate({
          target: [
            workflowArtifacts.workflowRunId,
            workflowArtifacts.producerNodeId,
            workflowArtifacts.descriptor,
          ],
          set: {
            ioType: input.ioType,
            contentHash: input.contentHash,
            sizeBytes: input.sizeBytes,
            durability: input.durability,
            netdriveFileId: null,
            persistentAt: null,
          },
        })
        .returning();
      if (!artifact) throw new Error("workflow artifact was not persisted");
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
    result: { netdriveFileId: string; storageRef: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(workflowArtifacts)
        .set({ netdriveFileId: result.netdriveFileId, persistentAt: now })
        .where(eq(workflowArtifacts.id, artifactId));
      await tx
        .update(artifactReplicas)
        .set({
          storageRef: result.storageRef,
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
    if (input.durability === "Ephemeral") return registered.artifact;
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
    if (tasks.length === 0) return;
    try {
      await Promise.all(tasks);
    } finally {
      this.checkpointTasks.delete(workflowRunId);
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

  private async persist(
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
