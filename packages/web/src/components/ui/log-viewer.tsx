import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import type { AuditEntry } from "../../lib/dashboard-data";
import { toUserFacingError } from "../../lib/user-facing-error";
import { describeEvent } from "../dashboard/EventsList";
import { Button } from "./button";
import { Input } from "./input";
import { PaginationControls } from "./pagination-controls";
import { RefreshButton } from "./refresh-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

interface LogPage {
  entries: Partial<AuditEntry>[];
  total: number;
}
const PAGE_SIZE = 25;
const emptyFilter = { search: "", from: "", to: "" };

export function LogViewer({
  endpoint,
  title,
  description,
}: {
  endpoint: string;
  title: string;
  description?: string;
}) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState(emptyFilter);
  const [filter, setFilter] = useState(emptyFilter);
  const [page, setPage] = useState(0);
  const rangeError = Boolean(draft.from && draft.to && draft.from > draft.to);
  const query = useQuery({
    queryKey: ["log-viewer", endpoint, getAuthState().revision, filter, page],
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (filter.search) params.set("search", filter.search);
      if (filter.from) params.set("from", new Date(filter.from).toISOString());
      if (filter.to) params.set("to", new Date(filter.to).toISOString());
      return api.get<LogPage>(`${endpoint}?${params}`);
    },
  });
  return (
    <section className="space-y-3" data-testid="platform-audit-log">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <RefreshButton
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          data-testid="platform-audit-refresh"
        />
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (rangeError) return;
          setFilter({ ...draft, search: draft.search.trim() });
          setPage(0);
        }}
      >
        <Input
          className="min-w-0 flex-1 basis-52"
          type="search"
          maxLength={200}
          aria-label={t("logViewer.search")}
          placeholder={t("logViewer.search")}
          value={draft.search}
          onChange={(event) => setDraft({ ...draft, search: event.target.value })}
        />
        {(["from", "to"] as const).map((key) => (
          <label key={key} className="grid min-w-0 flex-1 basis-44 gap-1 text-xs">
            {t(key === "from" ? "logViewer.fromTime" : "logViewer.toTime")}
            <Input
              type="datetime-local"
              value={draft[key]}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
            />
          </label>
        ))}
        <Button type="submit" variant="outline" disabled={rangeError}>
          {t("logViewer.searchButton")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft(emptyFilter);
            setFilter(emptyFilter);
            setPage(0);
          }}
        >
          {t("logViewer.clear")}
        </Button>
      </form>
      {rangeError && (
        <p role="alert" className="text-sm text-status-failed">
          {t("cp.metering.invalidRange")}
        </p>
      )}
      {query.error ? (
        <div role="alert" className="text-sm text-status-failed" data-testid="platform-audit-error">
          {toUserFacingError(query.error, t("settings.operations.auditLog.loadFailed"))}
        </div>
      ) : query.isPending ? (
        <p role="status">{t("common.loading")}</p>
      ) : (
        <>
          <div className="overflow-x-auto border-y border-border" data-testid="log-viewer-records">
            <Table className="min-w-[38rem] text-sm">
              <TableHeader>
                <TableRow>
                  {[
                    "logViewer.time",
                    "logViewer.action",
                    "logViewer.actor",
                    "logViewer.target",
                    "logViewer.detail",
                  ].map((key) => (
                    <TableHead key={key} className="whitespace-nowrap px-3 py-2">
                      {t(key)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.entries.map((entry, index) => {
                  const event = entry.action
                    ? describeEvent({
                        ...entry,
                        id: entry.id ?? "",
                        actor: entry.actor ?? "",
                        action: entry.action,
                        target: entry.target ?? "",
                        createdAt: entry.createdAt ?? "",
                      })
                    : null;
                  const timestamp = Date.parse(entry.createdAt ?? "");
                  return (
                    <TableRow key={entry.id ?? `${page}-${index}`}>
                      <TableCell className="whitespace-nowrap px-3 py-2 text-xs tabular-nums">
                        {Number.isNaN(timestamp)
                          ? "—"
                          : new Date(timestamp).toLocaleString(i18n.language, {
                              dateStyle: "short",
                              timeStyle: "short",
                            })}
                      </TableCell>
                      <TableCell className="max-w-64 px-3 py-2 break-words" title={entry.action}>
                        {event ? t(event.labelKey, { defaultValue: event.defaultLabel }) : "—"}
                      </TableCell>
                      <TableCell className="max-w-48 px-3 py-2 break-all text-xs">
                        {entry.actor || "—"}
                      </TableCell>
                      <TableCell className="max-w-64 px-3 py-2 break-words text-xs">
                        {event?.subject || entry.target || "—"}
                      </TableCell>
                      <TableCell className="px-3 py-2">
                        <details>
                          <summary className="cursor-pointer text-xs text-brand">
                            {t("logViewer.detail")}
                          </summary>
                          <pre className="mt-2 max-h-64 max-w-md overflow-auto whitespace-pre-wrap break-all text-xs">
                            {JSON.stringify(entry, null, 2)}
                          </pre>
                        </details>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {query.data.entries.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("dashboard.noRecentEvents")}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t("logViewer.total", { count: query.data.total })}</span>
            <PaginationControls
              previous={{
                disabled: page === 0 || query.isFetching,
                onClick: () => setPage(page - 1),
              }}
              next={{
                disabled: (page + 1) * PAGE_SIZE >= query.data.total || query.isFetching,
                onClick: () => setPage(page + 1),
              }}
            >
              <span>{t("logViewer.page", { page: page + 1 })}</span>
            </PaginationControls>
          </div>
        </>
      )}
    </section>
  );
}
