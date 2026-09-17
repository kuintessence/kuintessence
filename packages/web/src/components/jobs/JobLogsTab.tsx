import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { useTheme } from "../ThemeProvider";

interface LogsResp {
  text: string;
}

const POLL_MS = 3_000;

export function JobLogsTab({
  jobId,
  terminal: terminalState,
}: {
  jobId: string;
  terminal?: boolean;
}) {
  void terminalState;
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(true);
  const { resolved } = useTheme();
  const showTerminal = !error;

  // Initialise xterm once.
  useEffect(() => {
    if (!showTerminal) return;
    if (!containerRef.current) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 5000,
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      theme:
        resolved === "dark"
          ? { background: "#1a1d27", foreground: "#cdd1da" }
          : { background: "#ffffff", foreground: "#1f2330" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    requestAnimationFrame(() => fit.fit());
    termRef.current = term;
    fitRef.current = fit;

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [resolved, showTerminal]);

  useEffect(() => {
    let cancelled = false;
    let lastText = "";

    async function poll() {
      try {
        const resp = await api.get<LogsResp>(`/jobs/${jobId}/logs?text=1`);
        if (cancelled) return;
        const text = resp.text ?? "";
        setError(null);
        if (!termRef.current) return;
        if (text === lastText) return;
        if (text.startsWith(lastText)) termRef.current.write(text.slice(lastText.length));
        else {
          termRef.current.reset();
          termRef.current.write(text);
        }
        lastText = text;
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "JOB_LOG_UNAVAILABLE") {
          setError(t("jobs.logs.unavailable"));
        } else if (err instanceof ApiError && err.status === 404) {
          setError(t("jobs.logs.notImplemented"));
        } else {
          setError(toUserFacingError(err, t("jobs.logs.loadFailed")));
        }
      } finally {
        setBusy(false);
      }
    }

    poll();
    const handle = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [jobId, t]);

  return (
    <div className="space-y-2" data-testid="job-logs-tab">
      {busy ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> {t("jobs.logs.connecting")}
        </div>
      ) : null}
      {error ? (
        <div
          className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          data-testid="job-logs-unavailable"
        >
          {error}
        </div>
      ) : null}
      {showTerminal ? (
        <div
          ref={containerRef}
          className="h-[50vh] w-full overflow-hidden rounded-md border border-border bg-card"
          data-testid="job-logs-terminal"
        />
      ) : null}
    </div>
  );
}
