import { create } from "@bufbuild/protobuf";
import {
  type AgentMessage,
  type ServerMessage,
  ServerMessageSchema,
  SshAuthSchema,
  SshCloseSchema,
  SshDataSchema,
  SshOpenSchema,
  SshResizeSchema,
} from "@kuintessence/proto";
import { createLogger } from "@kuintessence/shared";
import type { Logger } from "pino";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { SshRecordingEvent, SshRecordingSink } from "./ssh-recording";

/**
 * Server-side SSH gateway.
 *
 * Owns the per-session bridge between:
 *   - one Server WebSocket client (browser xterm.js or `kq ssh` CLI), and
 *   - the Agent connectRPC bidirectional stream addressed by `agentId`.
 *
 * The lifecycle for a single session is straightforward:
 *
 *   1. WS upgrades (route layer authenticates + RBACs first).
 *   2. Route layer calls {@link SshGateway.openSession}, supplying the
 *      target agentId and the resolved SSH credentials. The gateway
 *      uses the provided `sessionId` or issues a UUID, stashes the WSContext,
 *      and pushes SshOpen onto the Server→Agent channel.
 *   3. Each WS message bytes flow through {@link SshGateway.forwardClientData}
 *      → SshData on the wire to the Agent.
 *   4. Agent emits SshOutput / SshClosed → the connectRPC handler calls
 *      {@link SshGateway.handleAgentMessage} → bytes are written to the
 *      WSContext or the WS is closed and the registry entry removed.
 *   5. WS close from the client side calls {@link SshGateway.closeSession},
 *      which sends SshClose to the Agent and forgets the session.
 *
 * Concurrent-session caps, an open-rate limit, an idle-timeout sweep, and an
 * opt-in output-only recording sink are all enforced here (see the deps).
 */

export interface WsConnectionLike {
  send(data: string | ArrayBufferView | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
}

export interface SshCredentials {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Base64 SHA-256 host-key pin; forwarded to the Agent for MITM defense. */
  hostKeySha256?: string;
}

interface SessionEntry {
  sessionId: string;
  agentId: string;
  ws: WsConnectionLike;
  /** Audit-trail bookkeeping. */
  user: string;
  actorUserId?: string | null;
  sourceIp?: string;
  openedAtMs: number;
  /** Last input/output activity (ms), drives the idle timeout. */
  lastActivityMs: number;
  /** Output transcript, present only when a recording sink is configured. */
  events?: SshRecordingEvent[];
  /** Bytes recorded so far (bounds the transcript buffer). */
  recordedBytes?: number;
  /** Latest negotiated PTY geometry (from resize frames); sizes the recording. */
  cols?: number;
  rows?: number;
}

export interface SshGatewayDeps {
  dispatcher: AgentDispatcher;
  logger?: Logger;
  /** Inject for deterministic IDs in tests. Default: crypto.randomUUID(). */
  newSessionId?: () => string;
  /**
   * Optional audit hook. Called on session OPEN and CLOSE. When omitted
   * the gateway just logs at INFO. The route layer is expected to wire
   * this into the audit-log table.
   */
  auditLog?: (event: SshAuditEvent) => Promise<void>;
  /**
   * Optional session-recording sink. When present, every session's terminal
   * output is captured and handed over on close (asciinema-replayable). When
   * absent, nothing is recorded — no buffering overhead.
   */
  recordSink?: SshRecordingSink;
  /**
   * Cap on bytes buffered per recorded session. Past this the transcript stops
   * growing (a truncation marker is appended once) so a noisy session — `yes`,
   * `cat bigfile` — cannot exhaust Server memory. Default {@link DEFAULT_MAX_RECORDING_BYTES}.
   */
  maxRecordingBytes?: number;
  /**
   * Session limits. A privileged SSH shell holds an ssh2 channel and a
   * WebSocket open; without bounds a single account could exhaust an Agent's
   * channel slots (denial of service), hide a runaway client, or storm the
   * gateway with rapid open/close churn. Two independent guards:
   *   - concurrent caps: {@link DEFAULT_MAX_PER_USER_AGENT} per (user, agent),
   *     {@link DEFAULT_MAX_PER_USER} per user across all agents;
   *   - an open-rate limit: at most {@link DEFAULT_MAX_OPENS_PER_WINDOW} opens
   *     per user within a sliding {@link DEFAULT_OPEN_WINDOW_MS} window.
   */
  limits?: {
    maxPerUserAgent?: number;
    maxPerUser?: number;
    maxOpensPerWindow?: number;
    openWindowMs?: number;
  };
  /** Injected wall clock (ms) for the open-rate window. Default: Date.now. */
  now?: () => number;
  /** Optional cleanup hook for per-session external state such as authorization tuples. */
  onSessionClosed?: (event: SshSessionClosedEvent) => Promise<void> | void;
  /**
   * Idle timeout in ms. A session with no input or output for longer than this
   * is force-closed by {@link SshGateway.sweepIdleSessions}. 0 (default)
   * disables idle expiry — sessions live until a party closes them.
   */
  idleTimeoutMs?: number;
  /**
   * Absolute maximum session lifetime in ms. A session open longer than this is
   * force-closed by {@link SshGateway.sweepAgedSessions} regardless of activity
   * — a standard bastion control that idle timeout cannot provide (a
   * continuously-active or compromised shell never goes idle). 0 (default)
   * disables it.
   */
  maxSessionMs?: number;
}

/** Default cap on concurrent sessions a single user may hold on one agent. */
export const DEFAULT_MAX_PER_USER_AGENT = 3;
/** Default cap on concurrent sessions a single user may hold across all agents. */
export const DEFAULT_MAX_PER_USER = 10;
/** Default cap on session opens per user within {@link DEFAULT_OPEN_WINDOW_MS}. */
export const DEFAULT_MAX_OPENS_PER_WINDOW = 20;
/** Default sliding-window length (ms) for the open-rate limit. */
export const DEFAULT_OPEN_WINDOW_MS = 60_000;
/** Default per-session recording buffer cap (5 MB of terminal output). */
export const DEFAULT_MAX_RECORDING_BYTES = 5_000_000;

/** Base for limit violations the route maps to WS close 4429 / HTTP 429. */
export class SshLimitError extends Error {}
/** Thrown when a concurrent-session cap is hit. */
export class SshSessionLimitError extends SshLimitError {}
/** Thrown when the per-user open-rate window is exceeded. */
export class SshRateLimitError extends SshLimitError {}

export type SshAuditEvent =
  | {
      kind: "session_open";
      sessionId: string;
      agentId: string;
      user: string;
      sourceIp?: string;
      ts: Date;
    }
  | {
      kind: "session_close";
      sessionId: string;
      agentId: string;
      user: string;
      reason: string;
      durationMs: number;
      ts: Date;
    };

export interface SshSessionClosedEvent {
  sessionId: string;
  agentId: string;
  actorUserId: string | null;
  reason: string;
}

/** Secret-free live-session row for the admin monitoring view. */
export interface SshSessionSummary {
  sessionId: string;
  agentId: string;
  user: string;
  sourceIp?: string;
  openedAtMs: number;
  durationMs: number;
}

export class SshGateway {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly dispatcher: AgentDispatcher;
  private readonly logger: Logger;
  private readonly newSessionId: () => string;
  private readonly auditLog?: (event: SshAuditEvent) => Promise<void>;
  private recordSink?: SshRecordingSink;
  private readonly maxRecordingBytes: number;
  private readonly maxPerUserAgent: number;
  private readonly maxPerUser: number;
  private readonly maxOpensPerWindow: number;
  private readonly openWindowMs: number;
  private readonly now: () => number;
  private readonly onSessionClosed?: (event: SshSessionClosedEvent) => Promise<void> | void;
  private readonly idleTimeoutMs: number;
  private readonly maxSessionMs: number;
  /** Per-user open timestamps within the current window (sliding-window rate limit). */
  private readonly openLog = new Map<string, number[]>();

  constructor(deps: SshGatewayDeps) {
    this.dispatcher = deps.dispatcher;
    this.logger = deps.logger ?? createLogger("ssh-gateway");
    this.newSessionId = deps.newSessionId ?? (() => crypto.randomUUID());
    this.auditLog = deps.auditLog;
    this.recordSink = deps.recordSink;
    this.maxRecordingBytes = deps.maxRecordingBytes ?? DEFAULT_MAX_RECORDING_BYTES;
    this.maxPerUserAgent = deps.limits?.maxPerUserAgent ?? DEFAULT_MAX_PER_USER_AGENT;
    this.maxPerUser = deps.limits?.maxPerUser ?? DEFAULT_MAX_PER_USER;
    this.maxOpensPerWindow = deps.limits?.maxOpensPerWindow ?? DEFAULT_MAX_OPENS_PER_WINDOW;
    this.openWindowMs = deps.limits?.openWindowMs ?? DEFAULT_OPEN_WINDOW_MS;
    this.now = deps.now ?? (() => Date.now());
    this.onSessionClosed = deps.onSessionClosed;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? 0;
    this.maxSessionMs = deps.maxSessionMs ?? 0;
  }

  /**
   * Open a new SSH session. Returns the minted sessionId so the route
   * layer can correlate close-frames. Throws when the agent is not
   * currently registered with the dispatcher — the caller MUST close the
   * WebSocket with code 4404 so the client gets a clean signal instead
   * of a half-open tunnel.
   */
  openSession(input: {
    sessionId?: string;
    agentId: string;
    ws: WsConnectionLike;
    credentials: SshCredentials;
    user: string;
    actorUserId?: string | null;
    sourceIp?: string;
  }): string {
    if (!this.dispatcher.isOnline(input.agentId)) {
      throw new Error(`agent ${input.agentId} is not online`);
    }
    this.enforceLimits(input.user, input.agentId);
    this.enforceOpenRate(input.user);
    const sessionId = input.sessionId ?? this.newSessionId();
    const entry: SessionEntry = {
      sessionId,
      agentId: input.agentId,
      ws: input.ws,
      user: input.user,
      actorUserId: input.actorUserId ?? null,
      sourceIp: input.sourceIp,
      openedAtMs: this.now(),
      lastActivityMs: this.now(),
      events: this.recordSink ? [] : undefined,
      recordedBytes: this.recordSink ? 0 : undefined,
    };
    this.sessions.set(sessionId, entry);

    const open = create(ServerMessageSchema, {
      payload: {
        case: "sshOpen",
        value: create(SshOpenSchema, {
          sessionId,
          host: input.credentials.host,
          port: input.credentials.port,
          username: input.credentials.username,
          hostKeySha256: input.credentials.hostKeySha256 ?? "",
          auth: create(SshAuthSchema, {
            password: input.credentials.password ?? "",
            privateKey: input.credentials.privateKey ?? "",
            passphrase: input.credentials.passphrase ?? "",
          }),
        }),
      },
    });
    const ok = this.pushToAgent(input.agentId, open);
    if (!ok) {
      this.sessions.delete(sessionId);
      throw new Error(`agent ${input.agentId} channel disappeared mid-open`);
    }
    this.logger.info({ sessionId, agentId: input.agentId, user: input.user }, "SSH session opened");
    if (this.auditLog) {
      this.auditLog({
        kind: "session_open",
        sessionId,
        agentId: input.agentId,
        user: input.user,
        sourceIp: input.sourceIp,
        ts: new Date(),
      }).catch((err) => {
        this.logger.error({ err, sessionId }, "Failed to audit-log session_open");
      });
    }
    return sessionId;
  }

  /** Forward raw stdin bytes from the WS client to the Agent. */
  forwardClientData(sessionId: string, data: Uint8Array): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.logger.warn({ sessionId }, "forwardClientData for unknown session — dropping");
      return;
    }
    entry.lastActivityMs = this.now();
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "sshData",
        value: create(SshDataSchema, {
          sessionId,
          data,
        }),
      },
    });
    this.pushToAgent(entry.agentId, msg);
  }

  /** Forward a PTY window-resize from the WS client to the Agent. */
  forwardResize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.logger.warn({ sessionId }, "forwardResize for unknown session — dropping");
      return;
    }
    entry.lastActivityMs = this.now();
    entry.cols = cols;
    entry.rows = rows;
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "sshResize",
        value: create(SshResizeSchema, { sessionId, cols, rows }),
      },
    });
    this.pushToAgent(entry.agentId, msg);
  }

  /**
   * Process one Agent → Server message. Returns `true` when the message was
   * consumed (i.e. it was an SSH-related variant), so the connectRPC
   * handler can short-circuit and skip its own dispatch fallback. The
   * connectRPC handler is the only caller — see grpc/agent-handler.ts.
   */
  handleAgentMessage(msg: AgentMessage): boolean {
    const payload = msg.payload;
    if (!payload || payload.case === undefined) return false;
    if (payload.case === "sshOutput") {
      const out = payload.value;
      const entry = this.sessions.get(out.sessionId);
      if (!entry) {
        this.logger.debug({ sessionId: out.sessionId }, "sshOutput for unknown session");
        return true;
      }
      entry.lastActivityMs = this.now();
      // Record the output chunk (output only — never keystrokes) before
      // forwarding, so a WS-send failure still captures what the agent sent.
      // Stop at the byte cap (append one truncation marker) so a noisy session
      // cannot exhaust Server memory.
      if (entry.events) {
        const used = entry.recordedBytes ?? 0;
        if (used < this.maxRecordingBytes) {
          entry.events.push({ tMs: this.now() - entry.openedAtMs, data: out.data });
          entry.recordedBytes = used + out.data.length;
          if (entry.recordedBytes >= this.maxRecordingBytes) {
            entry.events.push({
              tMs: this.now() - entry.openedAtMs,
              data: new TextEncoder().encode("\r\n[recording truncated: size cap reached]\r\n"),
            });
          }
        }
      }
      try {
        // ws.send accepts Uint8Array; we pass the raw bytes through.
        entry.ws.send(out.data);
      } catch (err) {
        this.logger.warn({ err, sessionId: out.sessionId }, "WS send failed — closing session");
        this.closeSession(out.sessionId, "ws send failed");
      }
      return true;
    }
    if (payload.case === "sshClosed") {
      const closed = payload.value;
      const entry = this.sessions.get(closed.sessionId);
      if (!entry) return true;
      this.finalizeSession(entry, closed.reason || "agent closed", /* notifyAgent */ false);
      return true;
    }
    return false;
  }

  /**
   * Close a session from the Server side — typically called when the WS
   * client disconnected. Sends SshClose to the agent so the ssh2 channel
   * is torn down, then removes the session entry.
   */
  closeSession(sessionId: string, reason = "closed by server"): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.finalizeSession(entry, reason, /* notifyAgent */ true);
  }

  /** Test-visible accessor. */
  activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Snapshot of every live session for the admin monitoring view. No secrets
   * or transcript bytes — just who is connected where, and for how long.
   */
  listSessions(): SshSessionSummary[] {
    const now = this.now();
    return Array.from(this.sessions.values()).map((e) => ({
      sessionId: e.sessionId,
      agentId: e.agentId,
      user: e.user,
      sourceIp: e.sourceIp,
      openedAtMs: e.openedAtMs,
      durationMs: now - e.openedAtMs,
    }));
  }

  /** Test-visible accessor. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Force-close every session idle (no input or output) for longer than the
   * configured idle timeout. No-op when the timeout is disabled (0). Returns
   * the number of sessions closed. Production calls this on an interval; tests
   * call it directly with an injected clock.
   */
  sweepIdleSessions(): number {
    if (this.idleTimeoutMs <= 0) return 0;
    const now = this.now();
    const stale: string[] = [];
    for (const e of this.sessions.values()) {
      if (now - e.lastActivityMs >= this.idleTimeoutMs) stale.push(e.sessionId);
    }
    for (const sessionId of stale) {
      this.closeSession(sessionId, "idle timeout");
    }
    return stale.length;
  }

  /**
   * Force-close every session whose total lifetime exceeds the configured
   * maximum, regardless of activity. No-op when disabled (0). Returns the number
   * closed. This is the absolute-lifetime bound idle timeout cannot enforce: an
   * active or compromised shell never goes idle, so without this it could hold a
   * privileged session indefinitely. Production calls it on the same interval as
   * the idle sweep; tests call it directly with an injected clock.
   */
  sweepAgedSessions(): number {
    if (this.maxSessionMs <= 0) return 0;
    const now = this.now();
    const aged: string[] = [];
    for (const e of this.sessions.values()) {
      if (now - e.openedAtMs >= this.maxSessionMs) aged.push(e.sessionId);
    }
    for (const sessionId of aged) {
      this.closeSession(sessionId, "max session duration exceeded");
    }
    return aged.length;
  }

  /**
   * Force-close every session bound to `agentId`. Called when the agent's
   * connectRPC stream drops — its ssh2 channels are already gone, so the
   * sessions would otherwise leave their WebSocket clients on a frozen terminal
   * (keystrokes silently dropped on the missing channel) while still holding a
   * concurrent-session slot. The agent is not notified (it is offline); the
   * client gets a clean WS close. Returns the number closed.
   */
  closeSessionsForAgent(agentId: string, reason = "agent disconnected"): number {
    const ids: string[] = [];
    for (const e of this.sessions.values()) {
      if (e.agentId === agentId) ids.push(e.sessionId);
    }
    for (const id of ids) {
      const entry = this.sessions.get(id);
      if (entry) this.finalizeSession(entry, reason, /* notifyAgent */ false);
    }
    return ids.length;
  }

  /** Attach (or replace) the recording sink. Used at startup once the object
   *  store backing the recordings is available. Sessions opened after this
   *  call are recorded. */
  setRecordSink(sink: SshRecordingSink): void {
    this.recordSink = sink;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private finalizeSession(entry: SessionEntry, reason: string, notifyAgent: boolean): void {
    this.sessions.delete(entry.sessionId);
    if (notifyAgent) {
      const close = create(ServerMessageSchema, {
        payload: {
          case: "sshClose",
          value: create(SshCloseSchema, { sessionId: entry.sessionId, reason }),
        },
      });
      this.pushToAgent(entry.agentId, close);
    }
    try {
      entry.ws.close(1000, reason);
    } catch (err) {
      this.logger.debug({ err, sessionId: entry.sessionId }, "WS close threw");
    }
    const endedAtMs = this.now();
    const durationMs = endedAtMs - entry.openedAtMs;
    this.logger.info(
      { sessionId: entry.sessionId, agentId: entry.agentId, reason, durationMs },
      "SSH session closed",
    );
    if (this.recordSink && entry.events && entry.events.length > 0) {
      this.recordSink({
        sessionId: entry.sessionId,
        agentId: entry.agentId,
        user: entry.user,
        actorUserId: entry.actorUserId ?? null,
        startedAtMs: entry.openedAtMs,
        endedAtMs,
        reason,
        events: entry.events,
        cols: entry.cols,
        rows: entry.rows,
      }).catch((err) => {
        this.logger.error({ err, sessionId: entry.sessionId }, "Failed to persist SSH recording");
      });
    }
    if (this.auditLog) {
      this.auditLog({
        kind: "session_close",
        sessionId: entry.sessionId,
        agentId: entry.agentId,
        user: entry.user,
        reason,
        durationMs,
        ts: new Date(),
      }).catch((err) => {
        this.logger.error({ err, sessionId: entry.sessionId }, "Failed to audit-log session_close");
      });
    }
    if (this.onSessionClosed) {
      Promise.resolve(
        this.onSessionClosed({
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          actorUserId: entry.actorUserId ?? null,
          reason,
        }),
      ).catch((err) => {
        this.logger.warn(
          { err, sessionId: entry.sessionId },
          "Failed to cleanup SSH session external state",
        );
      });
    }
  }

  /**
   * Reject a new session when the caller already holds the maximum number of
   * concurrent sessions, either on this agent or across all agents. Counts the
   * live `sessions` map by `user`; a closed session frees its slot because
   * `finalizeSession` removes the entry before the next open is attempted.
   */
  private enforceLimits(user: string, agentId: string): void {
    let perUser = 0;
    let perUserAgent = 0;
    for (const e of this.sessions.values()) {
      if (e.user !== user) continue;
      perUser++;
      if (e.agentId === agentId) perUserAgent++;
    }
    if (perUserAgent >= this.maxPerUserAgent) {
      throw new SshSessionLimitError(
        `session limit reached: ${user} already has ${perUserAgent} session(s) on ${agentId} (max ${this.maxPerUserAgent})`,
      );
    }
    if (perUser >= this.maxPerUser) {
      throw new SshSessionLimitError(
        `session limit reached: ${user} already has ${perUser} active session(s) (max ${this.maxPerUser})`,
      );
    }
  }

  /**
   * Sliding-window open-rate limit per user: prune timestamps older than the
   * window, reject when the remaining count has reached the cap, otherwise
   * record this open. Keeps a single account from storming the gateway with
   * rapid open/close churn even when no concurrent cap is hit.
   */
  private enforceOpenRate(user: string): void {
    const cutoff = this.now() - this.openWindowMs;
    const recent = (this.openLog.get(user) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.maxOpensPerWindow) {
      this.openLog.set(user, recent);
      throw new SshRateLimitError(
        `open rate limit: ${user} opened ${recent.length} session(s) within ${this.openWindowMs}ms (max ${this.maxOpensPerWindow})`,
      );
    }
    recent.push(this.now());
    this.openLog.set(user, recent);
  }

  private pushToAgent(agentId: string, msg: ServerMessage): boolean {
    const ch = this.dispatcher.getChannel(agentId);
    if (!ch) return false;
    ch.push(msg);
    return true;
  }
}
