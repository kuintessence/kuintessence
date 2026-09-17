import type { CloudObject } from "@kuintessence/shared/browser";
import {
  ArrowUp,
  Download,
  EllipsisVertical,
  File,
  Folder,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { relativeFromNow } from "../../lib/format";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { type FileContextAction, FileContextMenu, type FileContextTarget } from "./FileContextMenu";
import { buildCloudBrowserRows, fmtBytes, parentCloudPrefix } from "./path-picker-utils";

type SortKey = "name" | "size" | "modified";

export type CloudPaneEntry = CloudObject;

export interface CloudPaneProps {
  title: string;
  emptyMessage: string;
  disabledMessage?: string;
  prefix: string;
  entries: CloudPaneEntry[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
  onUpload?: (files: FileList) => void;
  onPrefixChange?: (next: string) => void;
  onDownload?: (obj: CloudObject) => void;
  onDelete?: (obj: CloudPaneEntry) => void;
  deletingId?: string | null;
}

export function CloudPane({
  title,
  emptyMessage,
  disabledMessage,
  prefix,
  entries,
  selected,
  onSelect,
  onRefresh,
  onUpload,
  onPrefixChange,
  onDownload,
  onDelete,
  deletingId,
}: CloudPaneProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [isDragging, setIsDragging] = useState(false);
  const [contextTarget, setContextTarget] = useState<FileContextTarget | null>(null);
  const [contextTrigger, setContextTrigger] = useState<HTMLElement | null>(null);
  const [newEntryIds, setNewEntryIds] = useState<ReadonlySet<string>>(new Set());
  const knownEntryIdsRef = useRef<ReadonlySet<string> | null>(null);
  const rows = useMemo(() => buildCloudBrowserRows(entries, prefix), [entries, prefix]);
  const visibleRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? rows.filter((row) =>
          (row.kind === "dir" ? row.name : row.displayName).toLowerCase().includes(normalizedQuery),
        )
      : rows;
    return [...filtered].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      if (sortKey === "size") {
        const leftSize = left.kind === "dir" ? left.totalSize : left.obj.size;
        const rightSize = right.kind === "dir" ? right.totalSize : right.obj.size;
        return rightSize - leftSize;
      }
      if (sortKey === "modified") {
        const leftModified = left.kind === "dir" ? left.latestModifiedAt : left.obj.modifiedAt;
        const rightModified = right.kind === "dir" ? right.latestModifiedAt : right.obj.modifiedAt;
        return new Date(rightModified).getTime() - new Date(leftModified).getTime();
      }
      const leftName = left.kind === "dir" ? left.name : left.displayName;
      const rightName = right.kind === "dir" ? right.name : right.displayName;
      return leftName.localeCompare(rightName);
    });
  }, [rows, query, sortKey]);
  const total = rows.reduce((acc, r) => acc + (r.kind === "file" ? r.obj.size : r.totalSize), 0);
  const fileCount = rows.filter((r) => r.kind === "file").length;
  const folderCount = rows.length - fileCount;
  const selectedRow = rows.find((r) => r.kind === "file" && r.obj.id === selected);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canGoUp = !!onPrefixChange && prefix.length > 0;
  const uploadPrefix = prefix.replace(/\/$/, "") || "users/me";

  useEffect(() => {
    const currentIds = new Set(entries.map((entry) => entry.id));
    const previousIds = knownEntryIdsRef.current;
    knownEntryIdsRef.current = currentIds;
    if (previousIds === null) return;
    setNewEntryIds(new Set([...currentIds].filter((id) => !previousIds.has(id))));
  }, [entries]);
  const openContextMenu = (target: Omit<FileContextTarget, "x" | "y">, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setContextTrigger(anchor);
    setContextTarget({ ...target, x: rect.right, y: rect.bottom });
  };
  const onContextAction = (action: FileContextAction) => {
    if (!contextTarget) return;
    if (action === "delete") {
      const entry = entries.find((item) => item.id === contextTarget.resourceId);
      setContextTarget(null);
      if (entry?.canDelete) onDelete?.(entry);
      return;
    }
    const value = contextTarget.path || contextTarget.label;
    if (!navigator.clipboard) {
      toast.error(t("files.context.copyPathFailed"));
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => toast.success(t("files.context.copyPathSucceeded")))
      .catch(() => toast.error(t("files.context.copyPathFailed")));
    setContextTarget(null);
  };

  return (
    <section
      className={
        "flex h-full flex-col overflow-hidden rounded-md border " +
        (isDragging ? "border-brand bg-brand-soft/20" : "border-border")
      }
      data-testid="files-cloud-pane"
      aria-label={title}
      onDragOver={(event) => {
        if (!onUpload) return;
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(event) => {
        if (!onUpload) return;
        event.preventDefault();
        setIsDragging(false);
        if (event.dataTransfer.files.length > 0) onUpload(event.dataTransfer.files);
      }}
    >
      <div className="flex h-10 items-center justify-between gap-2 border-b border-border bg-card/60 px-3">
        <div className="flex items-center gap-1">
          {canGoUp ? (
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              aria-label={t("files.upOneLevel")}
              data-testid="files-cloud-up"
              onClick={() => onPrefixChange?.(parentCloudPrefix(prefix))}
            >
              <ArrowUp />
            </Button>
          ) : null}
          <span className="font-mono text-[11px] text-muted-foreground" title={prefix}>
            {title} · {prefix || "/"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onUpload ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                data-testid="files-cloud-upload-input"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onUpload(e.target.files);
                    e.target.value = "";
                  }
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                aria-label={t("files.uploadLocal")}
                title={t("files.uploadLocal")}
                data-testid="files-cloud-upload"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload />
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            aria-label={t("files.refreshCloud")}
            title={t("files.refreshCloud")}
            data-testid="files-cloud-refresh"
            onClick={onRefresh}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-b border-border bg-card/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("files.searchPlaceholder")}
            aria-label={t("files.searchPlaceholder")}
            className="h-8 font-mono text-xs"
            data-testid="files-cloud-search"
          />
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
            aria-label={t("files.sortBy")}
            className="h-8 rounded-md border border-border bg-card px-2 font-mono text-[11px]"
            data-testid="files-cloud-sort"
          >
            <option value="name">{t("files.sort.name")}</option>
            <option value="modified">{t("files.sort.modified")}</option>
            <option value="size">{t("files.sort.size")}</option>
          </select>
        </div>
        {onUpload ? (
          <div
            className="font-mono text-[10px] text-muted-foreground"
            data-testid="files-cloud-upload-target"
          >
            {t("files.uploadTarget", { prefix: uploadPrefix })}
          </div>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto">
        {visibleRows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            {disabledMessage ?? (query ? t("files.emptySearch") : emptyMessage)}
          </div>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="min-w-0 px-3 py-2 font-medium">{t("files.table.name")}</th>
                <th className="hidden px-3 py-2 font-medium text-right sm:table-cell">
                  {t("files.table.size")}
                </th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">
                  {t("files.table.modified")}
                </th>
                <th
                  className="w-[92px] px-1 py-2 font-medium sm:w-[72px]"
                  aria-label={t("files.table.actions")}
                />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                if (r.kind === "dir") {
                  return (
                    <tr
                      key={`dir:${r.fullPath}`}
                      data-testid={`files-cloud-dir-${r.name}`}
                      onClick={() => onPrefixChange?.(r.fullPath)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextTrigger(event.currentTarget);
                        setContextTarget({
                          x: event.clientX,
                          y: event.clientY,
                          label: `${r.name}/`,
                          path: r.fullPath,
                          kind: "dir",
                        });
                      }}
                      className="cursor-pointer border-t border-border hover:bg-muted/40"
                    >
                      <td className="min-w-0 px-3 py-2 font-medium">
                        <div className="flex min-w-0 items-center gap-2">
                          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 truncate font-mono text-xs" title={`${r.name}/`}>
                            {r.name}/
                          </span>
                          <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                            {t("files.childCount", { count: r.childCount })}
                          </span>
                        </div>
                      </td>
                      <td className="hidden px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground sm:table-cell">
                        {fmtBytes(r.totalSize)}
                      </td>
                      <td
                        className="hidden px-3 py-2 font-mono text-[11px] text-muted-foreground tabular-nums md:table-cell"
                        title={r.latestModifiedAt}
                      >
                        {relativeFromNow(r.latestModifiedAt)}
                      </td>
                      <td className="px-1 py-0 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                          aria-label={t("files.moreActions", { name: `${r.name}/` })}
                          data-testid={`files-cloud-more-dir-${r.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openContextMenu(
                              {
                                label: `${r.name}/`,
                                path: r.fullPath,
                                kind: "dir",
                              },
                              event.currentTarget,
                            );
                          }}
                        >
                          <EllipsisVertical />
                        </Button>
                      </td>
                    </tr>
                  );
                }
                const isSelected = selected === r.obj.id;
                const canUse = r.obj.canUse === true;
                return (
                  <tr
                    key={r.obj.id}
                    data-testid={`files-cloud-row-${r.obj.id}`}
                    onClick={() => onSelect(isSelected ? null : r.obj.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextTrigger(event.currentTarget);
                      setContextTarget({
                        x: event.clientX,
                        y: event.clientY,
                        label: r.displayName,
                        path: r.obj.key,
                        kind: "file",
                        resourceId: r.obj.id,
                      });
                    }}
                    className={
                      (newEntryIds.has(r.obj.id) ? "kq-motion kq-motion--item " : "") +
                      "cursor-pointer border-t border-border " +
                      (isSelected ? "bg-brand-soft/40" : "hover:bg-muted/40")
                    }
                    data-state={newEntryIds.has(r.obj.id) ? "open" : undefined}
                  >
                    <td className="min-w-0 px-3 py-2 font-medium">
                      <div className="flex min-w-0 items-center gap-2">
                        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate font-mono text-xs" title={r.displayName}>
                          {r.displayName}
                        </span>
                      </div>
                    </td>
                    <td className="hidden px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground sm:table-cell">
                      {fmtBytes(r.obj.size)}
                    </td>
                    <td
                      className="hidden px-3 py-2 font-mono text-[11px] text-muted-foreground tabular-nums md:table-cell"
                      title={r.obj.modifiedAt}
                    >
                      {relativeFromNow(r.obj.modifiedAt)}
                    </td>
                    <td className="px-1 py-0 text-right">
                      <div className="flex items-center justify-end">
                        {onDownload && canUse ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                            aria-label={t("files.downloadFile", { name: r.displayName })}
                            data-testid={`files-cloud-download-${r.obj.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDownload(r.obj);
                            }}
                          >
                            <Download />
                          </Button>
                        ) : null}
                        {!canUse ? (
                          <span
                            className="px-2 text-[10px] text-muted-foreground"
                            title={t("files.useUnavailable")}
                            data-testid={`files-cloud-view-only-${r.obj.id}`}
                          >
                            {t("files.viewOnly")}
                          </span>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                          disabled={deletingId === r.obj.id}
                          aria-label={t("files.moreActions", { name: r.displayName })}
                          data-testid={`files-cloud-more-${r.obj.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openContextMenu(
                              {
                                label: r.displayName,
                                path: r.obj.key,
                                kind: "file",
                                resourceId: r.obj.id,
                              },
                              event.currentTarget,
                            );
                          }}
                        >
                          {deletingId === r.obj.id ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <EllipsisVertical />
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          {t("files.itemCount", { count: folderCount + fileCount })} · {fmtBytes(total)}
        </span>
        {selected ? (
          <span
            className="min-w-0 truncate font-mono tabular-nums"
            data-testid="files-cloud-selected"
          >
            {t("files.selectedValue", {
              value: selectedRow?.kind === "file" ? selectedRow.displayName : selected,
            })}
          </span>
        ) : (
          <span className="font-mono tabular-nums">{t("files.selectedNone")}</span>
        )}
      </div>
      <FileContextMenu
        target={contextTarget}
        actions={
          contextTarget?.kind === "file" &&
          entries.some((entry) => entry.id === contextTarget.resourceId && entry.canDelete) &&
          onDelete
            ? ["copy", "delete"]
            : ["copy"]
        }
        disabledActions={{ delete: deletingId === contextTarget?.resourceId }}
        onAction={onContextAction}
        onClose={() => setContextTarget(null)}
        restoreFocusTo={contextTrigger}
      />
    </section>
  );
}
