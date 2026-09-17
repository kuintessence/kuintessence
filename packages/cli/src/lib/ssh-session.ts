// -----------------------------------------------------------------------------
// SSH session driver — testable core for `kq ssh <agentId>`.
//
// The CLI command (commands/ssh.ts) wires real I/O (Bun WebSocket, process
// stdin/stdout/stderr) into this module. Tests substitute in-memory fakes for
// every dependency so the protocol behavior is verifiable without sockets.
//
// Protocol (Server-side: packages/server/src/routes/ssh.ts):
//   wss://<server>/api/ssh/sessions/:agentId
//   - both directions are raw bytes (binary frames)
//   - server may close with code 4404 + reason on auth/session failure
//   - clean close: code 1000 (server-initiated "ssh ended" or client-initiated
//     "client closed")
//
// Window resize is forwarded as a JSON text control frame
// (`{type:"resize",cols,rows}`) that the Server gateway recognises — binary
// frames remain raw stdin. Out of scope here (TODOs):
//   - SFTP / scp
//   - ProxyJump / multi-hop
//   - identity selection on the client (server picks creds by agentId)
//   - local session recording
// -----------------------------------------------------------------------------

/**
 * The minimal WebSocket surface this module needs. Both Bun's native
 * `WebSocket` and the standard `ws` library satisfy this shape. Resize
 * control frames are sent as strings; stdin is sent as binary.
 */
export interface SshWsLike {
  send(data: ArrayBufferView | ArrayBufferLike | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: (ev: Event) => void): void;
  addEventListener(type: "message", listener: (ev: MessageEvent<unknown>) => void): void;
  addEventListener(type: "close", listener: (ev: CloseEvent) => void): void;
  addEventListener(type: "error", listener: (ev: Event) => void): void;
}

/**
 * The minimal stdin surface. Node/Bun streams already match this; tests can
 * pass a hand-rolled fake (see ssh-session.test.ts).
 */
export interface SshStdinLike {
  on(event: "data", cb: (chunk: Uint8Array | Buffer) => void): unknown;
  on(event: "end", cb: () => void): unknown;
  off?(event: "data", cb: (chunk: Uint8Array | Buffer) => void): unknown;
  off?(event: "end", cb: () => void): unknown;
  removeListener?(event: "data", cb: (chunk: Uint8Array | Buffer) => void): unknown;
  removeListener?(event: "end", cb: () => void): unknown;
  setRawMode?(value: boolean): unknown;
  pause?(): unknown;
  resume?(): unknown;
}

export interface SshWriterLike {
  write(data: Uint8Array | string): boolean;
}

/**
 * Terminal size source for PTY resize forwarding. In production this wraps
 * `process.stdout` (`{cols,rows}` from `columns`/`rows`, `onResize` over the
 * `"resize"` event). Tests inject a fake. Only consulted in interactive TTY
 * mode — `--no-tty` and non-TTY stdin never forward resizes.
 */
export interface SshResizeSource {
  getSize(): { cols: number; rows: number } | null;
  onResize(cb: () => void): void;
  offResize?(cb: () => void): void;
}

export interface SshSessionDeps {
  ws: SshWsLike;
  stdin: SshStdinLike;
  stdout: SshWriterLike;
  stderr: SshWriterLike;
  /** True when stdin is attached to a real TTY. */
  isTty: boolean;
  /** When true, never put stdin in raw mode (pipe-friendly). */
  noTty: boolean;
  /** Used only for the connection banner / error text. */
  agentId: string;
  /** Optional terminal-size source; enables PTY resize forwarding in TTY mode. */
  resize?: SshResizeSource;
}

export interface SshSessionResult {
  exitCode: number;
  reason: string;
}

/**
 * Drive a Server SSH gateway WebSocket session to completion.
 *
 * Lifecycle:
 *   1. Wait for `open`. Print connection banner to stderr.
 *   2. If TTY mode is enabled, switch stdin to raw and resume reading.
 *   3. Forward stdin chunks as binary WS frames.
 *   4. Forward inbound binary messages straight to stdout.
 *   5. On stdin EOF, send a clean WS close (1000 "client closed").
 *   6. On WS close, restore stdin mode, print reason if non-clean,
 *      resolve with exit code (0 on clean close, 1 otherwise).
 */
export function runSshSession(deps: SshSessionDeps): Promise<SshSessionResult> {
  return new Promise<SshSessionResult>((resolve) => {
    const { ws, stdin, stdout, stderr, isTty, noTty, agentId, resize } = deps;
    let opened = false;
    let resolved = false;
    let rawModeSet = false;
    let stdinAttached = false;
    let winchHandler: (() => void) | null = null;

    const cleanup = (): void => {
      if (stdinAttached) {
        if (stdin.off) {
          stdin.off("data", onStdinData);
          stdin.off("end", onStdinEnd);
        } else if (stdin.removeListener) {
          stdin.removeListener("data", onStdinData);
          stdin.removeListener("end", onStdinEnd);
        }
        stdinAttached = false;
      }
      if (winchHandler && resize?.offResize) {
        try {
          resize.offResize(winchHandler);
        } catch {
          /* best-effort — a leaked listener is harmless once stdin is paused */
        }
        winchHandler = null;
      }
      if (rawModeSet && stdin.setRawMode) {
        try {
          stdin.setRawMode(false);
        } catch {
          // best-effort — swallowing is correct here since we're already
          // tearing down and a leaked raw-mode wedge is the worst case
        }
      }
      if (stdin.pause) {
        try {
          stdin.pause();
        } catch {
          /* ignore */
        }
      }
    };

    const finish = (exitCode: number, reason: string): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ exitCode, reason });
    };

    const onStdinData = (chunk: Uint8Array | Buffer): void => {
      try {
        // Buffer is a Uint8Array subclass on Node/Bun; either is fine.
        ws.send(chunk);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr.write(`ssh: failed to send to remote: ${msg}\n`);
      }
    };

    const onStdinEnd = (): void => {
      // EOF on stdin = client-initiated disconnect. Send a clean close;
      // the server's onClose handler will tear the relay down and emit
      // a confirming 1000 close back to us.
      try {
        ws.close(1000, "client closed");
      } catch {
        // ignore — close is already in flight
      }
    };

    ws.addEventListener("open", () => {
      opened = true;
      stderr.write(`ssh: connected to agent ${agentId}\n`);

      if (isTty && !noTty && stdin.setRawMode) {
        try {
          stdin.setRawMode(true);
          rawModeSet = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stderr.write(`ssh: failed to enter raw mode: ${msg}\n`);
        }
      }

      // Forward PTY size now and on every terminal resize so the remote shell
      // re-flows. Interactive TTY only — piped/`--no-tty` sessions have no size.
      if (isTty && !noTty && resize) {
        const sendResize = (): void => {
          const size = resize.getSize();
          if (!size) return;
          try {
            ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
          } catch {
            /* best-effort — a dropped resize only costs a momentarily wrong size */
          }
        };
        winchHandler = sendResize;
        resize.onResize(sendResize);
        sendResize();
      }

      stdin.on("data", onStdinData);
      stdin.on("end", onStdinEnd);
      stdinAttached = true;
      if (stdin.resume) {
        try {
          stdin.resume();
        } catch {
          /* ignore */
        }
      }
    });

    ws.addEventListener("message", (evt: MessageEvent<unknown>) => {
      const bytes = coerceInboundBytes(evt.data);
      if (bytes && bytes.length > 0) {
        stdout.write(bytes);
      }
    });

    ws.addEventListener("close", (evt: CloseEvent) => {
      const code = typeof evt.code === "number" ? evt.code : 1000;
      const reason = typeof evt.reason === "string" ? evt.reason : "";
      const isClean = code === 1000 || reason === "client closed" || reason === "ssh ended";

      if (!isClean) {
        const msg = reason || `ssh: connection closed with code ${code}`;
        stderr.write(`ssh: ${msg}\n`);
      } else if (!opened) {
        // server closed cleanly before open — surface it
        stderr.write(`ssh: ${reason || "connection closed"}\n`);
      }

      finish(isClean ? 0 : 1, reason);
    });

    ws.addEventListener("error", () => {
      // Let the close event carry the real reason. In some runtimes
      // 'error' fires without a follow-up 'close' (notably on TLS
      // handshake failures); guard against that with a fallback.
      if (!opened && !resolved) {
        stderr.write("ssh: connection error\n");
        finish(1, "connection error");
      }
    });
  });
}

/**
 * Normalize the many shapes a WebSocket `MessageEvent.data` can take into a
 * Uint8Array we can write to stdout. Mirrors the Server-side `coerceWsBytes`
 * helper but simpler — we only see binary on this socket.
 */
function coerceInboundBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof data === "object" && "buffer" in (data as ArrayBufferView)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof data === "string") {
    // Server's gateway sends binary frames only, but Blob/text fallback shows
    // up in browsers. The CLI never hits the Blob branch.
    return new TextEncoder().encode(data);
  }
  return null;
}

// -----------------------------------------------------------------------------
// URL builder + WebSocket factory — exposed so commands/ssh.ts can stay thin.
// -----------------------------------------------------------------------------

/** Build the wss:// URL for a given server base URL + agentId. */
export function buildSshWsUrl(serverUrl: string, agentId: string): string {
  // serverUrl examples: http://localhost:3000, https://server.example.com
  // We turn http -> ws, https -> wss; otherwise leave untouched.
  const trimmed = serverUrl.replace(/\/+$/, "");
  let wsBase: string;
  if (trimmed.startsWith("https://")) {
    wsBase = `wss://${trimmed.slice("https://".length)}`;
  } else if (trimmed.startsWith("http://")) {
    wsBase = `ws://${trimmed.slice("http://".length)}`;
  } else if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    wsBase = trimmed;
  } else {
    // Default to ws for unprefixed dev hosts.
    wsBase = `ws://${trimmed}`;
  }
  return `${wsBase}/api/ssh/sessions/${encodeURIComponent(agentId)}`;
}
