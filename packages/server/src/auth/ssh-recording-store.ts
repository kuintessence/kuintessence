/**
 * PostgreSQL index for SSH session recordings (PRD F17).
 *
 * The transcript bytes live in object storage; this table is the searchable
 * metadata. Kept separate from the gateway and the object-store sink so each
 * stays unit-testable without a DB.
 */
import { type PgDb, sshRecordings } from "@kuintessence/db";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  sshRecordingActorTuple,
  sshRecordingAgentTuple,
  sshRecordingPlatformTuple,
} from "../authz/projection";
import type { AuthzService } from "../authz/service";
import type { StoredRecordingMeta } from "../services/ssh-recording";

/** A recordings-index row as the admin UI sees it (no transcript bytes). */
export interface RecordingIndexRow {
  agentId: string;
  sessionId: string;
  user: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  sizeBytes: number;
}

export interface InsertRecordingRowOptions {
  authz?: AuthzService;
  resolveActorUserId?: (actor: string) => Promise<string | null>;
}

export interface DeleteRecordingRowOptions {
  authz?: AuthzService;
  resolveActorUserId?: (actor: string) => Promise<string | null>;
}

/** Upsert the index row for a finished recording (idempotent on agent+session). */
export async function insertRecordingRow(
  db: PgDb,
  meta: StoredRecordingMeta,
  opts: InsertRecordingRowOptions = {},
): Promise<void> {
  await db
    .insert(sshRecordings)
    .values({
      agentId: meta.agentId,
      sessionId: meta.sessionId,
      actorUser: meta.actorUserId ?? meta.user,
      storageKey: meta.storageKey,
      startedAt: new Date(meta.startedAtMs),
      endedAt: new Date(meta.endedAtMs),
      durationMs: meta.durationMs,
      sizeBytes: meta.sizeBytes,
      reason: meta.reason,
    })
    .onConflictDoNothing();
  if (!opts.authz) return;
  const tuples = [
    sshRecordingAgentTuple({ agentId: meta.agentId, sessionId: meta.sessionId }),
    sshRecordingPlatformTuple(meta.sessionId),
  ];
  const actorUserId = meta.actorUserId ?? (await opts.resolveActorUserId?.(meta.user));
  if (actorUserId)
    tuples.push(sshRecordingActorTuple({ sessionId: meta.sessionId, userId: actorUserId }));
  await opts.authz.enqueueMany(tuples);
}

/** Most-recent recordings first, capped at `limit` (default 100). */
export async function listRecordings(db: PgDb, limit = 100): Promise<RecordingIndexRow[]> {
  const rows = await db
    .select()
    .from(sshRecordings)
    .orderBy(desc(sshRecordings.endedAt))
    .limit(limit);
  return recordingIndexRows(rows);
}

export async function listRecordingsBySessionIds(
  db: PgDb,
  sessionIds: string[],
  limit = 100,
): Promise<RecordingIndexRow[]> {
  if (sessionIds.length === 0) return [];
  const rows = await db
    .select()
    .from(sshRecordings)
    .where(inArray(sshRecordings.sessionId, sessionIds))
    .orderBy(desc(sshRecordings.endedAt))
    .limit(limit);
  return recordingIndexRows(rows);
}

function recordingIndexRows(rows: Array<typeof sshRecordings.$inferSelect>): RecordingIndexRow[] {
  return rows.map((r) => ({
    agentId: r.agentId,
    sessionId: r.sessionId,
    user: r.actorUser,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt.toISOString(),
    durationMs: r.durationMs,
    sizeBytes: r.sizeBytes,
  }));
}

/** Remove the index row for one recording. Idempotent. */
export async function deleteRecordingRow(
  db: PgDb,
  agentId: string,
  sessionId: string,
  opts: DeleteRecordingRowOptions = {},
): Promise<void> {
  const [existing] = opts.authz
    ? await db
        .select({ actorUser: sshRecordings.actorUser })
        .from(sshRecordings)
        .where(and(eq(sshRecordings.agentId, agentId), eq(sshRecordings.sessionId, sessionId)))
        .limit(1)
    : [];
  await db
    .delete(sshRecordings)
    .where(and(eq(sshRecordings.agentId, agentId), eq(sshRecordings.sessionId, sessionId)));
  if (!opts.authz) return;
  const tuples = [
    { ...sshRecordingAgentTuple({ agentId, sessionId }), operation: "delete" as const },
    { ...sshRecordingPlatformTuple(sessionId), operation: "delete" as const },
  ];
  const actorUser = existing?.actorUser;
  const actorUserId = actorUser ? await opts.resolveActorUserId?.(actorUser) : null;
  if (actorUserId) {
    tuples.push({
      ...sshRecordingActorTuple({ sessionId, userId: actorUserId }),
      operation: "delete",
    });
  }
  await opts.authz.enqueueMany(tuples);
}

/** Storage keys of recordings older than `cutoff` — drives a retention sweep. */
export async function recordingsOlderThan(
  db: PgDb,
  cutoff: Date,
): Promise<Array<{ agentId: string; sessionId: string; storageKey: string }>> {
  const rows = await db.select().from(sshRecordings).where(lt(sshRecordings.endedAt, cutoff));
  return rows.map((r) => ({
    agentId: r.agentId,
    sessionId: r.sessionId,
    storageKey: r.storageKey,
  }));
}

/** Object-store delete surface the retention sweep needs. */
export interface RecordingBlobStore {
  delete(key: string): Promise<void>;
}

export interface SweepOldRecordingsOptions extends DeleteRecordingRowOptions {}

/**
 * Delete every recording that ended before `cutoff`: remove the cast blob from
 * object storage and the index row. Returns how many were pruned. A per-item
 * failure aborts the sweep (the next tick retries); callers run it on a timer.
 */
export async function sweepOldRecordings(
  db: PgDb,
  store: RecordingBlobStore,
  cutoff: Date,
  opts: SweepOldRecordingsOptions = {},
): Promise<number> {
  const old = await recordingsOlderThan(db, cutoff);
  for (const rec of old) {
    await store.delete(rec.storageKey);
    await deleteRecordingRow(db, rec.agentId, rec.sessionId, opts);
  }
  return old.length;
}
