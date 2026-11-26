import type { TerminalAuditFrame, TerminalSession } from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { relativeFromNow } from "../../lib/format";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { fmtBytes } from "../files/path-picker-utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { SessionIdCopyButton } from "./SessionIdCopyButton";

const KIND_FILTERS = ["ALL", "stdin", "stdout", "stderr", "resize", "error", "exit"] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

export interface AuditDrawerProps {
  session: TerminalSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AuditDrawer({ session, open, onOpenChange }: AuditDrawerProps) {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState<KindFilter>("ALL");
  const [search, setSearch] = useState("");

  const auditQ = useQuery({
    queryKey: ["terminal-audit", session.id, open],
    queryFn: () =>
      api.get<{ frames: TerminalAuditFrame[] }>(`/terminal/sessions/${session.id}/audit`),
    enabled: open,
    refetchInterval: open && session.state === "open" ? 5_000 : false,
  });

  const frames = auditQ.isSuccess ? auditQ.data.frames : [];
  const counts = useMemo(() => {
    const out: Record<string, number> = { ALL: frames.length };
    for (const f of frames) out[f.kind] = (out[f.kind] ?? 0) + 1;
    return out;
  }, [frames]);

  const visible = useMemo(() => {
    return frames.filter((f) => {
      if (filter !== "ALL" && f.kind !== filter) return false;
      if (search.trim() && !f.data.toLowerCase().includes(search.trim().toLowerCase()))
        return false;
      return true;
    });
  }, [frames, filter, search]);

  const ready = auditQ.isSuccess;
  const totalBytes = useMemo(() => {
    const encoder = new TextEncoder();
    return frames.reduce((sum, frame) => sum + encoder.encode(frame.data).byteLength, 0);
  }, [frames]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="max-w-[720px]" data-testid="terminal-audit-drawer">
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{t("terminal.auditTitle")}</SheetTitle>
            <span className=" border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("terminal.auditReadonly")}
            </span>
          </div>
          <SheetDescription className="font-mono [overflow-wrap:anywhere]">
            {session.remoteUser}@{session.siteId}
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          <div className="space-y-4">
            <details
              className="border-b border-border pb-2 text-xs"
              data-testid="terminal-audit-meta"
            >
              <summary className="cursor-pointer py-1 text-sm font-medium">
                {t("terminal.auditSessionDetails")}
              </summary>
              <dl className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5 break-words font-mono [overflow-wrap:anywhere] sm:grid-cols-[120px_minmax(0,1fr)]">
                <dt className="text-muted-foreground">{t("terminal.sessionId")}</dt>
                <dd>{session.id}</dd>
                <dt className="text-muted-foreground">{t("terminal.auditSite")}</dt>
                <dd>{session.siteId}</dd>
                <dt className="text-muted-foreground">{t("terminal.auditAgent")}</dt>
                <dd>{session.agentId}</dd>
                <dt className="text-muted-foreground">{t("terminal.auditRemoteUser")}</dt>
                <dd>{session.remoteUser}</dd>
                <dt className="text-muted-foreground">{t("terminal.auditAuthMethod")}</dt>
                <dd>{session.authMethod}</dd>
                <dt className="text-muted-foreground">{t("terminal.auditOpened")}</dt>
                <dd title={session.openedAt}>
                  {session.openedAt} (
                  {relativeFromNow(session.openedAt, new Date(), i18n?.language)})
                </dd>
                <dt className="text-muted-foreground">{t("terminal.auditClosed")}</dt>
                <dd title={session.closedAt ?? undefined}>
                  {session.closedAt ? session.closedAt : t("terminal.auditStillOpen")}
                </dd>
                <dt className="text-muted-foreground">{t("terminal.auditBytes")}</dt>
                <dd className="tabular-nums">
                  {session.bytesIn} / {session.bytesOut}
                </dd>
              </dl>
            </details>

            {ready && frames.length > 0 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1" data-testid="terminal-audit-filter">
                  {KIND_FILTERS.map((k) => {
                    const active = filter === k;
                    const n = counts[k] ?? 0;
                    return (
                      <button
                        key={k}
                        type="button"
                        data-testid={`terminal-audit-filter-${k}`}
                        aria-pressed={active}
                        onClick={() => setFilter(k)}
                        className={cn(
                          "min-h-8 rounded-sm border px-2 font-mono text-xs",
                          active
                            ? "border-brand bg-brand-soft text-foreground"
                            : "border-border text-muted-foreground hover:bg-muted/60",
                        )}
                      >
                        {k === "ALL" ? t("terminal.auditAll") : k} ({n})
                      </button>
                    );
                  })}
                </div>
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  type="search"
                  aria-label={t("terminal.auditSearch")}
                  placeholder={t("terminal.auditSearch")}
                  className="w-full"
                  data-testid="terminal-audit-search"
                />
              </div>
            ) : null}

            <div
              className="max-h-[50vh] overflow-auto border-border"
              data-testid="terminal-audit-list"
            >
              {auditQ.isLoading ? (
                <div role="status" className="py-4 text-sm text-muted-foreground">
                  {t("terminal.auditLoading")}
                </div>
              ) : auditQ.isError ? (
                <div className="space-y-2 py-2">
                  <p role="alert" className="text-sm text-status-failed">
                    {toUserFacingError(auditQ.error, t("terminal.auditLoadFailed"))}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void auditQ.refetch()}
                    disabled={auditQ.isFetching}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              ) : frames.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">{t("terminal.auditEmpty")}</p>
              ) : visible.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  <p>{t("terminal.auditNoFrames")}</p>
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() => {
                      setFilter("ALL");
                      setSearch("");
                    }}
                  >
                    {t("terminal.auditClearFilters")}
                  </Button>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {visible.map((f, i) => {
                    const multiline = f.data.includes("\n") || f.data.length > 140;
                    return (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: frames are append-only; (ts,kind) is not unique
                        key={`${f.ts}-${f.kind}-${i}`}
                        className="min-w-0 space-y-1 py-2 font-mono text-xs"
                      >
                        <div className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                          <time dateTime={f.ts} title={f.ts} className="tabular-nums">
                            {f.ts.slice(11, 23)}
                          </time>
                          <span
                            className={cn(
                              "font-medium",
                              (f.kind === "stderr" || f.kind === "error") && "text-status-failed",
                            )}
                          >
                            {f.kind}
                          </span>
                        </div>
                        {multiline ? (
                          <details>
                            <summary className="cursor-pointer truncate leading-6">
                              {f.data.split("\n", 1)[0] || t("terminal.auditFrameContent")}
                            </summary>
                            <pre className="mt-1 whitespace-pre-wrap pb-1 leading-5 [overflow-wrap:anywhere]">
                              {f.data}
                            </pre>
                          </details>
                        ) : (
                          <p className="whitespace-pre-wrap leading-5 [overflow-wrap:anywhere]">
                            {f.data}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs"
              data-testid="terminal-audit-retention"
            >
              <span className="text-muted-foreground">{t("terminal.auditRetention")}</span>
              <Button
                size="sm"
                variant="outline"
                data-testid="terminal-audit-export"
                disabled={!ready || !frames.length}
                onClick={() => exportFrames(session, frames)}
              >
                <Download />
                {t("terminal.auditExport")}
              </Button>
            </div>
          </div>
        </SheetBody>

        <SheetFooter className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {ready ? (
            <span
              className="font-mono text-[11px] text-muted-foreground tabular-nums"
              data-testid="terminal-audit-summary"
            >
              {t("terminal.auditSummary", {
                count: frames.length,
                size: fmtBytes(totalBytes),
              })}
            </span>
          ) : null}
          <span className="ml-auto flex gap-2">
            <SessionIdCopyButton id={session.id} />
            <Button size="sm" onClick={() => onOpenChange(false)}>
              {t("terminal.close")}
            </Button>
          </span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function exportFrames(session: TerminalSession, frames: TerminalAuditFrame[]): void {
  const lines = frames.map((f) => JSON.stringify({ ts: f.ts, kind: f.kind, data: f.data }));
  const blob = new Blob([lines.join("\n")], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kq-terminal-audit-${session.id.slice(0, 8)}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
}
