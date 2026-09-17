import type { TerminalSession } from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, RefreshCw, Server, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionPane } from "./SessionPane";

interface SessionsResp {
  sessions: TerminalSession[];
}

const STATUS_DOT: Record<string, string> = {
  opening: "bg-[var(--status-pending)]",
  open: "bg-[var(--status-running)]",
  closed: "bg-[var(--status-cancelled)]",
  errored: "bg-[var(--status-failed)]",
};

export function TerminalPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [newOpen, setNewOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sessionsQ = useQuery({
    queryKey: ["terminal-sessions"],
    queryFn: () => api.get<SessionsResp>("/terminal/sessions"),
    refetchInterval: 15_000,
  });

  const sessionsLoadError = sessionsQ.error as Error | null;
  const sessions = sessionsLoadError ? [] : (sessionsQ.data?.sessions ?? []);
  const open = sessions.filter((s) => s.state !== "closed");
  const active = open.find((s) => s.id === activeId) ?? open[0] ?? null;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["terminal-sessions"] });
  }

  function onCreated(session: TerminalSession) {
    setActiveId(session.id);
    refresh();
  }

  function onTabClose(s: TerminalSession) {
    if (sessionsLoadError) return;
    api
      .delete<TerminalSession>(`/terminal/sessions/${s.id}`)
      .catch((err) => {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      })
      .finally(() => {
        if (active?.id === s.id) setActiveId(null);
        refresh();
      });
  }

  function onPaneClose(s: TerminalSession) {
    if (active?.id === s.id) setActiveId(null);
    refresh();
  }

  return (
    <PageShell className="min-w-0" data-testid="terminal-page">
      <PageHeader
        title={t("terminal.title")}
        subtitle={t("terminal.subtitle")}
        meta={
          <div className="flex flex-wrap gap-2 text-xs">
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-muted-foreground"
              data-testid="terminal-mode-badge"
            >
              <TerminalSquare className="h-3.5 w-3.5" />
              {t("terminal.mode")}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t("terminal.auditBadge")}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-muted-foreground">
              <Server className="h-3.5 w-3.5" />
              {t("terminal.activeCount", { count: open.length })}
            </span>
          </div>
        }
        actions={
          <>
            <Button
              asChild
              variant="outline"
              className="min-w-0"
              data-testid="terminal-live-ssh-link"
            >
              <a href="/agents">
                {t("terminal.liveSsh")}
                <ArrowRight />
              </a>
            </Button>
            <Button
              variant="outline"
              data-testid="terminal-refresh"
              onClick={refresh}
              disabled={sessionsQ.isFetching}
            >
              <RefreshCw className={cn(sessionsQ.isFetching ? "animate-spin" : "")} />
              {t("terminal.refresh")}
            </Button>
            <Button
              data-testid="terminal-open-shell"
              onClick={() => setNewOpen(true)}
              disabled={Boolean(sessionsLoadError)}
            >
              <Plus />
              {t("terminal.openShell")}
            </Button>
          </>
        }
      />

      {sessionsLoadError ? (
        <div
          className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm text-status-failed"
          data-testid="terminal-sessions-error"
        >
          {toUserFacingError(sessionsLoadError, t("terminal.sessionsLoadFailed"))}
        </div>
      ) : open.length === 0 ? (
        <div
          className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
          data-testid="terminal-empty"
        >
          <TerminalSquare className="h-5 w-5" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">{t("terminal.noSessions")}</p>
            <p>{t("terminal.emptyHint")}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNewOpen(true)}
              disabled={Boolean(sessionsLoadError)}
            >
              {t("terminal.openShell")}
            </Button>
            <Button asChild size="sm" variant="ghost">
              <a href="/agents">{t("terminal.liveSsh")}</a>
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div
            className="flex gap-2 overflow-x-auto pb-1"
            data-testid="terminal-tabs"
            role="tablist"
            aria-label={t("terminal.openShellSessions")}
          >
            {open.map((s) => {
              const selected = active?.id === s.id;
              return (
                <div
                  key={s.id}
                  className={cn(
                    "flex min-w-max items-center gap-2 rounded-md border px-2 py-1 text-xs transition-colors",
                    selected
                      ? "border-brand bg-brand-soft text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    data-testid={`terminal-tab-${s.id}`}
                    onClick={() => setActiveId(s.id)}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[s.state])} />
                    <span className="max-w-48 truncate font-mono" title={s.siteId}>
                      {s.siteId}
                    </span>
                    <span>·</span>
                    <span className="font-mono">{s.remoteUser}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">{s.state}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t("terminal.closeSession", { siteId: s.siteId })}
                    data-testid={`terminal-tab-close-${s.id}`}
                    onClick={() => onTabClose(s)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>

          {open.map((session) => (
            <div
              key={session.id}
              role="tabpanel"
              data-testid={`terminal-panel-${session.id}`}
              hidden={active?.id !== session.id}
            >
              <SessionPane session={session} onClose={onPaneClose} />
            </div>
          ))}
        </>
      )}

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} onCreated={onCreated} />
    </PageShell>
  );
}
