import type { TerminalAuditFrame, TerminalSession } from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Copy, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { relativeFromNow } from "../../lib/format";
import { cn } from "../../lib/utils";
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

const KIND_FILTERS = ["ALL", "stdin", "stdout", "stderr", "resize", "error", "exit"] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

export interface AuditDrawerProps {
  session: TerminalSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AuditDrawer({ session, open, onOpenChange }: AuditDrawerProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<KindFilter>("ALL");
  const [search, setSearch] = useState("");

  const auditQ = useQuery({
    queryKey: ["terminal-audit", session.id, open],
    queryFn: () =>
      api.get<{ frames: TerminalAuditFrame[] }>(`/terminal/sessions/${session.id}/audit`),
    enabled: open,
    refetchInterval: open && session.state === "open" ? 5_000 : false,
  });

  const frames = auditQ.data?.frames ?? [];
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

  const totalBytes = frames.reduce((acc, f) => acc + f.data.length, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[720px] sm:max-w-[720px]" data-testid="terminal-audit-drawer">
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="font-mono text-sm">
              {t("terminal.auditTitle")} · {session.id.slice(0, 8)}
            </SheetTitle>
            <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("terminal.auditReadonly")}
            </span>
          </div>
          <SheetDescription>{t("terminal.auditDescription")}</SheetDescription>
        </SheetHeader>

        <SheetBody>
          <div className="space-y-4">
            <div
              className="rounded-md border border-border p-4 text-xs"
              data-testid="terminal-audit-meta"
            >
              <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 font-mono">
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
                  {session.openedAt} ({relativeFromNow(session.openedAt)})
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
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1" data-testid="terminal-audit-filter">
                {KIND_FILTERS.map((k) => {
                  const active = filter === k;
                  const n = counts[k] ?? 0;
                  return (
                    <button
                      key={k}
                      type="button"
                      data-testid={`terminal-audit-filter-${k}`}
                      onClick={() => setFilter(k)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 font-mono text-[11px]",
                        active
                          ? "border-brand bg-brand-soft text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      {k} ({n})
                    </button>
                  );
                })}
              </div>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="grep…"
                className="ml-auto h-7 w-40 font-mono text-xs"
                data-testid="terminal-audit-search"
              />
            </div>

            <div
              className="max-h-[50vh] overflow-auto rounded-md border border-border"
              data-testid="terminal-audit-list"
            >
              {auditQ.isLoading ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("terminal.auditLoading")}
                </div>
              ) : visible.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("terminal.auditNoFrames")}
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {visible.map((f, i) => {
                    const inbound = f.kind === "stdin";
                    const Icon = inbound ? ArrowUpRight : ArrowDownLeft;
                    return (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: frames are append-only; (ts,kind) is not unique
                        key={`${f.ts}-${f.kind}-${i}`}
                        className={cn(
                          "flex items-start gap-2 px-3 py-1.5 font-mono text-[11px]",
                          i % 2 === 1 ? "bg-muted/20" : "",
                        )}
                      >
                        <span
                          className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
                          title={f.ts}
                        >
                          {f.ts.slice(11, 23)}
                        </span>
                        <Icon
                          className={cn(
                            "h-3 w-3 shrink-0",
                            inbound ? "text-brand" : "text-muted-foreground",
                          )}
                        />
                        <span className="shrink-0 rounded-sm bg-muted/40 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {f.kind}
                        </span>
                        <span className="min-w-0 truncate" title={f.data}>
                          {f.data.replace(/\n/g, "⏎")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs"
              data-testid="terminal-audit-retention"
            >
              <span className="text-muted-foreground">{t("terminal.auditRetention")}</span>
              <Button
                size="sm"
                variant="outline"
                data-testid="terminal-audit-export"
                onClick={() => exportFrames(session, frames)}
              >
                <Download />
                {t("terminal.auditExport")}
              </Button>
            </div>
          </div>
        </SheetBody>

        <SheetFooter className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            data-testid="terminal-audit-summary"
          >
            {t("terminal.auditSummary", {
              count: frames.length,
              size: Math.round(totalBytes / 1024),
            })}
          </span>
          <span className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(session.id);
                toast.message(t("terminal.copySessionIdSucceeded", { id: session.id.slice(0, 8) }));
              }}
              data-testid="terminal-audit-copy-id"
            >
              <Copy />
              {t("terminal.copySessionIdShort")}
            </Button>
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
