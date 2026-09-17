import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createLogger } from "@kuintessence/shared";
import type { Logger } from "pino";
import type { ConnectConfig, ClientChannel as Ssh2ClientChannel } from "ssh2";
import { Client as DefaultSsh2Client } from "ssh2";

/** Base64 SHA-256 of a host's public key — the form a pin is compared against. */
export function hostKeySha256(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64");
}

/**
 * Modern SSH algorithm allowlist (OpenSSH ~7.x+). Opt-in via
 * `strictAlgorithms` — disables legacy KEX/ciphers/MACs that ssh2 still offers
 * for compatibility. Strong and widely supported, but pre-7.x servers may not
 * negotiate, which is why it is off by default.
 */
export const MODERN_SSH_ALGORITHMS = {
  kex: [
    "curve25519-sha256",
    "curve25519-sha256@libssh.org",
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384",
    "ecdh-sha2-nistp521",
    "diffie-hellman-group-exchange-sha256",
    "diffie-hellman-group16-sha512",
    "diffie-hellman-group18-sha512",
  ],
  cipher: [
    "chacha20-poly1305@openssh.com",
    "aes256-gcm@openssh.com",
    "aes128-gcm@openssh.com",
    "aes256-ctr",
    "aes192-ctr",
    "aes128-ctr",
  ],
  serverHostKey: [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
  ],
  hmac: [
    "hmac-sha2-256-etm@openssh.com",
    "hmac-sha2-512-etm@openssh.com",
    "hmac-sha2-256",
    "hmac-sha2-512",
  ],
} as const;

/**
 * per-Agent SSH relay.
 *
 * One {@link SshClient} owns N concurrent ssh2 sessions, each keyed by the
 * Server-minted `sessionId`. The handler layer (handler.ts) drives this client:
 *
 *   1. Server sends SshOpen → handler calls {@link SshClient.open}.
 *   2. Server sends SshData → handler calls {@link SshClient.write}.
 *   3. Server sends SshClose / channel ends → handler calls {@link SshClient.close}.
 *
 * Reverse flow: the client emits `output` on every stdout/stderr chunk and
 * `closed` on remote-side close (or error). The handler turns those into
 * SshOutput / SshClosed protobuf messages on the agent → Server stream.
 *
 * Jumphost chaining, X11 forwarding, and SFTP are out of scope. Adding them
 * later only needs new methods + new proto fields.
 */

export interface SshOpenParams {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /**
   * Base64 SHA-256 of the expected host public key. When set, the connection
   * is rejected unless the presented host key matches — pinning against MITM.
   * When absent, the host key is not verified (trust-on-first-use).
   */
  expectedHostKeySha256?: string;
}

export type SshOutputListener = (sessionId: string, data: Buffer) => void;
export type SshClosedListener = (sessionId: string, reason: string, exitCode?: number) => void;

/**
 * Minimal ssh2.Client surface this module depends on. Tests inject a fake
 * implementation so we never hit a real network.
 */
export interface Ssh2ClientLike {
  on(event: "ready", cb: () => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  on(event: "close", cb: () => void): this;
  on(event: "end", cb: () => void): this;
  shell(cb: (err: Error | undefined, stream: Ssh2ClientChannel) => void): boolean;
  connect(cfg: ConnectConfig): this;
  end(): this;
}

/** Factory for the underlying ssh2.Client instance. Tests override. */
export type Ssh2Factory = () => Ssh2ClientLike;

// `ssh2.Client.on` carries a deeply overloaded signature spanning ~15
// distinct event names; structurally narrowing it down to the four events
// this module needs is what `Ssh2ClientLike` is for. We cast through the
// real client at the factory boundary so call sites stay strictly typed.
const defaultFactory: Ssh2Factory = () => new DefaultSsh2Client() as unknown as Ssh2ClientLike;

interface ActiveSession {
  client: Ssh2ClientLike;
  channel: Ssh2ClientChannel | null;
  /** Pending stdin bytes received before the shell channel is open. */
  pendingWrites: Buffer[];
  /** Latest window size received before the shell channel was open; applied
   *  once it opens so the initial resize (sent right after connect) is never
   *  lost, which would otherwise pin the PTY to the default geometry. */
  pendingResize?: { cols: number; rows: number };
  closed: boolean;
  /** Set when the host-key pin rejected the presented key (drives a clear
   *  MITM-flavoured close reason instead of a generic ssh2 error). */
  hostKeyRejected?: boolean;
}

export interface SshClientDeps {
  /** Defaults to the real `ssh2.Client`. Tests override with a fake. */
  ssh2Factory?: Ssh2Factory;
  logger?: Logger;
  /** When true, restrict the handshake to {@link MODERN_SSH_ALGORITHMS}. */
  strictAlgorithms?: boolean;
  /**
   * Keepalive interval in ms. When > 0, ssh2 sends keepalives and drops the
   * connection after 3 unanswered ones — detecting a dead login-node link
   * (network partition) that would otherwise linger. 0 (default) disables it.
   */
  keepaliveIntervalMs?: number;
}

export class SshClient {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly factory: Ssh2Factory;
  private readonly logger: Logger;
  private readonly strictAlgorithms: boolean;
  private readonly keepaliveIntervalMs: number;
  private readonly outputListeners: SshOutputListener[] = [];
  private readonly closedListeners: SshClosedListener[] = [];

  constructor(deps: SshClientDeps = {}) {
    this.factory = deps.ssh2Factory ?? defaultFactory;
    this.logger = deps.logger ?? createLogger("agent-ssh-client");
    this.strictAlgorithms = deps.strictAlgorithms ?? false;
    this.keepaliveIntervalMs = deps.keepaliveIntervalMs ?? 0;
  }

  onOutput(cb: SshOutputListener): void {
    this.outputListeners.push(cb);
  }

  onClosed(cb: SshClosedListener): void {
    this.closedListeners.push(cb);
  }

  /** Open a new SSH session keyed by `sessionId`. Idempotent on the close. */
  open(sessionId: string, params: SshOpenParams): void {
    if (this.sessions.has(sessionId)) {
      this.logger.warn({ sessionId }, "open() called for an existing session — ignoring");
      return;
    }
    const client = this.factory();
    const session: ActiveSession = {
      client,
      channel: null,
      pendingWrites: [],
      closed: false,
    };
    this.sessions.set(sessionId, session);

    client.on("ready", () => {
      const ok = client.shell((err, channel) => {
        if (err) {
          this.emitClosed(sessionId, `shell open failed: ${err.message}`);
          this.cleanup(sessionId);
          return;
        }
        session.channel = channel;
        channel.on("data", (chunk: Buffer) => {
          this.emitOutput(sessionId, ensureBuffer(chunk));
        });
        // ssh2 emits stderr on the dedicated `extended data` event with type=1.
        channel.stderr?.on?.("data", (chunk: Buffer) => {
          this.emitOutput(sessionId, ensureBuffer(chunk));
        });
        channel.on("close", () => {
          this.emitClosed(sessionId, "channel closed");
          this.cleanup(sessionId);
        });
        channel.on("error", (chErr: Error) => {
          this.emitClosed(sessionId, `channel error: ${chErr.message}`);
          this.cleanup(sessionId);
        });
        // Flush anything that arrived before the channel was open.
        for (const buf of session.pendingWrites) {
          channel.write(buf);
        }
        session.pendingWrites.length = 0;
        // Apply the initial window size if a resize arrived before this point.
        if (session.pendingResize) {
          channel.setWindow(session.pendingResize.rows, session.pendingResize.cols, 0, 0);
          session.pendingResize = undefined;
        }
      });
      if (!ok) {
        // ssh2 returned synchronous "no more channels" backpressure refusal.
        this.emitClosed(sessionId, "shell open refused (out of channel slots)");
        this.cleanup(sessionId);
      }
    });

    client.on("error", (err: Error) => {
      const reason = session.hostKeyRejected
        ? "host key verification failed (possible MITM — pinned key did not match)"
        : `client error: ${err.message}`;
      this.emitClosed(sessionId, reason);
      this.cleanup(sessionId);
    });

    client.on("end", () => {
      // Remote end closed the transport before/after our explicit close.
      // Ensure we surface a `closed` event exactly once.
      this.emitClosed(sessionId, "client end");
      this.cleanup(sessionId);
    });

    client.on("close", () => {
      this.emitClosed(sessionId, "client close");
      this.cleanup(sessionId);
    });

    const cfg: ConnectConfig = {
      host: params.host,
      port: params.port,
      username: params.username,
    };
    if (params.password) cfg.password = params.password;
    if (params.privateKey) cfg.privateKey = params.privateKey;
    if (params.passphrase) cfg.passphrase = params.passphrase;
    // Host-key pinning: reject the handshake when the presented key doesn't
    // match the expected fingerprint. Without a pin, ssh2 performs no host-key
    // verification (the prior behaviour), so this is the MITM defense.
    if (params.expectedHostKeySha256) {
      const expected = params.expectedHostKeySha256;
      cfg.hostVerifier = (key: Buffer) => {
        const ok = hostKeySha256(key) === expected;
        if (!ok) session.hostKeyRejected = true;
        return ok;
      };
    }
    if (this.strictAlgorithms) {
      cfg.algorithms = MODERN_SSH_ALGORITHMS as unknown as ConnectConfig["algorithms"];
    }
    if (this.keepaliveIntervalMs > 0) {
      cfg.keepaliveInterval = this.keepaliveIntervalMs;
      cfg.keepaliveCountMax = 3;
    }
    try {
      client.connect(cfg);
    } catch (err) {
      this.emitClosed(
        sessionId,
        `connect threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.cleanup(sessionId);
    }
  }

  /** Forward stdin bytes to the SSH channel. Buffered until ready. */
  write(sessionId: string, data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn({ sessionId }, "write() to unknown session — dropping");
      return;
    }
    if (!session.channel) {
      session.pendingWrites.push(Buffer.from(data));
      return;
    }
    session.channel.write(data);
  }

  /**
   * Resize the PTY window so the remote shell re-flows. ssh2's
   * `setWindow(rows, cols, height, width)` takes cell counts first; pixel
   * dimensions are sent as 0 (unset). When the shell channel is not yet open
   * the size is buffered and applied the moment it opens, so the initial resize
   * is never lost.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    if (!session.channel) {
      // Channel not open yet — remember the latest size and apply it on open.
      session.pendingResize = { cols, rows };
      return;
    }
    session.channel.setWindow(rows, cols, 0, 0);
  }

  /** Tear down the session. Always emits exactly one `closed`. */
  close(sessionId: string, reason = "closed by server"): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    try {
      session.channel?.end();
    } catch {
      // ignore — we're tearing down anyway
    }
    try {
      session.client.end();
    } catch {
      // ignore
    }
    this.emitClosed(sessionId, reason);
    this.cleanup(sessionId);
  }

  /** Tear down every active session. Used at agent shutdown. */
  closeAll(reason = "agent shutdown"): void {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) this.close(id, reason);
  }

  /** Number of currently-active sessions. Used by health probes / tests. */
  activeCount(): number {
    return Array.from(this.sessions.values()).filter((s) => !s.closed).length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private emitOutput(sessionId: string, data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    for (const cb of this.outputListeners) {
      try {
        cb(sessionId, data);
      } catch (err) {
        this.logger.error({ err, sessionId }, "output listener threw");
      }
    }
  }

  private emitClosed(sessionId: string, reason: string, exitCode?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    for (const cb of this.closedListeners) {
      try {
        cb(sessionId, reason, exitCode);
      } catch (err) {
        this.logger.error({ err, sessionId }, "closed listener threw");
      }
    }
  }

  private cleanup(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.channel = null;
    session.pendingWrites.length = 0;
    this.sessions.delete(sessionId);
  }
}

function ensureBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
