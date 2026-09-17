import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  Cloud,
  FilePlus2,
  Folder,
  FolderPlus,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api, uploadFileToNetDrive } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { fmtBytes } from "../files/path-picker-utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export interface CommandWorkdirEntry {
  id: string;
  source: "cloud" | "upload";
  fileMetadataId: string;
  fileMetadataName: string;
  cloudPath: string;
  stagePath: string;
  size: number | null;
}

interface NetDriveListResp {
  success: true;
  data: {
    files: Array<{
      id: string;
      path: string;
      size: number;
      mtime: string;
    }>;
    total: number;
  };
}

type NetDriveFile = NetDriveListResp["data"]["files"][number];

interface BrowserFolderRow {
  kind: "folder";
  name: string;
  fullPath: string;
  childCount: number;
}

interface BrowserFileRow {
  kind: "file";
  file: NetDriveFile;
  displayName: string;
}

type BrowserRow = BrowserFolderRow | BrowserFileRow;

export interface CommandWorkdirDialogProps {
  entries: CommandWorkdirEntry[];
  folders?: string[];
  onApply: (entries: CommandWorkdirEntry[], folders: string[]) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  uploadPrefix: string;
}

export function CommandWorkdirDialog({
  entries,
  folders,
  onApply,
  onOpenChange,
  open,
  uploadPrefix,
}: CommandWorkdirDialogProps) {
  const { t } = useTranslation();
  const activeOrganizationId = useActiveOrganizationId();
  const [draft, setDraft] = useState<CommandWorkdirEntry[]>(entries);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [cloudPrefix, setCloudPrefix] = useState("");
  const [workdirPrefix, setWorkdirPrefix] = useState("");
  const [workdirFolders, setWorkdirFolders] = useState<string[]>([]);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(entries);
    setError(null);
    setQuery("");
    setCloudPrefix("");
    setWorkdirPrefix("");
    setWorkdirFolders(mergeFolderPaths(folders ?? [], folderPathsFromEntries(entries)));
    setNewFolderName("");
  }, [entries, folders, open]);

  const cloudQ = useQuery({
    queryKey: ["command-workdir-cloud-files", activeOrganizationId],
    queryFn: () => api.get<NetDriveListResp>("/netdrive/files"),
    enabled: open,
    refetchInterval: open ? 30_000 : false,
  });

  const files = cloudQ.data?.data.files ?? [];
  const cloudError = cloudQ.error
    ? toUserFacingError(
        cloudQ.error,
        t("jobs.commandWorkdir.cloudLoadFailed", {
          defaultValue: "无法加载 NetDrive 文件，请稍后重试。",
        }),
      )
    : null;
  const cloudActionsDisabled = cloudQ.isLoading || Boolean(cloudError);
  const confirmBlockedByCloudState = cloudActionsDisabled && draft.length > 0;
  const cloudRows = useMemo(
    () => buildBrowserRows(files, cloudPrefix, query),
    [cloudPrefix, files, query],
  );
  const workdirRows = useMemo(
    () => buildWorkdirRows(draft, workdirFolders, workdirPrefix),
    [draft, workdirFolders, workdirPrefix],
  );

  const addCloudFile = (file: NetDriveFile) => {
    setDraft((current) => {
      if (current.some((entry) => entry.fileMetadataId === file.id)) return current;
      return [
        ...current,
        {
          id: `cloud:${file.id}`,
          source: "cloud",
          fileMetadataId: file.id,
          fileMetadataName: filenameFromPath(file.path),
          cloudPath: file.path,
          stagePath: `${workdirPrefix}${filenameFromPath(file.path)}`,
          size: file.size,
        },
      ];
    });
  };

  const removeEntry = (id: string) => {
    setDraft((current) => current.filter((entry) => entry.id !== id));
  };

  const updateStagePath = (id: string, stagePath: string) => {
    setDraft((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, stagePath } : entry)),
    );
  };

  const onUpload = async (filesList: FileList | null) => {
    if (cloudActionsDisabled || !filesList || filesList.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(filesList)) {
        const committed = await uploadFileToNetDrive(file, uploadPrefix);
        setDraft((current) => [
          ...current,
          {
            id: `upload:${committed.id}`,
            source: "upload",
            fileMetadataId: committed.id,
            fileMetadataName: filenameFromPath(committed.path),
            cloudPath: committed.path,
            stagePath: `${workdirPrefix}${filenameFromPath(committed.path)}`,
            size: committed.size,
          },
        ]);
      }
    } catch (err) {
      toast.error(toUserFacingError(err, t("jobs.commandWorkdir.uploadFailed")));
    } finally {
      setUploading(false);
    }
  };

  const createWorkdirFolder = () => {
    const segments = normalizeFolderSegments(newFolderName);
    if (!segments) {
      setError(
        t("jobs.commandWorkdir.folderNameInvalid", {
          defaultValue: "Folder name must not contain '.', '..', or control characters.",
        }),
      );
      return;
    }
    if (segments.length === 0) return;
    const nextPath = `${workdirPrefix}${segments.join("/")}/`;
    setWorkdirFolders((current) => addUniqueFolder(current, nextPath));
    setError(null);
    setNewFolderName("");
  };

  const onNewFolderKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    createWorkdirFolder();
  };

  const renameWorkdirFolder = (fromPath: string, nextName: string) => {
    const name = normalizeFolderSegment(nextName);
    if (!name) return;
    const toPath = `${parentFolderPath(fromPath)}${name}/`;
    if (toPath === fromPath) return;
    setWorkdirFolders((current) => renameFolderPaths(current, fromPath, toPath));
    setDraft((current) =>
      current.map((entry) =>
        entry.stagePath.startsWith(fromPath)
          ? { ...entry, stagePath: `${toPath}${entry.stagePath.slice(fromPath.length)}` }
          : entry,
      ),
    );
    if (workdirPrefix.startsWith(fromPath)) {
      setWorkdirPrefix(`${toPath}${workdirPrefix.slice(fromPath.length)}`);
    }
  };

  const deleteWorkdirFolder = (path: string) => {
    setWorkdirFolders((current) => current.filter((folder) => !folder.startsWith(path)));
    setDraft((current) => current.filter((entry) => !entry.stagePath.startsWith(path)));
    if (workdirPrefix.startsWith(path)) {
      setWorkdirPrefix(parentFolderPath(path));
    }
  };

  const confirm = () => {
    if (confirmBlockedByCloudState) {
      setError(
        t("jobs.commandWorkdir.cloudStateUnverified", {
          defaultValue: "Wait for NetDrive files to load before applying staged files.",
        }),
      );
      return;
    }
    const validationError = validateEntries(draft, t);
    if (validationError) {
      setError(validationError);
      return;
    }
    onApply(draft, mergeFolderPaths(workdirFolders, folderPathsFromEntries(draft)));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(88vh,900px)] w-[min(calc(100vw-1rem),1160px)]"
        data-testid="command-workdir-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {t("jobs.commandWorkdir.title", { defaultValue: "Job working directory" })}
          </DialogTitle>
          <DialogDescription>
            {t("jobs.commandWorkdir.description", {
              defaultValue:
                "Choose NetDrive files or upload local files, then map them into the job run directory.",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4 lg:grid-cols-2">
          <section className="flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-background">
            <div className="border-b border-border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Cloud className="h-4 w-4 text-muted-foreground" />
                {t("jobs.commandWorkdir.cloud", { defaultValue: "NetDrive" })}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
                {cloudPrefix ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setCloudPrefix(parentFolderPath(cloudPrefix))}
                    aria-label={t("jobs.commandWorkdir.up", { defaultValue: "Up" })}
                    data-testid="command-workdir-cloud-up"
                  >
                    <ArrowUp />
                  </Button>
                ) : null}
                <span className="min-w-0 truncate" title={cloudPrefix || "/"}>
                  {cloudPrefix || "/"}
                </span>
              </div>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("jobs.commandWorkdir.searchCloud", {
                  defaultValue: "Search cloud files",
                })}
                className="mt-2"
                disabled={cloudActionsDisabled}
                data-testid="command-workdir-cloud-search"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {cloudQ.isLoading ? (
                <div className="p-3 text-sm text-muted-foreground">{t("common.loading")}</div>
              ) : cloudError ? (
                <div
                  className="p-3 text-sm text-status-failed"
                  data-testid="command-workdir-cloud-error"
                >
                  {t("software.unreachable", { defaultValue: "Unavailable" })}
                  <div className="mt-1 break-words text-xs text-muted-foreground">{cloudError}</div>
                </div>
              ) : cloudRows.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">
                  {t("software.noMatches", { defaultValue: "No matches" })}
                </div>
              ) : (
                <div className="grid gap-2">
                  {cloudRows.map((row) =>
                    row.kind === "folder" ? (
                      <button
                        key={row.fullPath}
                        type="button"
                        className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-muted/40"
                        onClick={() => setCloudPrefix(row.fullPath)}
                        data-testid={`command-workdir-cloud-dir-${safeTestId(row.fullPath)}`}
                      >
                        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" title={row.name}>
                            {row.name}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {t("jobs.commandWorkdir.childCount", {
                              count: row.childCount,
                              defaultValue: "{{count}} items",
                            })}
                          </span>
                        </span>
                      </button>
                    ) : (
                      <div
                        key={row.file.id}
                        className="grid min-w-0 gap-2 rounded-md border border-border bg-card p-3"
                        data-testid={`command-workdir-cloud-row-${row.file.id}`}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs" title={row.file.path}>
                            {row.displayName}
                          </div>
                          <div className="mt-1 truncate text-[11px] text-muted-foreground">
                            {fmtBytes(row.file.size)}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => addCloudFile(row.file)}
                          data-testid={`command-workdir-add-${row.file.id}`}
                        >
                          <FilePlus2 />
                          {t("jobs.commandWorkdir.add", { defaultValue: "Add" })}
                        </Button>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          </section>
          <section className="flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-background">
            <div className="grid gap-3 border-b border-border p-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {t("jobs.commandWorkdir.workdir", { defaultValue: "Working directory" })}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {t("jobs.commandWorkdir.fileCount", {
                    count: draft.length,
                    defaultValue: "{{count}} files",
                  })}
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
                <Input
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={onNewFolderKeyDown}
                  placeholder={t("jobs.commandWorkdir.newFolder", {
                    defaultValue: "New folder",
                  })}
                  className="h-8 min-w-0 flex-1 text-xs sm:w-36 sm:flex-none"
                  data-testid="command-workdir-new-folder-name"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={createWorkdirFolder}
                  data-testid="command-workdir-create-folder"
                >
                  <FolderPlus />
                  {t("jobs.commandWorkdir.createFolder", { defaultValue: "Create" })}
                </Button>
                <label
                  className={`inline-flex h-8 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium ${
                    cloudActionsDisabled
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer hover:bg-muted"
                  }`}
                >
                  {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
                  {t("jobs.commandWorkdir.upload", { defaultValue: "Upload" })}
                  <input
                    type="file"
                    multiple
                    className="sr-only"
                    disabled={cloudActionsDisabled}
                    onChange={(event) => onUpload(event.target.files)}
                    data-testid="command-workdir-upload"
                  />
                </label>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
              {workdirPrefix ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setWorkdirPrefix(parentFolderPath(workdirPrefix))}
                  aria-label={t("jobs.commandWorkdir.up", { defaultValue: "Up" })}
                  data-testid="command-workdir-up"
                >
                  <ArrowUp />
                </Button>
              ) : null}
              <span className="min-w-0 truncate" title={workdirPrefix || "/"}>
                {workdirPrefix || "/"}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="command-workdir-entries">
              {workdirRows.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                  {t("jobs.commandWorkdir.empty", {
                    defaultValue: "No files staged into the working directory.",
                  })}
                </div>
              ) : (
                <div className="grid gap-2">
                  {workdirRows.map((row) =>
                    row.kind === "folder" ? (
                      <div
                        key={row.fullPath}
                        className="grid min-w-0 gap-2 rounded-md border border-border bg-card p-3"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            onClick={() => setWorkdirPrefix(row.fullPath)}
                            data-testid={`command-workdir-open-dir-${safeTestId(row.fullPath)}`}
                          >
                            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span
                              className="min-w-0 flex-1 truncate text-sm font-medium"
                              title={row.fullPath}
                            >
                              {row.name}
                            </span>
                          </button>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {row.itemCount === 0
                              ? t("jobs.commandWorkdir.emptyFolder", {
                                  defaultValue: "Empty folder",
                                })
                              : t("jobs.commandWorkdir.childCount", {
                                  count: row.itemCount,
                                  defaultValue: "{{count}} items",
                                })}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteWorkdirFolder(row.fullPath)}
                            aria-label={t("jobs.commandWorkdir.deleteFolder", {
                              defaultValue: "Delete folder",
                            })}
                            data-testid={`command-workdir-delete-dir-${safeTestId(row.fullPath)}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                        <Input
                          value={row.name}
                          onChange={(event) =>
                            renameWorkdirFolder(row.fullPath, event.target.value)
                          }
                          className="min-w-0 font-mono text-xs"
                          data-testid={`command-workdir-rename-dir-${safeTestId(row.fullPath)}`}
                        />
                      </div>
                    ) : (
                      <div
                        key={row.entry.id}
                        className="grid min-w-0 gap-2 overflow-hidden rounded-md border border-border bg-card p-3"
                        data-testid={`command-workdir-entry-${row.entry.fileMetadataId}`}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0 overflow-hidden">
                            <div
                              className="truncate text-sm font-medium"
                              title={row.entry.fileMetadataName}
                            >
                              {row.entry.fileMetadataName}
                            </div>
                            <div
                              className="truncate font-mono text-[11px] text-muted-foreground"
                              title={row.entry.cloudPath}
                              data-testid={`command-workdir-entry-cloud-${row.entry.fileMetadataId}`}
                            >
                              {row.entry.cloudPath}
                            </div>
                          </div>
                          <Badge
                            variant={row.entry.source === "upload" ? "brand" : "outline"}
                            className="shrink-0"
                          >
                            {row.entry.source === "upload"
                              ? t("jobs.commandWorkdir.uploadSource", {
                                  defaultValue: "Upload",
                                })
                              : t("jobs.commandWorkdir.cloudSource", {
                                  defaultValue: "Cloud",
                                })}
                          </Badge>
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <Input
                            value={row.entry.stagePath}
                            onChange={(event) => updateStagePath(row.entry.id, event.target.value)}
                            className="min-w-0 truncate font-mono text-xs"
                            title={row.entry.stagePath}
                            data-testid={`command-workdir-stage-${row.entry.fileMetadataId}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => removeEntry(row.entry.id)}
                            aria-label={t("jobs.commandWorkdir.remove", {
                              defaultValue: "Remove",
                            })}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
            {error ? (
              <div className="border-t border-status-failed/30 p-3 text-xs text-status-failed">
                <span data-testid="command-workdir-error">{error}</span>
              </div>
            ) : null}
          </section>
        </DialogBody>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={confirm}
            disabled={confirmBlockedByCloudState}
            data-testid="command-workdir-confirm"
          >
            {t("common.confirm", { defaultValue: "Confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function filenameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "file";
}

function buildBrowserRows(files: NetDriveFile[], prefix: string, query: string): BrowserRow[] {
  const q = query.trim().toLowerCase();
  if (q) {
    return files
      .filter((file) => file.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ kind: "file", file, displayName: file.path }));
  }

  const folders = new Map<string, BrowserFolderRow>();
  const visibleFiles: BrowserFileRow[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      visibleFiles.push({ kind: "file", file, displayName: rest });
      continue;
    }
    const name = rest.slice(0, slash);
    const fullPath = `${prefix}${name}/`;
    const existing = folders.get(fullPath);
    if (existing) {
      existing.childCount += 1;
    } else {
      folders.set(fullPath, {
        kind: "folder",
        name,
        fullPath,
        childCount: 1,
      });
    }
  }

  return [
    ...[...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ...visibleFiles.sort((a, b) => a.displayName.localeCompare(b.displayName)),
  ];
}

interface WorkdirFolderRow {
  kind: "folder";
  name: string;
  fullPath: string;
  itemCount: number;
}

interface WorkdirFileRow {
  kind: "file";
  entry: CommandWorkdirEntry;
}

type WorkdirRow = WorkdirFolderRow | WorkdirFileRow;

function buildWorkdirRows(
  entries: CommandWorkdirEntry[],
  folders: string[],
  prefix: string,
): WorkdirRow[] {
  const folderMap = new Map<string, WorkdirFolderRow>();
  const files: WorkdirFileRow[] = [];
  for (const folder of folders) {
    addImmediateFolder(folderMap, folder, prefix);
  }
  for (const entry of entries) {
    if (!entry.stagePath.startsWith(prefix)) continue;
    const rest = entry.stagePath.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      files.push({ kind: "file", entry });
      continue;
    }
    addImmediateFolder(folderMap, `${prefix}${rest.slice(0, slash)}/`, prefix);
  }
  const foldersWithCounts = [...folderMap.values()].map((folder) => ({
    ...folder,
    itemCount: countWorkdirFolderItems(folder.fullPath, entries, folders),
  }));
  return [
    ...foldersWithCounts.sort((a, b) => a.name.localeCompare(b.name)),
    ...files.sort((a, b) => a.entry.stagePath.localeCompare(b.entry.stagePath)),
  ];
}

function addImmediateFolder(
  folderMap: Map<string, WorkdirFolderRow>,
  folderPath: string,
  prefix: string,
) {
  if (!folderPath.startsWith(prefix) || folderPath === prefix) return;
  const rest = folderPath.slice(prefix.length);
  const name = rest.split("/").filter(Boolean)[0];
  if (!name) return;
  const fullPath = `${prefix}${name}/`;
  if (!folderMap.has(fullPath)) {
    folderMap.set(fullPath, { kind: "folder", name, fullPath, itemCount: 0 });
  }
}

function countWorkdirFolderItems(
  folderPath: string,
  entries: CommandWorkdirEntry[],
  folders: string[],
): number {
  const childFolders = folders.filter(
    (folder) => folder !== folderPath && parentFolderPath(folder) === folderPath,
  );
  const childFiles = entries.filter((entry) => parentFolderPath(entry.stagePath) === folderPath);
  return childFolders.length + childFiles.length;
}

function folderPathsFromEntries(entries: CommandWorkdirEntry[]): string[] {
  const folders = new Set<string>();
  for (const entry of entries) {
    const parts = entry.stagePath.split("/").filter(Boolean);
    for (let index = 0; index < parts.length - 1; index += 1) {
      folders.add(`${parts.slice(0, index + 1).join("/")}/`);
    }
  }
  return [...folders];
}

function mergeFolderPaths(...groups: string[][]): string[] {
  const paths = new Set<string>();
  for (const folder of groups.flat()) {
    for (const path of folderPathWithAncestors(folder)) {
      paths.add(path);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function addUniqueFolder(folders: string[], path: string): string[] {
  return mergeFolderPaths(folders, [path]);
}

function renameFolderPaths(folders: string[], fromPath: string, toPath: string): string[] {
  const next = new Set<string>();
  for (const folder of folders) {
    next.add(folder.startsWith(fromPath) ? `${toPath}${folder.slice(fromPath.length)}` : folder);
  }
  next.add(toPath);
  return [...next];
}

function parentFolderPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "" : `${trimmed.slice(0, slash)}/`;
}

function normalizeFolderSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/") || trimmed === "." || trimmed === "..") return "";
  if ([...trimmed].some((char) => char.charCodeAt(0) < 0x20)) return "";
  return trimmed;
}

function normalizeFolderSegments(value: string): string[] | null {
  const segments = value
    .trim()
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        [...segment].some((char) => char.charCodeAt(0) < 0x20),
    )
  ) {
    return null;
  }
  return segments;
}

function folderPathWithAncestors(path: string): string[] {
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.map((_, index) => `${parts.slice(0, index + 1).join("/")}/`);
}

function safeTestId(value: string): string {
  return value.replace(/\/+$/, "").replaceAll(/[^a-zA-Z0-9_-]+/g, "-");
}

function validateEntries(
  entries: CommandWorkdirEntry[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const stagePath = entry.stagePath.trim();
    if (!stagePath) {
      return t("jobs.commandWorkdir.stagePathRequired", {
        defaultValue: "Stage path is required.",
      });
    }
    if (stagePath.split("/").some((part) => part === "..")) {
      return t("jobs.commandWorkdir.stagePathNoParent", {
        defaultValue: "Stage path must not contain '..'.",
      });
    }
    if ([...stagePath].some((char) => char.charCodeAt(0) < 0x20)) {
      return t("jobs.commandWorkdir.stagePathNoControl", {
        defaultValue: "Stage path must not contain control characters.",
      });
    }
    if (seen.has(stagePath)) {
      return t("jobs.commandWorkdir.stagePathUnique", {
        defaultValue: "Stage paths must be unique.",
      });
    }
    seen.add(stagePath);
  }
  return null;
}
