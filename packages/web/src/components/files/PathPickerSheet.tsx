import { apiErrorReason, type CloudObject, type ClusterEntry } from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  Cloud,
  File,
  Folder,
  FolderSearch,
  HardDrive,
  Loader2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { ApiError, api } from "../../lib/api-client";
import { relativeFromNow } from "../../lib/format";
import { listAllNetDriveFiles } from "../../lib/netdrive-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import type { AgentRow } from "../agents/AgentCard";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  buildCloudBrowserRows,
  canNavigateClusterUp,
  findClusterRoot,
  fmtBytes,
  isClusterPathWithinRoots,
  joinClusterPath,
  parentCloudPrefix,
  parentClusterPath,
} from "./path-picker-utils";

export type PathPickerLocation = "cloud" | "cluster";
export type PathPickerMode = "file" | "directory";

export interface PathPickerSelection {
  location: PathPickerLocation;
  mode: PathPickerMode;
  path: string;
  id?: string;
  agentId?: string;
  siteId?: string;
  name?: string;
  size?: number | null;
}

interface NetDriveListResp {
  success: true;
  data: {
    files: Array<{
      id: string;
      path: string;
      size: number;
      mtime: string;
      canUse: boolean;
      canDelete: boolean;
    }>;
    total: number;
  };
}

interface ClusterResp {
  entries: ClusterEntry[];
  siteId: string;
  path: string | null;
  roots?: string[];
}

export interface PathPickerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: PathPickerMode;
  locations: PathPickerLocation[];
  initialLocation?: PathPickerLocation;
  initialCloudPrefix?: string;
  initialClusterPath?: string;
  initialAgentId?: string | null;
  title: string;
  description: string;
  onSelect: (selection: PathPickerSelection) => void;
}

export interface PathPickerFieldProps extends Omit<PathPickerSheetProps, "open" | "onOpenChange"> {
  value: string;
  emptyValue?: string;
  testId: string;
}

function firstLocation(
  locations: PathPickerLocation[],
  preferred?: PathPickerLocation,
): PathPickerLocation {
  if (preferred && locations.includes(preferred)) return preferred;
  return locations.includes("cloud") ? "cloud" : "cluster";
}

export function PathPickerField({
  value,
  emptyValue,
  testId,
  onSelect,
  ...pickerProps
}: PathPickerFieldProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fallbackEmptyValue = emptyValue ?? t("files.pathPicker.emptyValue");
  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={value || fallbackEmptyValue}
          data-testid={testId}
        >
          {value || fallbackEmptyValue}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-0"
          onClick={() => setOpen(true)}
          data-testid={`${testId}-picker`}
        >
          <FolderSearch />
          {t("files.pathPicker.choose")}
        </Button>
      </div>
      <PathPickerSheet
        {...pickerProps}
        open={open}
        onOpenChange={setOpen}
        onSelect={(selection) => {
          onSelect(selection);
          setOpen(false);
        }}
      />
    </>
  );
}

export function PathPickerSheet({
  open,
  onOpenChange,
  mode,
  locations,
  initialLocation,
  initialCloudPrefix = "",
  initialClusterPath = "",
  initialAgentId,
  title,
  description,
  onSelect,
}: PathPickerSheetProps) {
  const { t } = useTranslation();
  const activeOrganizationId = useActiveOrganizationId();
  const [location, setLocation] = useState<PathPickerLocation>(
    firstLocation(locations, initialLocation),
  );
  const [cloudPrefix, setCloudPrefix] = useState(initialCloudPrefix);
  const [requestedClusterPath, setRequestedClusterPath] = useState(initialClusterPath);
  const [selectedClusterRoot, setSelectedClusterRoot] = useState("");
  const [knownClusterRoots, setKnownClusterRoots] = useState<string[]>([]);
  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  const [selection, setSelection] = useState<PathPickerSelection | null>(null);
  const selectionRef = useRef<PathPickerSelection | null>(null);

  const updateSelection = useCallback((next: PathPickerSelection | null) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const handleBrowserSelection = useCallback(
    (next: PathPickerSelection) => {
      updateSelection(next);
      if (next.mode !== "directory") return;
      onSelect(next);
      onOpenChange(false);
    },
    [onOpenChange, onSelect, updateSelection],
  );

  useEffect(() => {
    if (!open) return;
    setLocation(firstLocation(locations, initialLocation));
    setCloudPrefix(initialCloudPrefix);
    setRequestedClusterPath(initialClusterPath);
    setSelectedClusterRoot("");
    setKnownClusterRoots([]);
    setAgentId(initialAgentId ?? "");
    updateSelection(null);
  }, [
    open,
    locations,
    initialLocation,
    initialCloudPrefix,
    initialClusterPath,
    initialAgentId,
    updateSelection,
  ]);

  const agentsQ = useQuery({
    queryKey: ["agents-list", activeOrganizationId],
    queryFn: () => api.get<{ agents: AgentRow[] }>("/agents"),
    enabled: open && locations.includes("cluster"),
    refetchInterval: open ? 30_000 : false,
  });
  const onlineAgents = useMemo(
    () => (agentsQ.data?.agents ?? []).filter((agent) => agent.status.toLowerCase() === "online"),
    [agentsQ.data],
  );
  const selectedAgent =
    onlineAgents.find((agent) => agent.agentId === agentId) ?? onlineAgents[0] ?? null;

  const cloudQ = useQuery({
    queryKey: ["files-cloud", activeOrganizationId],
    queryFn: () => listAllNetDriveFiles() as Promise<NetDriveListResp>,
    enabled: open && locations.includes("cloud"),
    refetchInterval: open ? 30_000 : false,
  });
  const clusterQ = useQuery({
    queryKey: [
      "files-cluster",
      activeOrganizationId,
      selectedAgent?.siteName,
      requestedClusterPath,
    ],
    queryFn: () => {
      const query = new URLSearchParams({
        agentId: selectedAgent?.agentId ?? "",
        siteId: selectedAgent?.siteName ?? "default",
      });
      if (requestedClusterPath) query.set("path", requestedClusterPath);
      return api.get<ClusterResp>(`/files/cluster?${query.toString()}`);
    },
    enabled: open && locations.includes("cluster") && !!selectedAgent,
    refetchInterval: open ? 30_000 : false,
  });

  const cloudObjects: CloudObject[] = useMemo(
    () =>
      (cloudQ.data?.data.files ?? []).map((file) => ({
        id: file.id,
        userId: "",
        key: file.path,
        size: file.size,
        contentType: "application/octet-stream",
        createdAt: file.mtime,
        modifiedAt: file.mtime,
        etag: "",
        canUse: file.canUse === true,
      })),
    [cloudQ.data],
  );
  const cloudRows = useMemo(
    () => buildCloudBrowserRows(cloudObjects, cloudPrefix),
    [cloudObjects, cloudPrefix],
  );
  const clusterEntries = clusterQ.data?.entries ?? [];
  const clusterPath = requestedClusterPath || clusterQ.data?.path || "";
  const responseClusterRoots = useMemo(
    () => clusterQ.data?.roots ?? (clusterQ.data?.path ? [clusterQ.data.path] : []),
    [clusterQ.data],
  );
  const clusterRoots = clusterQ.data ? responseClusterRoots : knownClusterRoots;
  const activeClusterRoot =
    selectedClusterRoot && clusterRoots.includes(selectedClusterRoot)
      ? selectedClusterRoot
      : findClusterRoot(clusterPath, clusterRoots);
  const cloudReady = !cloudQ.isLoading && !cloudQ.error;
  const clusterReady =
    !agentsQ.isLoading &&
    !clusterQ.isLoading &&
    !agentsQ.error &&
    !clusterQ.error &&
    Boolean(selectedAgent) &&
    clusterQ.data?.path === clusterPath;
  const canConfirm = isSelectionConfirmable(selection, {
    cloudObjects,
    cloudReady,
    clusterEntries,
    clusterPath,
    clusterReady,
    location,
    mode,
  });
  const showTabs = locations.length > 1;

  useEffect(() => {
    if (!clusterQ.isSuccess || !clusterPath) return;
    const inferredRoot = findClusterRoot(clusterPath, clusterRoots);
    if (!inferredRoot) return;
    setSelectedClusterRoot((current) =>
      current && clusterRoots.includes(current) && isClusterPathWithinRoots(clusterPath, [current])
        ? current
        : inferredRoot,
    );
  }, [clusterQ.isSuccess, clusterPath, clusterRoots]);

  useEffect(() => {
    if (!clusterQ.isSuccess) return;
    setKnownClusterRoots((current) =>
      current.length === responseClusterRoots.length &&
      current.every((root, index) => root === responseClusterRoots[index])
        ? current
        : responseClusterRoots,
    );
  }, [clusterQ.isSuccess, responseClusterRoots]);

  useEffect(() => {
    if (
      !requestedClusterPath ||
      !(clusterQ.error instanceof ApiError) ||
      clusterQ.error.status !== 403 ||
      apiErrorReason(clusterQ.error) !== "PATH_OUTSIDE_ALLOWED_ROOT"
    ) {
      return;
    }
    setRequestedClusterPath("");
    setSelectedClusterRoot("");
    setKnownClusterRoots([]);
    updateSelection(null);
  }, [clusterQ.error, requestedClusterPath, updateSelection]);

  const confirmSelection = () => {
    const current = selectionRef.current ?? selection;
    if (
      !current ||
      !isSelectionConfirmable(current, {
        cloudObjects,
        cloudReady,
        clusterEntries,
        clusterPath,
        clusterReady,
        location,
        mode,
      })
    )
      return;
    onSelect(current);
    onOpenChange(false);
  };

  const canSelectCurrentDirectory =
    mode === "directory" && (location === "cloud" || Boolean(selectedAgent && clusterPath));

  function selectCurrentDirectory() {
    if (!canSelectCurrentDirectory) return;
    if (location === "cloud") {
      const next: PathPickerSelection = {
        location: "cloud",
        mode: "directory",
        path: cloudPrefix,
        name: cloudPrefix.split("/").filter(Boolean).pop() ?? "/",
      };
      updateSelection(next);
      onSelect(next);
      onOpenChange(false);
      return;
    }
    if (!selectedAgent) return;
    const next: PathPickerSelection = {
      location: "cluster",
      mode: "directory",
      path: clusterPath,
      agentId: selectedAgent.agentId,
      siteId: selectedAgent.siteName,
      name: clusterPath.split("/").filter(Boolean).pop() ?? "/",
    };
    updateSelection(next);
    onSelect(next);
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="max-w-4xl" data-testid="path-picker-sheet">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <SheetBody className="flex min-h-0 flex-col gap-3">
          {showTabs ? (
            <Tabs
              value={location}
              onValueChange={(value) => setLocation(value as PathPickerLocation)}
            >
              <TabsList data-testid="path-picker-tabs">
                {locations.includes("cloud") ? (
                  <TabsTrigger value="cloud" data-testid="path-picker-tab-cloud">
                    <Cloud />
                    {t("files.pathPicker.cloud")}
                  </TabsTrigger>
                ) : null}
                {locations.includes("cluster") ? (
                  <TabsTrigger value="cluster" data-testid="path-picker-tab-cluster">
                    <HardDrive />
                    {t("files.pathPicker.cluster")}
                  </TabsTrigger>
                ) : null}
              </TabsList>
              <TabsContent value="cloud" className="min-h-0">
                <CloudBrowser
                  mode={mode}
                  prefix={cloudPrefix}
                  rows={cloudRows}
                  loading={cloudQ.isLoading}
                  error={cloudQ.error}
                  selectedPath={selection?.location === "cloud" ? selection.path : null}
                  onPrefixChange={(next) => {
                    setCloudPrefix(next);
                    updateSelection(null);
                  }}
                  onSelect={handleBrowserSelection}
                />
              </TabsContent>
              <TabsContent value="cluster" className="min-h-0">
                <ClusterBrowser
                  mode={mode}
                  agents={onlineAgents}
                  agent={selectedAgent}
                  path={clusterPath}
                  roots={clusterRoots}
                  activeRoot={activeClusterRoot}
                  canNavigateUp={canNavigateClusterUp(clusterPath, [activeClusterRoot])}
                  entries={clusterEntries}
                  loading={clusterQ.isLoading || agentsQ.isLoading}
                  error={clusterQ.error ?? agentsQ.error}
                  selectedPath={selection?.location === "cluster" ? selection.path : null}
                  emptyMessage={
                    clusterQ.isSuccess && !clusterPath
                      ? t("files.pathPicker.noAuthorizedRoot")
                      : undefined
                  }
                  onAgentChange={(next) => {
                    setAgentId(next);
                    setRequestedClusterPath("");
                    setSelectedClusterRoot("");
                    setKnownClusterRoots([]);
                    updateSelection(null);
                  }}
                  onRootChange={(next) => {
                    if (!clusterRoots.includes(next)) return;
                    setSelectedClusterRoot(next);
                    setRequestedClusterPath(next);
                    updateSelection(null);
                  }}
                  onPathChange={(next) => {
                    if (!isClusterPathWithinRoots(next, [activeClusterRoot])) return;
                    setRequestedClusterPath(next);
                    updateSelection(null);
                  }}
                  onSelect={handleBrowserSelection}
                />
              </TabsContent>
            </Tabs>
          ) : location === "cloud" ? (
            <CloudBrowser
              mode={mode}
              prefix={cloudPrefix}
              rows={cloudRows}
              loading={cloudQ.isLoading}
              error={cloudQ.error}
              selectedPath={selection?.location === "cloud" ? selection.path : null}
              onPrefixChange={(next) => {
                setCloudPrefix(next);
                updateSelection(null);
              }}
              onSelect={handleBrowserSelection}
            />
          ) : (
            <ClusterBrowser
              mode={mode}
              agents={onlineAgents}
              agent={selectedAgent}
              path={clusterPath}
              roots={clusterRoots}
              activeRoot={activeClusterRoot}
              canNavigateUp={canNavigateClusterUp(clusterPath, [activeClusterRoot])}
              entries={clusterEntries}
              loading={clusterQ.isLoading || agentsQ.isLoading}
              error={clusterQ.error ?? agentsQ.error}
              selectedPath={selection?.location === "cluster" ? selection.path : null}
              emptyMessage={
                clusterQ.isSuccess && !clusterPath
                  ? t("files.pathPicker.noAuthorizedRoot")
                  : undefined
              }
              onAgentChange={(next) => {
                setAgentId(next);
                setRequestedClusterPath("");
                setSelectedClusterRoot("");
                setKnownClusterRoots([]);
                updateSelection(null);
              }}
              onRootChange={(next) => {
                if (!clusterRoots.includes(next)) return;
                setSelectedClusterRoot(next);
                setRequestedClusterPath(next);
                updateSelection(null);
              }}
              onPathChange={(next) => {
                if (!isClusterPathWithinRoots(next, [activeClusterRoot])) return;
                setRequestedClusterPath(next);
                updateSelection(null);
              }}
              onSelect={handleBrowserSelection}
            />
          )}
        </SheetBody>
        <SheetFooter className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div
            className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            data-testid="path-picker-current"
            title={selection?.path ?? (location === "cloud" ? cloudPrefix || "/" : clusterPath)}
          >
            {selection?.path ?? (location === "cloud" ? cloudPrefix || "/" : clusterPath)}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("files.pathPicker.cancel")}
            </Button>
            {mode === "directory" ? (
              <Button
                type="button"
                variant="outline"
                disabled={!canSelectCurrentDirectory}
                onClick={selectCurrentDirectory}
                data-testid={
                  location === "cloud" ? "path-picker-cloud-current" : "path-picker-cluster-current"
                }
              >
                <Folder />
                {location === "cloud"
                  ? t("files.pathPicker.selectCurrentCloudDirectory")
                  : t("files.pathPicker.selectCurrentClusterDirectory")}
              </Button>
            ) : null}
            {mode === "file" ? (
              <Button
                type="button"
                disabled={!canConfirm}
                onClick={confirmSelection}
                data-testid="path-picker-confirm"
              >
                <Check />
                {t("files.pathPicker.chooseFile")}
              </Button>
            ) : null}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

interface CloudBrowserProps {
  mode: PathPickerMode;
  prefix: string;
  rows: ReturnType<typeof buildCloudBrowserRows>;
  loading: boolean;
  error: unknown;
  selectedPath: string | null;
  onPrefixChange: (next: string) => void;
  onSelect: (selection: PathPickerSelection) => void;
}

function CloudBrowser({
  mode,
  prefix,
  rows,
  loading,
  error,
  selectedPath,
  onPrefixChange,
  onSelect,
}: CloudBrowserProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[420px] flex-col overflow-hidden rounded-md border border-border">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-border bg-card/60 px-3">
        <div className="flex min-w-0 items-center gap-1">
          {prefix ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("files.pathPicker.cloudUp")}
              data-testid="path-picker-cloud-up"
              onClick={() => onPrefixChange(parentCloudPrefix(prefix))}
            >
              <ArrowUp />
            </Button>
          ) : null}
          <span
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={prefix || "/"}
          >
            {prefix || "/"}
          </span>
        </div>
      </div>
      <BrowserBody loading={loading} error={error} empty={t("files.pathPicker.cloudEmpty")}>
        {rows.length === 0 ? (
          <EmptyBrowserState message={t("files.pathPicker.cloudEmpty")} />
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
                {mode === "directory" ? (
                  <th
                    className="w-24 px-1 py-2 font-medium"
                    aria-label={t("files.table.actions")}
                  />
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                if (row.kind === "dir") {
                  const selected = selectedPath === row.fullPath;
                  return (
                    <tr
                      key={`cloud-dir:${row.fullPath}`}
                      data-testid={`path-picker-cloud-dir-${row.name}`}
                      onClick={() => onPrefixChange(row.fullPath)}
                      onDoubleClick={() => onPrefixChange(row.fullPath)}
                      className={rowClassName(selected)}
                    >
                      <td className="min-w-0 px-3 py-2 font-medium">
                        <div className="flex min-w-0 items-center gap-2">
                          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span
                            className="min-w-0 truncate font-mono text-xs"
                            title={`${row.name}/`}
                          >
                            {row.name}/
                          </span>
                        </div>
                      </td>
                      <td className="hidden px-3 py-2 text-right font-mono text-xs text-muted-foreground sm:table-cell">
                        {fmtBytes(row.totalSize)}
                      </td>
                      <td className="hidden px-3 py-2 font-mono text-[11px] text-muted-foreground md:table-cell">
                        {relativeFromNow(row.latestModifiedAt)}
                      </td>
                      {mode === "directory" ? (
                        <td className="px-3 py-2 text-right">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-0"
                            data-testid={`path-picker-cloud-choose-dir-${row.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelect({
                                location: "cloud",
                                mode,
                                path: row.fullPath,
                                name: row.name,
                              });
                            }}
                          >
                            {t("files.pathPicker.choose")}
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  );
                }
                const selected = selectedPath === row.obj.key;
                const usable = cloudObjectCanUse(row.obj);
                return (
                  <tr
                    key={row.obj.id}
                    data-testid={`path-picker-cloud-file-${row.obj.id}`}
                    onClick={() => {
                      if (mode !== "file" || !usable) return;
                      onSelect({
                        location: "cloud",
                        mode,
                        path: row.obj.key,
                        id: row.obj.id,
                        name: row.displayName,
                        size: row.obj.size,
                      });
                    }}
                    aria-disabled={mode === "file" && !usable}
                    title={!usable ? t("files.useUnavailable") : undefined}
                    className={rowClassName(selected, mode === "file" && usable)}
                  >
                    <td className="min-w-0 px-3 py-2 font-medium">
                      <div className="flex min-w-0 items-center gap-2">
                        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span
                          className="min-w-0 truncate font-mono text-xs"
                          title={row.displayName}
                        >
                          {row.displayName}
                        </span>
                        {!usable ? (
                          <span className="text-[10px] text-muted-foreground">
                            {t("files.viewOnly")}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="hidden px-3 py-2 text-right font-mono text-xs text-muted-foreground sm:table-cell">
                      {fmtBytes(row.obj.size)}
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-[11px] text-muted-foreground md:table-cell">
                      {relativeFromNow(row.obj.modifiedAt)}
                    </td>
                    {mode === "directory" ? <td className="px-3 py-2" /> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </BrowserBody>
    </div>
  );
}

interface ClusterBrowserProps {
  mode: PathPickerMode;
  agents: AgentRow[];
  agent: AgentRow | null;
  path: string;
  roots: string[];
  activeRoot: string;
  canNavigateUp: boolean;
  entries: ClusterEntry[];
  loading: boolean;
  error: unknown;
  selectedPath: string | null;
  emptyMessage?: string;
  onAgentChange: (agentId: string) => void;
  onRootChange: (root: string) => void;
  onPathChange: (path: string) => void;
  onSelect: (selection: PathPickerSelection) => void;
}

function ClusterBrowser({
  mode,
  agents,
  agent,
  path,
  roots,
  activeRoot,
  canNavigateUp,
  entries,
  loading,
  error,
  selectedPath,
  emptyMessage,
  onAgentChange,
  onRootChange,
  onPathChange,
  onSelect,
}: ClusterBrowserProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[420px] flex-col overflow-hidden rounded-md border border-border">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-border bg-card/60 px-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("files.pathPicker.clusterUp")}
            data-testid="path-picker-cluster-up"
            disabled={!canNavigateUp}
            onClick={() => onPathChange(parentClusterPath(path))}
          >
            <ArrowUp />
          </Button>
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={path}>
            {path}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {agents.length > 0 ? (
            <select
              data-testid="path-picker-agent-select"
              className="rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
              value={agent?.agentId ?? ""}
              onChange={(event) => onAgentChange(event.target.value)}
            >
              {agents.map((item) => (
                <option key={item.agentId} value={item.agentId}>
                  {item.siteName} · {item.schedulerType} {item.schedulerVersion}
                </option>
              ))}
            </select>
          ) : null}
          {roots.length > 1 ? (
            <select
              value={activeRoot}
              onChange={(event) => onRootChange(event.target.value)}
              aria-label={t("files.pathPicker.clusterRoot")}
              className="min-w-0 max-w-44 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
              data-testid="path-picker-cluster-root-select"
            >
              {roots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>
      <BrowserBody
        loading={loading}
        error={error}
        empty={
          emptyMessage ??
          (agent ? t("files.pathPicker.clusterEmpty") : t("files.pathPicker.noClusterAgent"))
        }
      >
        {entries.length === 0 ? (
          <EmptyBrowserState
            message={
              emptyMessage ??
              (agent ? t("files.pathPicker.clusterEmpty") : t("files.pathPicker.noClusterAgent"))
            }
          />
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
                {mode === "directory" ? (
                  <th
                    className="w-24 px-1 py-2 font-medium"
                    aria-label={t("files.table.actions")}
                  />
                ) : null}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const fullPath = joinClusterPath(path, entry.name);
                const selected = selectedPath === fullPath;
                return (
                  <tr
                    key={entry.name}
                    data-testid={`path-picker-cluster-${entry.kind}-${entry.name}`}
                    onClick={() => {
                      if (entry.kind === "dir") {
                        onPathChange(fullPath);
                        return;
                      }
                      if (mode === "file" && agent) {
                        onSelect({
                          location: "cluster",
                          mode,
                          path: fullPath,
                          agentId: agent.agentId,
                          siteId: agent.siteName,
                          name: entry.name,
                          size: entry.size,
                        });
                      }
                    }}
                    onDoubleClick={() => {
                      if (entry.kind === "dir") onPathChange(fullPath);
                    }}
                    className={rowClassName(selected, entry.kind === "dir" || mode === "file")}
                  >
                    <td className="min-w-0 px-3 py-2 font-medium">
                      <div className="flex min-w-0 items-center gap-2">
                        {entry.kind === "dir" ? (
                          <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <File className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className="min-w-0 truncate font-mono text-xs" title={entry.name}>
                          {entry.name}
                          {entry.kind === "dir" ? "/" : ""}
                        </span>
                      </div>
                    </td>
                    <td className="hidden px-3 py-2 text-right font-mono text-xs text-muted-foreground sm:table-cell">
                      {fmtBytes(entry.size)}
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-[11px] text-muted-foreground md:table-cell">
                      {relativeFromNow(entry.modifiedAt)}
                    </td>
                    {mode === "directory" ? (
                      <td className="px-3 py-2 text-right">
                        {entry.kind === "dir" && agent ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-0"
                            data-testid={`path-picker-cluster-choose-dir-${entry.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelect({
                                location: "cluster",
                                mode,
                                path: fullPath,
                                agentId: agent.agentId,
                                siteId: agent.siteName,
                                name: entry.name,
                                size: entry.size,
                              });
                            }}
                          >
                            {t("files.pathPicker.choose")}
                          </Button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </BrowserBody>
    </div>
  );
}

interface BrowserBodyProps {
  loading: boolean;
  error: unknown;
  empty: string;
  children: ReactNode;
}

function BrowserBody({ loading, error, empty, children }: BrowserBodyProps) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("files.pathPicker.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-40 items-center justify-center px-4 text-center text-xs text-status-failed">
        {toUserFacingError(error, t("files.pathPicker.loadFailed"))}
      </div>
    );
  }
  return <div className="flex-1 overflow-auto">{children ?? empty}</div>;
}

function isSelectionConfirmable(
  selection: PathPickerSelection | null,
  context: {
    cloudObjects: CloudObject[];
    cloudReady: boolean;
    clusterEntries: ClusterEntry[];
    clusterPath: string;
    clusterReady: boolean;
    location: PathPickerLocation;
    mode: PathPickerMode;
  },
): boolean {
  if (!selection || selection.location !== context.location || selection.mode !== context.mode) {
    return false;
  }
  if (selection.location === "cloud") {
    if (!context.cloudReady) return false;
    if (selection.mode === "directory") return true;
    return context.cloudObjects.some(
      (entry) =>
        entry.id === selection.id && entry.key === selection.path && cloudObjectCanUse(entry),
    );
  }
  if (!context.clusterReady) return false;
  if (selection.mode === "directory" && selection.path === context.clusterPath) return true;
  return context.clusterEntries.some(
    (entry) =>
      entry.kind === (selection.mode === "directory" ? "dir" : "file") &&
      joinClusterPath(context.clusterPath, entry.name) === selection.path,
  );
}

function cloudObjectCanUse(entry: CloudObject): boolean {
  return entry.canUse === true;
}

function EmptyBrowserState({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}

function rowClassName(selected: boolean, enabled = true): string {
  return cn(
    "border-t border-border",
    enabled ? "cursor-pointer hover:bg-muted/40" : "text-muted-foreground",
    selected ? "bg-brand-soft/40" : "",
  );
}
