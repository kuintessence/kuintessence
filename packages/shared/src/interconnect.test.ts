import { describe, expect, test } from "bun:test";
import {
  CenterMetadataSchema,
  ClusterInputSchema,
  type InterconnectCluster,
  isObservationStale,
  LinkInputSchema,
  MapViewSchema,
  summarizeInterconnect,
} from "./interconnect";

const centerId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const cluster: InterconnectCluster = {
  id: otherId,
  centerId,
  updatedAt: "2026-01-01T00:00:00Z",
  agentIds: ["agent-1", "agent-2"],
  agents: [],
  metadata: {
    name: "Cluster",
    status: "unknown",
    cpuCores: 64,
    storageBytes: 1024,
    computeTypes: ["CPU", "GPU"],
    storageTypes: ["NFS"],
    applications: ["gromacs"],
  },
  software: [{ name: "gromacs", source: "inventory", observedAt: null }],
  jobs24h: { succeeded: 3, failed: 1 },
};
describe("interconnect contracts", () => {
  test("sums capacity once per logical cluster and deduplicates application names", () => {
    const totals = summarizeInterconnect(
      [],
      [
        cluster,
        {
          ...cluster,
          id: centerId,
          metadata: { ...cluster.metadata, cpuCores: null, storageBytes: null },
        },
      ],
    );
    expect(totals.cpuCores).toBe(64);
    expect(totals.storageBytes).toBe(1024);
    expect(totals.applications).toBe(1);
    expect(totals.computeTypes).toBe(2);
    expect(totals.missingCpu).toBe(1);
    expect(totals.missingStorage).toBe(1);
  });
  test("rejects partial coordinates, duplicate agents and invalid capacity", () => {
    expect(
      CenterMetadataSchema.safeParse({
        name: "Center",
        country: "中国",
        province: "北京",
        city: "北京",
        latitude: 40,
        longitude: null,
        status: "unknown",
      }).success,
    ).toBe(false);
    expect(
      ClusterInputSchema.safeParse({ centerId, agentIds: ["a", "a"], metadata: cluster.metadata })
        .success,
    ).toBe(false);
    expect(
      ClusterInputSchema.safeParse({
        centerId,
        agentIds: [],
        metadata: { ...cluster.metadata, cpuCores: -1 },
      }).success,
    ).toBe(false);
  });
  test("requires provenance for measurements and rejects self-links and impossible loss", () => {
    const value = {
      fromCenterId: centerId,
      toCenterId: otherId,
      metadata: {
        name: "Link",
        status: "unknown",
        bandwidthMbps: null,
        throughputMbps: null,
        latencyMs: null,
        packetLossPercent: null,
        observedAt: null,
        source: "",
      },
    };
    expect(LinkInputSchema.safeParse(value).success).toBe(true);
    expect(LinkInputSchema.safeParse({ ...value, toCenterId: centerId }).success).toBe(false);
    expect(
      LinkInputSchema.safeParse({ ...value, metadata: { ...value.metadata, latencyMs: 0 } })
        .success,
    ).toBe(false);
    expect(
      LinkInputSchema.safeParse({
        ...value,
        metadata: { ...value.metadata, status: "operational" },
      }).success,
    ).toBe(false);
    expect(
      LinkInputSchema.safeParse({
        ...value,
        metadata: {
          ...value.metadata,
          latencyMs: 0,
          packetLossPercent: 101,
          observedAt: "2026-01-01T00:00:00Z",
          source: "probe",
        },
      }).success,
    ).toBe(false);
    expect(
      LinkInputSchema.safeParse({
        ...value,
        metadata: {
          ...value.metadata,
          latencyMs: 0,
          observedAt: "2026-01-01T00:00:00Z",
          source: "probe",
        },
      }).success,
    ).toBe(true);
  });
  test("validates view bounds and labels stale observations independently of update time", () => {
    expect(
      MapViewSchema.safeParse({ level: "province", region: "", center: [104, 35], zoom: 1 })
        .success,
    ).toBe(false);
    expect(
      MapViewSchema.safeParse({ level: "world", region: "", center: [181, 35], zoom: 1 }).success,
    ).toBe(false);
    expect(isObservationStale(null)).toBe(true);
    expect(isObservationStale("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:06:00Z"))).toBe(
      true,
    );
    expect(isObservationStale("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:01:00Z"))).toBe(
      false,
    );
  });
});
