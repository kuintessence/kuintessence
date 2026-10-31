import { z } from "zod";

export const ResourceStatusSchema = z.enum([
  "operational",
  "degraded",
  "offline",
  "maintenance",
  "unknown",
]);
const label = z.string().trim().min(1).max(120);
const nullableMetric = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const CenterMetadataSchema = z
  .object({
    name: label,
    country: label,
    province: z.string().trim().max(120),
    city: z.string().trim().max(120),
    longitude: z.number().min(-180).max(180).nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    status: ResourceStatusSchema,
  })
  .strict()
  .refine((v) => (v.longitude === null) === (v.latitude === null), "经纬度须同时填写或同时留空");
export const ClusterMetadataSchema = z
  .object({
    name: label,
    status: ResourceStatusSchema,
    computeTypes: z
      .array(z.enum(["CPU", "国产 CPU", "GPU", "其他"]))
      .max(4)
      .refine((v) => new Set(v).size === v.length),
    cpuCores: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    storageBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    storageTypes: z
      .array(label)
      .max(20)
      .refine((v) => new Set(v).size === v.length),
    applications: z
      .array(label)
      .max(500)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const LinkMetadataSchema = z
  .object({
    name: label,
    status: ResourceStatusSchema,
    bandwidthMbps: nullableMetric,
    throughputMbps: nullableMetric,
    latencyMs: nullableMetric,
    packetLossPercent: z.number().min(0).max(100).nullable(),
    observedAt: z.string().datetime().nullable(),
    source: z.string().trim().max(240),
  })
  .strict()
  .refine(
    (v) =>
      (v.status === "unknown" &&
        [v.bandwidthMbps, v.throughputMbps, v.latencyMs, v.packetLossPercent].every(
          (x) => x === null,
        )) ||
      (v.observedAt !== null && v.source.length > 0),
    "链路状态和指标须提供观测时间及来源",
  )
  .refine(
    (v) => !v.observedAt || Date.parse(v.observedAt) <= Date.now() + 60_000,
    "观测时间不能在未来",
  );
export const MapViewSchema = z
  .object({
    level: z.enum(["world", "china", "province"]),
    region: z.string().max(120),
    center: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    zoom: z.number().min(0.5).max(64),
  })
  .strict()
  .refine((v) => v.level !== "province" || v.region.length > 0, "请选择省份");
export const CenterInputSchema = z
  .object({ orgId: z.string().uuid(), metadata: CenterMetadataSchema })
  .strict();
export const ClusterInputSchema = z
  .object({
    centerId: z.string().uuid(),
    metadata: ClusterMetadataSchema,
    agentIds: z
      .array(z.string().min(1).max(255))
      .max(200)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const LinkInputSchema = z
  .object({
    fromCenterId: z.string().uuid(),
    toCenterId: z.string().uuid(),
    metadata: LinkMetadataSchema,
  })
  .strict()
  .refine((v) => v.fromCenterId !== v.toCenterId, "链路两端必须不同");
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>;
export type CenterMetadata = z.infer<typeof CenterMetadataSchema>;
export type ClusterMetadata = z.infer<typeof ClusterMetadataSchema>;
export type LinkMetadata = z.infer<typeof LinkMetadataSchema>;
export type MapView = z.infer<typeof MapViewSchema>;
export type CenterInput = z.infer<typeof CenterInputSchema>;
export type ClusterInput = z.infer<typeof ClusterInputSchema>;
export type LinkInput = z.infer<typeof LinkInputSchema>;
export type InterconnectCenter = CenterInput & { id: string; updatedAt: string };
export type InterconnectCluster = ClusterInput & {
  id: string;
  updatedAt: string;
  software: { name: string; source: "inventory" | "declared"; observedAt: string | null }[];
  agents: { id: string; status: string; observedAt: string | null }[];
  jobs24h: { succeeded: number; failed: number };
};
export type InterconnectLink = LinkInput & { id: string; updatedAt: string };
export interface InterconnectSnapshot {
  centers: InterconnectCenter[];
  clusters: InterconnectCluster[];
  links: InterconnectLink[];
  agents: { id: string; name: string; orgId: string | null; clusterId: string | null }[];
  organizations: { id: string; name: string }[];
  defaultView: MapView | null;
  generatedAt: string;
  canManage: boolean;
}

export const DEFAULT_MAP_VIEW: MapView = { level: "china", region: "", center: [104, 35], zoom: 1 };
export function isObservationStale(observedAt: string | null, now = Date.now()): boolean {
  return !observedAt || now - Date.parse(observedAt) > 5 * 60_000;
}
export function summarizeInterconnect(
  centers: InterconnectCenter[],
  clusters: InterconnectCluster[],
) {
  return {
    centers: centers.length,
    operational: centers.filter((c) => c.metadata.status === "operational").length,
    cpuCores: clusters.reduce((n, c) => n + (c.metadata.cpuCores ?? 0), 0),
    missingCpu: clusters.filter((c) => c.metadata.cpuCores === null).length,
    storageBytes: clusters.reduce((n, c) => n + (c.metadata.storageBytes ?? 0), 0),
    missingStorage: clusters.filter((c) => c.metadata.storageBytes === null).length,
    computeTypes: new Set(clusters.flatMap((c) => c.metadata.computeTypes)).size,
    storageTypes: new Set(clusters.flatMap((c) => c.metadata.storageTypes)).size,
    applications: new Set(clusters.flatMap((c) => c.software.map((s) => s.name))).size,
    succeeded: clusters.reduce((n, c) => n + c.jobs24h.succeeded, 0),
    failed: clusters.reduce((n, c) => n + c.jobs24h.failed, 0),
  };
}
