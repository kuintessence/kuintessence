import type { ClusterEntry } from "@kuintessence/shared/browser";
import { ArrowUp, Download, EllipsisVertical, File, Folder, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { relativeFromNow } from "../../lib/format";
import type { AgentRow } from "../agents/AgentCard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { type FileContextAction, FileContextMenu, type FileContextTarget } from "./FileContextMenu";
import { fmtBytes, joinClusterPath, parentClusterPath } from "./path-picker-utils";

type SortKey = "name" | "size" | "modified";

export interface ClusterPaneProps {
  title: string;
  emptyMessage: string;
  noAgentMessage: string;
  disabledMessage?: string;
  agent: AgentRow | null;
  path: string;
  roots: string[];
  activeRoot: string;
  canNavigateUp: boolean;
  entries: ClusterEntry[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onAgentChange: (agentId: string) => void;
  onRootChange: (root: string) => void;
  onPathChange: (path: string) => void;
  onRefresh: () => void;
  onDownload?: (entry: ClusterEntry) => void;
  agents: AgentRow[];
}

export function ClusterPane({
  title,
  emptyMessage,
  noAgentMessage,
  disabledMessage,
  agent,
  path,
  roots,
  activeRoot,
  canNavigateUp,
  entries,
  selected,
  onSelect,
  onAgentChange,
  onRootChange,
  onPathChange,
  onRefresh,
  onDownload,
  agents,
}: ClusterPaneProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [contextTarget, setContextTarget] = useState<FileContextTarget | null>(null);
  const [contextTrigger, setContextTrigger] = useState<HTMLElement | null>(null);
  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? entries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery))
      : entries;
    return [...filtered].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      if (sortKey === "size") return (right.size ?? 0) - (left.size ?? 0);
      if (sortKey === "modified") {
        return new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime();
      }
      return left.name.localeCompare(right.name);
    });
  }, [entries, query, sortKey]);
  const total = entries.reduce((acc, e) => acc + (e.size ?? 0), 0);
  const openContextMenu = (entry: ClusterEntry, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setContextTrigger(anchor);
    setContextTarget({
      x: rect.right,
      y: rect.bottom,
      label: `${entry.name}${entry.kind === "dir" ? "/" : ""}`,
      path: joinClusterPath(path, entry.name),
      kind: entry.kind,
    });
  };
  const onContextAction = (action: FileContextAction) => {
    if (!contextTarget) return;
    if (action !== "copy") return;
    if (!navigator.clipboard) {
      toast.error(t("files.context.copyPathFailed"));
      return;
    }
    void navigator.clipboard
      .writeText(contextTarget.path)
      .then(() => toast.success(t("files.context.copyPathSucceeded")))
      .catch(() => toast.error(t("files.context.copyPathFailed")));
    setContextTarget(null);
  };

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-md border border-border"
      data-testid="files-cluster-pane"
    >
      <div className="border-b border-border bg-card/60 px-3 py-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              aria-label={t("files.upOneLevel")}
              title={t("files.upOneLevel")}
              data-testid="files-cluster-up"
              disabled={!canNavigateUp}
              onClick={() => onPathChange(parentClusterPath(path))}
            >
              <ArrowUp />
            </Button>
            <span className="text-sm font-medium">{title}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1">
            {agents.length === 0 ? (
              <span className="font-mono text-[11px] text-muted-foreground">{noAgentMessage}</span>
            ) : (
              <select
                data-testid="files-cluster-agent-select"
                className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-0.5 font-mono text-[11px] sm:max-w-80"
                value={agent?.agentId ?? ""}
                onChange={(e) => onAgentChange(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.siteName} · {a.schedulerType} {a.schedulerVersion}
                  </option>
                ))}
              </select>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 shrink-0 sm:min-h-9 sm:min-w-9"
              aria-label={t("files.refreshCluster")}
              title={t("files.refreshCluster")}
              data-testid="files-cluster-refresh"
              onClick={onRefresh}
            >
              <RefreshCw />
            </Button>
          </div>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 pl-9">
          {roots.length > 1 ? (
            <select
              value={activeRoot}
              onChange={(event) => onRootChange(event.target.value)}
              aria-label={t("files.clusterRoot")}
              className="min-w-0 max-w-48 rounded-md border border-border bg-card px-2 py-0.5 font-mono text-[11px]"
              data-testid="files-cluster-root-select"
            >
              {roots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          ) : null}
          <div
            className="min-w-0 flex-1 break-all font-mono text-[11px] leading-4 text-muted-foreground"
            title={path}
            data-testid="files-cluster-path"
          >
            {path}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 border-b border-border bg-card/30 px-3 py-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("files.searchPlaceholder")}
          aria-label={t("files.searchPlaceholder")}
          className="h-8 font-mono text-xs"
          data-testid="files-cluster-search"
        />
        <select
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as SortKey)}
          aria-label={t("files.sortBy")}
          className="h-8 rounded-md border border-border bg-card px-2 font-mono text-[11px]"
          data-testid="files-cluster-sort"
        >
          <option value="name">{t("files.sort.name")}</option>
          <option value="modified">{t("files.sort.modified")}</option>
          <option value="size">{t("files.sort.size")}</option>
        </select>
      </div>
      <div className="flex-1 overflow-auto">
        {visibleEntries.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            {disabledMessage ??
              (agent ? (query ? t("files.emptySearch") : emptyMessage) : noAgentMessage)}
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
              {visibleEntries.map((e) => {
                const isSelected = selected === e.name;
                const isFile = e.kind === "file";
                return (
                  <tr
                    key={e.name}
                    data-testid={
                      isFile ? `files-cluster-row-${e.name}` : `files-cluster-dir-${e.name}`
                    }
                    onClick={() => {
                      if (isFile) {
                        onSelect(isSelected ? null : e.name);
                        return;
                      }
                      onSelect(null);
                      onPathChange(joinClusterPath(path, e.name));
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextTrigger(event.currentTarget);
                      setContextTarget({
                        x: event.clientX,
                        y: event.clientY,
                        label: `${e.name}${e.kind === "dir" ? "/" : ""}`,
                        path: joinClusterPath(path, e.name),
                        kind: e.kind,
                      });
                    }}
                    className={
                      "cursor-pointer border-t border-border " +
                      (isSelected ? "bg-brand-soft/40" : "hover:bg-muted/40")
                    }
                  >
                    <td className="min-w-0 px-3 py-2 font-medium">
                      <div className="flex min-w-0 items-center gap-2">
                        {e.kind === "dir" ? (
                          <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <File className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className="min-w-0 truncate font-mono text-xs" title={e.name}>
                          {e.name}
                        </span>
                      </div>
                    </td>
                    <td className="hidden px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground sm:table-cell">
                      {fmtBytes(e.size)}
                    </td>
                    <td
                      className="hidden px-3 py-2 font-mono text-[11px] text-muted-foreground tabular-nums md:table-cell"
                      title={e.modifiedAt}
                    >
                      {relativeFromNow(e.modifiedAt)}
                    </td>
                    <td className="px-1 py-0 text-right">
                      <div className="flex items-center justify-end">
                        {isFile && onDownload ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                            aria-label={t("files.downloadFile", { name: e.name })}
                            data-testid={`files-cluster-download-${e.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onDownload(e);
                            }}
                          >
                            <Download />
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                          aria-label={t("files.moreActions", { name: e.name })}
                          data-testid={`files-cluster-more-${e.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openContextMenu(e, event.currentTarget);
                          }}
                        >
                          <EllipsisVertical />
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
          {t("files.itemCount", { count: entries.length })} · {fmtBytes(total)}
        </span>
        <span className="font-mono tabular-nums">
          {selected ? t("files.selectedValue", { value: selected }) : t("files.selectedNone")}
        </span>
      </div>
      <FileContextMenu
        target={contextTarget}
        actions={["copy"]}
        onAction={onContextAction}
        onClose={() => setContextTarget(null)}
        restoreFocusTo={contextTrigger}
      />
    </div>
  );
}
