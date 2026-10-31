import type { InterconnectCenter, InterconnectCluster } from "@kuintessence/shared/browser";

export const STATUS_LABELS = {
  operational: "正常",
  degraded: "异常",
  offline: "离线",
  maintenance: "维护",
  unknown: "未知",
} as const;
export const STATUS_COLORS = {
  operational: "#16a34a",
  degraded: "#d97706",
  offline: "#dc2626",
  maintenance: "#2563eb",
  unknown: "#64748b",
} as const;
export interface ResourceFilter {
  kind: "centers" | "clusters" | "applications" | "links";
  centerId?: string;
  clusterId?: string;
  centerIds?: string[];
  computeType?: string;
  storageType?: string;
  application?: string;
  status?: string;
  metric?: "cpu" | "storage" | "jobs" | "agents";
}
export function filterClusters(clusters: InterconnectCluster[], filter: ResourceFilter) {
  return clusters.filter(
    (c) =>
      (!filter.centerId || c.centerId === filter.centerId) &&
      (!filter.clusterId || c.id === filter.clusterId) &&
      (!filter.centerIds || filter.centerIds.includes(c.centerId)) &&
      (!filter.computeType ||
        c.metadata.computeTypes.includes(
          filter.computeType as InterconnectCluster["metadata"]["computeTypes"][number],
        )) &&
      (!filter.storageType || c.metadata.storageTypes.includes(filter.storageType)) &&
      (!filter.application || c.software.some((s) => s.name === filter.application)) &&
      (!filter.status || c.metadata.status === filter.status),
  );
}
export function formatCapacity(bytes: number | null): string {
  if (bytes === null) return "未提供";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${Number(n.toFixed(1))} ${units[i]}`;
}
export type ProjectedCenter<T extends InterconnectCenter = InterconnectCenter> = {
  center: T;
  x: number;
  y: number;
};
export function groupNearbyCenters<T extends InterconnectCenter>(
  points: ProjectedCenter<T>[],
  radius = 48,
): [T, ...T[]][] {
  const groups: [ProjectedCenter<T>, ...ProjectedCenter<T>[]][] = [];
  for (const point of points) {
    const matching = groups.filter((g) =>
      g.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < radius),
    );
    const first = matching[0];
    if (!first) groups.push([point]);
    else {
      first.push(point);
      for (const other of matching.slice(1)) {
        first.push(...other);
        groups.splice(groups.indexOf(other), 1);
      }
    }
  }
  return groups.map((g) => [g[0].center, ...g.slice(1).map((p) => p.center)]);
}
export function clusterSymbol(centers: InterconnectCenter[]): string {
  let offset = 0;
  const arcs = Object.entries(STATUS_COLORS)
    .map(([status, color]) => {
      const portion =
        (centers.filter((c) => c.metadata.status === status).length / centers.length) * 100;
      const circle = `<circle cx="28" cy="28" r="23" fill="none" stroke="${color}" stroke-width="6" pathLength="100" stroke-dasharray="${portion} ${100 - portion}" stroke-dashoffset="${-offset}" transform="rotate(-90 28 28)"/>`;
      offset += portion;
      return circle;
    })
    .join("");
  return `image://data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><circle cx="28" cy="28" r="24" fill="#fff"/>${arcs}</svg>`)}`;
}
