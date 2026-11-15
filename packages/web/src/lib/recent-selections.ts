export interface RecentSelectionScope {
  userId: string;
  organizationId: string | null;
  resourceType: string;
}

export function recentSelectionKey(scope: RecentSelectionScope): string {
  return `kq:recent-selection:${JSON.stringify([scope.userId, scope.organizationId, scope.resourceType])}`;
}

export function readRecentSelections(scope: RecentSelectionScope): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recentSelectionKey(scope)) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === "string"))].slice(0, 5)
      : [];
  } catch {
    // A blocked browser store must not prevent choosing a resource.
    return [];
  }
}

export function rememberSelection(scope: RecentSelectionScope, id: string): string[] {
  const recent = [id, ...readRecentSelections(scope).filter((item) => item !== id)].slice(0, 5);
  try {
    localStorage.setItem(recentSelectionKey(scope), JSON.stringify(recent));
  } catch {
    // Choosing remains usable when browser storage is unavailable.
  }
  return recent;
}
