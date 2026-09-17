import { useCallback, useEffect, useRef, useState } from "react";
import { platformApiUrl } from "./platform-paths";

/**
 * Web SSH WebSocket subscription hook.
 *
 * Wires a single browser WebSocket to /platform/api/ssh/sessions/:agentId. The Server-side
 * gateway (see packages/server/src/routes/ssh.ts) accepts the JWT via the
 * same-origin auth cookie, the `Sec-WebSocket-Protocol` subprotocol, or a
 * `?token=` query parameter. When a legacy browser-readable token is present
 * we default to the subprotocol path; cookie-only OIDC sessions connect
 * without exposing a token in the URL.
 *
 * Wire format:
 *   - Keystrokes go as raw binary frames; `send(bytes)` forwards them.
 *   - `resize(cols, rows)` sends a JSON *text* frame `{type:"resize",cols,rows}`;
 *     the Server distinguishes it from binary stdin and forwards a SshResize.
 *   - Inbound frames are surfaced as `Uint8Array` to the registered `onData`
 *     handler (string frames are coerced via UTF-8 for safety).
 *
 * State machine:
 *
 *      idle ──► connecting ──► connected ──┐
 *                  │                       │
 *                  └──► closed ◄───────────┘
 *
 * `reconnect()` returns a closed session to `connecting` by opening a fresh
 * WebSocket. The hook deliberately does not auto-reconnect — server-side
 * close codes (e.g. 4404) usually mean human action is required (no creds,
 * agent offline, RBAC denied).
 *
 * Out of scope:
 *   - SFTP / file transfer
 *   - session sharing / observer mode
 *   - recording / playback
 */

export type SshStreamState = "idle" | "connecting" | "connected" | "closed";

export interface UseSshStreamResult {
  state: SshStreamState;
  /** Last close reason or pre-flight error (e.g. "unauthorized"). */
  lastReason: string | null;
  /** Last close code (RFC 6455 — 1006 = abnormal, 4404 = open failed). */
  lastCode: number | null;
  /** Forward a keystroke chunk to the agent. No-op until `connected`. */
  send: (bytes: Uint8Array) => void;
  /** Forward a PTY window resize (terminal cols/rows). No-op until `connected`. */
  resize: (cols: number, rows: number) => void;
  /**
   * Register the consumer's inbound-data callback. The hook invokes this
   * with each raw `Uint8Array` frame received from the Server.
   *
   * Why a setter instead of a useEffect-driven prop: the consumer typically
   * wants to feed frames directly into an xterm instance, and we don't want
   * to re-create the WebSocket every time the callback identity changes.
   */
  onData: (cb: ((bytes: Uint8Array) => void) | null) => void;
  /** Return the bounded transcript captured for this browser-side session. */
  readTranscript: () => Uint8Array[];
  /** Re-open the WebSocket after a close. */
  reconnect: () => void;
}

const TOKEN_KEY = "kq_token";
const SSH_TRANSCRIPT_LIMIT_BYTES = 1024 * 1024;
const SSH_TRANSCRIPT_STORAGE_PREFIX = "kq_ssh_transcript:";

interface SshTranscript {
  chunks: Uint8Array[];
  totalBytes: number;
}

interface SharedSshSession {
  agentId: string;
  ws: WebSocket | null;
  state: SshStreamState;
  lastReason: string | null;
  lastCode: number | null;
  listeners: Set<() => void>;
  dataListeners: Set<(bytes: Uint8Array) => void>;
  transcript: SshTranscript;
}

const sessionsByAgent = new Map<string, SharedSshSession>();

function transcriptStorageKey(agentId: string): string {
  return `${SSH_TRANSCRIPT_STORAGE_PREFIX}${agentId}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readStoredTranscript(agentId: string): SshTranscript {
  if (typeof sessionStorage === "undefined") return { chunks: [], totalBytes: 0 };
  try {
    const raw = sessionStorage.getItem(transcriptStorageKey(agentId));
    if (!raw) return { chunks: [], totalBytes: 0 };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { chunks: [], totalBytes: 0 };
    const chunks = parsed
      .filter((item): item is string => typeof item === "string")
      .map(base64ToBytes);
    return {
      chunks,
      totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    };
  } catch {
    return { chunks: [], totalBytes: 0 };
  }
}

function persistTranscript(agentId: string, transcript: SshTranscript): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      transcriptStorageKey(agentId),
      JSON.stringify(transcript.chunks.map(bytesToBase64)),
    );
  } catch {
    // Browsers can reject storage in private mode or when the quota is full.
  }
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Build the SSH WebSocket URL. Mirrors the strategy used by
 * `useJobStatusStream` so the dev Vite proxy and prod nginx can both
 * forward it.
 */
function buildSshUrl(agentId: string): string {
  const loc = typeof window !== "undefined" ? window.location : undefined;
  const proto = loc?.protocol === "https:" ? "wss:" : "ws:";
  const host = loc?.host || "localhost";
  return `${proto}//${host}${platformApiUrl(`/ssh/sessions/${encodeURIComponent(agentId)}`)}`;
}

function coerceInboundBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data && typeof data === "object" && "buffer" in (data as ArrayBufferView)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

function appendTranscript(session: SharedSshSession, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) return;
  session.transcript.chunks.push(copyBytes(bytes));
  session.transcript.totalBytes += bytes.byteLength;
  while (session.transcript.totalBytes > SSH_TRANSCRIPT_LIMIT_BYTES) {
    const dropped = session.transcript.chunks.shift();
    if (!dropped) break;
    session.transcript.totalBytes -= dropped.byteLength;
  }
  persistTranscript(session.agentId, session.transcript);
}

function readSessionTranscript(session: SharedSshSession): Uint8Array[] {
  return session.transcript.chunks.slice();
}

function getOrCreateSession(agentId: string): SharedSshSession {
  const existing = sessionsByAgent.get(agentId);
  if (existing) return existing;
  const session: SharedSshSession = {
    agentId,
    ws: null,
    state: "idle",
    lastReason: null,
    lastCode: null,
    listeners: new Set(),
    dataListeners: new Set(),
    transcript: readStoredTranscript(agentId),
  };
  sessionsByAgent.set(agentId, session);
  return session;
}

function notifySession(session: SharedSshSession): void {
  for (const listener of session.listeners) listener();
}

function setSessionState(
  session: SharedSshSession,
  state: SshStreamState,
  lastReason: string | null = session.lastReason,
  lastCode: number | null = session.lastCode,
): void {
  session.state = state;
  session.lastReason = lastReason;
  session.lastCode = lastCode;
  notifySession(session);
}

function connectSession(session: SharedSshSession, force = false): void {
  const existing = session.ws;
  if (
    !force &&
    existing &&
    existing.readyState !== WebSocket.CLOSING &&
    existing.readyState !== WebSocket.CLOSED
  ) {
    return;
  }

  if (force && existing && existing.readyState !== WebSocket.CLOSED) {
    try {
      existing.close(1000, "reconnect");
    } catch {
      // ignore
    }
  }

  const token = readToken();
  setSessionState(session, "connecting", null, null);

  let ws: WebSocket;
  try {
    ws = token
      ? new WebSocket(buildSshUrl(session.agentId), ["Bearer", token])
      : new WebSocket(buildSshUrl(session.agentId));
  } catch {
    // Some test/runtime shims don't support the protocols arg — fall back
    // to a query-string token. Server-side `extractToken` accepts both.
    ws = token
      ? new WebSocket(`${buildSshUrl(session.agentId)}?token=${encodeURIComponent(token)}`)
      : new WebSocket(buildSshUrl(session.agentId));
  }
  ws.binaryType = "arraybuffer";
  session.ws = ws;

  ws.onopen = () => {
    if (session.ws !== ws) return;
    setSessionState(session, "connected");
  };

  ws.onmessage = (evt: MessageEvent) => {
    if (session.ws !== ws) return;
    const bytes = coerceInboundBytes(evt.data);
    if (!bytes) return;
    appendTranscript(session, bytes);
    for (const listener of session.dataListeners) listener(bytes);
  };

  ws.onclose = (evt: CloseEvent) => {
    if (session.ws !== ws) return;
    setSessionState(session, "closed", evt.reason || null, evt.code);
  };

  ws.onerror = () => {
    // Browsers always follow `onerror` with `onclose` — let onclose own
    // the state transition.
  };
}

function sessionSnapshot(session: SharedSshSession) {
  return {
    state: session.state,
    lastReason: session.lastReason,
    lastCode: session.lastCode,
  };
}

export function resetSshStreamSessionsForTests(
  options: { keepStoredTranscripts?: boolean } = {},
): void {
  for (const session of sessionsByAgent.values()) {
    const ws = session.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close(1000, "reset");
      } catch {
        // ignore
      }
    }
  }
  sessionsByAgent.clear();
  if (!options.keepStoredTranscripts && typeof sessionStorage !== "undefined") {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(SSH_TRANSCRIPT_STORAGE_PREFIX)) sessionStorage.removeItem(key);
    }
  }
}

/**
 * Subscribe to a real-time SSH session for `agentId`.
 *
 * @param agentId — Server agent UUID (route param).
 */
export function useSshStream(agentId: string): UseSshStreamResult {
  const [snapshot, setSnapshot] = useState(() => sessionSnapshot(getOrCreateSession(agentId)));
  const onDataRef = useRef<((bytes: Uint8Array) => void) | null>(null);

  useEffect(() => {
    const session = getOrCreateSession(agentId);
    const listener = () => setSnapshot(sessionSnapshot(session));
    session.listeners.add(listener);
    listener();
    if (session.state === "idle" || !session.ws) connectSession(session);
    return () => {
      session.listeners.delete(listener);
    };
  }, [agentId]);

  useEffect(() => {
    return () => {
      const cb = onDataRef.current;
      if (!cb) return;
      getOrCreateSession(agentId).dataListeners.delete(cb);
      onDataRef.current = null;
    };
  }, [agentId]);

  const send = useCallback(
    (bytes: Uint8Array) => {
      const ws = getOrCreateSession(agentId).ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Copy into a fresh ArrayBuffer-backed Uint8Array so we satisfy the
      // strict `BufferSource` shape `WebSocket.send` expects (the input may be
      // backed by SharedArrayBuffer, which `send` doesn't accept). Cheap for
      // typical keystroke payloads.
      const out: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(bytes.byteLength));
      out.set(bytes);
      ws.send(out);
    },
    [agentId],
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      const ws = getOrCreateSession(agentId).ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    },
    [agentId],
  );

  const onData = useCallback(
    (cb: ((bytes: Uint8Array) => void) | null) => {
      const session = getOrCreateSession(agentId);
      const previous = onDataRef.current;
      if (previous) session.dataListeners.delete(previous);
      onDataRef.current = cb;
      if (cb) session.dataListeners.add(cb);
    },
    [agentId],
  );

  const readTranscript = useCallback(
    () => readSessionTranscript(getOrCreateSession(agentId)),
    [agentId],
  );

  const reconnect = useCallback(() => {
    connectSession(getOrCreateSession(agentId), true);
  }, [agentId]);

  return {
    state: snapshot.state,
    lastReason: snapshot.lastReason,
    lastCode: snapshot.lastCode,
    send,
    resize,
    onData,
    readTranscript,
    reconnect,
  };
}
