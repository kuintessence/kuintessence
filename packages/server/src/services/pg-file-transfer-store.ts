import { fileTransfers, type PgDb } from "@kuintessence/db";
import {
  AppError,
  createLogger,
  ErrorCode,
  type Transfer,
  type TransferState,
} from "@kuintessence/shared";
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { FileTransferListFilter, FileTransferPatch, FileTransferStore } from "./file-service";

const leaseEnd = sql`clock_timestamp() + interval '30 seconds'`;
const liveLease = gt(fileTransfers.dispatchExpiresAt, sql`clock_timestamp()`);
const expiredLease = or(
  isNull(fileTransfers.dispatchExpiresAt),
  lte(fileTransfers.dispatchExpiresAt, sql`clock_timestamp()`),
);
type Cancel = (row: Transfer) => Promise<boolean>;

export class PgFileTransferStore implements FileTransferStore {
  private readonly logger = createLogger("transfer-cancellation");
  private readonly cancellations = new Set<string>();
  constructor(
    private readonly db: PgDb,
    readonly serverId: string = crypto.randomUUID(),
  ) {}

  get claim() {
    return { dispatchOwner: this.serverId, dispatchExpiresAt: leaseEnd };
  }

  get owned() {
    return and(eq(fileTransfers.dispatchOwner, this.serverId), liveLease);
  }

  async maintain(cancel: Cancel) {
    await this.db
      .update(fileTransfers)
      .set({ dispatchExpiresAt: leaseEnd })
      .where(
        and(
          this.owned,
          lte(fileTransfers.dispatchExpiresAt, sql`clock_timestamp() + interval '15 seconds'`),
          or(
            inArray(fileTransfers.state, ["queued", "running"]),
            isNotNull(fileTransfers.cancelRequest),
          ),
        ),
      );
    await this.markInterrupted("TRANSFER_INTERRUPTED_BY_SERVER_RESTART");
    const requests = await this.db
      .select()
      .from(fileTransfers)
      .where(
        and(
          this.owned,
          isNotNull(fileTransfers.cancelRequest),
          this.cancellations.size
            ? notInArray(fileTransfers.cancelRequest, [...this.cancellations])
            : undefined,
        ),
      )
      .limit(64);
    for (const row of requests) this.scheduleCancellation(row, cancel);
  }

  private scheduleCancellation(row: FileTransferRow, cancel: Cancel) {
    const token = row.cancelRequest;
    if (!token || this.cancellations.has(token)) return;
    this.cancellations.add(token);
    void (async () => {
      const accepted =
        (row.state !== "running" && !row.resumeSession) || (await cancel(mapTransferRow(row)));
      await this.db
        .update(fileTransfers)
        .set({
          cancelRequest: null,
          ...(accepted
            ? {
                state: "cancelled",
                finishedAt: new Date(),
                dispatchOwner: null,
                dispatchExpiresAt: null,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(fileTransfers.id, row.id),
            eq(fileTransfers.cancelRequest, token),
            this.owned,
            eq(fileTransfers.state, row.state),
          ),
        );
    })()
      .catch((err) => this.logger.error({ err, transferId: row.id }, "Transfer cleanup will retry"))
      .finally(() => this.cancellations.delete(token));
  }

  async coordinateCancel(userId: string, id: string, cancel: Cancel): Promise<Transfer> {
    const [request] = await this.db
      .update(fileTransfers)
      .set({
        cancelRequest: sql`coalesce(${fileTransfers.cancelRequest}, ${crypto.randomUUID()}::uuid)`,
        dispatchOwner: sql`coalesce(${fileTransfers.dispatchOwner}, ${this.serverId}::uuid)`,
        dispatchExpiresAt: sql`coalesce(${fileTransfers.dispatchExpiresAt}, ${leaseEnd})`,
      })
      .where(
        and(
          eq(fileTransfers.id, id),
          eq(fileTransfers.userId, userId),
          inArray(fileTransfers.state, ["queued", "running", "failed"]),
          or(
            and(
              or(isNotNull(fileTransfers.dispatchOwner), eq(fileTransfers.state, "queued")),
              liveLease,
            ),
            and(eq(fileTransfers.state, "failed"), isNull(fileTransfers.dispatchOwner)),
          ),
        ),
      )
      .returning();
    if (request?.dispatchOwner === this.serverId) this.scheduleCancellation(request, cancel);
    const deadline = performance.now() + 5000;
    do {
      const [row] = await this.db
        .select({ state: fileTransfers.state, cancelRequest: fileTransfers.cancelRequest })
        .from(fileTransfers)
        .where(and(eq(fileTransfers.id, id), eq(fileTransfers.userId, userId)));
      if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Transfer not found", 404);
      if (row.state === "cancelled" || (!request && row.state === "succeeded")) {
        const transfer = await this.getByUser(userId, id);
        if (!transfer) throw new AppError(ErrorCode.NOT_FOUND, "Transfer not found", 404);
        return transfer;
      }
      if (!request)
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Transfer awaits owner lease recovery", 503);
      if (row.cancelRequest !== request.cancelRequest)
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Transfer cancellation not accepted", 409, {
          reason: "TRANSFER_CANCELLATION_NOT_ACCEPTED",
        });
      await Bun.sleep(100);
    } while (performance.now() < deadline);
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      "Transfer owner has not confirmed cancellation",
      503,
    );
  }

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
        ...(transfer.state === "queued" ? this.claim : {}),
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

  async transition(
    userId: string,
    id: string,
    from: TransferState,
    patch: FileTransferPatch,
    expectedStartedAt?: string,
  ): Promise<Transfer | null> {
    const [row] = await this.db
      .update(fileTransfers)
      .set({
        ...(patch.state === "queued" || (from === "failed" && patch.state === "running")
          ? this.claim
          : {}),
        ...(patch.state === "failed" || patch.state === "succeeded"
          ? { dispatchOwner: null, dispatchExpiresAt: null, cancelRequest: null }
          : {}),
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
          from === "queued" || from === "running" ? this.owned : undefined,
          from === "failed" || from === "queued" ? isNull(fileTransfers.cancelRequest) : undefined,
          expectedStartedAt !== undefined
            ? eq(fileTransfers.startedAt, new Date(expectedStartedAt))
            : undefined,
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
        cancelRequest: sql`case when ${fileTransfers.state} <> 'running' then ${fileTransfers.cancelRequest} end`,
        dispatchOwner: sql`case when ${fileTransfers.state} <> 'running' and ${fileTransfers.cancelRequest} is not null then ${this.serverId}::uuid end`,
        dispatchExpiresAt: sql`case when ${fileTransfers.state} <> 'running' and ${fileTransfers.cancelRequest} is not null then ${leaseEnd} end`,
        state: "failed",
        finishedAt: new Date(),
        error,
        updatedAt: new Date(),
      })
      .where(
        and(
          expiredLease,
          or(
            inArray(fileTransfers.state, ["queued", "running"]),
            and(eq(fileTransfers.state, "failed"), isNotNull(fileTransfers.cancelRequest)),
          ),
        ),
      )
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
