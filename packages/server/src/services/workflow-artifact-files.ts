import { posix } from "node:path";
import {
  artifactReplicas,
  jobs,
  netdriveFiles,
  type PgDb,
  type PgTransaction,
  workflowArtifactFiles,
  workflowArtifacts,
  workflowRuns,
} from "@kuintessence/db";
import {
  canonicalJson,
  type FileInputValue,
  type FileValue,
  WorkflowExecutionInterrupted,
} from "@kuintessence/shared";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { validateArtifactMembers } from "./artifact-members";
import type {
  ArtifactPersister,
  ArtifactRecord,
  WorkflowArtifactService,
} from "./workflow-artifact";

type Publication = Parameters<ArtifactPersister["persist"]>[0];
type FilePublication = {
  artifact: ArtifactRecord;
  ownerId: string;
  agentId: string;
  source: string;
  target: string;
  sha256: string;
  sizeBytes: number;
};

/** Uses the existing Agent → NetDrive transfer; only references cross node boundaries. */
export class WorkflowArtifactFiles implements ArtifactPersister {
  constructor(
    private readonly db: PgDb,
    private readonly publishFile: (
      input: FilePublication,
    ) => Promise<{ netdriveFileId: string; storageRef: string }>,
  ) {}

  async persist(input: Publication) {
    await this.assertExportAllowed(input.artifact, input.ownerId);
    try {
      return await this.publish(input);
    } catch (cause) {
      if (cause instanceof WorkflowExecutionInterrupted) throw cause;
      throw new WorkflowExecutionInterrupted("Artifact file publication is pending", { cause });
    }
  }

  private async publish({ artifact, localReplica, ownerId }: Publication) {
    // Separate upload targets cannot overwrite a file already referenced by a concurrent reader.
    const base = `workflow-runs/${artifact.workflowRunId}/artifacts/${artifact.id}`;
    if (artifact.ioType !== "FileBatch") {
      return this.publishFile({
        artifact,
        ownerId,
        agentId: localReplica.agentId,
        source: localReplica.storageRef,
        target: `${base}/copies/${crypto.randomUUID()}/${artifact.descriptor.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
        sha256: artifact.contentHash,
        sizeBytes: artifact.sizeBytes,
      });
    }
    const members = validateArtifactMembers(artifact);
    if (!members) throw new Error("FileBatch manifest is unavailable");
    for (const member of members) {
      if (await this.memberFile(artifact.id, member.relativePath, ownerId, member)) continue;
      const uploaded = await this.publishFile({
        artifact,
        ownerId,
        agentId: localReplica.agentId,
        source: posix.join(localReplica.storageRef, member.relativePath),
        target: `${base}/copies/${crypto.randomUUID()}/${member.relativePath}`,
        sha256: member.sha256,
        sizeBytes: member.sizeBytes,
      });
      await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(workflowArtifacts)
          .where(eq(workflowArtifacts.id, artifact.id))
          .for("update");
        if (
          !current ||
          current.contentHash !== artifact.contentHash ||
          canonicalJson(current.fileMembers) !== canonicalJson(artifact.fileMembers)
        )
          throw new WorkflowExecutionInterrupted("Artifact manifest changed during publication", {
            retryable: false,
          });
        const [file] = await tx
          .select()
          .from(netdriveFiles)
          .where(
            and(
              eq(netdriveFiles.id, uploaded.netdriveFileId),
              eq(netdriveFiles.ownerId, ownerId),
              isNull(netdriveFiles.deletedAt),
            ),
          );
        if (!file || file.sha256 !== member.sha256 || file.size !== member.sizeBytes)
          throw new WorkflowExecutionInterrupted(
            "Published artifact member failed ownership/size/hash verification",
            { retryable: false },
          );
        if (await this.memberFile(artifact.id, member.relativePath, ownerId, member, tx)) return;
        // A deleted replica may be replaced; a live mapping remains stable across retries.
        await tx
          .insert(workflowArtifactFiles)
          .values({
            artifactId: artifact.id,
            relativePath: member.relativePath,
            netdriveFileId: file.id,
          })
          .onConflictDoUpdate({
            target: [workflowArtifactFiles.artifactId, workflowArtifactFiles.relativePath],
            set: { netdriveFileId: file.id },
          });
      });
    }
    return { netdriveFileId: null, storageRef: base };
  }

  async resolve(
    value: unknown,
    scope: { workflowRunId: string; ownerId: string },
    service: WorkflowArtifactService,
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      const resolved = await Promise.all(value.map((item) => this.resolve(item, scope, service)));
      return resolved.flat();
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || !("artifactId" in value))
      return value;
    const artifactId = z.uuid().parse(value.artifactId);
    const [row] = await this.db
      .select({ artifact: workflowArtifacts })
      .from(workflowArtifacts)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowArtifacts.workflowRunId))
      .where(
        and(
          eq(workflowArtifacts.id, artifactId),
          eq(workflowRuns.id, scope.workflowRunId),
          eq(workflowRuns.submittedBy, scope.ownerId),
        ),
      );
    if (!row || !["File", "FileBatch"].includes(row.artifact.ioType))
      throw new Error("Workflow file artifact is unavailable in this execution scope");
    if (!("type" in value) || value.type !== row.artifact.ioType)
      throw new Error("Workflow file artifact type does not match its saved manifest");
    const artifact = row.artifact as ArtifactRecord;
    await this.assertExportAllowed(artifact, scope.ownerId);
    const saved = await this.publishedFiles(artifact, scope.ownerId);
    if (saved !== null) return saved;
    const replicas = await this.db
      .select()
      .from(artifactReplicas)
      .where(
        and(
          eq(artifactReplicas.artifactId, artifactId),
          eq(artifactReplicas.storageKind, "agent-local"),
          eq(artifactReplicas.status, "available"),
        ),
      );
    const replica = replicas.find(
      (item) => item.verifiedAt && (!item.expiresAt || item.expiresAt.getTime() > Date.now()),
    );
    if (!replica)
      throw new WorkflowExecutionInterrupted(
        "Workflow file artifact awaits a verified local replica",
      );
    try {
      await service.persist(
        { artifact, replica: { ...replica, storageKind: "agent-local", status: "available" } },
        scope.ownerId,
      );
    } catch (cause) {
      if (cause instanceof WorkflowExecutionInterrupted) throw cause;
      throw new WorkflowExecutionInterrupted("Workflow file artifact publication is pending", {
        cause,
      });
    }
    const [updated] = await this.db
      .select()
      .from(workflowArtifacts)
      .where(eq(workflowArtifacts.id, artifactId));
    const files = updated && (await this.publishedFiles(updated as ArtifactRecord, scope.ownerId));
    if (files == null)
      throw new WorkflowExecutionInterrupted("Workflow file artifact publication is incomplete");
    return files;
  }

  private async assertExportAllowed(artifact: ArtifactRecord, ownerId: string): Promise<void> {
    if (!artifact.producerJobId)
      throw new WorkflowExecutionInterrupted("Artifact export requires a verified producer Job", {
        retryable: false,
      });
    const [producer] = await this.db.select().from(jobs).where(eq(jobs.id, artifact.producerJobId));
    if (
      !producer ||
      producer.submittedBy !== ownerId ||
      producer.status !== "completed" ||
      producer.restrictedNoEgress
    )
      throw new WorkflowExecutionInterrupted("Artifact producer does not permit file export", {
        retryable: false,
      });
  }

  private async publishedFiles(
    artifact: ArtifactRecord,
    ownerId: string,
  ): Promise<FileInputValue | null> {
    if (artifact.ioType === "FileBatch") {
      const members = validateArtifactMembers(artifact);
      if (!members) throw new Error("FileBatch manifest is unavailable");
      const files: FileValue[] = [];
      for (const member of members) {
        const file = await this.memberFile(artifact.id, member.relativePath, ownerId, member);
        if (!file) return null;
        files.push({
          fileMetadataId: file.id,
          fileMetadataName: member.relativePath,
          relativePath: member.relativePath,
        });
      }
      return files;
    }
    if (!artifact.netdriveFileId) return null;
    const [file] = await this.db
      .select()
      .from(netdriveFiles)
      .where(
        and(
          eq(netdriveFiles.id, artifact.netdriveFileId),
          eq(netdriveFiles.ownerId, ownerId),
          isNull(netdriveFiles.deletedAt),
        ),
      );
    if (!file) return null;
    if (file.sha256 !== artifact.contentHash || file.size !== artifact.sizeBytes)
      throw new Error("Published artifact failed size/hash verification");
    return { fileMetadataId: file.id, fileMetadataName: posix.basename(file.path) };
  }

  private async memberFile(
    artifactId: string,
    path: string,
    ownerId: string,
    expected: { sha256: string; sizeBytes: number },
    reader: PgDb | PgTransaction = this.db,
  ) {
    const [row] = await reader
      .select({ file: netdriveFiles })
      .from(workflowArtifactFiles)
      .innerJoin(netdriveFiles, eq(netdriveFiles.id, workflowArtifactFiles.netdriveFileId))
      .where(
        and(
          eq(workflowArtifactFiles.artifactId, artifactId),
          eq(workflowArtifactFiles.relativePath, path),
          eq(netdriveFiles.ownerId, ownerId),
          isNull(netdriveFiles.deletedAt),
        ),
      );
    if (!row) return null;
    if (row.file.sha256 !== expected.sha256 || row.file.size !== expected.sizeBytes)
      throw new Error("Published FileBatch member failed size/hash verification");
    return row.file;
  }
}
