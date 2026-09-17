import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSession } from "@kuintessence/shared/browser";
import { Copy, ScrollText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { AuditDrawer } from "./AuditDrawer";

const PROMPT_GUESS_RE = /\]\$\s*$/;

export interface SessionPaneProps {
  session: TerminalSession;
  onClose: (session: TerminalSession) => void;
}

interface ExecResp {
  output: string;
  session: TerminalSession;
}

export function SessionPane({ session, onClose }: SessionPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputBufferRef = useRef<string>("");
  const busyRef = useRef<boolean>(false);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({
    cols: session.cols,
    rows: session.rows,
  });
  const [auditOpen, setAuditOpen] = useState(false);
  const [size, setSize] = useState({ cols: session.cols, rows: session.rows });

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount once per session id
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: "#0B0D12",
        foreground: "#E5E7EB",
        cursor: "#4361EE",
        selectionBackground: "rgba(67,97,238,0.35)",
      },
      allowProposedApi: true,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    term.write(
      `\x1b[2mSession ${session.id.slice(0, 8)} · ${session.remoteUser}@${session.siteId}\x1b[0m\r\n`,
    );

    term.write(`[agent:${session.agentId}]$ `);

    const sub = term.onData((data) => {
      if (busyRef.current) return;
      if (data === "\r") {
        const cmd = inputBufferRef.current;
        inputBufferRef.current = "";
        term.write("\r\n");
        busyRef.current = true;
        runExec(session, `${cmd}\n`, (out) => term.write(out.replace(/\n/g, "\r\n")))
          .catch((err) => {
            term.write(
              `\r\n\x1b[31m${toUserFacingError(err, t("terminal.commandFailed"))}\x1b[0m\r\n`,
            );
          })
          .finally(() => {
            busyRef.current = false;
          });
        return;
      }
      if (data === "") {
        if (inputBufferRef.current.length === 0) return;
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        term.write("\b \b");
        return;
      }
      if (data >= " ") {
        inputBufferRef.current += data;
        term.write(data);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        const lastSize = lastSizeRef.current;
        if (cols === lastSize.cols && rows === lastSize.rows) return;
        lastSizeRef.current = { cols, rows };
        setSize({ cols, rows });
        api
          .post<TerminalSession>(`/terminal/sessions/${session.id}/resize`, { cols, rows })
          .catch(() => {});
      } catch {
        return;
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      sub.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // mount once per session id
  }, [session.id, session.remoteUser, session.siteId]);

  return (
    <div
      className="min-w-0 overflow-hidden rounded-md border border-border"
      data-testid="terminal-pane"
    >
      <div className="flex min-h-11 flex-col gap-2 border-b border-border bg-card/60 px-3 py-2 md:flex-row md:items-center">
        <span
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
          title={`opened ${session.openedAt}`}
          data-testid="terminal-session-label"
        >
          {session.remoteUser}@{session.siteId}
        </span>
        <span className="flex flex-wrap items-center gap-1 md:ml-auto">
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            data-testid="terminal-dimensions"
          >
            {size.cols}×{size.rows}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("terminal.copySessionId")}
            data-testid="terminal-copy-id"
            onClick={() => {
              void navigator.clipboard?.writeText(session.id);
              toast.message(t("terminal.copySessionIdSucceeded", { id: session.id.slice(0, 8) }));
            }}
          >
            <Copy />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("terminal.openAudit")}
            data-testid="terminal-open-audit"
            onClick={() => setAuditOpen(true)}
          >
            <ScrollText />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            data-testid="terminal-close"
            aria-label={t("terminal.closeSession", { siteId: session.siteId })}
            onClick={() => {
              api
                .delete<TerminalSession>(`/terminal/sessions/${session.id}`)
                .then((closed) => onClose(closed))
                .catch((err) => {
                  toast.error(toUserFacingError(err, t("terminal.closeFailed")));
                });
            }}
          >
            <X className="h-3.5 w-3.5" />
            {t("terminal.close")}
          </Button>
        </span>
      </div>
      <div
        ref={containerRef}
        className={cn("h-[min(58vh,680px)] min-h-80 bg-[#0B0D12] p-2 md:h-[calc(100vh-22rem)]")}
        data-testid="terminal-canvas"
      />
      <AuditDrawer session={session} open={auditOpen} onOpenChange={setAuditOpen} />
    </div>
  );
}

async function runExec(
  session: TerminalSession,
  input: string,
  write: (output: string) => void,
): Promise<void> {
  const r = await api.post<ExecResp>(`/terminal/sessions/${session.id}/exec`, { input });
  // Trim a trailing prompt-with-no-newline so xterm doesn't leave a blank line.
  write(PROMPT_GUESS_RE.test(r.output) ? r.output : `${r.output}\n`);
}
