/**
 * SSH session recording (PRD F17 audit follow-up).
 *
 * The gateway accumulates the terminal OUTPUT of a session (stdout/stderr the
 * Agent streams back) with millisecond offsets, and on close hands the whole
 * {@link SshSessionRecording} to an injected sink. Input is deliberately NOT
 * recorded — keystrokes can carry typed secrets, and the replayable artifact
 * an auditor needs is what the terminal showed.
 *
 * {@link toAsciinemaCast} serializes a recording to the asciinema v2 cast
 * format so it replays in any asciinema player. The sink (e.g. a MinIO-backed
 * adapter) decides where the bytes land.
 */

import { AppError, ErrorCode } from "@kuintessence/shared";

/** One output chunk, offset in ms from session start. */
export interface SshRecordingEvent {
  tMs: number;
  data: Uint8Array;
}

export interface SshSessionRecording {
  sessionId: string;
  agentId: string;
  user: string;
  actorUserId?: string | null;
  startedAtMs: number;
  endedAtMs: number;
  reason: string;
  events: SshRecordingEvent[];
  /** Negotiated terminal geometry, if the session resized; sizes the cast
   *  header so the replay isn't clipped to the 80x24 default. */
  cols?: number;
  rows?: number;
}

/** Persist a finished recording. Mirrors the optional `auditLog` hook shape. */
export type SshRecordingSink = (rec: SshSessionRecording) => Promise<void>;

/**
 * Serialize a recording to an asciinema v2 cast (newline-delimited JSON): a
 * header object followed by one `[timeSec, "o", text]` line per output chunk.
 * Times are seconds (offset from start). Output bytes are decoded as UTF-8;
 * invalid sequences become U+FFFD, which is correct for a terminal transcript.
 */
export function toAsciinemaCast(rec: SshSessionRecording, cols = 80, rows = 24): string {
  const decoder = new TextDecoder();
  const header = {
    version: 2,
    width: rec.cols ?? cols,
    height: rec.rows ?? rows,
    timestamp: Math.floor(rec.startedAtMs / 1000),
  };
  const lines = [JSON.stringify(header)];
  for (const ev of rec.events) {
    lines.push(JSON.stringify([ev.tMs / 1000, "o", decoder.decode(ev.data)]));
  }
  return `${lines.join("\n")}\n`;
}

const SAFE_KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_KEY_SEGMENT.test(value) || value.includes("..")) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `invalid ${label} in recording key`, 400);
  }
}

/** Deterministic storage key from (agentId, sessionId) — the retrieval side
 *  rebuilds it without a full recording object. Both segments are validated
 *  against an allowlist (and an explicit `..` check) so an untrusted route
 *  param can't reference an object outside the `ssh-recordings/` prefix. */
export function recordingKeyFor(agentId: string, sessionId: string): string {
  assertSafeSegment(agentId, "agentId");
  assertSafeSegment(sessionId, "sessionId");
  return `ssh-recordings/${agentId}/${sessionId}.cast`;
}

/** Deterministic storage key for a recording artifact. */
export function recordingStorageKey(rec: SshSessionRecording): string {
  return recordingKeyFor(rec.agentId, rec.sessionId);
}

/** Minimal object-store surface a recording sink needs (matches MinioBackend). */
export interface RecordingObjectStore {
  putBlob(key: string, body: Uint8Array, contentType: string): Promise<{ etag: string }>;
}

/** Metadata persisted to the recordings index after a successful upload. */
export interface StoredRecordingMeta {
  agentId: string;
  sessionId: string;
  user: string;
  actorUserId?: string | null;
  storageKey: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  sizeBytes: number;
  reason: string;
}

/**
 * Build a sink that serializes each recording to an asciinema cast, uploads it
 * to object storage under {@link recordingStorageKey}, then (optionally) hands
 * the index metadata to `onStored` so a DB row can be written for browsing /
 * retention. An `onStored` failure is logged by the caller, not fatal.
 */
export function makeObjectStoreRecordingSink(
  store: RecordingObjectStore,
  onStored?: (meta: StoredRecordingMeta) => Promise<void>,
): SshRecordingSink {
  return async (rec) => {
    const body = new TextEncoder().encode(toAsciinemaCast(rec));
    const storageKey = recordingStorageKey(rec);
    await store.putBlob(storageKey, body, "application/x-asciicast");
    if (onStored) {
      await onStored({
        agentId: rec.agentId,
        sessionId: rec.sessionId,
        user: rec.user,
        actorUserId: rec.actorUserId ?? null,
        storageKey,
        startedAtMs: rec.startedAtMs,
        endedAtMs: rec.endedAtMs,
        durationMs: rec.endedAtMs - rec.startedAtMs,
        sizeBytes: body.length,
        reason: rec.reason,
      });
    }
  };
}
