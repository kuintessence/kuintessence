import type { Buffer } from "node:buffer";
import { createLogger } from "@kuintessence/shared";
import type { Logger } from "pino";
import type { Ssh2Factory } from "./client";
import { SshClient } from "./client";

/**
 * Agent-side SSH dispatch handler.
 *
 * Sits between the connectRPC stream (stream.ts) and the per-session
 * {@link SshClient}. The bidi stream layer hands us decoded SshOpen /
 * SshData / SshClose payloads; we drive the client and forward output /
 * closed events back through the injected `enqueue` callback.
 *
 * We intentionally keep this layer pure (no proto encoding here) so the
 * tests can drive lifecycle assertions with plain JS values.
 */

export interface SshOutgoingMessage {
  kind: "sshOutput" | "sshClosed";
  sessionId: string;
  /** sshOutput only */
  data?: Buffer;
  /** sshClosed only */
  reason?: string;
  /** sshClosed only */
  exitCode?: number;
}

export interface SshHandlerDeps {
  /** Inject a fake ssh2.Client factory in tests. */
  ssh2Factory?: Ssh2Factory;
  /** Outbound enqueue — wired to the connectRPC outbound queue in production. */
  enqueue: (msg: SshOutgoingMessage) => void;
  logger?: Logger;
  /** Reuse an existing client (advanced — most callers omit). */
  client?: SshClient;
  /** Restrict the ssh2 handshake to the modern algorithm allowlist. */
  strictAlgorithms?: boolean;
  /** Keepalive interval (ms) for dead-connection detection; 0 disables. */
  keepaliveIntervalMs?: number;
}

export interface SshOpenInput {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Base64 SHA-256 host-key pin; when set the ssh2 connect is verified. */
  expectedHostKeySha256?: string;
}

export class SshHandler {
  private readonly client: SshClient;
  private readonly logger: Logger;
  private readonly enqueue: (msg: SshOutgoingMessage) => void;

  constructor(deps: SshHandlerDeps) {
    this.logger = deps.logger ?? createLogger("agent-ssh-handler");
    this.enqueue = deps.enqueue;
    this.client =
      deps.client ??
      new SshClient({
        ssh2Factory: deps.ssh2Factory,
        logger: this.logger.child({ component: "ssh-client" }),
        strictAlgorithms: deps.strictAlgorithms,
        keepaliveIntervalMs: deps.keepaliveIntervalMs,
      });
    this.client.onOutput((sessionId, data) => {
      this.enqueue({ kind: "sshOutput", sessionId, data });
    });
    this.client.onClosed((sessionId, reason, exitCode) => {
      this.enqueue({ kind: "sshClosed", sessionId, reason, exitCode });
    });
  }

  /** Handle a Server SshOpen dispatch. */
  handleOpen(input: SshOpenInput): void {
    if (!input.sessionId) {
      this.logger.warn("SshOpen with empty sessionId — ignoring");
      return;
    }
    if (!input.password && !input.privateKey) {
      this.enqueue({
        kind: "sshClosed",
        sessionId: input.sessionId,
        reason: "auth payload missing",
      });
      return;
    }
    this.logger.info(
      { sessionId: input.sessionId, host: input.host, username: input.username },
      "Opening SSH session",
    );
    this.client.open(input.sessionId, {
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password,
      privateKey: input.privateKey,
      passphrase: input.passphrase,
      expectedHostKeySha256: input.expectedHostKeySha256,
    });
  }

  /** Handle a Server SshData dispatch. */
  handleData(sessionId: string, data: Buffer): void {
    if (!sessionId) {
      this.logger.warn("SshData with empty sessionId — ignoring");
      return;
    }
    this.client.write(sessionId, data);
  }

  /** Handle a Server SshResize dispatch — re-flow the remote PTY. */
  handleResize(sessionId: string, cols: number, rows: number): void {
    if (!sessionId) {
      this.logger.warn("SshResize with empty sessionId — ignoring");
      return;
    }
    this.client.resize(sessionId, cols, rows);
  }

  /** Handle a Server SshClose dispatch. */
  handleClose(sessionId: string, reason: string): void {
    if (!sessionId) {
      this.logger.warn("SshClose with empty sessionId — ignoring");
      return;
    }
    this.client.close(sessionId, reason || "closed by server");
  }

  /** Tear down every session. Used at agent shutdown. */
  shutdown(reason = "agent shutdown"): void {
    this.client.closeAll(reason);
  }

  /** Test-visible accessor. */
  activeCount(): number {
    return this.client.activeCount();
  }
}
