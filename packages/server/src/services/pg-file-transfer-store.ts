import { fileTransfers, type PgDb } from "@kuintessence/db";
import type { Transfer, TransferState } from "@kuintessence/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FileTransferListFilter, FileTransferPatch, FileTransferStore } from "./file-service";

export class PgFileTransferStore implements FileTransferStore {
  constructor(private readonly db: PgDb) {}

  async listByUser(userId: string, filter: FileTransferListFilter = {}): Promise<Transfer[]> {
    const filters = [eq(fileTransfers.userId, userId)];
    if (filter.state) filters.push(eq(fileTransfers.state, filter.state));
    if (filter.error) filters.push(eq(fileTransfers.error, filter.error));
    const rows = await this.db
      .select()
      .from(fileTransfers)
      .where(and(...filters))
      .orderBy(fileTransfers.createdAt);
    return rows.map(mapTransferRow);
  }

  async getByUser(userId: string, id: string): Promise<Transfer | null> {
    const [row] = await this.db
      .select()
      .from(fileTransfers)
      .where(and(eq(fileTransfers.userId, userId), eq(fileTransfers.id, id)))
      .limit(1);
    return row ? mapTransferRow(row) : null;
  }

  async create(transfer: Transfer): Promise<Transfer> {
    const [row] = await this.db
      .insert(fileTransfers)
      .values({
        id: transfer.id,
        userId: transfer.userId,
        direction: transfer.direction,
        source: transfer.source,
        target: transfer.target,
        sourceFileId: transfer.sourceFileId ?? null,
        agentId: transfer.agentId ?? null,
        siteId: transfer.siteId ?? null,
        totalBytes: transfer.totalBytes,
        copiedBytes: transfer.copiedBytes,
        state: transfer.state,
        startedAt: parseTransferDate(transfer.startedAt),
        finishedAt: parseTransferDate(transfer.finishedAt),
        error: transfer.error,
        clusterRootId: transfer.clusterRootId ?? null,
        clusterRootRevision: parseTransferDate(transfer.clusterRootRevision),
        rootPolicyChangedAt: parseTransferDate(transfer.rootPolicyChangedAt),
        jobId: transfer.jobId ?? null,
        workflowRunId: transfer.workflowRunId ?? null,
        netdriveFileIds: transfer.netdriveFileIds ?? [],
      })
      .returning();
    return mapTransferRow(requireTransferRow(row));
  }

  async update(userId: string, id: string, patch: FileTransferPatch): Promise<Transfer | null> {
    const [row] = await this.db
      .update(fileTransfers)
      .set({
        ...("copiedBytes" in patch ? { copiedBytes: patch.copiedBytes } : {}),
        ...("state" in patch ? { state: patch.state } : {}),
        ...("startedAt" in patch ? { startedAt: parseTransferDate(patch.startedAt) } : {}),
        ...("finishedAt" in patch ? { finishedAt: parseTransferDate(patch.finishedAt) } : {}),
        ...("error" in patch ? { error: patch.error } : {}),
        ...("clusterRootId" in patch ? { clusterRootId: patch.clusterRootId } : {}),
        ...("clusterRootRevision" in patch
          ? { clusterRootRevision: parseTransferDate(patch.clusterRootRevision) }
          : {}),
        ...("rootPolicyChangedAt" in patch
          ? { rootPolicyChangedAt: parseTransferDate(patch.rootPolicyChangedAt) }
          : {}),
        ...("netdriveFileIds" in patch ? { netdriveFileIds: patch.netdriveFileIds } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(fileTransfers.userId, userId), eq(fileTransfers.id, id)))
      .returning();
    return row ? mapTransferRow(row) : null;
  }

  async transition(
    userId: string,
    id: string,
    from: TransferState,
    patch: FileTransferPatch,
  ): Promise<Transfer | null> {
    const [row] = await this.db
      .update(fileTransfers)
      .set({
        ...("copiedBytes" in patch ? { copiedBytes: patch.copiedBytes } : {}),
        ...("state" in patch ? { state: patch.state } : {}),
        ...("startedAt" in patch ? { startedAt: parseTransferDate(patch.startedAt) } : {}),
        ...("finishedAt" in patch ? { finishedAt: parseTransferDate(patch.finishedAt) } : {}),
        ...("error" in patch ? { error: patch.error } : {}),
        ...("clusterRootId" in patch ? { clusterRootId: patch.clusterRootId } : {}),
        ...("clusterRootRevision" in patch
          ? { clusterRootRevision: parseTransferDate(patch.clusterRootRevision) }
          : {}),
        ...("rootPolicyChangedAt" in patch
          ? { rootPolicyChangedAt: parseTransferDate(patch.rootPolicyChangedAt) }
          : {}),
        ...("netdriveFileIds" in patch ? { netdriveFileIds: patch.netdriveFileIds } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fileTransfers.userId, userId),
          eq(fileTransfers.id, id),
          eq(fileTransfers.state, from),
        ),
      )
      .returning();
    return row ? mapTransferRow(row) : null;
  }

  async markRunningRootPolicyChanged(rootId: string, changedAt: string): Promise<Transfer[]> {
    const rows = await this.db
      .update(fileTransfers)
      .set({ rootPolicyChangedAt: new Date(changedAt), updatedAt: new Date() })
      .where(and(eq(fileTransfers.clusterRootId, rootId), eq(fileTransfers.state, "running")))
      .returning();
    return rows.map(mapTransferRow);
  }

  async markInterrupted(error: string): Promise<number> {
    const rows = await this.db
      .update(fileTransfers)
      .set({
        state: "failed",
        finishedAt: new Date(),
        error,
        updatedAt: new Date(),
      })
      .where(inArray(fileTransfers.state, ["queued", "running"]))
      .returning({ id: fileTransfers.id });
    return rows.length;
  }
}

type FileTransferRow = typeof fileTransfers.$inferSelect;

function requireTransferRow(row: FileTransferRow | undefined): FileTransferRow {
  if (!row) {
    throw new Error("file transfer write returned no row");
  }
  return row;
}

function mapTransferRow(row: FileTransferRow): Transfer {
  return {
    id: row.id,
    userId: row.userId,
    direction: row.direction as Transfer["direction"],
    source: row.source,
    target: row.target,
    sourceFileId: row.sourceFileId ?? undefined,
    agentId: row.agentId,
    siteId: row.siteId,
    totalBytes: row.totalBytes,
    copiedBytes: row.copiedBytes,
    state: row.state as Transfer["state"],
    startedAt: formatTransferDate(row.startedAt),
    finishedAt: formatTransferDate(row.finishedAt),
    error: row.error,
    clusterRootId: row.clusterRootId,
    clusterRootRevision: formatTransferDate(row.clusterRootRevision),
    rootPolicyChangedAt: formatTransferDate(row.rootPolicyChangedAt),
    jobId: row.jobId ?? undefined,
    workflowRunId: row.workflowRunId ?? undefined,
    netdriveFileIds: row.netdriveFileIds,
  };
}

function parseTransferDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function formatTransferDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
