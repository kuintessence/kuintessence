import { useQuery } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { useTheme } from "../ThemeProvider";
import { Button } from "../ui/button";

interface LogsResp {
  text: string;
}

const POLL_MS = 3_000;

export function JobLogsTab({ jobId }: { jobId: string }) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const logsQ = useQuery({
    queryKey: ["job-logs", jobId],
    queryFn: () => api.get<LogsResp>(`/jobs/${jobId}/logs?text=1`),
    retry: false,
    refetchInterval: POLL_MS,
  });
  const error = logsQ.error
    ? logsQ.error instanceof ApiError && logsQ.error.code === "JOB_LOG_UNAVAILABLE"
      ? t("jobs.logs.unavailable")
      : logsQ.error instanceof ApiError && logsQ.error.status === 404
        ? t("jobs.logs.notImplemented")
        : toUserFacingError(logsQ.error, t("jobs.logs.loadFailed"))
    : null;
  const showTerminal = !error;
  const text = logsQ.data?.text ?? "";

  return (
    <div className="space-y-2" data-testid="job-logs-tab">
      {logsQ.isPending ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> {t("jobs.logs.connecting")}
        </div>
      ) : null}
      {error ? (
        <div
          className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          data-testid="job-logs-unavailable"
        >
          <p role="alert">{error}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={logsQ.isFetching}
            onClick={() => void logsQ.refetch()}
          >
            {logsQ.isFetching ? t("common.loading") : t("common.retry")}
          </Button>
        </div>
      ) : null}
      {showTerminal ? (
        <LogTerminal key={`${jobId}:${resolved}`} theme={resolved} text={text} />
      ) : null}
    </div>
  );
}

function LogTerminal({ text, theme }: { text: string; theme: "light" | "dark" }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const lastTextRef = useRef("");
  // A new terminal needs the full snapshot, even if the log text has not changed.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 5000,
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      theme:
        theme === "dark"
          ? { background: "#1a1d27", foreground: "#cdd1da" }
          : { background: "#ffffff", foreground: "#1f2330" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    const frame = requestAnimationFrame(() => fit.fit());
    termRef.current = term;
    lastTextRef.current = "";

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      lastTextRef.current = "";
    };
  }, [theme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const previous = lastTextRef.current;
    if (text === previous) return;
    if (text.startsWith(previous)) term.write(text.slice(previous.length));
    else {
      term.reset();
      term.write(text);
    }
    lastTextRef.current = text;
  }, [text]);

  return (
    <div
      ref={containerRef}
      className="h-[50vh] w-full overflow-hidden rounded-md border border-border bg-card"
      data-testid="job-logs-terminal"
    />
  );
}
