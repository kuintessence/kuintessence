import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Loader2, RefreshCcw, ShieldOff, WifiOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSshStream } from "../../lib/use-ssh-stream";
import { useTheme } from "../ThemeProvider";
import { Button } from "../ui/button";

export interface SshTerminalProps {
  agentId: string;
}

interface SshTerminalView {
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  sendRef: { current: (bytes: Uint8Array) => void };
  resizeRef: { current: (cols: number, rows: number) => void };
  dataSub: { dispose: () => void };
  resizeSub: { dispose: () => void };
  appliedTranscriptChunks: number;
}

const terminalViewsByAgent = new Map<string, SshTerminalView>();

function terminalTheme(resolved: string | undefined) {
  return resolved === "dark"
    ? { background: "#1a1d27", foreground: "#cdd1da" }
    : { background: "#ffffff", foreground: "#1f2330" };
}

function createTerminalView(
  send: (bytes: Uint8Array) => void,
  resize: (cols: number, rows: number) => void,
  resolved: string | undefined,
): SshTerminalView {
  const sendRef = { current: send };
  const resizeRef = { current: resize };
  const host = document.createElement("div");
  host.className = "h-full w-full";
  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    theme: terminalTheme(resolved),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  const encoder = new TextEncoder();
  const dataSub = term.onData((data: string) => {
    sendRef.current(encoder.encode(data));
  });
  const resizeSub = term.onResize(({ cols, rows }) => {
    resizeRef.current(cols, rows);
  });

  return {
    host,
    term,
    fit,
    sendRef,
    resizeRef,
    dataSub,
    resizeSub,
    appliedTranscriptChunks: 0,
  };
}

function getOrCreateTerminalView(
  agentId: string,
  send: (bytes: Uint8Array) => void,
  resize: (cols: number, rows: number) => void,
  resolved: string | undefined,
): SshTerminalView {
  const existing = terminalViewsByAgent.get(agentId);
  if (existing) {
    existing.sendRef.current = send;
    existing.resizeRef.current = resize;
    existing.term.options.theme = terminalTheme(resolved);
    return existing;
  }
  const view = createTerminalView(send, resize, resolved);
  terminalViewsByAgent.set(agentId, view);
  return view;
}

function fitTerminal(view: SshTerminalView): void {
  try {
    view.fit.fit();
  } catch {
    // happy-dom doesn't implement layout — ignore.
  }
}

function syncTranscriptDelta(view: SshTerminalView, transcript: Uint8Array[]): void {
  for (const chunk of transcript.slice(view.appliedTranscriptChunks)) {
    view.term.write(chunk);
  }
  view.appliedTranscriptChunks = transcript.length;
}

function closeMessage(
  code: number | null,
  t: (key: string, options?: { defaultValue?: string }) => string,
): string | null {
  if (code === 401 || code === 4401) {
    return t("ssh.terminal.sessionExpired", { defaultValue: "登录状态已失效，请重新登录。" });
  }
  if (code === 403 || code === 4403 || code === 1008) {
    return t("ssh.terminal.unauthorized");
  }
  if (code === 4404) {
    return t("ssh.terminal.offline");
  }
  if (code === 4429) {
    return t("ssh.terminal.rateLimited", {
      defaultValue: "连接请求过于频繁，请稍后再试。",
    });
  }
  if (code === 1006 || code === 1011) {
    return t("ssh.terminal.unavailable", {
      defaultValue: "SSH 服务暂时不可用，请稍后重试。",
    });
  }
  return null;
}

export function resetSshTerminalViewsForTests(): void {
  for (const view of terminalViewsByAgent.values()) {
    view.dataSub.dispose();
    view.resizeSub.dispose();
    view.term.dispose();
  }
  terminalViewsByAgent.clear();
}

/**
 * Web SSH terminal pane.
 *
 * Mounts a single xterm instance bound to the `useSshStream(agentId)` hook.
 * Inbound binary frames are written into the terminal verbatim; user
 * keystrokes are forwarded back as raw bytes via `useSshStream.send`, and
 * xterm dimension changes are forwarded via `useSshStream.resize` so the
 * remote PTY re-flows.
 *
 * RBAC is enforced by the route layer (`ProtectedRoute` + role gate at
 * `Role.ORG_ADMIN+`). When the socket itself closes with `unauthorized` or
 * code 4404, this component renders the corresponding panel.
 *
 * Out of scope:
 *   - SFTP / file transfer
 *   - session sharing / observer mode
 *   - recording / playback (the live terminal; replay lives in Settings)
 */
export function SshTerminal({ agentId }: SshTerminalProps) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const stream = useSshStream(agentId);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SshTerminalView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const view = getOrCreateTerminalView(agentId, stream.send, stream.resize, resolved);
    viewRef.current = view;
    syncTranscriptDelta(view, stream.readTranscript());
    containerRef.current.replaceChildren(view.host);
    requestAnimationFrame(() => fitTerminal(view));

    const onResize = () => {
      fitTerminal(view);
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (containerRef.current?.contains(view.host)) {
        containerRef.current.removeChild(view.host);
      }
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [agentId, resolved, stream.readTranscript, stream.resize, stream.send]);

  // Pipe inbound bytes from the hook into xterm.
  useEffect(() => {
    stream.onData((bytes: Uint8Array) => {
      const view = viewRef.current;
      if (!view) return;
      view.term.write(bytes);
      view.appliedTranscriptChunks += 1;
    });
    return () => stream.onData(null);
  }, [stream.onData]);

  const isUnauthorized =
    stream.state === "closed" &&
    (stream.lastCode === 401 ||
      stream.lastCode === 403 ||
      stream.lastCode === 4401 ||
      stream.lastCode === 4403 ||
      stream.lastCode === 1008);
  const isOffline = stream.state === "closed" && stream.lastCode === 4404;

  return (
    <div className="space-y-3" data-testid="ssh-terminal">
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-xs"
        data-testid="ssh-status"
      >
        <SshStatusBanner state={stream.state} code={stream.lastCode} t={t} />
        {stream.state === "closed" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="ssh-reconnect"
            onClick={() => stream.reconnect()}
          >
            <RefreshCcw className="mr-1 h-3 w-3" />
            {t("ssh.terminal.reconnect")}
          </Button>
        ) : null}
      </div>

      {isUnauthorized ? (
        <div
          className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          data-testid="ssh-unauthorized"
        >
          <ShieldOff className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t("ssh.terminal.unauthorized")}</span>
        </div>
      ) : null}

      {isOffline && !isUnauthorized ? (
        <div
          className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          data-testid="ssh-offline"
        >
          <WifiOff className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t("ssh.terminal.offline")}</span>
        </div>
      ) : null}

      <div
        ref={containerRef}
        className="h-[60vh] w-full overflow-hidden rounded-md border border-border bg-card"
        data-testid="ssh-viewport"
      />
    </div>
  );
}

function SshStatusBanner({
  state,
  code,
  t,
}: {
  state: "idle" | "connecting" | "connected" | "closed";
  code: number | null;
  t: (key: string, options?: { defaultValue?: string }) => string;
}) {
  if (state === "connecting") {
    return (
      <span className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> {t("ssh.terminal.connecting")}
      </span>
    );
  }
  if (state === "connected") {
    return (
      <span className="flex items-center gap-2 text-status-success">
        <span className="h-2 w-2 rounded-full bg-current" /> {t("ssh.terminal.connected")}
      </span>
    );
  }
  if (state === "closed") {
    const detail = closeMessage(code, t);
    return (
      <span className="flex items-center gap-2 text-status-failed">
        <span className="h-2 w-2 rounded-full bg-current" /> {t("ssh.terminal.disconnected")}
        {detail ? <span className="text-muted-foreground">— {detail}</span> : null}
      </span>
    );
  }
  return <span className="text-muted-foreground">{t("ssh.terminal.idle")}</span>;
}
