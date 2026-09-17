import { describe, expect, test } from "bun:test";
import type {
  ArtifactRecord,
  ArtifactReplicaRecord,
  ArtifactStore,
  LocalArtifactRegistration,
} from "./workflow-artifact";
import { WorkflowArtifactService } from "./workflow-artifact";

class MemoryArtifactStore implements ArtifactStore {
  artifact?: ArtifactRecord;

  local?: ArtifactReplicaRecord;

  persistent?: ArtifactReplicaRecord;

  expiry?: Date;

  async registerLocal(input: LocalArtifactRegistration) {
    this.artifact = {
      id: "artifact-1",
      workflowRunId: input.workflowRunId,
      producerNodeId: input.producerNodeId,
      descriptor: input.descriptor,
      ioType: input.ioType,
      contentHash: input.contentHash,
      sizeBytes: input.sizeBytes,
      durability: input.durability,
      netdriveFileId: null,
      createdAt: new Date(),
      persistentAt: null,
    };
    this.local = {
      id: "replica-local",
      artifactId: this.artifact.id,
      agentId: input.agentId,
      siteId: input.siteId,
      clusterId: input.clusterId,
      storageKind: "agent-local",
      storageRef: input.storageRef,
      status: "available",
      verifiedAt: new Date(),
      expiresAt: null,
      failureReason: null,
    };
    return { artifact: this.artifact, replica: this.local };
  }

  async beginPersistence(artifact: ArtifactRecord, local: ArtifactReplicaRecord) {
    this.persistent = {
      ...local,
      id: "replica-netdrive",
      artifactId: artifact.id,
      storageKind: "netdrive",
      storageRef: "pending",
      status: "persisting",
    };
    return this.persistent;
  }

  async completePersistence(
    _artifactId: string,
    _replicaId: string,
    result: { netdriveFileId: string; storageRef: string },
  ) {
    if (this.artifact) {
      this.artifact.netdriveFileId = result.netdriveFileId;
      this.artifact.persistentAt = new Date();
    }
    if (this.persistent) {
      this.persistent.status = "available";
      this.persistent.storageRef = result.storageRef;
    }
  }

  async failPersistence(_replicaId: string, reason: string) {
    if (this.persistent) {
      this.persistent.status = "failed";
      this.persistent.failureReason = reason;
    }
  }

  async expireEphemeral(_workflowRunId: string, expiresAt: Date) {
    this.expiry = expiresAt;
  }

  async availableReplicas() {
    return this.local ? [this.local] : [];
  }

  async collectExpired() {
    return this.local ? [this.local] : [];
  }

  async markExpired() {
    if (this.local) this.local.status = "expired";
  }
}

const registration = (
  durability: LocalArtifactRegistration["durability"],
): LocalArtifactRegistration => ({
  workflowRunId: "run-1",
  producerNodeId: "transform",
  descriptor: "result",
  ioType: "JSON",
  contentHash: "a".repeat(64),
  sizeBytes: 12,
  durability,
  ownerId: "owner-1",
  agentId: "agent-1",
  siteId: "site-1",
  clusterId: "cluster-1",
  storageRef: "/managed/output/result",
});

describe("WorkflowArtifactService", () => {
  test("Persistent waits for NetDrive before registration succeeds", async () => {
    const store = new MemoryArtifactStore();
    let persisted = false;
    const service = new WorkflowArtifactService(store, {
      persist: async () => {
        persisted = true;
        return { netdriveFileId: "file-1", storageRef: "workflow-runs/run-1/result" };
      },
    });

    await service.registerLocal(registration("Persistent"));

    expect(persisted).toBe(true);
    expect(store.artifact?.netdriveFileId).toBe("file-1");
    expect(store.persistent?.status).toBe("available");
  });

  test("Checkpoint is locally consumable but must finish before workflow completion", async () => {
    const store = new MemoryArtifactStore();
    let release: (() => void) | undefined;
    const service = new WorkflowArtifactService(store, {
      persist: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ netdriveFileId: "file-1", storageRef: "workflow-runs/run-1/result" });
        }),
    });

    await service.registerLocal(registration("Checkpoint"));
    expect(store.local?.status).toBe("available");
    const completing = service.awaitCheckpointPersistence("run-1");
    let completed = false;
    completing.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release?.();
    await completing;
    expect(completed).toBe(true);
  });

  test("Ephemeral gets terminal plus 24 hour expiry and GC removes local data", async () => {
    const store = new MemoryArtifactStore();
    const removed: string[] = [];
    const service = new WorkflowArtifactService(store, undefined, async (replica) => {
      removed.push(replica.storageRef);
    });
    await service.registerLocal(registration("Ephemeral"));
    const terminal = new Date("2026-07-14T00:00:00Z");

    await service.markWorkflowTerminal("run-1", terminal);
    const count = await service.collectGarbage();

    expect(store.expiry?.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(count).toBe(1);
    expect(removed).toEqual(["/managed/output/result"]);
    expect(store.local?.status).toBe("expired");
  });
});
