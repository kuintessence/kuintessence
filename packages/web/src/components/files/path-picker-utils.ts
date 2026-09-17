import type { CloudObject } from "@kuintessence/shared/browser";

export interface CloudFolderRow {
  kind: "dir";
  name: string;
  fullPath: string;
  childCount: number;
  totalSize: number;
  latestModifiedAt: string;
}

export interface CloudFileRow {
  kind: "file";
  obj: CloudObject;
  displayName: string;
}

export type CloudBrowserRow = CloudFolderRow | CloudFileRow;

export function buildCloudBrowserRows(entries: CloudObject[], prefix: string): CloudBrowserRow[] {
  const folders = new Map<string, CloudFolderRow>();
  const files: CloudFileRow[] = [];
  for (const entry of entries) {
    if (!entry.key.startsWith(prefix)) continue;
    const rest = entry.key.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      files.push({ kind: "file", obj: entry, displayName: rest });
      continue;
    }
    const name = rest.slice(0, slash);
    const fullPath = `${prefix}${name}/`;
    const existing = folders.get(fullPath);
    if (existing) {
      existing.childCount += 1;
      existing.totalSize += entry.size;
      if (entry.modifiedAt > existing.latestModifiedAt) {
        existing.latestModifiedAt = entry.modifiedAt;
      }
    } else {
      folders.set(fullPath, {
        kind: "dir",
        name,
        fullPath,
        childCount: 1,
        totalSize: entry.size,
        latestModifiedAt: entry.modifiedAt,
      });
    }
  }
  const sortedFolders = [...folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  const sortedFiles = files.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return [...sortedFolders, ...sortedFiles];
}

export function parentCloudPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "" : `${trimmed.slice(0, slash)}/`;
}

export function parentClusterPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return "/";
  return trimmed.slice(0, slash);
}

export function joinClusterPath(parent: string, child: string): string {
  return `${parent.replace(/\/$/, "")}/${child}`;
}

export function isClusterPathWithinRoots(path: string, roots: string[]): boolean {
  return roots.some(
    (root) => root && (path === root || path.startsWith(`${root.replace(/\/$/, "")}/`)),
  );
}

export function canNavigateClusterUp(path: string, roots: string[]): boolean {
  if (!path) return false;
  const parent = parentClusterPath(path);
  return parent !== path && isClusterPathWithinRoots(parent, roots);
}

export function findClusterRoot(path: string, roots: string[]): string {
  return (
    roots
      .filter((root) => isClusterPathWithinRoots(path, [root]))
      .sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? ""
  );
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "-";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
}
