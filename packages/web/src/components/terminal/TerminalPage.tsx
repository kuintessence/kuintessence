import type { TerminalSession } from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, RefreshCw, Server, ShieldCheck, TerminalSquare, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";
import { RefreshButton } from "../ui/refresh-button";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionPane } from "./SessionPane";

interface SessionsResp {
  sessions: TerminalSession[];
}

interface ClosingFocus {
  id: string;
  origin: HTMLElement;
  restoreOrigin: boolean;
  stop: () => void;
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
  const tabsId = useId();
  const [newOpen, setNewOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const pendingCloseIds = useRef(new Set<string>());
  const [closingIds, setClosingIds] = useState<ReadonlySet<string>>(() => new Set());
  const closingFocus = useRef<ClosingFocus | null>(null);
  const openShellRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);

  const sessionsQ = useQuery({
    queryKey: ["terminal-sessions"],
    queryFn: () => api.get<SessionsResp>("/terminal/sessions"),
    refetchInterval: 15_000,
  });

  const sessionsLoadError = sessionsQ.error as Error | null;
  const sessions = sessionsLoadError ? [] : (sessionsQ.data?.sessions ?? []);
  const open = sessions.filter((s) => s.state !== "closed");
  const active = open.find((s) => s.id === activeId) ?? open[0] ?? null;

  useEffect(() => () => closingFocus.current?.stop(), []);

  useLayoutEffect(() => {
    const pendingFocus = closingFocus.current;
    if (!pendingFocus) return;
    const stillOpen = open.some((session) => session.id === pendingFocus.id);
    if (stillOpen && !pendingFocus.restoreOrigin) return;

    pendingFocus.stop();
    if (document.activeElement !== document.body && document.activeElement !== pendingFocus.origin)
      return;

    if (stillOpen && !pendingFocus.origin.closest("[hidden]")) {
      pendingFocus.origin.focus();
    } else if (active) {
      document.getElementById(`${tabsId}-tab-${active.id}`)?.focus();
    } else {
      (sessionsLoadError ? refreshRef.current : openShellRef.current)?.focus();
    }
  }, [active, open, sessionsLoadError, tabsId]);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    let nextIndex: number;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = (index + open.length - 1) % open.length;
        break;
      case "ArrowRight":
        nextIndex = (index + 1) % open.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = open.length - 1;
        break;
      default:
        return;
    }

    const next = open[nextIndex];
    if (!next) return;
    event.preventDefault();
    setActiveId(next.id);
    document.getElementById(`${tabsId}-tab-${next.id}`)?.focus();
  }

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["terminal-sessions"] });
  }

  function onCreated(session: TerminalSession) {
    setActiveId(session.id);
    refresh();
  }

  function rememberClosingFocus(id: string) {
    const origin = document.activeElement;
    const region = `[data-terminal-session="${tabsId}-${id}"]`;
    if (!(origin instanceof HTMLElement) || !origin.closest(region)) return;

    closingFocus.current?.stop();
    const pendingFocus: ClosingFocus = {
      id,
      origin,
      restoreOrigin: false,
      stop() {
        document.removeEventListener("focusin", onFocusIn, true);
        closingFocus.current = null;
      },
    };
    // Disabling the close button can drop focus to the body while the request runs.
    function onFocusIn(event: FocusEvent) {
      if (event.target === document.body) return;
      if (event.target instanceof HTMLElement && event.target.closest(region)) {
        pendingFocus.origin = event.target;
      } else {
        pendingFocus.stop();
      }
    }
    closingFocus.current = pendingFocus;
    document.addEventListener("focusin", onFocusIn, true);
  }

  async function onSessionClose(session: TerminalSession) {
    const { id } = session;
    const pending = pendingCloseIds.current;
    if (sessionsLoadError || pending.has(id)) return;
    rememberClosingFocus(id);
    pending.add(id);
    setClosingIds(new Set(pending));

    try {
      await api.delete<TerminalSession>(`/terminal/sessions/${id}`).catch((err) => {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      });
      setActiveId((currentId) => (currentId === id ? null : currentId));
      await refresh();
    } catch (err) {
      if (closingFocus.current?.id === id) closingFocus.current.restoreOrigin = true;
      toast.error(toUserFacingError(err, t("terminal.closeFailed")));
    } finally {
      pending.delete(id);
      setClosingIds(new Set(pending));
    }
  }

  return (
    <PageShell className="min-w-0" data-testid="terminal-page">
      <PageHeader
        title={t("terminal.title")}
        meta={
          <div className="flex flex-wrap gap-2 text-xs">
            <span
              className="inline-flex items-center gap-1.5 border-border px-2.5 py-1 text-muted-foreground"
              data-testid="terminal-mode-badge"
            >
              <TerminalSquare className="h-3.5 w-3.5" />
              {t("terminal.mode")}
            </span>
            <span className="inline-flex items-center gap-1.5 border-border px-2.5 py-1 text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t("terminal.auditBadge")}
            </span>
            <span className="inline-flex items-center gap-1.5 border-border px-2.5 py-1 text-muted-foreground">
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
            <RefreshButton
              ref={refreshRef}
              variant="outline"
              data-testid="terminal-refresh"
              onClick={refresh}
              disabled={sessionsQ.isFetching}
              label={t("terminal.refresh")}
            >
              <RefreshCw className={cn(sessionsQ.isFetching ? "animate-spin" : "")} />
            </RefreshButton>
            <Button
              ref={openShellRef}
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
        <div className=" p-3 text-sm text-status-failed" data-testid="terminal-sessions-error">
          {toUserFacingError(sessionsLoadError, t("terminal.sessionsLoadFailed"))}
        </div>
      ) : open.length === 0 ? (
        <div
          className="flex min-h-48 flex-col items-center justify-center gap-3 border-border px-4 py-8 text-center text-sm text-muted-foreground"
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
            {open.map((s, index) => {
              const selected = active?.id === s.id;
              return (
                <div
                  key={s.id}
                  data-terminal-session={`${tabsId}-${s.id}`}
                  className={cn(
                    "flex min-w-max items-center gap-2 px-2 py-1 text-xs transition-colors",
                    selected ? " text-foreground" : "border-border text-muted-foreground ",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`${tabsId}-tab-${s.id}`}
                    aria-selected={selected}
                    aria-controls={`${tabsId}-panel-${s.id}`}
                    tabIndex={selected ? 0 : -1}
                    data-testid={`terminal-tab-${s.id}`}
                    onClick={() => setActiveId(s.id)}
                    onKeyDown={(event) => onTabKeyDown(event, index)}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <span className={cn("h-1.5 w-1.5 ", STATUS_DOT[s.state])} />
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
                    onClick={() => void onSessionClose(s)}
                    disabled={closingIds.has(s.id)}
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
              id={`${tabsId}-panel-${session.id}`}
              aria-labelledby={`${tabsId}-tab-${session.id}`}
              data-terminal-session={`${tabsId}-${session.id}`}
              data-testid={`terminal-panel-${session.id}`}
              hidden={active?.id !== session.id}
            >
              <SessionPane
                session={session}
                closing={closingIds.has(session.id)}
                onClose={onSessionClose}
              />
            </div>
          ))}
        </>
      )}

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} onCreated={onCreated} />
    </PageShell>
  );
}
