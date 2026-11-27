import { FileIcon, Folder } from "lucide-react";
import type { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import type { CommandWorkdirEntry } from "./CommandWorkdirDialog";

interface CommandWorkdirPreviewFile {
  kind: "file";
  entry: CommandWorkdirEntry;
  name: string;
}

interface CommandWorkdirPreviewDir {
  kind: "dir";
  name: string;
  path: string;
  children: CommandWorkdirPreviewNode[];
}

type CommandWorkdirPreviewNode = CommandWorkdirPreviewDir | CommandWorkdirPreviewFile;

export function commandWorkdirBytes(entries: CommandWorkdirEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
}

export function commandWorkdirFolderCount(folders: string[]): number {
  return new Set(folders.map((folder) => folder.replace(/\/+$/, "")).filter(Boolean)).size;
}

function stagePathSegments(path: string): string[] {
  return path
    .trim()
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function safeStageTestId(path: string): string {
  return (
    path
      .trim()
      .replaceAll(/[^a-zA-Z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "")
      .toLowerCase() || "root"
  );
}

function sortPreviewNodes(nodes: CommandWorkdirPreviewNode[]): CommandWorkdirPreviewNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function buildCommandWorkdirPreviewTree(
  entries: CommandWorkdirEntry[],
  folders: string[],
): CommandWorkdirPreviewNode[] {
  const root: CommandWorkdirPreviewDir = {
    kind: "dir",
    name: "",
    path: "",
    children: [],
  };

  for (const folder of folders) {
    insertPreviewFolder(root, stagePathSegments(folder));
  }

  for (const entry of entries) {
    const segments = stagePathSegments(entry.stagePath);
    if (segments.length === 0) continue;
    let cursor = root;
    cursor = insertPreviewFolder(cursor, segments.slice(0, -1));
    const name = segments.at(-1);
    if (!name) continue;
    cursor.children.push({ kind: "file", entry, name });
  }

  const sortDeep = (nodes: CommandWorkdirPreviewNode[]): CommandWorkdirPreviewNode[] =>
    sortPreviewNodes(nodes).map((node) =>
      node.kind === "dir" ? { ...node, children: sortDeep(node.children) } : node,
    );

  return sortDeep(root.children);
}

function insertPreviewFolder(
  root: CommandWorkdirPreviewDir,
  segments: string[],
): CommandWorkdirPreviewDir {
  let cursor = root;
  for (const segment of segments) {
    const path = cursor.path ? `${cursor.path}/${segment}` : segment;
    const existing = cursor.children.find(
      (node): node is CommandWorkdirPreviewDir => node.kind === "dir" && node.name === segment,
    );
    if (existing) {
      cursor = existing;
      continue;
    }
    const next: CommandWorkdirPreviewDir = {
      kind: "dir",
      name: segment,
      path,
      children: [],
    };
    cursor.children.push(next);
    cursor = next;
  }
  return cursor;
}

function previewDirFileCount(dir: CommandWorkdirPreviewDir): number {
  return dir.children.reduce(
    (count, child) => count + (child.kind === "dir" ? previewDirFileCount(child) : 1),
    0,
  );
}

export function CommandWorkdirPreviewTree({
  entries,
  folders,
  t,
}: {
  entries: CommandWorkdirEntry[];
  folders: string[];
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const nodes = buildCommandWorkdirPreviewTree(entries, folders);

  const renderNode = (node: CommandWorkdirPreviewNode, depth: number) => {
    const paddingLeft = `min(calc(${depth * 1.25}rem + 0.75rem), 20%)`;
    if (node.kind === "dir") {
      const fileCount = previewDirFileCount(node);
      return (
        <div
          className="min-w-0 space-y-1"
          data-testid={`submit-command-workdir-tree-dir-${safeStageTestId(node.path)}`}
          key={`dir:${node.path}`}
        >
          <div
            className="flex min-w-0 items-center gap-2 border-border py-2 pr-3"
            style={{ paddingLeft }}
          >
            <Folder className="h-4 w-4 shrink-0 text-brand" />
            <span
              className="min-w-0 flex-1 [overflow-wrap:anywhere] font-mono text-xs"
              title={node.path}
            >
              {node.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {fileCount === 0
                ? t("jobs.commandWorkdir.emptyFolder", {
                    defaultValue: "Empty folder",
                  })
                : t("jobs.commandWorkdir.fileCount", {
                    count: fileCount,
                    defaultValue: "{{count}} files",
                  })}
            </span>
          </div>
          <div className="space-y-1">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        </div>
      );
    }
    const stagePath = node.entry.stagePath.trim();
    return (
      <div
        className="flex min-w-0 items-center gap-2 border-border py-2 pr-3"
        data-testid={`submit-command-workdir-tree-file-${safeStageTestId(stagePath)}`}
        key={`file:${node.entry.id}:${stagePath}`}
        style={{ paddingLeft }}
      >
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="[overflow-wrap:anywhere] font-mono text-xs" title={stagePath}>
            {node.name}
          </div>
          {node.entry.cloudPath !== node.name && (
            <div
              className="mt-0.5 [overflow-wrap:anywhere] font-mono text-[11px] text-muted-foreground"
              title={node.entry.cloudPath}
            >
              {node.entry.cloudPath}
            </div>
          )}
        </div>
        <Badge className="shrink-0" variant={node.entry.source === "upload" ? "brand" : "outline"}>
          {node.entry.source === "upload"
            ? t("jobs.commandWorkdir.uploadSource", {
                defaultValue: "Upload",
              })
            : t("jobs.commandWorkdir.cloudSource", {
                defaultValue: "Cloud",
              })}
        </Badge>
      </div>
    );
  };

  return (
    <div
      className="mt-3 max-h-56 space-y-1 overflow-auto border-border p-2"
      data-testid="submit-command-workdir-preview"
    >
      {nodes.map((node) => renderNode(node, 0))}
    </div>
  );
}
