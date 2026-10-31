import type { InterconnectCenter, InterconnectCluster } from "@kuintessence/shared/browser";
import { describe, expect, test } from "vitest";
import { clusterSymbol, filterClusters, groupNearbyCenters } from "./model";

const center = (id: string): InterconnectCenter => ({
  id,
  orgId: "o",
  updatedAt: "2026-01-01T00:00:00Z",
  metadata: {
    name: id,
    country: "中国",
    province: "北京",
    city: "北京",
    longitude: 116,
    latitude: 40,
    status: "operational",
  },
});
const cluster = (id: string, centerId: string): InterconnectCluster => ({
  id,
  centerId,
  updatedAt: "2026-01-01T00:00:00Z",
  agentIds: [],
  agents: [],
  metadata: {
    name: id,
    status: "operational",
    cpuCores: 32,
    storageBytes: null,
    computeTypes: ["GPU"],
    storageTypes: ["Ceph"],
    applications: [],
  },
  software: [{ name: "gromacs", source: "inventory", observedAt: null }],
  jobs24h: { succeeded: 0, failed: 0 },
});
describe("interconnect drilldown and map grouping", () => {
  test("keeps center, type and application filters combined", () => {
    const rows = [cluster("a", "north"), cluster("b", "south")];
    expect(
      filterClusters(rows, {
        kind: "applications",
        centerId: "north",
        computeType: "GPU",
        storageType: "Ceph",
        application: "gromacs",
      }).map((c) => c.id),
    ).toEqual(["a"]);
    expect(
      filterClusters(rows, { kind: "clusters", centerId: "north", computeType: "CPU" }),
    ).toEqual([]);
    expect(filterClusters(rows, { kind: "clusters", centerIds: [] })).toEqual([]);
  });
  test("merges transitive neighbors and expands to individual centers when zoomed", () => {
    const points = [
      { center: center("a"), x: 0, y: 0 },
      { center: center("b"), x: 70, y: 0 },
      { center: center("c"), x: 35, y: 0 },
    ];
    expect(groupNearbyCenters(points)).toHaveLength(1);
    expect(groupNearbyCenters(points.map((p) => ({ ...p, x: p.x * 3 })))).toHaveLength(3);
    expect(
      groupNearbyCenters(points)
        .flat()
        .map((c) => c.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });
  test("aggregate symbol includes state proportions without embedding user-provided labels", () => {
    const result = decodeURIComponent(
      clusterSymbol([
        center("<script>"),
        { ...center("b"), metadata: { ...center("b").metadata, status: "offline" } },
      ]),
    );
    expect(result).toContain('stroke-dasharray="50 50"');
    expect(result).not.toContain("<script>");
  });
});
