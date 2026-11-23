import { fileTransfers, type PgDb } from "@kuintessence/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgFileTransferStore } from "../services/pg-file-transfer-store";
import type { OutputTransferInput, OutputTransferStore } from "./output-transfer";

const workflowOutputTransferBinding = (input: OutputTransferInput) =>
  and(
    eq(fileTransfers.id, input.transferId),
    eq(fileTransfers.userId, input.ownerId),
    eq(fileTransfers.direction, "cluster_to_cloud"),
    eq(fileTransfers.source, input.source),
    eq(fileTransfers.target, input.target),
    eq(fileTransfers.agentId, input.agentId),
    input.jobId ? eq(fileTransfers.jobId, input.jobId) : isNull(fileTransfers.jobId),
    input.workflowRunId
      ? eq(fileTransfers.workflowRunId, input.workflowRunId)
      : isNull(fileTransfers.workflowRunId),
    input.totalBytes !== undefined ? eq(fileTransfers.totalBytes, input.totalBytes) : undefined,
  );
export function pgOutputTransferStore(
  db: PgDb,
  fileTransferStore: PgFileTransferStore,
): OutputTransferStore {
  return {
    ensure: async (input) => {
      await db
        .insert(fileTransfers)
        .values({
          id: input.transferId,
          userId: input.ownerId,
          direction: "cluster_to_cloud",
          source: input.source,
          target: input.target,
          agentId: input.agentId,
          jobId: input.jobId,
          workflowRunId: input.workflowRunId,
          totalBytes: input.totalBytes,
          state: "queued",
          // Allow a waiter to claim this row before the interruption sweep.
          dispatchExpiresAt: fileTransferStore.claim.dispatchExpiresAt,
        })
        .onConflictDoNothing();
      const [saved] = await db
        .select()
        .from(fileTransfers)
        .where(eq(fileTransfers.id, input.transferId))
        .limit(1);
      return saved;
    },
    activate: async (input, previousState) => {
      const rows = await db
        .update(fileTransfers)
        .set({
          ...fileTransferStore.claim,
          state: "running",
          startedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp() at time zone 'UTC'), ${fileTransfers.startedAt} + interval '1 millisecond')`,
          finishedAt: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            workflowOutputTransferBinding(input),
            eq(fileTransfers.state, previousState),
            isNull(fileTransfers.cancelRequest),
            isNull(fileTransfers.dispatchOwner),
          ),
        )
        .returning({ startedAt: fileTransfers.startedAt });
      return rows[0]?.startedAt ?? false;
    },
    finish: async (input, event, startedAt) => {
      const rows = await db
        .update(fileTransfers)
        .set({
          dispatchOwner: null,
          dispatchExpiresAt: null,
          cancelRequest: null,
          state: event.state,
          error: event.state === "failed" ? "Workflow output transfer retry required" : null,
          copiedBytes: event.copiedBytes,
          finishedAt: new Date(),
          updatedAt: new Date(),
          ...(event.state === "succeeded" ? { netdriveFileIds: event.netdriveFileIds ?? [] } : {}),
        })
        .where(
          and(
            workflowOutputTransferBinding(input),
            fileTransferStore.owned,
            eq(fileTransfers.startedAt, startedAt),
            eq(fileTransfers.state, "running"),
          ),
        )
        .returning({ id: fileTransfers.id });
      return rows.length === 1;
    },
  };
}
