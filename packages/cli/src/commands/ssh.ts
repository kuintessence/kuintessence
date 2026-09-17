import type { Command } from "commander";
import type { CliConfig } from "../lib/config";
import { loadCliConfig } from "../lib/config";
import {
  buildSshWsUrl,
  runSshSession,
  type SshResizeSource,
  type SshSessionResult,
  type SshStdinLike,
  type SshWriterLike,
  type SshWsLike,
} from "../lib/ssh-session";

// -----------------------------------------------------------------------------
// `kq ssh <agentId>` — open an interactive shell on the cluster login node
// behind <agentId> through the Server SSH gateway.
//
// Wire protocol (Server-side: packages/server/src/routes/ssh.ts):
//   wss://<server>/api/ssh/sessions/:agentId
//   - Auth: Bearer JWT via Authorization header (preferred for CLI)
//   - Both directions: raw bytes (binary frames)
//   - Server may close with code 4404 + reason on auth/session failure
//   - HTTP 403 during upgrade ⇒ RBAC denial (org_admin or above required)
//
// Window resize is forwarded (TTY mode) as a JSON control frame the gateway
// parses. Out of scope for now:
//   - SFTP / scp
//   - ProxyJump / multi-hop
//   - identity selection on the client side
//   - local session recording
// -----------------------------------------------------------------------------

export interface RunSshCommandOptions {
  agentId: string;
  noTty: boolean;
  config: CliConfig;
  stdin: SshStdinLike;
  stdout: SshWriterLike;
  stderr: SshWriterLike;
  isTty: boolean;
  /**
   * Inject a WebSocket-like factory. Tests pass an in-process fake;
   * production wiring uses Bun's native `WebSocket` (see `defaultWsFactory`).
   */
  wsFactory: (url: string, headers: Record<string, string>) => SshWsLike;
  /** Terminal-size source for PTY resize forwarding. Omitted in pipe contexts. */
  resize?: SshResizeSource;
}

/**
 * Pure async core of the `ssh` command. Decoupled from `process.*` and the
 * commander instance so tests can drive it deterministically.
 */
export async function runSshCommand(opts: RunSshCommandOptions): Promise<SshSessionResult> {
  if (!opts.config.token) {
    opts.stderr.write("ssh: not logged in (run `kq login` first)\n");
    return { exitCode: 1, reason: "not logged in" };
  }

  const url = buildSshWsUrl(opts.config.serverUrl, opts.agentId);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.config.token}`,
  };

  let ws: SshWsLike;
  try {
    ws = opts.wsFactory(url, headers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.stderr.write(`ssh: failed to open websocket: ${msg}\n`);
    return { exitCode: 1, reason: "ws open failed" };
  }

  // We intercept 403 close reasons emitted by the WS runtime when the HTTP
  // upgrade is rejected. Bun surfaces this as the standard 1006 close code
  // with a reason like "Unexpected server response: 403". We translate it
  // into a friendlier message before delegating to runSshSession's banner /
  // exit-code logic. To do this we wrap the close listener.
  const wrapped = wrapWsForRbac(ws, opts.stderr);

  const result = await runSshSession({
    ws: wrapped,
    stdin: opts.stdin,
    stdout: opts.stdout,
    stderr: opts.stderr,
    isTty: opts.isTty,
    noTty: opts.noTty,
    agentId: opts.agentId,
    resize: opts.resize,
  });

  return result;
}

/**
 * Terminal-size source backed by `process.stdout` — reports the live
 * `columns`/`rows` and fires on the stream's `"resize"` event (Node/Bun raise
 * it on SIGWINCH). Returns null size when stdout is not a sized TTY.
 */
function processResizeSource(): SshResizeSource {
  const out = process.stdout;
  return {
    getSize: () =>
      typeof out.columns === "number" && typeof out.rows === "number"
        ? { cols: out.columns, rows: out.rows }
        : null,
    onResize: (cb) => {
      out.on("resize", cb);
    },
    offResize: (cb) => {
      out.off("resize", cb);
    },
  };
}

/**
 * Forward all WS events through, but catch the specific 1006 + "403" close
 * reason and emit a permission-denied message before the inner session
 * driver formats its own generic close text. The wrapped object itself
 * is what we hand to runSshSession.
 */
function wrapWsForRbac(ws: SshWsLike, stderr: SshWriterLike): SshWsLike {
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    addEventListener: (type: string, cb: unknown) => {
      if (type === "close") {
        const wrappedCb = (evt: CloseEvent) => {
          if (looksLike403(evt)) {
            stderr.write("ssh: permission denied (org_admin or above required)\n");
            // Rewrite the event for the inner driver so its banner stays
            // consistent and exit code routes through the non-clean branch.
            const rewritten = {
              code: evt.code,
              reason: "permission denied (org_admin or above required)",
              wasClean: false,
            } as unknown as CloseEvent;
            (cb as (e: CloseEvent) => void)(rewritten);
            return;
          }
          (cb as (e: CloseEvent) => void)(evt);
        };
        // biome-ignore lint/suspicious/noExplicitAny: event-listener pass-through
        ws.addEventListener("close", wrappedCb as any);
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: event-listener pass-through
      ws.addEventListener(type as any, cb as any);
    },
  };
}

function looksLike403(evt: CloseEvent): boolean {
  const reason = typeof evt.reason === "string" ? evt.reason : "";
  return /\b403\b/.test(reason);
}

// -----------------------------------------------------------------------------
// Default Bun WebSocket factory + commander wiring
// -----------------------------------------------------------------------------

function defaultWsFactory(url: string, headers: Record<string, string>): SshWsLike {
  // Bun's native WebSocket constructor accepts `{ headers }` — verified on
  // Bun >= 1.1. If the runtime ever drops this, the catch falls back to a
  // ?token= query string with a one-line warning. (Browsers can't set
  // Authorization on `new WebSocket()` either — same workaround.)
  try {
    // biome-ignore lint/suspicious/noExplicitAny: Bun-specific options bag
    return new WebSocket(url, { headers } as any) as unknown as SshWsLike;
  } catch {
    const token = (headers.Authorization ?? "").replace(/^Bearer\s+/, "");
    const sep = url.includes("?") ? "&" : "?";
    const fallbackUrl = `${url}${sep}token=${encodeURIComponent(token)}`;
    process.stderr.write(
      "ssh: header auth unavailable, falling back to query token (less secure for shared shell history)\n",
    );
    return new WebSocket(fallbackUrl) as unknown as SshWsLike;
  }
}

/**
 * Run an interactive SSH session wired to the real process TTY, returning the
 * result instead of calling `process.exit`. Used by the TUI, which hands the
 * terminal to SSH and then resumes rendering — so it must NOT exit the process.
 * Always restores raw mode on the way out so a failed session can't wedge the
 * terminal before the TUI re-renders.
 */
export async function runInteractiveSsh(
  config: CliConfig,
  agentId: string,
): Promise<SshSessionResult> {
  const restoreTty = (): void => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
  };
  try {
    return await runSshCommand({
      agentId,
      noTty: false,
      config,
      stdin: process.stdin as unknown as SshStdinLike,
      stdout: process.stdout as unknown as SshWriterLike,
      stderr: process.stderr as unknown as SshWriterLike,
      isTty: Boolean(process.stdin.isTTY),
      wsFactory: defaultWsFactory,
      resize: processResizeSource(),
    });
  } finally {
    restoreTty();
  }
}

export function registerSshCommand(program: Command): void {
  program
    .command("ssh <agentId>")
    .description("Open an interactive shell on the cluster login node behind <agentId>")
    .option("--no-tty", "Don't put stdin in raw mode (useful for piping)")
    .action(async (agentId: string, opts: { tty?: boolean }) => {
      const config = loadCliConfig();
      // commander negates `--no-tty` into `opts.tty === false`. Default is on.
      const noTty = opts.tty === false;

      // Restore TTY raw mode on unexpected exit — leaking raw mode wedges
      // the user's terminal. Idempotent: runSshSession also restores in its
      // own cleanup path.
      const restoreTty = (): void => {
        try {
          if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
        } catch {
          /* ignore */
        }
      };
      const onUncaught = (err: Error): void => {
        restoreTty();
        process.stderr.write(`ssh: ${err.message}\n`);
        process.exit(1);
      };
      const onSignal = (): void => {
        restoreTty();
        process.exit(130);
      };
      process.on("uncaughtException", onUncaught);
      process.on("SIGTERM", onSignal);
      process.on("SIGHUP", onSignal);

      try {
        const result = await runSshCommand({
          agentId,
          noTty,
          config,
          stdin: process.stdin as unknown as SshStdinLike,
          stdout: process.stdout as unknown as SshWriterLike,
          stderr: process.stderr as unknown as SshWriterLike,
          isTty: Boolean(process.stdin.isTTY),
          wsFactory: defaultWsFactory,
          resize: processResizeSource(),
        });
        restoreTty();
        process.exit(result.exitCode);
      } finally {
        process.off("uncaughtException", onUncaught);
        process.off("SIGTERM", onSignal);
        process.off("SIGHUP", onSignal);
      }
    });
}
