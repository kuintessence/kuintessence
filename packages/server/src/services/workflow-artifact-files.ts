import { posix } from "node:path";
import {
  artifactReplicas,
  fileTransfers,
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
  type NetDriveFile,
  WorkflowExecutionInterrupted,
} from "@kuintessence/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type OutputTransferInput, sandboxArtifactTransferId } from "../workflow/output-transfer";
import { validateArtifactMembers } from "./artifact-members";
import {
  type ArtifactPersister,
  type ArtifactRecord,
  replicaRecord,
  type WorkflowArtifactService,
} from "./workflow-artifact";

type Publication = Parameters<ArtifactPersister["persist"]>[0];
type CommittedCopy = {
  netdriveFileId: string;
  storageRef: string;
  replica: Publication["localReplica"];
};
type FilePublication = {
  transferId: string;
  artifact: ArtifactRecord;
  ownerId: string;
  agentId: string;
  source: string;
  target: string;
  sha256: string;
  sizeBytes: number;
};

export async function publishSandboxArtifactFile(
  input: FilePublication,
  transfer: (data: OutputTransferInput) => Promise<string[]>,
  files: {
    getFileById(
      id: string,
    ): Promise<Pick<NetDriveFile, "id" | "ownerId" | "path" | "sha256" | "size"> | null>;
  },
) {
  let transferId = input.transferId;
  let target = input.target;
  for (;;) {
    const [fileId] = await transfer({
      transferId,
      target,
      ownerId: input.ownerId,
      source: input.source,
      agentId: input.agentId,
      workflowRunId: input.artifact.workflowRunId,
      jobId: input.artifact.producerJobId ?? undefined,
      totalBytes: input.sizeBytes,
    });
    if (!fileId) throw new Error("Missing Sandbox transfer receipt");
    const file = await files.getFileById(fileId);
    if (file) {
      if (
        file.ownerId !== input.ownerId ||
        file.path !== target ||
        file.sha256 !== input.sha256 ||
        file.size !== input.sizeBytes
      )
        throw new Error("Persisted Sandbox artifact failed ownership/path/size/hash verification");
      return { netdriveFileId: file.id, storageRef: target };
    }
    // A deleted published copy needs a new transfer. Its receipt fixes the next identity across retries.
    transferId = sandboxArtifactTransferId(transferId, fileId);
    target = input.target.replace(`/copies/${input.transferId}/`, `/copies/${transferId}/`);
  }
}

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

  private async committedCopies(artifact: ArtifactRecord, ownerId: string) {
    const copies = new Map<string, CommittedCopy>();
    if (!artifact.producerJobId) return copies;
    const prefix = `workflow-runs/${artifact.workflowRunId}/artifacts/${artifact.id}/copies/`;
    const rows = await this.db
      .select({
        fileId: netdriveFiles.id,
        path: netdriveFiles.path,
        sha256: netdriveFiles.sha256,
        size: netdriveFiles.size,
        source: fileTransfers.source,
        replica: artifactReplicas,
      })
      .from(fileTransfers)
      .innerJoin(
        netdriveFiles,
        and(
          eq(netdriveFiles.path, fileTransfers.target),
          eq(netdriveFiles.ownerId, ownerId),
          isNull(netdriveFiles.deletedAt),
          sql`${fileTransfers.netdriveFileIds} @> jsonb_build_array(${netdriveFiles.id}::text)`,
        ),
      )
      .innerJoin(
        artifactReplicas,
        and(
          eq(artifactReplicas.artifactId, artifact.id),
          eq(artifactReplicas.storageKind, "agent-local"),
          eq(artifactReplicas.agentId, fileTransfers.agentId),
        ),
      )
      .where(
        and(
          eq(fileTransfers.workflowRunId, artifact.workflowRunId),
          eq(fileTransfers.jobId, artifact.producerJobId),
          eq(fileTransfers.userId, ownerId),
          eq(fileTransfers.direction, "cluster_to_cloud"),
          eq(fileTransfers.state, "succeeded"),
          sql`starts_with(${fileTransfers.target},${prefix})`,
        ),
      )
      .orderBy(fileTransfers.createdAt, fileTransfers.id);
    const members = validateArtifactMembers(artifact);
    const singleName = artifact.descriptor.replace(/[^a-zA-Z0-9._-]/g, "_");
    for (const row of rows) {
      const path = row.path.slice(prefix.length);
      const separator = path.indexOf("/");
      if (separator < 0 || !z.uuid().safeParse(path.slice(0, separator)).success) continue;
      const name = path.slice(separator + 1);
      const member = members?.find((item) => item.relativePath === name);
      if (members ? !member : name !== singleName) continue;
      const source = member ? posix.join(row.replica.storageRef, name) : row.replica.storageRef;
      if (
        row.source !== source ||
        row.size !== (member?.sizeBytes ?? artifact.sizeBytes) ||
        row.sha256 !== (member?.sha256 ?? artifact.contentHash) ||
        copies.has(name)
      )
        continue;
      copies.set(name, {
        netdriveFileId: row.fileId,
        storageRef: row.path,
        replica: replicaRecord(row.replica),
      });
    }
    return copies;
  }

  async receiptSource(artifact: ArtifactRecord, ownerId: string) {
    return (await this.committedCopies(artifact, ownerId)).values().next().value?.replica;
  }

  private async publish({ artifact, localReplica, ownerId }: Publication) {
    // Separate upload targets cannot overwrite a file already referenced by a concurrent reader.
    const base = `workflow-runs/${artifact.workflowRunId}/artifacts/${artifact.id}`;
    let copies: Map<string, CommittedCopy> | undefined;
    const copy = async (name: string, input: FilePublication) => {
      copies ??= await this.committedCopies(artifact, ownerId);
      const saved = copies.get(name);
      if (saved) return { netdriveFileId: saved.netdriveFileId, storageRef: saved.storageRef };
      if (
        localReplica.status !== "available" ||
        !localReplica.verifiedAt ||
        (localReplica.expiresAt && localReplica.expiresAt.getTime() <= Date.now())
      )
        throw new WorkflowExecutionInterrupted(
          "Workflow file artifact awaits a verified local replica",
        );
      return this.publishFile(input);
    };
    if (artifact.ioType !== "FileBatch") {
      // A delayed resolver may still hold the snapshot from before another publication finished.
      const [existing] = await this.db
        .select({ file: netdriveFiles })
        .from(workflowArtifacts)
        .innerJoin(netdriveFiles, eq(netdriveFiles.id, workflowArtifacts.netdriveFileId))
        .where(
          and(
            eq(workflowArtifacts.id, artifact.id),
            eq(netdriveFiles.ownerId, ownerId),
            isNull(netdriveFiles.deletedAt),
          ),
        );
      if (existing) {
        if (
          existing.file.sha256 !== artifact.contentHash ||
          existing.file.size !== artifact.sizeBytes
        )
          throw new Error("Published artifact failed size/hash verification");
        return { netdriveFileId: existing.file.id, storageRef: existing.file.path };
      }
      const transferId = sandboxArtifactTransferId(artifact.id, localReplica.id);
      const name = artifact.descriptor.replace(/[^a-zA-Z0-9._-]/g, "_");
      return copy(name, {
        transferId,
        artifact,
        ownerId,
        agentId: localReplica.agentId,
        source: localReplica.storageRef,
        target: `${base}/copies/${transferId}/${name}`,
        sha256: artifact.contentHash,
        sizeBytes: artifact.sizeBytes,
      });
    }
    const members = validateArtifactMembers(artifact);
    if (!members) throw new Error("FileBatch manifest is unavailable");
    for (const member of members) {
      if (await this.memberFile(artifact.id, member.relativePath, ownerId, member)) continue;
      const transferId = sandboxArtifactTransferId(
        artifact.id,
        localReplica.id,
        member.relativePath,
      );
      const uploaded = await copy(member.relativePath, {
        transferId,
        artifact,
        ownerId,
        agentId: localReplica.agentId,
        source: posix.join(localReplica.storageRef, member.relativePath),
        target: `${base}/copies/${transferId}/${member.relativePath}`,
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
    try {
      await service.persist(
        { artifact, replica: replica ? replicaRecord(replica) : null },
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
